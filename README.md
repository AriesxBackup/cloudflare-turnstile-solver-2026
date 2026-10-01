# cloudflare-turnstile-solver-2026

Self-hosted Cloudflare Turnstile token solver. One Node process runs everything:

- **WebSocket hub** — matches solve requests to idle solver workers (byte-compatible with the original Rust token-server protocol, so existing custom clients/workers keep working).
- **HTTP API** — `POST /solve`, `GET /health`, `GET /` for callers that just want a token.
- **Solver workers** — each worker drives a real Chrome over CDP, renders the target page's Turnstile widget, and mints the token. No webdriver fingerprint, no third-party API.

Deployable as a single container on Railway, Fly, Docker, or bare metal (Node >= 22).

**Contents:** [Quick start](#quick-start) · [HTTP API](#http-api) · [Environment variables](#environment-variables) · [Docker](#docker) · [Railway](#railway) · [Proxies](#proxies) · [WS protocol (solvers)](#connecting-your-own-solver-over-websocket) · [WS protocol (clients)](#connecting-your-own-client-over-websocket) · [Smoke test](#smoke-test) · [Performance](#performance) · [Caveats](#caveats) · [Troubleshooting](#troubleshooting)

---

## Quick start

Windows (local dev): `.\start_services.ps1`, then `.\stop_services.ps1` to stop.

Linux/macOS (local dev):

```bash
npm install
SOLVER_INSTANCES=1 node server.mjs
```

The process starts the hub on the same port as the API (any WebSocket path is the hub endpoint) and spawns `SOLVER_INSTANCES` solver workers. Each worker launches its own Chrome (headless by default) and connects back to the hub automatically — there is nothing else to run.

```bash
# Solve a token (Cloudflare's always-passing test sitekey)
curl -s http://127.0.0.1:8082/solve \
  -H "Content-Type: application/json" \
  -d '{"sitekey":"1x00000000000000000000AA","url":"https://example.com/protected"}'

# -> {"success":true,"token":"0.","solve_ms":2143,"url":"https://example.com/protected","sitekey":"1x...","action":"...","proxy":"..."}

# Capacity check
curl -s http://127.0.0.1:8082/health
# -> {"ok":true,"version":"1.0.0","uptime_ms":...,"inflight":0,"max_inflight":32,"solvers_available":1,"solver_instances":1,"shutting_down":false}
```

One solver worker = one Chrome = one solve at a time. Run more workers for more parallel throughput (`SOLVER_INSTANCES=8`), and expect roughly one Chrome's worth of RAM per worker.

---

## Performance

Benchmarking Turnstile solves is hard — output varies by target site and how aggressively Cloudflare has seen traffic from your IP/proxy before. These are real-world numbers from actual usage, not idealized benchmarks: on an 8-core / 16 GB machine running 8–15 solvers, sustained rates of about **120 solves/min (~2 solves/sec)** were reachable, with individual solves usually completing in ~2–3 seconds (rarely over 5).

Latency is dominated by the Cloudflare challenge itself — everything else (hub routing, CDP control, HTTP round-trip) is a fraction of a second. The system is CPU/RAM bound once you run more workers than cores.

---

## Architecture

The service has three cooperating pieces, all in one process:

1. **WebSocket hub** — assigns an ID to every socket, tracks idle solvers in per-user-agent buckets, forwards each solve request to a free solver, and routes the token back to the original requester. Byte-compatible with the original Rust token-server wire protocol.
2. **HTTP API** — a thin layer over the hub: every `POST /solve` opens an internal virtual requester connection, so any number of solves can be in flight at once (up to `MAX_INFLIGHT`).
3. **Solver workers** — spawned and supervised child processes (`node solver.mjs`, one per configured instance) that each drive a real Chrome via CDP: navigate to the target URL, render the Turnstile widget with the requested sitekey/action, wait out the challenge, and return the token to the hub. Workers survive hub restarts (auto-reconnect) and Chrome crashes (hub respawns them after 3 s).

---

### Worker lifecycle

Every solver worker:
1. Boots (retrying browser + hub connection instead of exiting, so startup order does not matter).
2. Registers with the hub under its fixed user-agent bucket.
3. Loops: receive request → launch/attach Chrome → navigate to `url` → render the Turnstile widget with `sitekey`/`action` → wait for the challenge to resolve → send the token back to the hub.
4. Persists a small state file (`SOLVER_STATE_FILE`) noting which hosts challenged the headless fingerprint, so a restart skips the wasted headless attempt and can pre-warm the visible fallback browser.

On fingerprint challenges the worker automatically falls back to a **visible** Chrome (in Docker this is the Xvfb-backed `solver-chrome` wrapper). `SIGINT`/`SIGTERM` kill all spawned Chrome instances.

---

## Hub Wire Protocol

The hub speaks a compact binary protocol over WebSocket frames (any path works — `ws://host:port/anything`). Solvers and custom clients share it, and it is byte-identical to the original Rust token-server protocol.

#### Client -> hub (serverbound):

*All values are little-endian.*

| Sent From | Header | Description |
|-----------|--------|-------------|
| Solver | `0` | Incoming token result from a solver. The hub routes it back to the specific requester by extracting the requester ID, then re-adds the solver to its available bucket so it can take the next job.<br><br>**Structure:** `<0, ...requester_id_bytes (u32), proxy_url_len (u8), ...proxy_url_bytes, ...token_bytes>`<br>*Note: If the solver failed to get a token, then there are no token bytes.* |
| Receiver | `1` | On-demand solve request from a requester. The hub pulls the next available solver from the buckets and forwards this assignment to them.<br><br>**Fields:** The request carries a `url`, a `sitekey`, and optionally an `action` — the worker renders the page's Turnstile widget with exactly these parameters. The HTTP API builds this packet for you; custom WS clients construct it directly.<br><br>**Structure:** `<1, proxy_url_len (u8), ...proxy_url_bytes, ...(field_name_len (u8), ...field_name_bytes, field_value_len (u8), ...field_value_bytes)>` |
| Solver | `2` | Register the sending socket as a solver. The hub adds its socket ID to the available-solver bucket for the given user-agent (creating the bucket if needed).<br><br>**Structure:** `<2, ...user_agent_bytes>` |
| Any | `3` | Request the total available (idle) solver count. Good for autoscaling and health checks.<br><br>**Structure:** `<3>` |
| Any | `255` | Keepalive no-op. Solvers send this periodically so intermediaries do not drop idle connections.<br><br>**Structure:** `<255>` |

#### Hub -> client (clientbound):

*All values are little-endian.*

| Sent To | Header | Description |
|---------|--------|-------------|
| Receiver | `0` | Token delivered to a requester (empty token bytes = failed solve).<br><br>**Structure:** `<0, proxy_url_len (u8), ...proxy_url_bytes, ...token_bytes>` |
| Solver | `1` | Solve request delivered to a solver. Fields are parsed and drive the widget render (`url`, `sitekey`, `action`).<br><br>**Structure:** `<1, proxy_url_len (u8), ...proxy_url_bytes, ...requester_id_bytes (u32), ...(field_name_len (u8), ...field_name_bytes, field_value_len (u8), ...field_value_bytes)>` |
| Receiver | `2` | The request could not be completed because no solver was available to accept it.<br><br>**Structure:** `<2>` |
| Receiver | `3` | Reply to an available-solvers count query.<br><br>**Structure:** `<3, ...available_solvers_bytes (u32)>` |

**How it works:**

The hub assigns an ID to every socket. Solvers register themselves into available-solver buckets keyed by user-agent. Requesters send header-1 packets; the hub pops a free solver, injects the requester ID into the forwarded packet, and marks that solver busy. When the solver answers, the hub strips the requester ID, forwards the token back, and returns the solver to its bucket (so it can serve the next request immediately). The HTTP API uses this same protocol internally — each `POST /solve` is just a short-lived virtual requester.

---

## Proxies

- **Per-request**: pass `"proxy": "http://user:pass@host:port"` (or scheme-less `host:port:user:pass`). The worker lazily launches a dedicated Chrome with `--proxy-server` for that solve.
- **Always-on**: set `DEFAULT_PROXY` — used for every solve whose `proxy` field is empty, and enables boot-time prewarm (warm proxy browser + a pre-minted token for the last solved target) so the first request after a restart is fast.

Formats: `http://host:port`, `http://user:pass@host:port`, or `host:port:user:pass`. HTTP proxies are recommended — some browsers have iffy SOCKS implementations. Tunneling multiple proxies through a single iframe is not supported; per-solve proxying (one browser per proxy) is.

---

## HTTP API

All routes are JSON; the HTTP server and the WS hub share one port (`PORT`, default `8082`).

### POST /solve

```
{
  "sitekey": "0x4AAAAAAA...",             // required - the target's Turnstile sitekey
  "url": "https://target/page",           // required - page whose widget is rendered
  "action": "login",                      // optional - Turnstile action
  "proxy": "http://user:pass@host:port"   // optional - per-solve proxy
}
```

| Status | Meaning |
|--------|---------|
| `200` | `{ success: true, token, solve_ms, url, sitekey, action?, proxy? }` |
| `502` | Solve finished but returned no token (the `error` field explains) |
| `503` | No solver available (`NO_SOLVERS`) — all workers busy |
| `504` | Solve exceeded `SOLVE_TIMEOUT_MS` (`TIMEOUT`) |
| `429` | More than `MAX_INFLIGHT` concurrent requests |
| `400` | Missing/invalid `sitekey` or `url` |
| `401` | `API_KEY` is set and the request lacks `X-API-Key: <key>` or `Authorization: Bearer <key>` |

### GET /health

Always `200`: `{ ok, version, uptime_ms, inflight, max_inflight, active_solves, max_parallel_solves, dispatch_queue_len, solvers_available, solver_instances, recent_solver_errors, diag, shutting_down }`. `diag` exposes runtime env knobs, container memory and pids cgroup usage, ulimits, and live Chromium/thread counts — useful for diagnosing PaaS resource caps.

### GET /

Service banner (name, version, endpoints).

## Environment variables

Hub/API (read by `server.mjs`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `API_PORT` | `8082` | HTTP + WS port (Railway injects `PORT`). |
| `API_HOST` | `0.0.0.0` on Railway, else `127.0.0.1` | Bind address. |
| `API_KEY` | unset | Require `X-API-Key` / `Bearer` auth on `POST /solve`. |
| `SOLVE_TIMEOUT_MS` | `120000` | Per-request solve budget (`504` beyond). |
| `MAX_INFLIGHT` | `32` | Concurrent `/solve` cap (`429` beyond). |
| `MAX_PARALLEL_SOLVES` | `3` | Global cap on solves running *simultaneously* across all workers; excess requests queue FIFO. Each solve holds a Chrome, so this bounds Chrome count under PaaS pids caps. |
| `SOLVER_INSTANCES` | `1` | Solver workers to spawn (`0` = hub + API only). |
| `CDP_PORT_BASE` | `9230` | Worker *i* gets Chrome debug port `base + i`. |
| `FALLBACK_CDP_PORT_BASE` | `9329` | Worker *i* gets visible-fallback debug port `base + i`. |

Workers (read by `solver.mjs`; the hub sets `TOKEN_SERVER_URL`, `CDP_BASE`, `FALLBACK_CDP_PORT` and `SOLVER_STATE_FILE` per worker automatically — the rest are inherited from the hub's environment):

| Variable | Default | Description |
|----------|---------|-------------|
| `HEADLESS` | `1` | `0` = spawn Chrome visible (also forced per-host after a fingerprint challenge). |
| `MANAGE_BROWSER` | `1` | Worker launches/owns its Chrome at `CDP_BASE`; set `0` to attach to an external Chrome at `CDP_BASE` instead. |
| `CHROME_PATH` | `chrome` on PATH | Browser binary (Docker image: `solver-chrome` Xvfb wrapper). |
| `CHROME_ARGS_EXTRA` | unset | Extra Chrome flags, comma-separated (Docker needs `--no-sandbox,--disable-dev-shm-usage`). |
| `DEFAULT_PROXY` | unset | Proxy for every solve with no `proxy` field; enables boot prewarm. |
| `SOLVE_TIMEOUT_MS` | `55000` | Worker-side solve budget. |
| `NAV_TIMEOUT_MS` | `45000` | Page navigation budget. |
| `REQUEST_TIMEOUT_MS` | `110000` | Whole-request watchdog. |
| `RECONNECT_MS` | `3000` | Hub reconnect delay. |
| `PREWARM_TIMEOUT_MS` | `45000` | Prewarm budget. |
| `PAGE_INIT_SLEEP_MS` | `400` | Settle time after navigation. |
| `PROXY_BROWSER_IDLE_TTL_MS` | `120000` | Idle cached proxy browsers are killed after this (`0` disables) so a pids cap is never left exhausted by unused Chromes. |
| `PIDS_LAUNCH_HEADROOM` | `150` | Threads a new Chrome needs; a launch waits (see `PIDS_WAIT_MAX_MS`) while the container's pids cgroup has less than this much headroom. |
| `PIDS_WAIT_MAX_MS` | `30000` | How long a Chrome launch waits for pids headroom before going ahead anyway. |

## PaaS notes (Railway, Fly, ...)

Cloudflare-facing Chrome workers are fork-hungry: one headful Chrome is ~11 processes / ~1.4k threads, and platform containers cap **pids** (Railway: `pids.max = 1000`) as well as memory. When the cap is exhausted, a *new* Chrome launch fails its first `fork`/`pthread_create` and dies silently — we observed `SIGSEGV (code -11)` every relaunch while 8 boot Chromes held the cap at exactly 1000, long before memory (1.6 GB of 24 GB) mattered.

This service now self-regulates around that constraint:

- When `DEFAULT_PROXY` is set, the per-worker *default* browser is **not** launched at boot (it is never used — every solve goes through the proxy browser; it is still launched lazily for a true no-proxy solve).
- `MAX_PARALLEL_SOLVES` caps concurrent solves (each holds one Chrome) and queues the excess.
- `PIDS_LAUNCH_HEADROOM` + `PIDS_WAIT_MAX_MS` make a launch **wait** for pids headroom instead of crashing.
- `PROXY_BROWSER_IDLE_TTL_MS` reaps cached-but-idle proxy browsers.

Result under the Railway constraint: boot = ~64/1000 pids (was pinned at 1000 with 88 Chromium procs), solve bursts peak ~840, idle settles back to ~80, and relaunch-after-kill recovers cleanly. If you still see interactive-challenge timeouts on a specific target, it is almost always **egress-IP reputation** (the datacenter egress or a shared proxy IP flagged by Cloudflare) — use a clean residential/ISP proxy per solve, not a code change.

---

## Connecting your own client over WebSocket

The HTTP API is a thin wrapper around the hub — anything it can do, a raw WebSocket client can too. Connect to `ws://host:port/any-path` and speak binary frames (byte-compatible with the original Rust token-server, so existing integrations keep working):

1. **Request a solve** — send a header-`1` packet (builder below) and keep it in flight.
2. **Receive the result** — a header-`0` reply carries the token (empty token bytes = failed solve); header-`2` means no solver was free at that moment.
3. **Optionally** query capacity with header-`3` (reply: `3, available (u32)`), and send header-`255` periodically as keepalive. There is no failure callback for a lost request — apply your own client-side timeout and treat a dropped connection as a failed solve.

> **Never send the header-`2` registration packet from a requester.** Registering marks your socket as a *solver* — the hub will then start forwarding solve requests to it and expect header-`0` answers.

---

Helper snippets for building and parsing these packets in JavaScript:

**Construct solve request packet:**

```javascript
// proxy_url = the full proxy URL string (e.g. "http://user:pass@host:port").
// fields = object, { name: value, name2: value2, ... namen: valuen }. Names and values are strings.
function construct_solver_request_packet(proxy_url, fields = {}) {
   let encoder = new TextEncoder();
   let packet = [1];
   let proxy_url_bytes = encoder.encode(proxy_url);
   packet.push(proxy_url_bytes.length);
   packet.push(...proxy_url_bytes);
   for (let field_name in fields) {
         let field_value = fields[field_name];
         let field_name_bytes = encoder.encode(field_name);
         let field_value_bytes = encoder.encode(field_value);
         packet.push(field_name_bytes.length);
         packet.push(...field_name_bytes);
         packet.push(field_value_bytes.length);
         packet.push(...field_value_bytes);
   }
   return new Uint8Array(packet);
};
```

**Parse token response packet:**

```javascript
// packet = packet buffer.
function parse_token_response_packet(packet) {
    let u8 = new Uint8Array(packet);
    let proxy_url_len = u8[1];
    let proxy_url = new TextDecoder().decode(u8.slice(2, 2 + proxy_url_len));
    let token = undefined;
    if (u8.length > 2 + proxy_url_len) {
        token = new TextDecoder().decode(u8.subarray(2 + proxy_url_len));
    }
    return [proxy_url, token];
};
```

**Parse available solvers packet:**

```javascript
// packet = packet buffer.
function parse_available_solvers_count_packet(packet) {
    let view = new DataView(packet);
    return [view.getUint32(1, true)];
};
```

**Match packets:**

```javascript
// packet = Uint8Array
let header = packet[0];
if (header == 0) {
   // Token Packet (success or failed)
} else if (header == 2) {
   // Solvers Unavailable
} else if (header == 3) {
   // Available Solvers Result
}
```

---

## Caveats

- **Per-solve isolation** — each worker runs one Chrome per solve, so throughput scales with `SOLVER_INSTANCES` and available CPU/RAM.
- **Target-specific tuning** — sites that call `turnstile.render()` with `action`/`cData` require you to reproduce those values in the request; a mismatch yields a token the site rejects.
- **No TLS/JA4 or canvas spoofing** — the browser is real, but stock; fingerprinting at those layers sees exactly what a real Chrome shows.
- **Tokens are short-lived and single-use** per Cloudflare's policy — solve on demand rather than stockpiling.
- **Cloudflare adjusts Turnstile over time** — when the widget DOM changes, `solver.mjs` needs a matching update.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `503` with `NO_SOLVERS` | All workers busy or still booting. Check `solvers_available` in `/health`; raise `SOLVER_INSTANCES` or retry. |
| `502` "solver returned no token" | The challenge failed (site is hard-challenging your IP/proxy, or the headless fingerprint was flagged). Try a residential proxy, or `HEADLESS=0` to always use the visible browser. |
| `504` timeout | Solve exceeded `SOLVE_TIMEOUT_MS`. Slow site or overloaded machine — raise the budget or add workers. |
| Workers keep restarting (`exited (...); restarting in 3s`) | Chrome cannot launch. Check `CHROME_PATH` / `CHROME_ARGS_EXTRA`; in Docker the container runs as root and needs `--no-sandbox`. |
| Every solve on a site is ~2× slower | The host challenged the headless fingerprint once; the worker now uses the visible fallback there (by design, persisted in `SOLVER_STATE_FILE`). |
| `401` on `/solve` | `API_KEY` is set — send `X-API-Key: <key>` or `Authorization: Bearer <key>`. |
| `429` on `/solve` | Over `MAX_INFLIGHT` concurrent requests — raise the limit or add workers. |

---

## Docker

```bash
docker compose up --build -d          # http://127.0.0.1:8082
docker compose logs -f solver
```

The image (`node:22-bookworm-slim` + Chromium + Xvfb + `dumb-init`) runs hub, API and workers in one container. Worker state (fingerprint memory, Chrome profiles) lives in the `solver-state` volume mounted at `/app/.state`. Scale with `SOLVER_INSTANCES`; each worker is one Chromium (~250–400 MB RAM).

The container runs as root, so `CHROME_ARGS_EXTRA` must include `--no-sandbox` — the image ships that default (`--no-sandbox,--disable-dev-shm-usage,--disable-gpu`, override via deploy-time env if needed), and compose sets the same value explicitly. The bundled `solver-chrome` Xvfb wrapper makes the visible fingerprint fallback work without a real display.

## Railway

`railway.json` builds the Dockerfile, starts `node server.mjs`, and health-checks `/health` (300 s timeout, `ON_FAILURE` restarts). Railway injects `PORT` and the server binds it — just set `SOLVER_INSTANCES`, `API_KEY`, `DEFAULT_PROXY`, etc. as service variables. Use a larger instance size for many workers; RAM is the binding constraint. To persist worker state across deploys, attach a Railway Volume mounted at `/app/.state` (Railway's builder rejects Dockerfile `VOLUME` directives, so the image cannot declare it for you).

## Smoke test

`smoke-test.mjs` exercises the hub and HTTP API end-to-end using scripted fake solvers over WebSocket (no real Chrome needed): routes and validation, API-key auth (it spawns its own extra instance on `PORT+2`), 502 empty-token handling and pool reuse, sequential + parallel solves, 504 timeouts, 429 capacity gating, keepalive, and teardown. It expects a server already running with `SOLVER_INSTANCES=0` (it registers its own solvers), in two phases:

```bash
# terminal 1 - hub + API only; SOLVE_TIMEOUT_MS=1200 lets the test trip timeouts
SOLVER_INSTANCES=0 SOLVE_TIMEOUT_MS=1200 PORT=8091 node server.mjs

# terminal 2 - phase 1 (full matrix, default inflight cap)
node smoke-test.mjs 8091 1        # ALL CHECKS PASSED, exit code 0

# terminal 1 - restart with a one-request cap, then phase 2 (429 gating)
MAX_INFLIGHT=1 PORT=8092 node server.mjs
node smoke-test.mjs 8092 2        # ALL CHECKS PASSED, exit code 0
```

---

## Contributing

All contributions are very welcome. If you have a way to improve this project, please share with issues, pull requests, etc.

---
