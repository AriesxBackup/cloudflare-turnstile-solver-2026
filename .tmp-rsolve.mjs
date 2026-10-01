// .tmp-rsolve.mjs - Railway end-to-end test: solve capskip demo THROUGH the user's proxy,
// then verify the token server-side on capskip. No token persisted to disk.
const BASE = "https://cloudflare-turnstile-solver-2026-production-59c3.up.railway.app";
const PROXY = "202.28.17.5:8080:s6103021621234:frank100258";
const SITEKEY = "0x4AAAAAADogn3t3_JKwKkgS";             // capskip demo (real widget)
const URL_ = "https://capskip.com/captcha-demo/cloudflare-turnstile/";
const ACTION = "example_action";

// 1) health
const h = await fetch(BASE + "/health", { signal: AbortSignal.timeout(15000) }).then(r => r.json());
console.log("HEALTH:", JSON.stringify(h));
if (!h.solvers_available) { console.log("NO SOLVER AVAILABLE - aborting"); process.exit(1); }

// 2) solve with proxy (hub allows 120s; client gives 150s)
const t0 = Date.now();
const r = await fetch(BASE + "/solve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sitekey: SITEKEY, url: URL_, action: ACTION, proxy: PROXY }),
    signal: AbortSignal.timeout(150000),
}).catch(e => { console.log("FETCH ERROR:", e.message); process.exit(1); });
const j = await r.json().catch(() => ({ parse_fail: true }));
console.log("SOLVE: HTTP", r.status, "in", Date.now() - t0, "ms");
console.log(JSON.stringify({ ...j, token: j.token ? j.token.slice(0, 60) + `...(${j.token.length} chars)` : undefined }, null, 2));
if (!j.success || !j.token) process.exit(1);

// 3) verify server-side on capskip (payload per captcha-demos.js)
const html = await (await fetch(URL_)).text();
const nonce = html.match(/"nonce":"([^"]+)"/)?.[1];
const v = await fetch("https://capskip.com/wp-admin/admin-ajax.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action: "capskip_captcha_verify", nonce, provider: "turnstile", token: j.token }),
}).then(r => r.json()).catch(e => ({ fetch_error: e.message }));
console.log("VERIFY:", JSON.stringify(v, null, 2));
console.log(v?.success && v?.data?.verified ? "\n*** RAILWAY PROXY E2E: PASS ***" : "\n*** RAILWAY PROXY E2E: FAIL ***");
