// api_server.mjs
// HTTP API that fronts the token-server solve pipeline.
//
//   POST /solve   body: { "sitekey": "0x...", "url": "https://...", "action": "name", "proxy": "http://host:port" }
//                 200 { success, token, solve_ms, url, sitekey, action }
//                 400 bad request | 503 no solvers | 504 timeout | 502 other
//   GET /health   { ok, uptime_ms, busy, ws_state }
//   GET /         usage text
//
// Usage: node api_server.mjs   (binds 127.0.0.1:8082)
// Env:    API_PORT          http port (default 8082)
//         API_HOST          bind address (default 127.0.0.1 - set to 0.0.0.0 to expose)
//         API_KEY           if set, require X-API-Key / Authorization: Bearer <key>
//         TOKEN_SERVER_URL  ws url of the token server (default ws://127.0.0.1:8081)
//         SOLVE_TIMEOUT_MS  per-request solve budget (default 120000)
//         TOKEN_FILE        where to mirror the latest token ("" disables; default ./turnstile_token.txt)

import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = parseInt(process.env.API_PORT || "8082", 10);
const HOST = process.env.API_HOST || "127.0.0.1";
const API_KEY = process.env.API_KEY || "";
const TOKEN_WS = process.env.TOKEN_SERVER_URL || "ws://127.0.0.1:8081";
const SOLVE_TIMEOUT_MS = parseInt(process.env.SOLVE_TIMEOUT_MS || "120000", 10);
const TOKEN_FILE = process.env.TOKEN_FILE === undefined ? join(process.cwd(), "turnstile_token.txt") : process.env.TOKEN_FILE;
const MAX_BODY = 64 * 1024;
const startedAt = Date.now();

let ws = null;
let active = null;   // currently running solve job
let chain = Promise.resolve();
let inFlight = 0;

function buildSolveRequest({ url, sitekey, action, proxy }) {
    const enc = new TextEncoder();
    const proxyB = enc.encode(proxy || "");
    const parts = [1, proxyB.length, ...proxyB, 0]; // ua_len = 0 -> server picks any solver
    const fields = { url, sitekey, action };
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null || String(v) === "") continue;
        const kb = enc.encode(k);
        const vb = enc.encode(String(v));
        parts.push(kb.length, ...kb, vb.length, ...vb);
    }
    return new Uint8Array(parts);
}

function connect() {
    ws = new WebSocket(TOKEN_WS);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => console.log("[api] connected to", TOKEN_WS);
    ws.onmessage = (ev) => {
        const data = new Uint8Array(ev.data);
        if (!data.length) return;
        if (data[0] === 0) {
            const proxyLen = data[1];
            const token = new TextDecoder().decode(data.slice(2 + proxyLen));
            const job = active;
            if (job) {
                clearTimeout(job.timer);
                active = null;
                job.resolve({ token, proxy: new TextDecoder().decode(data.slice(2, 2 + proxyLen)) });
            }
        } else if (data[0] === 2) {
            const job = active;
            if (job) {
                clearTimeout(job.timer);
                active = null;
                job.reject(Object.assign(new Error("no solvers available"), { code: "NO_SOLVERS" }));
            }
        } else {
            console.log("[api] ignoring header-" + data[0], "(" + data.length + " bytes)");
        }
    };
    ws.onclose = () => {
        console.error("[api] token-server connection closed; reconnecting in 2s...");
        if (active) {
            clearTimeout(active.timer);
            active.reject(new Error("token server disconnected"));
            active = null;
        }
        setTimeout(connect, 2000);
    };
    ws.onerror = (e) => console.error("[api] ws error:", e.message || e);
}

function solveOne(req) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== 1) return reject(new Error("token server not connected"));
        const job = { req, resolve, reject, timer: null };
        active = job;
        job.timer = setTimeout(() => {
            active = null;
            reject(Object.assign(new Error("solve timed out after " + SOLVE_TIMEOUT_MS + " ms"), { code: "TIMEOUT" }));
        }, SOLVE_TIMEOUT_MS);
        try {
            ws.send(buildSolveRequest(req));
        } catch (e) {
            active = null;
            clearTimeout(job.timer);
            reject(e);
        }
    });
}

function enqueue(req) {
    inFlight += 1;
    const run = chain.then(async () => {
        try {
            const r = await solveOne(req);
            if (!r.token) {
                return {
                    success: false,
                    error: "solver returned no token (interactive challenge, invalid sitekey, or sitekey not authorized for this domain)",
                    code: "NO_TOKEN",
                };
            }
            return { success: true, token: r.token, proxy: r.proxy };
        } catch (e) {
            return { success: false, error: e.message, code: e.code || "SOLVE_FAILED" };
        } finally {
            inFlight -= 1;
        }
    });
    chain = run.catch(() => {});
    return run;
}

function json(res, status, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(body);
}

const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        });
        return res.end();
    }
    const path = (req.url || "/").split("?")[0];

    if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, uptime_ms: Date.now() - startedAt, busy: inFlight > 0, ws_state: ws ? ws.readyState : -1 });
    }
    if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
        return res.end(
            "Turnstile solve API\n\n" +
            "POST /solve  {\"sitekey\":\"0x...\",\"url\":\"https://...\",\"action\":\"name\",\"proxy\":\"http://host:port\"}\n" +
            "GET  /health\n"
        );
    }
    if (req.method === "POST" && path === "/solve") {
        if (API_KEY) {
            const auth = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
            if (auth !== API_KEY) return json(res, 401, { success: false, error: "unauthorized" });
        }
        let body = "";
        let tooBig = false;
        for await (const chunk of req) {
            body += chunk;
            if (body.length > MAX_BODY) { tooBig = true; break; }
        }
        // NOTE: do not req.destroy() here - it kills the socket before the
        // 413 response can be flushed. Breaking out of the read loop and
        // responding normally lets Node close the connection after the reply.
        if (tooBig) return json(res, 413, { success: false, error: "request body too large" });
        let data;
        try { data = JSON.parse(body); } catch { return json(res, 400, { success: false, error: "invalid JSON body" }); }
        const sitekey = String(data.sitekey || "").trim();
        const target = String(data.url || "").trim();
        const action = String(data.action || "").trim();
        const proxy = String(data.proxy || "").trim() || undefined;
        if (!/^https?:\/\//i.test(target)) return json(res, 400, { success: false, error: "url must start with http:// or https://" });
        if (!/^0x[A-Za-z0-9_-]{20,}$/.test(sitekey)) return json(res, 400, { success: false, error: "sitekey must be a valid 0x... Turnstile sitekey" });
        const t0 = Date.now();
        const result = await enqueue({ url: target, sitekey, action, proxy });
        result.solve_ms = Date.now() - t0;
        result.url = target;
        result.sitekey = sitekey;
        result.action = action;
        const status = result.success && result.token ? 200 : result.code === "NO_SOLVERS" ? 503 : result.code === "TIMEOUT" ? 504 : 502;
        console.log("[api] POST /solve " + (status === 200 ? "OK " + result.solve_ms + "ms" : "HTTP " + status + " " + (result.code || "FAIL")) + " url=" + target);
        if (status === 200 && TOKEN_FILE) {
            try { writeFileSync(TOKEN_FILE, result.token, "utf8"); } catch {}
        }
        return json(res, status, result);
    }
    return json(res, 404, { success: false, error: "not found" });
});

server.listen(PORT, HOST, () => console.log("[api] Turnstile solve API listening on http://" + HOST + ":" + PORT));
connect();

