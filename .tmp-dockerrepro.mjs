// TEMP: Docker repro v2 - solve, kill chrome+Xvfb, solve again (must relaunch cleanly)
import { execSync } from "node:child_process";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const say = (s) => console.log(s);
const B = "http://127.0.0.1:18082";
const solve = async (label, body, ms = 60000) => {
    const t0 = Date.now();
    try {
        const r = await fetch(B + "/solve", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(ms)
        });
        const j = await r.json().catch(() => ({}));
        say(`${label}: HTTP ${r.status} in ${Date.now() - t0} ms solve_ms=${j.solve_ms}` + (j.token ? ` token_len=${j.token.length}` : ` error=${JSON.stringify(j.error)}`));
        return j;
    } catch (e) { say(`${label}: NETERR ${e.message}`); return {}; }
};
const h = await fetch(B + "/health", { signal: AbortSignal.timeout(5000) }).then(r => r.json());
say("HEALTH pre: " + JSON.stringify({ avail: h.solvers_available + "/" + h.solver_instances, errors: h.recent_solver_errors }));

await solve("SOLVE #1 (warm default)", { sitekey: "1x00000000000000000000AA", url: "https://example.com/" });
say("-- killing chromium + Xvfb inside container --");
for (const what of ["chromium", "Xvfb"]) {
    try { execSync(`docker exec solver-test pkill -9 ${what}`); } catch { say(`(pkill ${what}: nothing/exit ${e})`); }
}
await sleep(2000);

await solve("SOLVE #2 (post-kill relaunch)", { sitekey: "1x00000000000000000000AA", url: "https://example.com/" }, 90000);
await solve("SOLVE #3 (stable after relaunch)", { sitekey: "1x00000000000000000000AA", url: "https://example.com/" }, 60000);
await sleep(1000);
const h2 = await fetch(B + "/health", { signal: AbortSignal.timeout(5000) }).then(r => r.json());
say("HEALTH post: " + JSON.stringify({ avail: h2.solvers_available + "/" + h2.solver_instances, errors: h2.recent_solver_errors }));

