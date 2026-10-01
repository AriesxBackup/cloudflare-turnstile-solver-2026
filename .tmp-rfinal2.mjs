// TEMP: Railway full validation: P1, P2, P3 (+verify), user target (no-proxy + proxy)
import { appendFileSync } from "node:fs";
const say = (s) => { console.log(s); appendFileSync(".tmp-rfinal2.out", s + "\n"); };
const B = "https://cloudflare-turnstile-solver-2026-production-59c3.up.railway.app";
const P = "202.28.17.5:8080:s6103021621234:frank100258";
const U = "https://capskip.com/captcha-demo/cloudflare-turnstile/";
const LURL = "https://www.languageline.com/bill-pay";
const LKEY = "0x4AAAAAAE0cgpbRIy-ljERB";
const solve = async (label, body, ms = 130000) => {
    const t0 = Date.now();
    try {
        const r = await fetch(B + "/solve", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(ms)
        });
        const j = await r.json().catch(() => ({}));
        say(`${label}: HTTP ${r.status} in ${Date.now() - t0} ms solve_ms=${j.solve_ms} success=${j.success}` + (j.token ? ` token_len=${j.token.length}` : ` error=${JSON.stringify(j.error)}`));
        return j;
    } catch (e) { say(`${label}: NETERR after ${Date.now() - t0} ms: ${e.message}`); return {}; }
};
const h = await fetch(B + "/health", { signal: AbortSignal.timeout(10000) }).then(r => r.json());
say("HEALTH-PRE: " + JSON.stringify({ uptime_ms: h.uptime_ms, avail: h.solvers_available + "/" + h.solver_instances, errors: h.recent_solver_errors }));

await solve("P1 testkey/no-proxy ", { sitekey: "1x00000000000000000000AA", url: "https://example.com/" }, 60000);
await solve("P2 testkey/proxy    ", { sitekey: "1x00000000000000000000AA", url: "https://example.com/", proxy: P }, 60000);
const p3 = await solve("P3 capskip/proxy    ", { sitekey: "0x4AAAAAADogn3t3_JKwKkgS", url: U, action: "example_action", proxy: P }, 130000);
if (p3.token) {
    const html = await fetch(U, { signal: AbortSignal.timeout(30000) }).then(x => x.text());
    const nonce = html.match(/"nonce":"([^"]+)"/)?.[1];
    const v = await fetch("https://capskip.com/wp-admin/admin-ajax.php", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "capskip_captcha_verify", nonce, provider: "turnstile", token: p3.token }).toString(),
        signal: AbortSignal.timeout(30000)
    }).then(x => x.json());
    const d = v?.data || {};
    say("VERIFY: " + JSON.stringify({ success: v.success, verified: d.verified, server: d.server, message: d.message }));
    say(v.success && d.verified ? ">>> P3 RAILWAY PROXY+VERIFY: PASS" : ">>> P3 RAILWAY PROXY+VERIFY: FAIL");
}

await solve("T1 target/no-proxy  ", { sitekey: LKEY, url: LURL, action: "ll_payment" }, 130000);
await solve("T2 target/proxy     ", { sitekey: LKEY, url: LURL, action: "ll_payment", proxy: P }, 130000);

const h2 = await fetch(B + "/health", { signal: AbortSignal.timeout(10000) }).then(r => r.json());
say("HEALTH-POST: " + JSON.stringify({ uptime_ms: h2.uptime_ms, avail: h2.solvers_available + "/" + h2.solver_instances, errors: h2.recent_solver_errors }));
