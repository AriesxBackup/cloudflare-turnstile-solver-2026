// TEMP local test: 3 parallel capskip solves against local hub + server-side verify
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync(".tmp-target.json", "utf8"));
const B = cfg.hub;
const K = cfg.sitekey, U = cfg.url, A = cfg.action;

// 1) fresh nonce from the demo page
const html = await fetch(U, { signal: AbortSignal.timeout(30000) }).then(r => r.text());
const nonce = html.match(/"nonce":"([^"]+)"/)?.[1];
console.log("nonce:", nonce ? nonce.slice(0, 8) + "..." : "NOT FOUND");

// 2) 3 parallel solves
const solve = (n) => fetch(B + "/solve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sitekey: K, url: U, action: A }), signal: AbortSignal.timeout(120000)
}).then(async r => ({ n, status: r.status, j: await r.json().catch(() => ({})) }));
const t0 = Date.now();
const results = await Promise.all([solve(1), solve(2), solve(3)]);
console.log("all 3 solves finished in", Date.now() - t0, "ms");
for (const r of results) {
    console.log(`  solve#${r.n}: HTTP ${r.status} solve_ms=${r.j.solve_ms} success=${r.j.success} token=${r.j.token ? r.j.token.slice(0, 30) + "...(" + r.j.token.length + ")" : r.j.error}`);
}

// 3) server-side verify each token on capskip
for (const r of results) {
    if (!r.j.token) { console.log(`verify#${r.n}: skipped (no token)`); continue; }
    const body = new URLSearchParams({ action: "capskip_captcha_verify", nonce, provider: "turnstile", token: r.j.token });
    const v = await fetch("https://capskip.com/wp-admin/admin-ajax.php", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(), signal: AbortSignal.timeout(30000)
    }).then(x => x.json()).catch(e => ({ fetch_error: e.message }));
    console.log(`verify#${r.n}:`, JSON.stringify(v));
}
