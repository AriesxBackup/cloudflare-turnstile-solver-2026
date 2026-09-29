// cdp_solver.mjs
// Token-server solver that mints Turnstile tokens for ANY domain-authorized
// sitekey by driving a real Chrome via CDP. The solve parameters arrive in the
// header-1 forward packet as fields: url, sitekey, action. An optional proxy
// field lazily launches a dedicated Chrome configured with --proxy-server.
//
// Protocol (see cf-turnstile-bypass/token-server/src/main.rs):
//   register: [2, ...ua_bytes]
//   request:  [1, proxy_len(u8), ...proxy, requester_id(u32 LE),
//              (name_len(u8), ...name, value_len(u8), ...value)*]
//   result:   [0, requester_id(u32 LE), proxy_len(u8), ...proxy, ...token]
//
// Usage: node cdp_solver.mjs
// Env:    CDP_BASE         default Chrome debugging endpoint (default http://127.0.0.1:9222)
//         TOKEN_SERVER_URL ws url of the token server (default ws://127.0.0.1:8081)
//         CHROME_PATH      chrome executable for proxy instances
//         SOLVE_TIMEOUT_MS per-solve poll budget in the page (default 55000)
//         NAV_TIMEOUT_MS   page navigation budget (default 45000)
//         HEADLESS         "1" runs spawned Chrome headless (default 1; "0" = visible)
//         MANAGE_BROWSER   "1" lets the solver launch+own its own Chrome at CDP_BASE
//         REQUEST_TIMEOUT_MS whole-request watchdog budget (default 110000)
//         RECONNECT_MS     token-server reconnect delay (default 3000)
//
// Production notes:
//   * Survives token-server restarts: reconnects and re-registers automatically.
//   * Boot retries (browser + ws) instead of exiting, so startup order does not matter.
//   * SIGINT/SIGTERM (or process 'exit') kill all spawned Chrome instances.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const __dir = dirname(fileURLToPath(import.meta.url));
const TOKEN_WS = process.env.TOKEN_SERVER_URL || "ws://127.0.0.1:8081";
const DEFAULT_CDP = process.env.CDP_BASE || "http://127.0.0.1:9222";
const SOLVE_TIMEOUT_MS = parseInt(process.env.SOLVE_TIMEOUT_MS || "55000", 10);
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || "45000", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "110000", 10);
const RECONNECT_MS = parseInt(process.env.RECONNECT_MS || "3000", 10);
const HEADLESS = process.env.HEADLESS === undefined ? "1" : process.env.HEADLESS;
const MANAGE_BROWSER = process.env.MANAGE_BROWSER === "1";
const CHROME_PATH = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SOLVER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const TURNSTILE_JS = "https://challenges.cloudflare.com/turnstile/api.js?render=explicit";
const MANAGED_PROFILE_DIR = join(__dir, ".chrome-solver-default");

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
    }

    async connect() {
        if (this.ws && this.ws.readyState === 1) return this;
        const ver = await fetch(this.cdpBase + "/json/version").then((r) => r.json());
        this.ws = await openWs(ver.webSocketDebuggerUrl);
        this.ws.onmessage = (ev) => {
            const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
            let msg;
            try { msg = JSON.parse(raw); } catch { return; }
            if (msg.id && this.pending.has(msg.id)) {
                const p = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
            }
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

    async ensurePage(url) {
        const { targetInfos } = await this.send("Target.getTargets", {}, false);
        let t = targetInfos.find((x) => x.type === "page" && x.url.startsWith("http"));
        if (!t) {
            const { targetId } = await this.send("Target.createTarget", { url: "about:blank" }, false);
            t = { targetId, url: "about:blank", title: "" };
        }
        if (this.targetId !== t.targetId) {
            this.targetId = t.targetId;
            const { sessionId } = await this.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }, false);
            this.sessionId = sessionId;
            this.widgetKey = "";
            await this.send("Page.enable", {}).catch(() => {});
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
            await sleep(500);
            const state = await this.eval("({ready: document.readyState, href: location.href})").catch(() => null);
            if (state && state.ready === "complete" && /^https?:/i.test(state.href)) { ok = true; break; }
        }
        if (!ok) throw new Error("navigation to " + url + " did not complete");
        await sleep(1500); // let page scripts initialize
        this.widgetKey = ""; // new document -> any cached widget is gone
        this.pageUrl = await this.eval("location.href").catch(() => url);
    }

    isSameTarget(a, b) {
        const norm = (u) => {
            try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ""); }
            catch { return u.replace(/\/+$/, ""); }
        };
        return /^https?:/i.test(a) && norm(a) === norm(b);
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
        await this.ensureTurnstile();
        await this.primeWidget(sitekey, action);
        const out = await this.eval(`(async () => {
            const S = window.__apiSolver;
            if (!S || !S.wid) return { ok: false, error: 'widget not found' };
            try { turnstile.reset(S.wid); } catch (e) { return { ok: false, error: 'reset: ' + e.message }; }
            await new Promise(r => setTimeout(r, 800));
            try { turnstile.execute(S.wid); } catch (e) { return { ok: false, error: 'execute: ' + e.message }; }
            const t0 = Date.now();
            while (Date.now() - t0 < ${SOLVE_TIMEOUT_MS}) {
                await new Promise(r => setTimeout(r, 400));
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
        "--remote-allow-origins=*",
        ...(useHeadless ? ["--headless=new", "--hide-scrollbars"] : []),
        ...extraArgs,
        "about:blank",
    ];
    mkdirSync(dir, { recursive: true });
    log("# launching Chrome (" + (useHeadless ? "headless" : "visible") + ") on port " + port);
    const proc = spawn(CHROME_PATH, args, { stdio: "ignore", windowsHide: true });
    proc.on("error", (e) => logErr("# chrome spawn error:", e.message));
    const base = "http://127.0.0.1:" + port;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
        try { if ((await fetch(base + "/json/version")).ok) break; } catch {}
        await sleep(400);
    }
    const b = new CdpBrowser(name, base);
    b.proc = proc;
    await b.connect();
    return b;
}

async function launchManagedDefaultBrowser() {
    const port = new URL(DEFAULT_CDP).port || 9222;
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
    const port = nextPort();
    const dir = join(__dir, ".chrome-solver-fallback");
    const b = await launchChrome({ name: "fallback", port, dir, extraArgs: [], headless: false });
    browsers.set(key, b);
    log("# visible fallback browser ready on http://127.0.0.1:" + port);
    return b;
}

async function launchProxyBrowser(proxy) {
    const key = "proxy:" + createHash("sha1").update(proxy).digest("hex").slice(0, 12);
    if (browsers.has(key)) return browsers.get(key);
    const port = nextPort();
    const dir = join(__dir, "cf-turnstile-bypass", "browser_launcher", "browser_profiles", "proxy_" + key.slice(6));
    const b = await launchChrome({ name: "proxy:" + proxy, port, dir, extraArgs: ["--proxy-server=" + proxy] });
    b.proxy = proxy;
    browsers.set(key, b);
    log("# proxy browser ready on http://127.0.0.1:" + port);
    return b;
}

// Ensure the browser is connected, relaunching it if its Chrome process died.
async function ensureBrowserConnected(b, key) {
    if (b.ws && b.ws.readyState === 1) return b;
    if (b.proc && b.proc.exitCode !== null) {
        logErr("# " + b.name + " chrome exited (code " + b.proc.exitCode + "); relaunching");
        if (key === "default") {
            await launchManagedDefaultBrowser();
            return defaultBrowser();
        }
        if (key === "fallback") {
            browsers.delete(key);
            return launchFallbackBrowser();
        }
        browsers.delete(key);
        return launchProxyBrowser(b.proxy);
    }
    await b.connect(); // throws if the endpoint is unreachable
    return b;
}

// ---------- token-server protocol ----------
function buildResultPacket(requesterId, proxy, token) {
    const enc = new TextEncoder();
    const proxyBytes = enc.encode(proxy || "");
    const tokenBytes = enc.encode(token || "");
    const pkt = new Uint8Array(6 + proxyBytes.length + tokenBytes.length);
    pkt[0] = 0;
    new DataView(pkt.buffer).setUint32(1, requesterId, true);
    pkt[5] = proxyBytes.length;
    pkt.set(proxyBytes, 6);
    pkt.set(tokenBytes, 6 + proxyBytes.length);
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

async function handleSolveRequest(requesterId, proxy, fields) {
    const url = (fields.url || "").trim();
    const sitekey = (fields.sitekey || "").trim();
    const action = (fields.action || "").trim();
    log("[solver] solve req " + requesterId + ": url=" + url + " sitekey=" + sitekey + " action=" + (action || "(none)") + " proxy=" + (proxy || "(none)"));
    let token = null;
    let error = null;
    const worker = (async () => {
        if (!/^https?:\/\//i.test(url)) throw new Error("invalid or missing url field");
        if (!/^0x[A-Za-z0-9_-]{20,}$/.test(sitekey)) throw new Error("invalid or missing sitekey field");
        let origin = "";
        try { origin = new URL(url).origin; } catch {}
        const wantFallback = !proxy && HEADLESS === "1" && fallbackHosts.has(origin);
        const key = proxy ? "proxy:" + proxy : (wantFallback ? "fallback" : "default");
        let b = proxy ? await launchProxyBrowser(proxy)
            : wantFallback ? await launchFallbackBrowser() : defaultBrowser();
        b = await ensureBrowserConnected(b, key);
        await b.ensurePage(url);
        let out = await b.solveTurnstile(sitekey, action);
        if (!out.ok && !proxy && HEADLESS === "1" && /timeout/i.test(out.error || "")) {
            // Cloudflare's risk engine challenged the headless fingerprint.
            // Retry once with a visible browser, and remember the host so
            // subsequent requests go straight to the fallback (~13 s) instead of
            // burning the headless poll budget first.
            if (origin) fallbackHosts.add(origin);
            log("[solver] headless solve blocked for " + origin + " (" + out.error + "); trying visible fallback");
            try {
                const fb = await ensureBrowserConnected(await launchFallbackBrowser(), "fallback");
                await fb.ensurePage(url);
                out = await fb.solveTurnstile(sitekey, action);
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
        try { defaultBrowser().widgetKey = ""; } catch {} // stale page state; next request re-primes
    }
    if (token) log("[solver] got token len " + token.length + " for requester " + requesterId);
    else logErr("[solver] solve failed for requester " + requesterId + ": " + error);
    if (solverWs && solverWs.readyState === 1) {
        solverWs.send(buildResultPacket(requesterId, proxy || "", token));
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

// ---------- boot ----------
(async () => {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("exit", cleanupProcs);

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
})().catch((e) => {
    logErr("[solver] boot failed:", e.message);
    process.exit(1);
});

