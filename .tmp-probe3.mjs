// TEMP: Railway decisive probes with failure-reason diagnostics
import { appendFileSync } from "node:fs";
const say = (s) => { console.log(s); appendFileSync(".tmp-probe3.out", s + "\n"); };
const B = "https://cloudflare-turnstile-solver-2026-production-59c3.up.railway.app";
const K = "0x4AAAAAADogn3t3_JKwKkgS", U = "https://capskip.com/captcha-demo/cloudflare-turnstile/", P = "202.28.17.5:8080:s6103021621234:frank100258";
const solve = async (label, body, ms = 60000) => {
    const t0 = Date.now();
    try {
        const r = await fetch(B + "/solve", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(ms)
        });
        const j = await r.json().catch(() => ({}));
        say(`${label}: HTTP ${r.status} in ${Date.now() - t0} ms solve_ms=${j.solve_ms} success=${j.success}` + (j.token ? ` token_len=${j.token.length}` : ` error=${JSON.stringify(j.error)}`));
        return j;
    } catch (e) {
        say(`${label}: NETERR after ${Date.now() - t0} ms: ${e.message}`);
        return {};
    }
};
const h1 = await fetch(B + "/health", { signal: AbortSignal.timeout(10000) }).then(r => r.json());
say("HEALTH-PRE: " + JSON.stringify({ uptime_ms: h1.uptime_ms, avail: h1.solvers_available + "/" + h1.solver_instances, errors: h1.recent_solver_errors }));

await solve("P1 testkey/no-proxy ", { sitekey: "1x00000000000000000000AA", url: "https://example.com/" }, 30000);
await solve("P2 testkey/proxy    ", { sitekey: "1x00000000000000000000AA", url: "https://example.com/", proxy: P }, 30000);
const p3 = await solve("P3 capskip/proxy    ", { sitekey: K, url: U, action: "example_action", proxy: P }, 60000);

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
    say(v.success && d.verified ? ">>> P3 RAILWAY PROXY PATH: PASS" : ">>> P3 RAILWAY PROXY PATH: FAIL");
}
const h2 = await fetch(B + "/health", { signal: AbortSignal.timeout(10000) }).then(r => r.json());
say("HEALTH-POST: " + JSON.stringify({ uptime_ms: h2.uptime_ms, avail: h2.solvers_available + "/" + h2.solver_instances, errors: h2.recent_solver_errors }));
