// TEMP: validate error propagation + success path through new protocol
const B = "http://127.0.0.1:8082";
const r1 = await fetch(B + "/solve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sitekey: "0xBADKEY", url: "https://capskip.com/captcha-demo/cloudflare-turnstile/" }),
    signal: AbortSignal.timeout(20000)
});
const j1 = await r1.json();
console.log("FAIL-path: HTTP " + r1.status + " error=" + JSON.stringify(j1.error));

const t0 = Date.now();
const r2 = await fetch(B + "/solve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sitekey: "0x4AAAAAADogn3t3_JKwKkgS", url: "https://capskip.com/captcha-demo/cloudflare-turnstile/", action: "example_action" }),
    signal: AbortSignal.timeout(120000)
});
const j2 = await r2.json();
console.log(`OK-path: HTTP ${r2.status} in ${Date.now() - t0} ms success=${j2.success}` + (j2.token ? ` token_len=${j2.token.length}` : ` error=${JSON.stringify(j2.error)}`));

const h = await fetch(B + "/health", { signal: AbortSignal.timeout(10000) }).then(x => x.json());
console.log("HEALTH errors:", JSON.stringify(h.recent_solver_errors));
console.log(j2.token ? ">>> PROTOCOL VALIDATION: PASS" : ">>> PROTOCOL VALIDATION: FAIL");
