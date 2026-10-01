// TEMP: local proxy-path validation (solve via proxy + capskip server-side verify)
const B = "http://127.0.0.1:8082";
const K = "0x4AAAAAADogn3t3_JKwKkgS", U = "https://capskip.com/captcha-demo/cloudflare-turnstile/", P = "202.28.17.5:8080:s6103021621234:frank100258";
const h = await fetch(B + "/health", { signal: AbortSignal.timeout(10000) }).then(r => r.json());
console.log("HEALTH:", JSON.stringify(h));
const t0 = Date.now();
const r = await fetch(B + "/solve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sitekey: K, url: U, action: "example_action", proxy: P }),
    signal: AbortSignal.timeout(120000)
});
const j = await r.json().catch(() => ({}));
console.log(`SOLVE(proxy): HTTP ${r.status} in ${Date.now() - t0} ms success=${j.success} solve_ms=${j.solve_ms}` + (j.token ? ` token_len=${j.token.length}` : ` error=${j.error}`));
if (!j.token) process.exit(1);
const html = await fetch(U, { signal: AbortSignal.timeout(30000) }).then(x => x.text());
const nonce = html.match(/"nonce":"([^"]+)"/)?.[1];
const v = await fetch("https://capskip.com/wp-admin/admin-ajax.php", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action: "capskip_captcha_verify", nonce, provider: "turnstile", token: j.token }).toString(),
    signal: AbortSignal.timeout(30000)
}).then(x => x.json());
const d = v?.data || {};
console.log("VERIFY:", JSON.stringify({ success: v.success, verified: d.verified, server: d.server, message: d.message }));
console.log(v.success && d.verified ? ">>> LOCAL PROXY PATH: PASS" : ">>> LOCAL PROXY PATH: FAIL");
