// .tmp-rdiag.mjs - Railway failure isolation:
//  P1: test sitekey, NO proxy   -> validates Chrome/widget mechanics on Railway
//  P2: test sitekey, WITH proxy -> validates proxy reachability from Railway
//  P3: real capskip key, WITH proxy -> the actual target (only if P1+P2 pass)
const BASE = "https://cloudflare-turnstile-solver-2026-production-59c3.up.railway.app";
const PROXY = "202.28.17.5:8080:s6103021621234:frank100258";
const TESTKEY = "1x00000000000000000000AA"; // Cloudflare always-passing test key

async function health() {
    try { return await fetch(BASE + "/health", { signal: AbortSignal.timeout(15000) }).then(r => r.json()); }
    catch (e) { return { error: e.message }; }
}
async function solve(label, body) {
    const t0 = Date.now();
    try {
        const r = await fetch(BASE + "/solve", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(150000),
        });
        const j = await r.json().catch(() => ({ parse_fail: true }));
        console.log(`${label}: HTTP ${r.status} in ${Date.now() - t0} ms ->`, JSON.stringify({
            success: j.success, error: j.error, solve_ms: j.solve_ms,
            token: j.token ? j.token.slice(0, 40) + `...(${j.token.length})` : undefined,
        }));
        return j;
    } catch (e) { console.log(`${label}: FETCH ERROR after ${Date.now() - t0} ms:`, e.message); return {}; }
}

console.log("HEALTH-PRE:", JSON.stringify(await health()));
const p1 = await solve("P1 testkey/noproxy ", { sitekey: TESTKEY, url: "https://example.com/protected" });
const p2 = await solve("P2 testkey/proxy   ", { sitekey: TESTKEY, url: "https://example.com/protected", proxy: PROXY });
let p3 = null;
if (p1.success && p2.success) {
    p3 = await solve("P3 capskip/proxy   ", {
        sitekey: "0x4AAAAAADogn3t3_JKwKkgS", action: "example_action",
        url: "https://capskip.com/captcha-demo/cloudflare-turnstile/", proxy: PROXY,
    });
} else console.log("P3 skipped (P1 or P2 failed).");
console.log("HEALTH-POST:", JSON.stringify(await health()));
