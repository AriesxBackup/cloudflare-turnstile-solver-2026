// TEMP: local capskip+proxy comparison (did the proxy IP get flagged interactive?)
const say = (s) => console.log(s);
const B = "http://127.0.0.1:8082";
const P = "202.28.17.5:8080:s6103021621234:frank100258";
const t0 = Date.now();
const r = await fetch(B + "/solve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sitekey: "0x4AAAAAADogn3t3_JKwKkgS", url: "https://capskip.com/captcha-demo/cloudflare-turnstile/", action: "example_action", proxy: P }),
    signal: AbortSignal.timeout(130000)
});
const j = await r.json();
say(`LOCAL capskip/proxy: HTTP ${r.status} in ${Date.now() - t0} ms solve_ms=${j.solve_ms} success=${j.success}` + (j.token ? ` token_len=${j.token.length}` : ` error=${JSON.stringify(j.error)}`));
if (j.token) {
    const html = await fetch("https://capskip.com/captcha-demo/cloudflare-turnstile/", { signal: AbortSignal.timeout(30000) }).then(x => x.text());
    const nonce = html.match(/"nonce":"([^"]+)"/)?.[1];
    const v = await fetch("https://capskip.com/wp-admin/admin-ajax.php", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "capskip_captcha_verify", nonce, provider: "turnstile", token: j.token }).toString(),
        signal: AbortSignal.timeout(30000)
    }).then(x => x.json());
    const d = v?.data || {};
    say("VERIFY: " + JSON.stringify({ success: v.success, verified: d.verified, server: d.server, message: d.message }));
    say(v.success && d.verified ? ">>> LOCAL P3+VERIFY: PASS" : ">>> LOCAL P3+VERIFY: FAIL");
} else {
    say(">>> LOCAL P3: FAIL (no token)");
}
