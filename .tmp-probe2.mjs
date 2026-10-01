// TEMP: Railway proxy-solve + verify, tees output to .tmp-probe2.out
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(".tmp-probe2.out", "");
const say = (s) => { console.log(s); appendFileSync(".tmp-probe2.out", s + "\n"); };
const B = "https://cloudflare-turnstile-solver-2026-production-59c3.up.railway.app";
const K = "0x4AAAAAADogn3t3_JKwKkgS", U = "https://capskip.com/captcha-demo/cloudflare-turnstile/", P = "202.28.17.5:8080:s6103021621234:frank100258";
try {
    const h = await fetch(B + "/health", { signal: AbortSignal.timeout(15000) }).then(r => r.json());
    say("HEALTH: " + JSON.stringify(h));
    const t0 = Date.now();
    const r = await fetch(B + "/solve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sitekey: K, url: U, action: "example_action", proxy: P }),
        signal: AbortSignal.timeout(140000)
    });
    const j = await r.json().catch(() => ({}));
    say(`PROXY-SOLVE: HTTP ${r.status} in ${Date.now() - t0} ms solve_ms=${j.solve_ms} success=${j.success}` + (j.token ? ` token_len=${j.token.length}` : ` error=${j.error}`));
    if (j.token) {
        const html = await fetch(U, { signal: AbortSignal.timeout(30000) }).then(x => x.text());
        const nonce = html.match(/"nonce":"([^"]+)"/)?.[1];
        const v = await fetch("https://capskip.com/wp-admin/admin-ajax.php", {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ action: "capskip_captcha_verify", nonce, provider: "turnstile", token: j.token }).toString(),
            signal: AbortSignal.timeout(30000)
        }).then(x => x.json());
        const d = v?.data || {};
        say("VERIFY: " + JSON.stringify({ success: v.success, verified: d.verified, server: d.server, message: d.message }));
        say(v.success && d.verified ? ">>> RAILWAY PROXY PATH: PASS" : ">>> RAILWAY PROXY PATH: FAIL");
    }
} catch (e) {
    say("ERR: " + e.message);
}
