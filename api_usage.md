# Turnstile Solve API

HTTP front-end over the existing token-server solve pipeline.

## Architecture

```
POST /solve ──► api_server.mjs ──(ws header-1, fields: url/sitekey/action)──► token-server (ws://127.0.0.1:8081)
      ▲                                                                             │
      └───────────────(ws header-0, token)◄────────────────── cdp_solver.mjs ◄──────┘
                                                                   │ CDP
                                                              solver-owned headless Chrome :9231
                                                              (+ visible fallback browser :9230)
```

- `cdp_solver.mjs` drives a real Chrome via CDP: navigates the tab to the requested
  `url`, ensures `window.turnstile` is loaded, renders a hidden widget with the
  requested `sitekey`/`action`, executes it, and returns the token.
- `api_server.mjs` accepts HTTP requests and translates each into a header-1 solve
  request on the token-server WebSocket, returning the minted token as JSON.

## Start

```powershell
# Production (recommended): headless, self-managed Chrome
.\start_services.ps1          # -> solver + API on 127.0.0.1:8082
.\stop_services.ps1           # teardown

# Manual (debugging)
# 1) token server (if not already running) — cd cf-turnstile-bypass/token-server && cargo run --release
# 2) solver + API
Start-Process node cdp_solver.mjs -RedirectStandardOutput cdp_solver_out.log -RedirectStandardError cdp_solver_err.log
Start-Process node api_server.mjs  -RedirectStandardOutput api_out.log          -RedirectStandardError api_err.log
```

Both services now **self-heal**: if the token server or Chrome is down at startup
(or restarts later), the solver keeps retrying and re-registers automatically
instead of exiting.

## Configuration (env vars)

| Var | Applies to | Default | Purpose |
|-----|-----------|---------|---------|
| `CDP_BASE` | solver | `http://127.0.0.1:9231` | Chrome debugging endpoint (9231 = dedicated solver-owned headless port; 9222 is a manual-debug Chrome) |
| `TOKEN_SERVER_URL` | both | `ws://127.0.0.1:8081` | Token-server WebSocket |
| `CHROME_PATH` | solver | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Chrome executable for spawned instances |
| `HEADLESS` | solver | `1` | `"1"` headless with visible auto-fallback; `"0"` all visible |
| `MANAGE_BROWSER` | solver | off | `"1"` = solver launches+owns its own Chrome at `CDP_BASE` |
| `SOLVE_TIMEOUT_MS` | solver | `55000` | In-page token poll budget |
| `NAV_TIMEOUT_MS` | solver | `45000` | Page navigation budget |
| `REQUEST_TIMEOUT_MS` | solver | `110000` | Whole-request watchdog (prevents a hung CDP call from blocking the queue) |
| `RECONNECT_MS` | solver | `3000` | Token-server reconnect delay |
| `API_PORT` | api | `8082` | HTTP port |
| `API_HOST` | api | `127.0.0.1` | Bind address (`0.0.0.0` exposes to the network) |
| `API_KEY` | api | unset | If set, `/solve` requires `X-API-Key` or `Authorization: Bearer <key>` |
| `SOLVE_TIMEOUT_MS` | api | `120000` | HTTP-level solve budget |
| `TOKEN_FILE` | api | `./turnstile_token.txt` | Token mirror; `""` disables |

### Securing the API

By default the API binds **127.0.0.1 only** (loopback). To require a key:

```powershell
$env:API_KEY = "a-long-random-secret"
node api_server.mjs
# client:
curl.exe -X POST http://127.0.0.1:8082/solve -H "X-API-Key: a-long-random-secret" -H "Content-Type: application/json" -d @payload.json
```

## Usage

```powershell
curl.exe -X POST http://127.0.0.1:8082/solve -H "Content-Type: application/json" -d @- <<'EOF'
{
  "sitekey": "0x4AAAAAAE0cgpbRIy-ljERB",
  "url": "https://www.languageline.com/bill-pay",
  "action": "ll_payment",
  "proxy": ""
}
EOF
```

Response:

```json
{
  "success": true,
  "token": "0.XXXXX...",
  "proxy": "",
  "solve_ms": 3748,
  "url": "https://www.languageline.com/bill-pay",
  "sitekey": "0x4AAAAAAE0cgpbRIy-ljERB",
  "action": "ll_payment"
}
```

The latest token is also mirrored to `./turnstile_token.txt`.

## Endpoints

| Method | Path      | Description                                                       |
|--------|-----------|-------------------------------------------------------------------|
| POST   | `/solve`  | Body: `{ "sitekey", "url", "action"?, "proxy"? }` → token JSON    |
| GET    | `/health` | `{ ok, uptime_ms, busy, ws_state }`                               |
| GET    | `/`       | Plain-text usage                                                  |

## Response codes

| Code | Meaning                                                                    |
|------|----------------------------------------------------------------------------|
| 200  | `success: true`, token returned                                            |
| 400  | Bad request: invalid JSON / missing or malformed `url` / `sitekey`         |
| 502  | Solver failed: `code: "NO_TOKEN"` (interactive challenge, invalid sitekey, or sitekey not authorized for this domain) or `SOLVE_FAILED` |
| 503  | No solver available                                                         |
| 504  | Solve timed out                                                             |

## Notes & limitations

- **Headless + auto visible-fallback**: the solver runs its managed Chrome with
  `--headless=new` by default. If Cloudflare's risk engine serves an interactive
  challenge to the headless fingerprint (measured: `www.languageline.com/bill-pay`
  with this sitekey returns NO_TOKEN headless but a real token in ~13 s visible),
  the solver **retries that solve once with a visible fallback Chrome** and then
  remembers the host, so later solves go straight to the fallback (~13 s). The
  fallback Chrome is a single shared window (`.chrome-solver-fallback` profile).
  Set `HEADLESS=0` to run everything visible and skip the fallback entirely.
- The sitekey must be **domain-authorized for `url`** — Turnstile mints tokens only
  for the hostnames the sitekey owner registered. A valid-format but unauthorized
  sitekey yields a clean 502 `NO_TOKEN`.
- For sites that do **not** already load `challenges.cloudflare.com/turnstile`,
  the solver injects the script; if the site's CSP blocks it, the solve fails
  (`NO_TOKEN`). Sites that already use Turnstile work out of the box.
- If the visitor's risk engine serves an **interactive challenge**, no token is
  produced without human interaction; the request times out (504) or fails (502).
- `proxy` is transmitted through the pipeline and, when non-empty, lazily launches
  a dedicated Chrome with `--proxy-server=<proxy>` (new profile/port per proxy).
  Empty proxy uses the default browser (managed headless when `MANAGE_BROWSER=1`).
- Requests are serialized: concurrent `/solve` calls are queued in order
  (~1 solve every 3–8 s). For more throughput, run additional solver instances;
  the token server balances across them.
- The API does **not** verify tokens via Cloudflare's `siteverify` endpoint (that
  requires the site's secret key); it returns the freshly minted token as-is.
- The token server itself has no auth on its WebSocket — keep it on localhost.
