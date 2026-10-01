// solver.mjs - solver worker (spawned by server.mjs, or run standalone).
// Mints Turnstile tokens for ANY domain-authorized
// sitekey by driving a real Chrome via CDP. The solve parameters arrive in the
// header-1 forward packet as fields: url, sitekey, action. An optional proxy
// field lazily launches a dedicated Chrome configured with --proxy-server.
//
// Hub protocol (see server.mjs; byte-compatible with the original Rust token-server):
//   register: [2, ...ua_bytes]
//   request:  [1, proxy_len(u8), ...proxy, requester_id(u32 LE),
//              (name_len(u8), ...name, value_len(u8), ...value)*]
//   result:   [0, requester_id(u32 LE), proxy_len(u8), ...proxy, ...token]
//
// Usage: node solver.mjs   (normally spawned and configured by server.mjs)
// Env:    CDP_BASE         default Chrome debugging endpoint (default http://127.0.0.1:9222)
//         TOKEN_SERVER_URL hub WebSocket url (set by server.mjs; default ws://127.0.0.1:8081)
//         CHROME_PATH      chrome executable for proxy instances
//         SOLVE_TIMEOUT_MS per-solve poll budget in the page (default 55000)
//         NAV_TIMEOUT_MS   page navigation budget (default 45000)
//         HEADLESS         "1" runs spawned Chrome headless (default 1; "0" = visible)
//         MANAGE_BROWSER   "1" lets the solver launch+own its own Chrome at CDP_BASE
//         REQUEST_TIMEOUT_MS whole-request watchdog budget (default 110000)
//         RECONNECT_MS     token-server reconnect delay (default 3000)
//         DEFAULT_PROXY    proxy used for EVERY solve when the request's proxy
//                          field is empty (always-on proxy). Colon form
//                          host:port:user:pass or http://user:pass@host:port.
//         PAGE_INIT_SLEEP_MS settle time after navigation (default 400)
//
// Production notes:
//   * Survives token-server restarts: reconnects and re-registers automatically.
//   * Boot retries (browser + ws) instead of exiting, so startup order does not matter.
//   * SIGINT/SIGTERM (or process 'exit') kill all spawned Chrome instances.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const TOKEN_WS = process.env.TOKEN_SERVER_URL || "ws://127.0.0.1:8081";
const DEFAULT_CDP = process.env.CDP_BASE || "http://127.0.0.1:9222";
const SOLVE_TIMEOUT_MS = parseInt(process.env.SOLVE_TIMEOUT_MS || "55000", 10);
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || "45000", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "110000", 10);
const RECONNECT_MS = parseInt(process.env.RECONNECT_MS || "3000", 10);
const PREWARM_TIMEOUT_MS = parseInt(process.env.PREWARM_TIMEOUT_MS || "45000", 10);
const PAGE_INIT_SLEEP_MS = parseInt(process.env.PAGE_INIT_SLEEP_MS || "400", 10);
const HEADLESS = process.env.HEADLESS === undefined ? "1" : process.env.HEADLESS;
// Managed by default: hub-spawned workers (and standalone `node solver.mjs`)
// launch and own their Chrome at CDP_BASE. Set MANAGE_BROWSER=0 to attach to an
// already-running external Chrome at CDP_BASE instead of launching one.
const MANAGE_BROWSER = process.env.MANAGE_BROWSER !== "0";
const DEFAULT_CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/local/bin/solver-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);
// Pick the first Chrome/Chromium that exists on this machine (env override
// always wins when it points at a real binary).
const CHROME_PATH = DEFAULT_CHROME_CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } }) || process.env.CHROME_PATH || "chromium";
const SOLVER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const TURNSTILE_JS = "https://challenges.cloudflare.com/turnstile/v0/api.js";
// Worker index (set by server.mjs per spawned worker). Chrome locks a
// user-data-dir to a single running instance, so every worker needs its OWN
// profile directories or all but the first worker fail to boot. Unset (0) in
// standalone `node solver.mjs` runs -> legacy shared names, behavior unchanged.
const SOLVER_INSTANCE = parseInt(process.env.SOLVER_INSTANCE || "", 10) || 0;
const MANAGED_PROFILE_DIR = join(__dir, ".state", SOLVER_INSTANCE ? `chrome-default-${SOLVER_INSTANCE}` : "chrome-default");
// Extra Chrome flags, comma-separated (e.g. "CHROME_ARGS_EXTRA=--no-sandbox,--disable-dev-shm-usage"
// for Docker). Appended to every spawned Chrome.
const CHROME_ARGS_EXTRA = (process.env.CHROME_ARGS_EXTRA || "").split(",").map(s => s.trim()).filter(Boolean);
// Fixed port for the visible fallback browser ("" = auto). Lets multiple solver
// instances on one host use distinct ports (default 9230, fallback 9330+i).
const FALLBACK_CDP_PORT = parseInt(process.env.FALLBACK_CDP_PORT || "0", 10) || 0;
// Where the solver persists which hosts challenged the headless fingerprint and
// the last solved target, so a restart skips the wasted 55s headless attempt and
// can pre-warm the fallback browser. Empty string disables persistence.
const STATE_FILE = process.env.SOLVER_STATE_FILE || join(__dir, ".state", "solver.json");
// Always-on proxy: used for every solve when the request's proxy field is empty.
// Enables boot-time prewarm (warm proxy browser + pre-minted token on the last
// solved target) so even the first request after a restart is fast.
const DEFAULT_PROXY = (process.env.DEFAULT_PROXY || "").trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const logErr = (...a) => console.error(new Date().toISOString(), ...a);
let shuttingDown = false;

// ---------- low-level ws ----------
function openWs(url, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("WS open TIMED OUT")); }, timeoutMs);
        ws.onopen = () => { clearTimeout(timer); resolve(ws); };
        ws.onerror = () => { clearTimeout(timer); reject(new Error("WS error")); };
    });
}

// ---------- CDP browser wrapper ----------
class CdpBrowser {
    constructor(name, cdpBase) {
        this.name = name;
        this.cdpBase = cdpBase;
        this.ws = null;
        this.sessionId = null;
        this.targetId = null;
        this.msgId = 0;
        this.pending = new Map();
        this.widgetKey = "";
        this.proc = null;
        this.proxyAuth = null; // { username, password } for authenticated proxies
        this.prewarmToken = null; // { key, token, at } token pre-minted at boot prewarm
        this._lock = null; // per-browser mutex: prewarm and solves never interleave evals
    }

    async connect() {
        if (this.ws && this.ws.readyState === 1) return this;
        let ver = null;
        try {
            ver = await fetch(this.cdpBase + "/json/version").then((r) => r.json());
        } catch (e) {
            throw new Error("CDP unreachable at " + this.cdpBase + ": " + e.message);
        }
        if (!ver || !ver.webSocketDebuggerUrl) {
            throw new Error("CDP at " + this.cdpBase + " returned no webSocketDebuggerUrl");
        }
        this.ws = await openWs(ver.webSocketDebuggerUrl);
        this.ws.onmessage = (ev) => {
            const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (msg.method === "Fetch.authRequired" && this.proxyAuth) {
                // Chrome cannot take proxy credentials from --proxy-server, so we
                // answer the proxy's 407 auth challenge via the Fetch domain.
                this.ws.send(JSON.stringify({
                    id: ++this.msgId,
                    sessionId: msg.sessionId,
                    method: "Fetch.continueWithAuth",
                    params: {
                        requestId: msg.params.requestId,
                        authChallengeResponse: {
                            response: "ProvideCredentials",
                            username: this.proxyAuth.username,
                            password: this.proxyAuth.password,
                        },
                    },
                }));
                return;
            }
            if (msg.method === "Fetch.requestPaused" && this.proxyAuth) {
                // Fetch.enable uses an "*" pattern (required for authRequired to
                // fire), so every request is paused at the Request stage; resume
                // each one immediately.
                this.ws.send(JSON.stringify({
                    id: ++this.msgId,
                    sessionId: msg.sessionId,
                    method: "Fetch.continueRequest",
                    params: { requestId: msg.params.requestId },
                }));
                return;
            }
            if (msg.id && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
            }
        };
        this.ws.onclose = () => {
            // Chrome died or the CDP socket dropped: reject every in-flight call
            // immediately so solves fail fast instead of hanging to the watchdog.
            const pend = [...this.pending.values()];
            this.pending.clear();
            for (const p of pend) p.reject(new Error("CDP connection closed"));
        };
        return this;
    }

    async send(method, params = {}, withSession = true) {
        const id = ++this.msgId;
        const payload = { id, method, params };
        if (withSession && this.sessionId) payload.sessionId = this.sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify(payload));
            } catch (e) {
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    async eval(expression) {
        const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (res.exceptionDetails) {
            throw new Error("page eval exception: " + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
        }
        return res.result?.value;
    }

    // Serialize page-driving work so prewarm and solve never interleave evals on
    // one page. Top-level page operations (ensurePage + solveTurnstile and the
    // boot prewarm) must run inside lock().
    async lock(fn) {
        const prev = this._lock;
        let release;
        this._lock = new Promise((r) => { release = r; });
        if (prev) await prev.catch(() => {});
        try {
            return await fn();
        } finally {
            release();
        }
    }

    async ensurePage(url) {
        let t = null;
        try {
            const { targetInfos } = await this.send("Target.getTargets", {}, false);
            t = targetInfos.find((x) => x.type === "page" && x.url.startsWith("http"));
        } catch {}
        if (!t) {
            // No usable page target: either first boot or the previous one died
            // (e.g. the OOM killer reaping the renderer). Create a fresh page.
            const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, false);
            t = { targetId, url: "about:blank", title: "" };
        }
        if (this.targetId !== t.targetId) {
            this.targetId = t.targetId;
            const { sessionId } = await this.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }, false);
            this.sessionId = sessionId;
            this.widgetKey = "";
            this.prewarmToken = null; // new target -> any pre-minted token is gone
            await this.send("Page.enable", {}).catch(() => {});
            await this.maskAutomation();
            if (this.proxyAuth) {
                // Intercept auth challenges so requests through an authenticated
                // proxy can be answered with the credentials. An "*" Request-stage
                // pattern is REQUIRED: without it Chromium never wires up the auth
                // handler and 407s die with ERR_INVALID_AUTH_CREDENTIALS. Every
                // paused request is resumed immediately by the onmessage handler.
                await this.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] }).catch(() => {});
            }
        }
        const cur = (await this.eval("location.href").catch(() => "")) || t.url || "";
        if (this.isSameTarget(cur, url)) {
            this.pageUrl = cur;
            return;
        }
        await this.send("Page.navigate", { url });
        const t0 = Date.now();
        let ok = false;
        while (Date.now() - t0 < NAV_TIMEOUT_MS) {
            await sleep(200);
            const state = await this.eval("({ready: document.readyState, href: location.href})").catch(() => null);
            if (state && state.ready === "complete" && /^https?:/i.test(state.href)) { ok = true; break; }
        }
        if (!ok) throw new Error("navigation to " + url + " did not complete");
        await sleep(PAGE_INIT_SLEEP_MS); // let page scripts initialize
        this.widgetKey = ""; // new document -> any cached widget is gone
        this.prewarmToken = null; // new document -> any pre-minted token is gone
        this.pageUrl = await this.eval("location.href").catch(() => url);
    }

    isSameTarget(a, b) {
        const norm = (u) => {
            try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ""); }
            catch { return u.replace(/\/+$/, ""); }
        };
        return /^https?:/i.test(a) && norm(a) === norm(b);
    }

    // Blunt the classic "automation" signals a real browser would not expose:
    // navigator.webdriver, missing chrome.runtime, and stock navigator fields.
    // Injected into every new document + the current one. Best-effort only.
    async maskAutomation() {
        const MASK = `(() => {
            try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
            try { window.chrome = window.chrome || { runtime: {} }; } catch (e) {}
            try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
            try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch (e) {}
        })()`;
        await this.send("Page.addScriptToEvaluateOnNewDocument", { source: MASK }).catch(() => {});
        await this.eval(MASK).catch(() => {});
    }

    async ensureTurnstile() {
        if (await this.eval("typeof window.turnstile !== 'undefined'")) return;
        await this.eval(`(async () => {
            const s = document.createElement('script');
            s.src = ${JSON.stringify(TURNSTILE_JS)};
            s.async = true;
            s.onerror = () => { window.__turnstileLoadError = new Error('turnstile script failed to load'); };
            document.head.appendChild(s);
            const t0 = Date.now();
            while (!window.turnstile && !window.__turnstileLoadError && Date.now() - t0 < 20000) {
                await new Promise(r => setTimeout(r, 200));
            }
            if (!window.turnstile) throw new Error(window.__turnstileLoadError ? window.__turnstileLoadError.message : 'window.turnstile never became available');
            return true;
        })()`);
        console.log("# [" + this.name + "] turnstile loaded on", this.pageUrl);
    }

    async primeWidget(sitekey, action) {
        const key = sitekey + "|" + (action || "");
        // The page may have been navigated/reloaded since the last render, so
        // only skip re-rendering when the key matches AND the widget exists.
        const present = await this.eval(
            "!!(window.__apiSolver && window.__apiSolver.wid && document.getElementById('api-solver-host'))"
        ).catch(() => false);
        if (this.widgetKey === key && present) return;
        this.prewarmToken = null; // re-rendering the widget invalidates any pre-minted token
        await this.eval(`(() => {
            const old = document.getElementById('api-solver-host');
            if (old) old.remove();
            const host = document.createElement('div');
            host.id = 'api-solver-host';
            host.style.cssText = 'position:fixed;left:-10000px;top:0;width:300px;height:65px;z-index:-1;';
            document.body.appendChild(host);
            const wid = turnstile.render(host, {
                sitekey: ${JSON.stringify(sitekey)},
                action: ${JSON.stringify(action || "")},
                execution: 'execute',
                appearance: 'interaction-only',
                size: 'flexible',
                theme: 'light',
                'response-field': false
            });
            window.__apiSolver = { host, wid };
        })()`);
        this.widgetKey = key;
        console.log("# [" + this.name + "] widget primed (sitekey=" + sitekey + " action=" + (action || "(none)") + ")");
    }

    async solveTurnstile(sitekey, action) {
        const key = sitekey + "|" + (action || "");
        // Fast path: consume a token that was pre-minted at boot prewarm (target
        // was already loaded and the widget already executed, so the answer is
        // available before the request even arrived).
        if (this.prewarmToken && this.prewarmToken.key === key && Date.now() - this.prewarmToken.at < 90000) {
            const t = this.prewarmToken.token;
            this.prewarmToken = null;
            console.log("# [" + this.name + "] using pre-minted token");
            return { ok: true, token: t };
        }
        this.prewarmToken = null;
        await this.ensureTurnstile();
        await this.primeWidget(sitekey, action);
        const out = await this.eval(`(async () => {
            const S = window.__apiSolver;
            if (!S || !S.wid) return { ok: false, error: 'widget not found' };
            try { turnstile.reset(S.wid); } catch (e) { return { ok: false, error: 'reset: ' + e.message }; }
            await new Promise(r => setTimeout(r, 250));
            try { turnstile.execute(S.wid); } catch (e) { return { ok: false, error: 'execute: ' + e.message }; }
            const t0 = Date.now();
            while (Date.now() - t0 < ${SOLVE_TIMEOUT_MS}) {
                await new Promise(r => setTimeout(r, 150));
                let tok = null;
                try { tok = turnstile.getResponse(S.wid); } catch (e) {}
                if (tok) return { ok: true, token: tok };
            }
            return { ok: false, error: 'timeout after ' + ${SOLVE_TIMEOUT_MS} + ' ms (interactive challenge or bad sitekey/domain)' };
        })()`);
        return out || { ok: false, error: "empty result from page" };
    }
}


// ---------- browser management ----------
const browsers = new Map();
let _port = 9229;
function nextPort() { _port += 1; return _port; }

function defaultBrowser() {
    if (!browsers.has("default")) browsers.set("default", new CdpBrowser("default", DEFAULT_CDP));
    return browsers.get("default");
}

async function launchChrome({ name, port, dir, extraArgs, headless }) {
    const useHeadless = headless === undefined ? HEADLESS === "1" : !!headless;
    const args = [
        "--user-data-dir=" + dir,
        "--remote-debugging-port=" + port,
        "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--disable-background-timer-throttling",
        "--disable-popup-blocking", "--disable-hang-monitor", "--disable-sync",
        "--metrics-recording-only", "--mute-audio",
        "--disable-blink-features=AutomationControlled",
        "--remote-allow-origins=*",
        ...(useHeadless ? ["--headless=new", "--hide-scrollbars"] : []),
        ...extraArgs,
        ...CHROME_ARGS_EXTRA,
        "about:blank",
    ];
    mkdirSync(dir, { recursive: true });
    log("config: chrome=" + CHROME_PATH + " headless=" + HEADLESS + " args=" + [...CHROME_ARGS_EXTRA, ...extraArgs].join(" "));
    log("# launching Chrome (" + (useHeadless ? "headless" : "visible") + ") on port " + (port || "auto"));
    const proc = spawn(CHROME_PATH, args, { stdio: "ignore", windowsHide: true });
    proc.on("error", (e) => logErr("# chrome spawn error:", e.message));
    // Keep the last ~4 KB of Chrome's stderr so an early crash (SIGSEGV/133/etc.)
    // can report the REAL FATAL line instead of an opaque exit code.
    let stderrBuf = "";
    if (proc.stderr) proc.stderr.on("data", (d) => { stderrBuf = (stderrBuf + d.toString()).slice(-4096); });
    const died = (prefix) => {
        const tail = stderrBuf.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(-6).join(" | ");
        return new Error(prefix + (tail ? " | chrome stderr: " + tail.slice(0, 700) : ""));
    };
    let base;
    if (port === 0) {
        // OS-assigned debugging port (used for proxy browsers so they can never
        // collide with the default/fallback CDP endpoints): Chrome writes the
        // actual port to <user-data-dir>/DevToolsActivePort shortly after launch.
        // Remove any stale file first so a locked/relaunched profile can never
        // make us attach to an old, dead endpoint.
        const dpFile = join(dir, "DevToolsActivePort");
        try { unlinkSync(dpFile); } catch {}
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
            if (proc.exitCode !== null) {
                throw died("chrome exited (code " + proc.exitCode + ") before publishing a DevTools port - profile dir locked by another instance?");
            }
            try {
                const line = readFileSync(dpFile, "utf8").split(/[\r\n]+/, 1)[0].trim();
                if (line && Number.isInteger(+line) && +line > 0) { port = +line; break; }
            } catch {}
            await sleep(100);
        }
        if (!port) throw new Error("chrome did not publish a DevToolsActivePort (auto port)");
        base = "http://127.0.0.1:" + port;
        log("# browser \"" + name + "\" published DevTools port " + port);
    } else {
        base = "http://127.0.0.1:" + port;
        const t0 = Date.now();
        while (Date.now() - t0 < 30000) {
            if (proc.exitCode !== null) {
                throw died("chrome exited (code " + proc.exitCode + ") before serving DevTools on port " + port);
            }
            try { if ((await fetch(base + "/json/version")).ok) break; } catch {}
            await sleep(400);
        }
    }
    const b = new CdpBrowser(name, base);
    b.proc = proc;
    await b.connect();
    return b;
}

async function launchManagedDefaultBrowser() {
    // A crashed Chrome can leave a stale SingletonLock/Socket in its profile dir;
    // relaunching into the same dir makes the new Chrome exit 133 immediately
    // ("profile in use by another process"). We only relaunch after the previous
    // process is confirmed dead, so always start from a pristine dir - the same
    // approach the proxy path already uses (see launchProxyBrowser).
    try { rmSync(MANAGED_PROFILE_DIR, { recursive: true, force: true }); } catch {}
    const port = new URL(DEFAULT_CDP).port || 9222;
    _port = Math.max(_port, port); // nextPort() must never hand out the default CDP port
    const b = await launchChrome({ name: "default", port, dir: MANAGED_PROFILE_DIR, extraArgs: [] });
    browsers.set("default", b);
    log("# managed default browser ready on http://127.0.0.1:" + port);
    return b;
}

// Visible fallback used when Cloudflare's risk engine challenges the headless
// fingerprint. Kept separate from the managed default so headless stays headless.
async function launchFallbackBrowser() {
    const key = "fallback";
    if (browsers.has(key)) return browsers.get(key);
    const port = FALLBACK_CDP_PORT || nextPort();
    if (FALLBACK_CDP_PORT) _port = Math.max(_port, port);
    const dir = join(__dir, ".state", SOLVER_INSTANCE ? `chrome-fallback-${SOLVER_INSTANCE}` : "chrome-fallback");
    // Same stale-singleton rationale as launchManagedDefaultBrowser: a relaunch
    // into a dir left behind by a crashed Chrome exits 133 before CDP comes up.
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    const b = await launchChrome({ name: "fallback", port, dir, extraArgs: [], headless: false });
    browsers.set(key, b);
    log("# visible fallback browser ready on http://127.0.0.1:" + port);
    return b;
}

// Normalize a proxy string from the token-server into (a) a Chrome-safe
// --proxy-server value WITHOUT credentials (Chrome rejects userinfo in proxy
// URLs with ERR_NO_SUPPORTED_PROXIES) and (b) the credentials used to answer
// the proxy's 407 challenge via the Fetch domain. Accepts both
//   http://user:pass@host:port      (URL form)
//   host:port:user:pass             (colon form)
// and plain host:port.
function parseProxy(proxy) {
    if (!proxy) return null;
    const p = proxy.trim();
    if (!p) return null;
    let proxyServer = "";
    let user = "";
    let pass = "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
        const u = new URL(p);
        user = decodeURIComponent(u.username || "");
        pass = decodeURIComponent(u.password || "");
        proxyServer = u.origin; // scheme://host:port (or scheme://host)
    } else {
        const parts = p.split("@").pop().split(":");
        // parts may be [host, port] | [host, port, user] | [host, port, user, pass]
        if (parts.length >= 3) {
            proxyServer = "http://" + parts[0] + ":" + parts[1];
            user = decodeURIComponent(parts[2] || "");
            pass = decodeURIComponent(parts.slice(3).join(":") || "");
        } else if (parts.length === 2) {
            proxyServer = "http://" + parts[0] + ":" + parts[1];
        } else {
            proxyServer = "http://" + p;
        }
    }
    return { proxyServer, auth: user ? { username: user, password: pass } : null };
}

async function launchProxyBrowser(proxy) {
    const key = "proxy:" + createHash("sha1").update(proxy).digest("hex").slice(0, 12);
    if (browsers.has(key)) return browsers.get(key);
    const port = 0; // OS-assigned; avoids colliding with default/fallback CDP endpoints
    const dir = join(__dir, ".state", `chrome-proxy-${key.slice(6)}${SOLVER_INSTANCE ? "-" + SOLVER_INSTANCE : ""}`);
    const parsed = parseProxy(proxy) || { proxyServer: proxy, auth: null };
    // A stale profile can cache an old proxy password and make Chrome fail with
    // ERR_INVALID_AUTH_CREDENTIALS (observed in testing), so always launch with
    // a fresh profile directory.
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    const b = await launchChrome({ name: "proxy:" + proxy, port, dir, extraArgs: ["--proxy-server=" + parsed.proxyServer] });
    b.proxy = proxy;
    b.proxyAuth = parsed.auth;
    b.browserKey = key; // exact map key, so a dead proxy browser can be replaced
    browsers.set(key, b);
    log("# proxy browser ready on " + parsed.proxyServer + (b.proxyAuth ? " (auth enabled)" : ""));
    return b;
}

// Ensure the browser is connected, relaunching it if its Chrome process died OR
// its CDP connection is gone/unrecoverable. Any unusable browser is killed and
// replaced so solves never fast-fail on a stale/broken endpoint.
async function ensureBrowserConnected(b, key) {
    if (b.ws && b.ws.readyState === 1) return b;
    let reason = "";
    if (b.proc && b.proc.exitCode !== null) {
        reason = "chrome exited (code " + b.proc.exitCode + ")";
    } else if (b.proc) {
        // Process metadata still says alive, but the CDP connection is gone.
        // Try one direct reconnect; if that fails the browser is unusable
        // (stale exit code, half-dead process, ...) so kill + relaunch it.
        try {
            await b.connect();
            return b;
        } catch (e) {
            reason = "CDP reconnect failed (" + e.message + ")";
        }
    } else {
        reason = "no browser process";
    }
    logErr("# " + b.name + " " + reason + "; relaunching");
    // Kill any surviving process so a zombie can never hold the CDP port or the
    // profile dir's singleton lock for the fresh browser.
    try { if (b.proc && b.proc.exitCode === null) b.proc.kill("SIGKILL"); } catch {}
    if (key === "default") {
        await launchManagedDefaultBrowser();
        return defaultBrowser();
    }
    if (key === "fallback") {
        browsers.delete(key);
        return launchFallbackBrowser();
    }
    const pkey = b.browserKey || key; // "proxy:<sha1>" map key, not the browser name
    browsers.delete(pkey);
    return launchProxyBrowser(b.proxy);
}

// ---------- token-server protocol ----------
// Result packet: [0, requester_id(u32), proxy_len(u8), proxy,
//                token_len(u16), token, error_len(u16), error]
function buildResultPacket(requesterId, proxy, token, error) {
    const enc = new TextEncoder();
    const proxyBytes = enc.encode(proxy || "");
    const tokenBytes = enc.encode(token || "");
    const errorBytes = enc.encode(error || "");
    const pkt = new Uint8Array(6 + proxyBytes.length + 2 + tokenBytes.length + 2 + errorBytes.length);
    pkt[0] = 0;
    const view = new DataView(pkt.buffer);
    view.setUint32(1, requesterId, true);
    pkt[5] = proxyBytes.length;
    let off = 6;
    pkt.set(proxyBytes, off);
    off += proxyBytes.length;
    view.setUint16(off, tokenBytes.length, true);
    off += 2;
    pkt.set(tokenBytes, off);
    off += tokenBytes.length;
    view.setUint16(off, errorBytes.length, true);
    off += 2;
    pkt.set(errorBytes, off);
    return pkt;
}

let solverWs = null;
let solveChain = Promise.resolve();

function queueSolve(fn) {
    const run = solveChain.then(fn, fn);
    solveChain = run.catch(() => {});
    return run;
}

const fallbackHosts = new Set(); // origins Cloudflare serves interactive challenges to in headless

// ---- persisted solver state (fallback-challenged hosts + last solved target) ----
// Lets a restart skip the wasted headless attempt for known-challenged hosts and
// pre-warm the fallback browser so the first solve after boot is already warm.
let solverState = { fallbackHosts: [], lastTarget: null };
function loadState() {
    if (!STATE_FILE) return;
    try {
        const raw = readFileSync(STATE_FILE, "utf8").replace(/^\uFEFF/, ""); // tolerate BOM (PowerShell -Encoding UTF8)
        solverState = JSON.parse(raw);
    } catch {}
    if (!solverState || typeof solverState !== "object") solverState = { fallbackHosts: [], lastTarget: null };
    if (!Array.isArray(solverState.fallbackHosts)) solverState.fallbackHosts = [];
    for (const h of solverState.fallbackHosts) if (typeof h === "string") fallbackHosts.add(h);
}
function saveState() {
    if (!STATE_FILE) return;
    try { writeFileSync(STATE_FILE, JSON.stringify(solverState, null, 2), "utf8"); } catch (e) { logErr("[solver] state save failed:", e.message); }
}

async function handleSolveRequest(requesterId, proxy, fields) {
    const url = (fields.url || "").trim();
    const sitekey = (fields.sitekey || "").trim();
    const action = (fields.action || "").trim();
    // Always-on proxy: when the request omits a proxy, fall back to the
    // configured default so EVERY solve goes through the proxy.
    const effProxy = (proxy || DEFAULT_PROXY).trim();
    const useProxy = !!effProxy;
    log("[solver] solve req " + requesterId + ": url=" + url + " sitekey=" + sitekey + " action=" + (action || "(none)") + " proxy=" + (proxy || "(none)") + (useProxy && !proxy ? " (default proxy on)" : ""));
    let token = null;
    let error = null;
    const worker = (async () => {
        if (!/^https?:\/\//i.test(url)) throw new Error("invalid or missing url field");
        if (!/^[0-3]x[A-Za-z0-9_-]{20,}$/.test(sitekey)) throw new Error("invalid or missing sitekey field");
        let origin = "";
        try { origin = new URL(url).origin; } catch {}
        // Remember the target even if this solve fails, so a restart can pre-warm
        // the proxy browser against the same page.
        solverState.lastTarget = { url, sitekey, action };
        saveState();
        const wantFallback = !useProxy && HEADLESS === "1" && fallbackHosts.has(origin);
        log("[solver] solve " + requesterId + " -> " + (wantFallback ? "FALLBACK (known challenged host)" : (useProxy ? "proxy browser" : "default headless")) + " | known=[" + [...fallbackHosts].join(",") + "]");
        const key = useProxy ? "proxy:" + effProxy : (wantFallback ? "fallback" : "default");
        let b = useProxy ? await launchProxyBrowser(effProxy)
            : wantFallback ? await launchFallbackBrowser() : defaultBrowser();
        b = await ensureBrowserConnected(b, key);
        let out = null;
        try {
            out = await b.lock(async () => {
                await b.ensurePage(url);
                return b.solveTurnstile(sitekey, action);
            });
        } catch (e) {
            // Stale page/session (crashed renderer, dead CDP session, ...).
            // Drop the cached target and retry once with a brand-new page.
            logErr("[solver] solve attempt failed (" + e.message + "); retrying with a fresh page");
            b.targetId = null;
            b.sessionId = null;
            b.widgetKey = "";
            b.prewarmToken = null;
            out = await b.lock(async () => {
                await b.ensurePage(url);
                return b.solveTurnstile(sitekey, action);
            });
        }
        if (!out.ok && !useProxy && HEADLESS === "1" && key !== "fallback" && /timeout/i.test(out.error || "")) {
            // Cloudflare's risk engine challenged the headless fingerprint.
            // Retry once with a visible browser, and remember the host so
            // subsequent requests go straight to the fallback (~13 s) instead of
            // burning the headless poll budget first.
            if (origin) {
                fallbackHosts.add(origin);
                solverState.fallbackHosts = [...fallbackHosts];
                saveState();
            }
            log("[solver] headless solve blocked for " + origin + " (" + out.error + "); trying visible fallback");
            try {
                const fb = await ensureBrowserConnected(await launchFallbackBrowser(), "fallback");
                out = await fb.lock(async () => {
                    await fb.ensurePage(url);
                    return fb.solveTurnstile(sitekey, action);
                });
            } catch (e) {
                logErr("[solver] fallback browser failed:", e.message);
                error = e.message;
            }
        }
        if (out.ok) token = out.token;
        else if (!error) error = out.error;
    })();
    const verdict = await Promise.race([
        worker.then(() => "done").catch((e) => { error = e.message; return "done"; }),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), REQUEST_TIMEOUT_MS)),
    ]);
    if (verdict === "timeout") {
        error = "solve timed out after " + REQUEST_TIMEOUT_MS + " ms (watchdog)";
        // Stale page state: any browser mid-poll must re-prime next time.
        for (const b of browsers.values()) {
            try { b.widgetKey = ""; } catch {}
        }
    }
    if (token) {
        solverState.lastTarget = { url, sitekey, action };
        saveState();
        log("[solver] got token len " + token.length + " for requester " + requesterId);
    }
    else logErr("[solver] solve failed for requester " + requesterId + ": " + error);
    if (solverWs && solverWs.readyState === 1) {
        // Echo the proxy that was actually used (may be the always-on default).
        solverWs.send(buildResultPacket(requesterId, useProxy ? effProxy : proxy || "", token, error));
        log("[solver] result sent", token ? "WITH token" : "FAIL");
    }
}

function onSolverMessage(ev) {
    const data = new Uint8Array(ev.data);
    if (!data.length) return;
    if (data[0] === 1) {
        const proxyLen = data[1];
        const proxy = new TextDecoder().decode(data.slice(2, 2 + proxyLen));
        const view = new DataView(ev.data);
        const requesterId = view.getUint32(2 + proxyLen, true);
        const fields = {};
        let off = 2 + proxyLen + 4;
        while (off < data.length) {
            if (off + 1 > data.length) break;
            const nl = data[off++];
            if (off + nl > data.length) break;
            const name = new TextDecoder().decode(data.slice(off, off + nl));
            off += nl;
            if (off + 1 > data.length) break;
            const vl = data[off++];
            if (off + vl > data.length) break;
            fields[name] = new TextDecoder().decode(data.slice(off, off + vl));
            off += vl;
        }
        queueSolve(() => handleSolveRequest(requesterId, proxy, fields));
    } else {
        log("[solver] ignoring header-" + data[0], "(" + data.length + " bytes)");
    }
}

// Connect to the token server forever: register, then wait for the socket to
// close and retry (survives token-server restarts).
async function connectSolverLoop() {
    while (!shuttingDown) {
        try {
            const ws = await openWs(TOKEN_WS, 6000);
            solverWs = ws;
            ws.binaryType = "arraybuffer";
            ws.send(new Uint8Array([2, ...new TextEncoder().encode(SOLVER_UA)]));
            log("[solver] registered on", TOKEN_WS);
            ws.onmessage = onSolverMessage;
            ws.onerror = () => {};
            await new Promise((resolve) => {
                ws.onclose = () => {
                    log("[solver] token-server connection closed; reconnecting in " + RECONNECT_MS + " ms...");
                    resolve();
                };
            });
            solverWs = null;
        } catch (e) {
            logErr("[solver] ws connect failed: " + TOKEN_WS + " ->", e.message);
        }
        if (!shuttingDown) await sleep(RECONNECT_MS);
    }
}

// ---------- shutdown ----------
function cleanupProcs() {
    for (const b of browsers.values()) {
        try { if (b.proc && b.proc.exitCode === null) b.proc.kill(); } catch {}
    }
}

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    log("[solver] shutting down...");
    try { if (solverWs) solverWs.close(); } catch {}
    cleanupProcs();
    setTimeout(() => process.exit(0), 500);
}

// After boot, if the previous run had to use the visible fallback for a host,
// pre-warm the fallback browser (page + widget) so the first solve after a
// restart is already warm instead of paying launch + navigate + prime + 55s poll.
// Awaited during boot (with a cap) so it can never race a solve on the same page.
async function prewarmFallback() {
    // Pre-warm only on worker 1: every worker prewarming at boot means N extra
    // headful Chrome+page stacks under one container's memory ceiling.
    if (SOLVER_INSTANCE > 1) return;
    const lt = solverState.lastTarget;
    if (!lt || !solverState.fallbackHosts.length) return;
    let origin = "";
    try { origin = new URL(lt.url).origin; } catch {}
    if (!origin || !fallbackHosts.has(origin)) return;
    if (HEADLESS !== "1") return;
    try {
        await Promise.race([
            (async () => {
                const fb = await launchFallbackBrowser();
                await fb.ensurePage(lt.url);
                await fb.ensureTurnstile();
                await fb.primeWidget(lt.sitekey, lt.action);
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("prewarm timed out after " + PREWARM_TIMEOUT_MS + " ms")), PREWARM_TIMEOUT_MS)),
        ]);
        log("[solver] fallback pre-warmed with", lt.url, "sitekey=" + lt.sitekey, "action=" + (lt.action || "(none)"));
    } catch (e) {
        logErr("[solver] fallback pre-warm failed:", e.message);
    }
}

// If an always-on proxy is configured, warm a proxy browser on the last solved
// target at boot (navigate + load turnstile + render the widget) so the first
// request after a restart is already fast. When the target wasn't challenged by
// Cloudflare, the widget is ALSO executed once so a pre-minted token is ready
// before the request even arrives (near-instant first solve).
async function prewarmProxy() {
    if (!DEFAULT_PROXY) return;
    // Same fan-out cap as prewarmFallback: only worker 1 pre-warms a proxy
    // browser at boot, so N workers no longer mean N extra warm Chromes.
    if (SOLVER_INSTANCE > 1) return;
    const lt = solverState.lastTarget;
    if (!lt || !/^https?:\/\//i.test(lt.url)) return;
    try {
        await Promise.race([
            (async () => {
                const b = await launchProxyBrowser(DEFAULT_PROXY);
                const tok = await b.lock(async () => {
                    await b.ensurePage(lt.url);
                    await b.ensureTurnstile();
                    await b.primeWidget(lt.sitekey, lt.action);
                    return b.eval(`(async () => {
                        const S = window.__apiSolver;
                        if (!S || !S.wid) return "";
                        try { turnstile.reset(S.wid); } catch (e) { return ""; }
                        await new Promise(r => setTimeout(r, 250));
                        try { turnstile.execute(S.wid); } catch (e) { return ""; }
                        const t0 = Date.now();
                        while (Date.now() - t0 < 10000) {
                            await new Promise(r => setTimeout(r, 200));
                            try { const t = turnstile.getResponse(S.wid); if (t) return t; } catch (e) {}
                        }
                        return "";
                    })()`).catch(() => "");
                });
                if (tok) {
                    b.prewarmToken = { key: lt.sitekey + "|" + (lt.action || ""), token: tok, at: Date.now() };
                    log("[solver] proxy pre-warmed with a pre-minted token for", lt.url);
                } else {
                    log("[solver] proxy pre-warmed (widget ready, no instant token) for", lt.url);
                }
            })(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("proxy prewarm timed out after " + PREWARM_TIMEOUT_MS + " ms")), PREWARM_TIMEOUT_MS)),
        ]);
    } catch (e) {
        logErr("[solver] proxy pre-warm failed:", e.message);
    }
}

// ---------- boot ----------
(async () => {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("exit", cleanupProcs);
    loadState();
    log("[solver] boot: instance=" + SOLVER_INSTANCE + " headless=" + HEADLESS + " chrome=" + CHROME_PATH + " default_proxy=" + (DEFAULT_PROXY ? "SET" : "none") + " cdp=" + DEFAULT_CDP + " args=" + (CHROME_ARGS_EXTRA.join(" ") || "(none)"));

    if (MANAGE_BROWSER) {
        await launchManagedDefaultBrowser();
    } else {
        // Wait for the external Chrome at CDP_BASE; retry so startup order does not matter.
        while (!shuttingDown) {
            try { await defaultBrowser().connect(); break; }
            catch (e) {
                logErr("# default browser not reachable at", DEFAULT_CDP, "-", e.message, "- retrying in 5s");
                await sleep(5000);
            }
        }
        if (shuttingDown) return;
        log("# connected to default browser at", DEFAULT_CDP);
    }

    connectSolverLoop(); // fire-and-forget; loops until shutdown
    setInterval(() => {
        try { if (solverWs && solverWs.readyState === 1) solverWs.send(new Uint8Array([255])); } catch {}
    }, 15000);
    prewarmProxy(); // fire-and-forget; serialized with solves via the per-browser lock
})().catch((e) => {
    logErr("[solver] boot failed:", e.message);
    process.exit(1);
});

