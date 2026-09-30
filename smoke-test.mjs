// smoke-test.mjs - end-to-end test of the hub + HTTP API without a real browser.
// Start the server first, then:
//   node smoke-test.mjs 8091 1    phase 1 (server with default MAX_INFLIGHT)
//   node smoke-test.mjs 8092 2    phase 2 (server started with MAX_INFLIGHT=1)
// Exits 0 when every check passes, 1 otherwise.
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = process.argv[2] || "8091";
const PHASE = process.argv[3] || "1";
const HTTP = `http://127.0.0.1:${PORT}`;
const HUB = `ws://127.0.0.1:${PORT}`;
const dec = new TextDecoder();
const encT = new TextEncoder();
let failures = 0;

function check(name, cond, extra = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "   [" + extra + "]" : ""}`);
    if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
    const res = await fetch(HTTP + path, { method, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
}

// A fake solver: registers on the hub, answers every request after delayMs.
// Tag "B" answers with an empty token (failure); others answer TOK_<tag>_<rid>.
function startSolver(tag, delayMs) {
    const rec = { tag, ws: null, lastFields: null };
    const ws = new WebSocket(HUB);
    rec.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.on("open", () => ws.send(new Uint8Array([2, ...encT.encode("smoke-ua-" + tag)])));
    ws.on("message", (buf) => {
        const data = new Uint8Array(buf);
        if (data[0] !== 1) return;
        const proxyLen = data[1];
        const rid = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(2 + proxyLen, true);
        let off = 2 + proxyLen + 4;
        const fields = {};
        while (off + 1 < data.length) {
            const nl = data[off++];
            const name = dec.decode(data.subarray(off, off + nl)); off += nl;
            const vl = data[off++];
            fields[name] = dec.decode(data.subarray(off, off + vl)); off += vl;
        }
        if (!fields.url || !fields.sitekey) console.log(`WARN solver ${tag}: fields missing`, fields);
        rec.lastFields = fields;
        setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            const token = encT.encode(tag === "B" ? "" : `TOK_${tag}_${rid}`);
            const pkt = new Uint8Array(6 + token.length); // empty proxy
            pkt[0] = 0;
            new DataView(pkt.buffer).setUint32(1, rid, true);
            pkt[5] = 0;
            pkt.set(token, 6);
            ws.send(pkt);
        }, delayMs);
    });
    return new Promise((resolve, reject) => {
        ws.on("open", () => resolve(rec));
        ws.on("error", reject);
    });
}
const closeSolver = async (s) => { try { (s && s.ws ? s.ws : s).close(); } catch {} await sleep(150); };

// Poll /health until solvers_available === n (gives up after 4s, returns -1).
async function waitForHealth(n) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        try {
            const j = (await api("GET", "/health")).json;
            if (j && j.solvers_available === n) return n;
        } catch {}
        await sleep(120);
    }
    return -1;
}

const VALID = { url: "https://example.com/demo", sitekey: "1x00000000000000000000AA", action: "" };

// PHASE 2 requires the server started with MAX_INFLIGHT=1: a burst of two
// /solve calls must yield exactly one accepted (200) and one 429.
async function phase2() {
    check("p2: health reachable", (await api("GET", "/health")).status === 200);
    const s1 = await startSolver("S1", 700);
    const s2 = await startSolver("S2", 700);
    await sleep(300);
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([api("POST", "/solve", VALID), api("POST", "/solve", VALID)]);
    const elapsed = Date.now() - t0;
    const codes = [r1.status, r2.status].sort((a, b) => a - b);
    check("p2: exactly one 200 + one 429", codes[0] === 200 && codes[1] === 429, `codes=${codes} elapsed=${elapsed}ms`);
    const okRes = r1.status === 200 ? r1 : r2;
    const rejected = r1.status === 429 ? r1 : r2;
    check("p2: accepted request got token", !!okRes.json?.success && String(okRes.json?.token || "").startsWith("TOK_"), okRes.json?.token);
    check("p2: 429 at capacity", rejected.status === 429 && /at capacity/i.test(String(rejected.json?.error)), rejected.json?.error);
    await closeSolver(s1);
    await closeSolver(s2);
    return failures;
}

// PHASE 1: full matrix against a server started with SOLVE_TIMEOUT_MS=1200
// (so the artificially slow solver below trips it) and default MAX_INFLIGHT.
async function phase1() {
    // --- basic routes ---
    const root = await fetch(HTTP + "/");
    const rootText = await root.text();
    check("p1: GET / usage text", root.status === 200 && rootText.includes("Turnstile"), rootText.split("\n")[0]);
    check("p1: 404 unknown path", (await api("GET", "/nope")).status === 404);
    check("p1: health ok with 0 solvers", (await api("GET", "/health")).json?.solvers_available === 0);

    // --- request validation ---
    let r = await api("POST", "/solve", { url: "ftp://x.com", sitekey: VALID.sitekey });
    check("p1: 400 bad url", r.status === 400, r.json?.error);
    r = await api("POST", "/solve", { url: VALID.url, sitekey: "0xshort" });
    check("p1: 400 bad sitekey", r.status === 400, r.json?.error);
    check("p1: 400 invalid JSON", (await fetch(HTTP + "/solve", { method: "POST", body: "{not json" })).status === 400);
    check("p1: 413 body too large", (await fetch(HTTP + "/solve", { method: "POST", body: "x".repeat(70000) })).status === 413);

    // --- no solver connected -> 503 ---
    r = await api("POST", "/solve", VALID);
    check("p1: 503 without solvers", r.status === 503 && r.json?.code === "NO_SOLVERS", r.json?.error);

    // --- API key enforcement on a dedicated instance (PORT+2) ---
    const authPort = String(parseInt(PORT, 10) + 2);
    const here = dirname(fileURLToPath(import.meta.url));
    const authSrv = spawn(process.execPath, [join(here, "server.mjs")], {
        env: { ...process.env, PORT: authPort, API_HOST: "127.0.0.1", API_KEY: "sk-test", SOLVER_INSTANCES: "0" },
        stdio: "ignore",
    });
    await sleep(800);
    const AH = `http://127.0.0.1:${authPort}`;
    const post = (h) => fetch(AH + "/solve", { method: "POST", headers: h, body: JSON.stringify(VALID) });
    check("p1: auth 401 without key", (await post({})).status === 401);
    check("p1: auth 401 wrong key", (await post({ "X-API-Key": "nope" })).status === 401);
    check("p1: auth X-API-Key accepted -> 503 (no solvers)", (await post({ "X-API-Key": "sk-test" })).status === 503);
    check("p1: auth Bearer accepted -> 503", (await post({ Authorization: "Bearer sk-test" })).status === 503);
    authSrv.kill();

    // --- solve flow: empty token -> 502, twice (proves solver returns to pool) ---
    const onlyB = await startSolver("B", 150);
    check("p1: health shows 1 available", (await waitForHealth(1)) === 1);
    r = await api("POST", "/solve", VALID);
    check("p1: 502 on empty token", r.status === 502 && /no token/i.test(String(r.json?.error)), r.json?.error);
    r = await api("POST", "/solve", VALID);
    check("p1: second solve after failure -> 502 not 503 (pool reuse)", r.status === 502, `status=${r.status}`);
    await closeSolver(onlyB);
    check("p1: health back to 0", (await waitForHealth(0)) === 0);

    // --- sequential 200s across a pool of 4 ---
    const pool = [];
    for (const t of ["C", "D", "E", "F"]) pool.push(await startSolver(t, 250));
    check("p1: health 4 after pool connect", (await waitForHealth(4)) === 4);
    r = await api("POST", "/solve", VALID);
    check("p1: 200 with token", r.status === 200 && r.json?.success === true, r.json?.token);
    r = await api("POST", "/solve", VALID);
    check("p1: immediate second solve 200 (concurrency bookkeeping)", r.status === 200 && String(r.json?.token || "").startsWith("TOK_"), r.json?.token);
    const seen = pool.map((s) => s.lastFields).filter(Boolean);
    check("p1: solver received url+sitekey fields", seen.length >= 1 && seen.every((f) => f.url === VALID.url && f.sitekey === VALID.sitekey), `${seen.length} solver(s) saw fields`);
    check("p1: health still 4 (all returned)", (await waitForHealth(4)) === 4);

    // --- parallel burst: 8 solvers, 4 concurrent requests, all must succeed ---
    for (const t of ["G", "H", "I", "J"]) pool.push(await startSolver(t, 1000));
    check("p1: health 8", (await waitForHealth(8)) === 8);
    const burst = await Promise.all([api("POST", "/solve", VALID), api("POST", "/solve", VALID), api("POST", "/solve", VALID), api("POST", "/solve", VALID)]);
    check("p1: 4 parallel solves all 200", burst.every((x) => x.status === 200), burst.map((x) => x.status).join(","));
    const toks = new Set(burst.map((x) => x.json?.token));
    check("p1: parallel tokens distinct", toks.size === 4);
    check("p1: health 8 after burst", (await waitForHealth(8)) === 8);

    // --- timeout: occupy all 8 fast solvers, so the next request can only
    // route to the slow solver K (5s answer > SOLVE_TIMEOUT_MS=1200) -> 504 ---
    const slow = await startSolver("K", 5000);
    check("p1: health 9 with slow solver", (await waitForHealth(9)) === 9);
    const occupyPs = Array.from({ length: 8 }, () => api("POST", "/solve", VALID));
    await sleep(60); // let the hub dispatch all 8 to fast solvers
    const t0 = Date.now();
    r = await api("POST", "/solve", VALID);
    const took = Date.now() - t0;
    const occupy = await Promise.all(occupyPs);
    check("p1: 8 occupied solves all 200", occupy.every((x) => x.status === 200), occupy.map((x) => x.status).join(","));
    check("p1: 504 on timeout", r.status === 504 && r.json?.code === "TIMEOUT", r.json?.error);
    check("p1: timeout honored (~1200ms)", took >= 1150 && took < 2500, `${took}ms`);
    check("p1: health 8 after timeout (slow solver busy)", (await waitForHealth(8)) === 8);

    // --- keepalive [255] is accepted silently (hub case 255 is a no-op) ---
    const ka = pool[0].ws;
    let kaClosed = false;
    ka.on("close", () => { kaClosed = true; });
    ka.send(new Uint8Array([255]));
    await sleep(300);
    check("p1: keepalive [255] accepted, conn alive", !kaClosed && ka.readyState === WebSocket.OPEN);
    check("p1: solver still available after keepalive", (await api("GET", "/health")).json?.solvers_available === 8);

    // --- teardown ---
    await closeSolver(slow);
    for (const s of pool) await closeSolver(s);
    check("p1: health 0 after teardown", (await waitForHealth(0)) === 0);
    return failures;
}

// --- runner ---
const main = async () => {
    console.log(`smoke-test: port ${PORT}, phase ${PHASE}`);
    if (PHASE === "2") await phase2();
    else await phase1();
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
};
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
