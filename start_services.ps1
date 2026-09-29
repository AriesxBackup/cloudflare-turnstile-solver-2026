# start_services.ps1
# Production startup for the Turnstile solve pipeline.
#
#   * The solver launches and owns its own HEADLESS Chrome (MANAGE_BROWSER=1).
#   * Set HEADLESS=0 to run with a visible browser window for debugging.
#   * Optional auth: uncomment the API_KEY line below to protect /solve.
#   * The token server must be running (cd cf-turnstile-bypass/token-server; cargo run --release).
#     If it is not up yet, the solver now reconnects on its own, so it self-heals.
#
# Usage:  .\start_services.ps1
#         .\stop_services.ps1   (stops solver + api + solver-spawned Chrome)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$env:MANAGE_BROWSER = "1"
if (-not $env:HEADLESS) { $env:HEADLESS = "1" }
# Dedicated port for the solver-owned headless Chrome (9222 is often taken by a
# manual debugging Chrome; do NOT reuse it or the solver would attach to it).
if (-not $env:CDP_BASE) { $env:CDP_BASE = "http://127.0.0.1:9231" }
# Explicit default so a stale TOKEN_SERVER_URL in the calling shell cannot
# silently point the services at the wrong WebSocket.
if (-not $env:TOKEN_SERVER_URL) { $env:TOKEN_SERVER_URL = "ws://127.0.0.1:8081" }
# Uncomment to require an API key on every /solve call:
# if (-not $env:API_KEY) { $env:API_KEY = "change-me" }

# Warn (don't fail) if the token server is down; the solver will keep retrying.
$probe = New-Object System.Net.Sockets.TcpClient
try {
    $probe.Connect("127.0.0.1", 8081); $probe.Close()
} catch {
    Write-Warning "Token server not reachable on 127.0.0.1:8081 - start it first, or the solver will keep retrying."
}

Remove-Item (Join-Path $root "cdp_solver_out.log"), (Join-Path $root "cdp_solver_err.log"),
           (Join-Path $root "api_out.log"),    (Join-Path $root "api_err.log") -Force -ErrorAction SilentlyContinue

Start-Process -FilePath "node" -ArgumentList "cdp_solver.mjs" -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $root "cdp_solver_out.log") `
    -RedirectStandardError  (Join-Path $root "cdp_solver_err.log") -WindowStyle Hidden
Start-Process -FilePath "node" -ArgumentList "api_server.mjs" -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $root "api_out.log") `
    -RedirectStandardError  (Join-Path $root "api_err.log") -WindowStyle Hidden

Start-Sleep -Seconds 5
Write-Host ""
Write-Host "Turnstile solve services started"
Write-Host "  headless=$env:HEADLESS  manage_browser=1  cdp_base=$env:CDP_BASE  token_server=$env:TOKEN_SERVER_URL"
Write-Host "  POST http://127.0.0.1:8082/solve   body: {""sitekey"", ""url"", ""action""?, ""proxy""?}"
Write-Host "  GET  http://127.0.0.1:8082/health"
Write-Host "  Logs: cdp_solver_out.log / api_out.log"
