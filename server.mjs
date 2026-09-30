// server.mjs - all-in-one Turnstile solve service.
// One Node process runs the WebSocket hub, the HTTP API and (optionally) a
// pool of real-Chrome solver workers. Deployable on Railway, Fly, Docker or
// bare metal (requires Node >= 22).
//
//   HTTP API   POST /solve   GET /health   GET /        (binds $PORT, default 8082)
//   WS hub     accepts WebSocket upgrades on any path (solvers + custom clients)
//   Workers    SOLVER_INSTANCES child `node solver.mjs` processes, auto-restarted
//
// Hub wire protocol (binary frames; little-endian u32s; byte-compatible with
// the original Rust token-server so existing workers/clients keep working):
//   requester->hub  [1, proxy_len(u8), proxy, (nlen,name,vlen,val)*]
//   hub->solver     [1, proxy_len(u8), proxy, requester_id(u32), (nlen,name,vlen,val)*]
//   solver->hub     [0, requester_id(u32), proxy_len(u8), proxy, token]
//   hub->requester  [0, proxy_len(u8), proxy, token]      (empty token = failed)
//   hub->requester  [2]                                   (no solver available)
//   requester->hub  [3]  -> hub answers [3, available(u32)]
//   solver->hub     [2, ...ua]        register as solver under a user-agent bucket
//   any->hub        [255]             keepalive no-op
//
// Env (hub/API):
//   PORT / API_PORT    http port (default 8082; Railway injects PORT)
//   API_HOST           bind address (default 0.0.0.0 on Railway, else 127.0.0.1)
//   API_KEY            if set, POST /solve requires X-API-Key or Bearer token
//   SOLVE_TIMEOUT_MS   per-request solve budget (default 120000)
//   MAX_INFLIGHT       concurrent /solve requests (default 32; 429 beyond)
//   SOLVER_INSTANCES   solver workers to spawn (default 1; 0 = hub+API only)
//   CDP_PORT_BASE      worker i gets Chrome CDP port base+i (default 9230)
//   FALLBACK_CDP_PORT_BASE  worker i visible-fallback port base+i (default 9329)
// Worker env (solver.mjs) is documented in the README.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { WebSocketServer } from "ws";

const __dir = dirname(fileURLToPath(import.meta.url));
const VERSION = "1.0.0";

const PORT = parseInt(process.env.PORT || process.env.API_PORT || "8082", 10);
const HOST = process.env.API_HOST || (process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1");
const API_KEY = process.env.API_KEY || "";
const SOLVE_TIMEOUT_MS = parseInt(process.env.SOLVE_TIMEOUT_MS || "120000", 10);
const MAX_INFLIGHT = Math.max(1, parseInt(process.env.MAX_INFLIGHT || "32", 10) || 32);
const SOLVER_INSTANCES = Math.max(0, parseInt(process.env.SOLVER_INSTANCES === undefined ? "1" : process.env.SOLVER_INSTANCES, 10) || 0);
const CDP_PORT_BASE = parseInt(process.env.CDP_PORT_BASE || "9230", 10);
const FALLBACK_CDP_PORT_BASE = parseInt(process.env.FALLBACK_CDP_PORT_BASE || "9329", 10);
const STATE_DIR = join(__dir, ".state");
const MAX_BODY = 64 * 1024;
const startedAt = Date.now();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const logErr = (...a) => console.error(new Date().toISOString(), ...a);
const enc = new TextEncoder();
const dec = new TextDecoder();
let shuttingDown = false;
let inflight = 0;

// ---------------------------------------------------------------- hub state
const connections = new Map();   // id -> conn { send(Uint8Array) }
const solverToUa = new Map();    // solver id -> user-agent bucket
const availableByUa = new Map(); // ua -> Set<solver id> (free solvers)
let nextId = 1;

function countAvailable() {
    let n = 0;
    for (const q of availableByUa.values()) n += q.size;
    return n;
}

function unregister(id) {
    connections.delete(id);
    const ua = solverToUa.get(id);
    if (ua !== undefined) {
        solverToUa.delete(id);
        const q = availableByUa.get(ua);
        if (q) { q.delete(id); if (q.size === 0) availableByUa.delete(ua); }
    }
}

// Take the next free solver from a bucket (or any bucket), marking it busy.
function pickSolver(uaWanted) {
    const take = (ua) => {
        const q = availableByUa.get(ua);
        if (!q || q.size === 0) return undefined;
        const id = q.values().next().value;
        q.delete(id);
        return id;
    };
    if (uaWanted) return take(uaWanted) ?? null;
    for (const ua of availableByUa.keys()) {
        const id = take(ua);
        if (id !== undefined) return id;
    }
    return null;
}

// Dispatch a requester packet [1, proxy_len, proxy, fields...] to a free
// solver with the requester id injected after the proxy (hub->solver):
// [1, proxy_len, proxy, requester_id(u32), fields...]
function dispatchRequest(conn, pkt) {
    if (pkt.length < 2 || pkt[0] !== 1) return;
    const proxyLen = pkt[1];
    const head = pkt.subarray(0, 2 + proxyLen); // [1, proxy_len, proxy]
    const rest = pkt.subarray(2 + proxyLen);    // fields...
    const solverId = pickSolver(null);
    if (solverId === null) return conn.send(new Uint8Array([2])); // no solver free
    const sconn = connections.get(solverId);
    if (!sconn) { unregister(solverId); return conn.send(new Uint8Array([2])); }
    const out = new Uint8Array(head.length + 4 + rest.length);
    out.set(head, 0);
    new DataView(out.buffer).setUint32(head.length, conn.id >>> 0, true);
    out.set(rest, head.length + 4);
    sconn.send(out);
}

// Handle one binary hub message from any connection (protocol in file header).
function handleHubMessage(conn, data) {
    const pkt = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (pkt.length === 0) return;
    switch (pkt[0]) {
        case 255: // keepalive no-op
            return;
        case 1: // solve request
            return dispatchRequest(conn, pkt);
        case 3: { // query free-solver count -> [3, available(u32)]
            const out = new Uint8Array(5);
            out[0] = 3;
            new DataView(out.buffer).setUint32(1, countAvailable(), true);
            return conn.send(out);
        }
        case 0: { // solver result: [0, requester_id(u32), proxy_len, proxy, token]
            if (pkt.length < 5) return;
            const rid = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength).getUint32(1, true);
            const rconn = connections.get(rid);
            if (rconn) {
                // Forward as [0, proxy_len, proxy, token]: keep the type byte,
                // drop only the 4 requester_id bytes the hub injected.
                const resp = new Uint8Array(pkt.length - 4);
                resp[0] = 0;
                resp.set(pkt.subarray(5), 1);
                rconn.send(resp);
            }
            // The solver is done with that job: put it back in the free pool
            // (idempotent - it stays registered under its UA bucket).
            const sua = solverToUa.get(conn.id);
            if (sua !== undefined) {
                let q = availableByUa.get(sua);
                if (!q) { q = new Set(); availableByUa.set(sua, q); }
                q.add(conn.id);
            }
            return;
        }
        case 2: { // solver registration: [2, ...user-agent]
            const ua = dec.decode(pkt.subarray(1)).trim().toLowerCase();
            if (!ua) return;
            solverToUa.set(conn.id, ua);
            if (!availableByUa.has(ua)) availableByUa.set(ua, new Set());
            availableByUa.get(ua).add(conn.id);
            log(`[hub] solver ${conn.id} registered (ua=${ua.slice(0, 48)}); available=${countAvailable()}`);
            return;
        }
        default:
            return;
    }
}

// ---------------------------------------------------- in-process requester
// Build the requester->hub request packet.
// [1, proxy_len(u8), proxy, (nlen,name,vlen,val)*]
function buildRequestPacket(proxy, fields) {
    const pb = enc.encode(proxy || "");
    const chunks = [[1], [pb.length], pb];
    for (const [k, v] of Object.entries(fields || {})) {
        if (v === undefined || v === null || String(v) === "") continue;
        const kb = enc.encode(k);
        const vb = enc.encode(String(v));
        if (kb.length > 255 || vb.length > 255) continue; // u8 length limit
        chunks.push([kb.length], kb, [vb.length], vb);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pkt = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { pkt.set(c, off); off += c.length; }
    return pkt;
}

// Run one solve through the hub as a virtual requester. Every call registers
// its own requester id, so any number of solves can be in flight at once -
// the hub hands each one a free solver. (This replaces the old single-
// connection API that serialized every /solve behind one shared socket.)
function hubRequestSolve({ proxy, fields }, timeoutMs) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        let done = false;
        const finish = (fn, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unregister(id);
            fn(value);
        };
        const conn = {
            id,
            send: (pkt) => {
                if (!pkt || pkt.length === 0) return;
                if (pkt[0] === 2) return finish(reject, Object.assign(new Error("no solvers available"), { code: "NO_SOLVERS" }));
                if (pkt[0] !== 0) return;
                const proxyLen = pkt[1];
                const proxyEcho = dec.decode(pkt.subarray(2, 2 + proxyLen));
                const token = pkt.length > 2 + proxyLen ? dec.decode(pkt.subarray(2 + proxyLen)) : "";
                finish(resolve, { success: token.length > 0, token, proxy: proxyEcho });
            },
        };
        const timer = setTimeout(
            () => finish(reject, Object.assign(new Error(`solve timed out after ${timeoutMs} ms`), { code: "TIMEOUT" })),
            timeoutMs,
        );
        connections.set(id, conn);
        dispatchRequest(conn, buildRequestPacket(proxy, fields));
    });
}

// ------------------------------------------------------------------- WS hub
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

wss.on("connection", (ws) => {
    const id = nextId++;
    const conn = {
        id,
        send: (pkt) => { if (ws.readyState === ws.OPEN) { try { ws.send(pkt, { binary: true }); } catch {} } },
    };
    connections.set(id, conn);
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (data, isBinary) => { if (isBinary) handleHubMessage(conn, data); });
    ws.on("close", () => { unregister(id); log(`[hub] conn ${id} closed; available=${countAvailable()}`); });
    ws.on("error", () => {});
    log(`[hub] conn ${id} opened (total ${wss.clients.size})`);
});

// Terminate dead sockets (no pong within one interval).
setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch {}
    }
}, 30000).unref();

// ---------------------------------------------------------------- HTTP API
function json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
    });
    res.end(body);
}

async function readBody(req, cap) {
    let body = "";
    let over = false;
    for await (const chunk of req) {
        body += chunk;
        if (body.length > cap) { over = true; break; }
        // NOTE: no req.destroy() here - it kills the socket before the 413
        // response can be flushed. Break and respond normally instead.
    }
    return { body, over };
}

const USAGE = `Turnstile solve service v${VERSION}

POST /solve  {"sitekey":"0x...","url":"https://...","action":"name","proxy":"http://host:port"}
             -> 200 {"success":true,"token":"...","solve_ms":1234,...}
GET  /health -> {"ok":true,"solvers_available":N,...}
GET  /       -> this text
`;

const server = createServer(async (req, res) => {
    try {
        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
            });
            return res.end();
        }
        const path = (req.url || "/").split("?")[0];

        if (req.method === "GET" && path === "/health") {
            return json(res, 200, {
                ok: true,
                version: VERSION,
                uptime_ms: Date.now() - startedAt,
                inflight,
                max_inflight: MAX_INFLIGHT,
                solvers_available: countAvailable(),
                solver_instances: SOLVER_INSTANCES,
                shutting_down: shuttingDown,
            });
        }
        if (req.method === "GET" && path === "/") {
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
            return res.end(USAGE);
        }
        if (req.method === "POST" && path === "/solve") return handleSolve(req, res);
        return json(res, 404, { success: false, error: "not found" });
    } catch (e) {
        logErr("[api] handler error:", e.message);
        if (!res.headersSent) json(res, 500, { success: false, error: "internal error" });
        else res.end();
    }
});

async function handleSolve(req, res) {
    if (API_KEY) {
        const auth = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (auth !== API_KEY) return json(res, 401, { success: false, error: "unauthorized" });
    }
    const { body, over } = await readBody(req, MAX_BODY);
    if (over) return json(res, 413, { success: false, error: "request body too large" });
    let data;
    try { data = JSON.parse(body); } catch { return json(res, 400, { success: false, error: "invalid JSON body" }); }
    const url = String(data.url || "").trim();
    const sitekey = String(data.sitekey || "").trim();
    const action = String(data.action || "").trim();
    const proxy = String(data.proxy || "").trim();
    if (!/^https?:\/\//i.test(url)) return json(res, 400, { success: false, error: "url must start with http:// or https://" });
    if (!/^[0-3]x[A-Za-z0-9_-]{20,}$/.test(sitekey)) return json(res, 400, { success: false, error: "sitekey must be a valid Turnstile sitekey (0x... real, 1x/2x/3x test keys)" });
    if (inflight >= MAX_INFLIGHT) return json(res, 429, { success: false, error: `server at capacity (${MAX_INFLIGHT} in flight); retry`, code: "AT_CAPACITY" });

    inflight++;
    const t0 = Date.now();
    try {
        const result = await hubRequestSolve({ proxy, fields: { url, sitekey, action } }, SOLVE_TIMEOUT_MS);
        const solve_ms = Date.now() - t0;
        if (result.success && result.token) {
            log(`[api] POST /solve OK ${solve_ms}ms url=${url}${action ? " action=" + action : ""}`);
            return json(res, 200, { success: true, token: result.token, solve_ms, url, sitekey, action: action || undefined, proxy: result.proxy || undefined });
        }
        log(`[api] POST /solve FAIL ${solve_ms}ms (empty token) url=${url}`);
        return json(res, 502, { success: false, error: "solver returned no token", solve_ms, url, sitekey });
    } catch (e) {
        const solve_ms = Date.now() - t0;
        const status = e.code === "TIMEOUT" ? 504 : e.code === "NO_SOLVERS" ? 503 : 500;
        logErr(`[api] POST /solve HTTP ${status} ${solve_ms}ms url=${url}: ${e.message}`);
        return json(res, status, { success: false, error: e.message, code: e.code || "ERROR", solve_ms, url, sitekey });
    } finally {
        inflight--;
    }
}

// WebSocket upgrades on any path are the hub endpoint (solvers + clients).
server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// --------------------------------------------------------- solver workers
const children = new Map(); // instance number -> ChildProcess

function spawnSolver(i) {
    if (shuttingDown || children.has(i)) return;
    const env = { ...process.env };
    env.TOKEN_SERVER_URL = `ws://127.0.0.1:${PORT}`;
    env.SOLVER_STATE_FILE = join(STATE_DIR, `solver-${i}.json`);
    // An explicit CDP_BASE is honored as-is only when a single worker is configured.
    if (!(SOLVER_INSTANCES === 1 && process.env.CDP_BASE)) {
        env.CDP_BASE = `http://127.0.0.1:${CDP_PORT_BASE + i}`;
    }
    env.FALLBACK_CDP_PORT = String(FALLBACK_CDP_PORT_BASE + i);
    const child = spawn(process.execPath, [join(__dir, "solver.mjs")], { env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    children.set(i, child);
    log(`[svc] solver worker ${i} started (pid ${child.pid})`);
    child.on("exit", (code, sig) => {
        children.delete(i);
        if (shuttingDown) return;
        logErr(`[svc] solver worker ${i} exited (${sig || code}); restarting in 3s`);
        setTimeout(() => spawnSolver(i), 3000);
    });
}

// ---------------------------------------------------------------- shutdown
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[svc] ${signal} received; shutting down...`);
    try { server.close(); } catch {}
    for (const ws of wss.clients) { try { ws.close(1001, "server shutting down"); } catch {} }
    for (const child of children.values()) { try { child.kill("SIGTERM"); } catch {} }
    setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { for (const child of children.values()) { try { child.kill("SIGTERM"); } catch {} } });

// -------------------------------------------------------------------- boot
mkdirSync(STATE_DIR, { recursive: true });
server.listen(PORT, HOST, () => {
    log(`[svc] turnstile solver service v${VERSION} listening on http://${HOST}:${PORT}`);
    log(`[svc] POST /solve | GET /health | hub ws (any path) | workers=${SOLVER_INSTANCES}`);
});
for (let i = 1; i <= SOLVER_INSTANCES; i++) spawnSolver(i);
