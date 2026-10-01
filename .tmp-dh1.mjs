// TEMP: Docker HEADLESS=1 proxy solve - replicate Railway's suspected combo
const say = (s) => console.log(s);
const B = "http://127.0.0.1:18082";
const P = "202.28.17.5:8080:s6103021621234:frank100258";
const t0 = Date.now();
try {
    const r = await fetch(B + "/solve", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ sitekey: "1x00000000000000000000AA", url: "https://example.com/", proxy: P }),
        signal: AbortSignal.timeout(60000)
    });
    const j = await r.json();
    say(`DOCKER HEADLESS=1 proxy: HTTP ${r.status} in ${Date.now() - t0} ms solve_ms=${j.solve_ms}` + (j.token ? ` token_len=${j.token.length}` : ` error=${JSON.stringify(j.error)}`));
} catch (e) { say(`NETERR: ${e.message}`); }
const h = await fetch(B + "/health", { signal: AbortSignal.timeout(5000) }).then(r => r.json());
say("HEALTH: " + JSON.stringify({ avail: h.solvers_available + "/" + h.solver_instances, errors: h.recent_solver_errors }));
