# stop_services.ps1
# Stops the solver, the API server, and any Chrome instances the solver spawned
# (managed headless default browser + per-proxy browsers).

$ErrorActionPreference = "SilentlyContinue"

# Stop our node processes.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*cdp_solver.mjs*" -or $_.CommandLine -like "*api_server.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Stop Chrome instances launched by the solver (managed + fallback + proxy profiles).
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -like "*chrome-solver*" -or $_.CommandLine -like "*browser_profiles*proxy_*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host "Stopped solver, api, and solver-spawned Chrome instances."
