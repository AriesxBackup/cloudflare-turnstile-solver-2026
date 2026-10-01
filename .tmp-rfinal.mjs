// TEMP: final Railway validation - P1/P2/P3 + server-side verify of P3 token
const B = "https://cloudflare-turnstile-solver-2026-production-59c3.up.railway.app";
const TESTKEY = "1x00000000000000000000AA";
const K = "0x4AAAAAADogn3t3_JKwKkgS", U = "https://capskip.com/captcha-demo/cloudflare-turnstile/", A = "example_action";
const PROXY = "202.28.17.5:8080:s6103021621234:frank100258";

const health = async (label) => {
    try {
        const j = await fetch(B + "/health", { signal: AbortSignal.timeout(15000) }).then(r => r.json());
        console.log(label, JSON.stringify(j));
        return j;
    } catch (e) { console.log(label, "UNREACHABLE:", e.message); return null; }
};
const solve = async (label, body) => {
    const t0 = Date.now();
    try {
        const r = await fetch(B + "/solve", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(140000)
        });
        const j = await r.json().catch(() => ({}));
        console.log(`${label}: HTTP ${r.status} in ${Date.now() - t0} ms ->`, JSON.stringify({
            success: j.success, solve_ms: j.solve_ms, error: j.error,
            token: j.token ? j.token.slice(0, 30) + "...(" + j.token.length + ")" : undefined
        }));
        return j;
    } catch (e) { console.log(`${label}: FETCH ERR after ${Date.now() - t0} ms:`, e.message); return {}; }
};

await health("HEALTH-PRE:");
const p1 = await solve("P1 testkey/noproxy", { sitekey: TESTKEY, url: "https://example.com/" });
const p2 = await solve("P2 testkey/proxy  ", { sitekey: TESTKEY, url: "https://example.com/", proxy: PROXY });
const p3 = await solve("P3 capskip/proxy  ", { sitekey: K, url: U, action: A, proxy: PROXY });
await health("HEALTH-POST:");

if (p3.token) {
    const html = await fetch(U, { signal: AbortSignal.timeout(30000) }).then(r => r.text());
    const nonce = html.match(/"nonce":"([^"]+)"/)?.[1];
    console.log("capskip nonce:", nonce ? nonce.slice(0, 8) + "..." : "NOT FOUND");
    const v = await fetch("https://capskip.com/wp-admin/admin-ajax.php", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "capskip_captcha_verify", nonce, provider: "turnstile", token: p3.token }).toString(),
        signal: AbortSignal.timeout(30000)
    }).then(r => r.json()).catch(e => ({ fetch_error: e.message }));
    const d = v?.data || {};
    console.log("P3 SERVER-SIDE VERIFY:", JSON.stringify({ success: v.success, verified: d.verified, server: d.server, message: d.message, action: d.result?.action, hostname: d.result?.hostname }));
    console.log(v.success && d.verified ? ">>> RAILWAY END-TO-END: PASS" : ">>> RAILWAY END-TO-END: FAIL");
} else {
    console.log(">>> P3 produced no token - skipping verify");
}
