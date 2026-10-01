// TEMP: Docker repro v3 - proxy path: capskip solve through 202.28.17.5 proxy
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const say = (s) => console.log(s);
const B = "http://127.0.0.1:18082";
const P = "202.28.17.5:8080:s6103021621234:frank100258";
const solve = async (label, body, ms = 120000) => {
    const t0 = Date.now();
    try {
        const r = await fetch(B + "/solve", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(ms)
        });
        const j = await r.json().catch(() => ({}));
        say(`${label}: HTTP ${r.status} in ${Date.now() - t0} ms solve_ms=${j.solve_ms}` + (j.token ? ` token_len=${j.token.length}` : ` error=${JSON.stringify(j.error)}`));
        return j;
    } catch (e) { say(`${label}: NETERR ${e.message}`); return {}; }
};
await solve("P2 testkey/proxy  ", { sitekey: "1x00000000000000000000AA", url: "https://example.com/", proxy: P }, 60000);
const p3 = await solve("P3 capskip/proxy   ", { sitekey: "0x4AAAAAADogn3t3_JKwKkgS", url: "https://capskip.com/captcha-demo/cloudflare-turnstile/", action: "example_action", proxy: P }, 120000);
if (p3.token) {
    const html = await fetch("https://capskip.com/captcha-demo/cloudflare-turnstile/", { signal: AbortSignal.timeout(30000) }).then(x => x.text());
    const nonce = html.match(/"nonce":"([^"]+)"/)?.[1];
    const v = await fetch("https://capskip.com/wp-admin/admin-ajax.php", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "capskip_captcha_verify", nonce, provider: "turnstile", token: p3.token }).toString(),
        signal: AbortSignal.timeout(30000)
    }).then(x => x.json());
    const d = v?.data || {};
    say("VERIFY: " + JSON.stringify({ success: v.success, verified: d.verified, server: d.server, message: d.message }));
    say(v.success && d.verified ? ">>> CONTAINER PROXY PATH: PASS" : ">>> CONTAINER PROXY PATH: FAIL");
} else {
    say(">>> CONTAINER PROXY PATH: FAIL (no token)");
}
const h = await fetch(B + "/health", { signal: AbortSignal.timeout(5000) }).then(r => r.json());
say("HEALTH: " + JSON.stringify({ avail: h.solvers_available + "/" + h.solver_instances, errors: h.recent_solver_errors }));
