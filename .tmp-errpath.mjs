// TEMP: solver-level error string round-trip (long budget)
const B = "http://127.0.0.1:8082";
const t0 = Date.now();
const r = await fetch(B + "/solve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sitekey: "0x4AAAAAADogn3t3_JKwKkgS", url: "https://definitely-not-a-real-host-9z9.invalid/" }),
    signal: AbortSignal.timeout(260000)
});
const j = await r.json();
console.log(`SOLVE: HTTP ${r.status} in ${Date.now() - t0} ms error=${JSON.stringify(j.error)}`);
const h = await fetch(B + "/health", { signal: AbortSignal.timeout(10000) }).then(x => x.json());
console.log("HEALTH errors:", JSON.stringify(h.recent_solver_errors));
console.log(j.error && h.recent_solver_errors?.length > 0 ? ">>> ERROR ROUND-TRIP: PASS" : ">>> ERROR ROUND-TRIP: FAIL");

