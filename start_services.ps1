# start_services.ps1 - local dev launcher (Windows).
# Starts the all-in-one service (hub + API + solver workers). Railway/Docker do
# NOT need this; they run `node server.mjs` directly.
#
# Usage:  .\start_services.ps1
#         .\stop_services.ps1   (stops the service + solver-spawned Chrome)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not $env:PORT) { $env:PORT = "8082" }
if (-not $env:API_HOST) { $env:API_HOST = "127.0.0.1" }
# One worker = one Chrome = one solve at a time. More workers = more parallel solves.
if (-not $env:SOLVER_INSTANCES) { $env:SOLVER_INSTANCES = "1" }
if (-not $env:HEADLESS) { $env:HEADLESS = "1" }
if (-not $env:CDP_PORT_BASE) { $env:CDP_PORT_BASE = "9230" }
if (-not $env:FALLBACK_CDP_PORT_BASE) { $env:FALLBACK_CDP_PORT_BASE = "9329" }
# Uncomment to require an API key on every /solve call:
# $env:API_KEY = "change-me"
# Always-on proxy for every solve (colon form host:port:user:pass or URL form):
# $env:DEFAULT_PROXY = ""

Start-Process -FilePath "node" -ArgumentList "server.mjs" -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $root "server_out.log") `
    -RedirectStandardError  (Join-Path $root "server_err.log") -WindowStyle Hidden

Start-Sleep -Seconds 3
Write-Host ""
Write-Host "Turnstile solve service started (hub + api + $env:SOLVER_INSTANCES solver worker(s))"
Write-Host "  POST http://127.0.0.1:$env:PORT/solve   body: {""sitekey"", ""url"", ""action""?, ""proxy""?}"
Write-Host "  GET  http://127.0.0.1:$env:PORT/health"
Write-Host "  Logs: server_out.log / server_err.log"
