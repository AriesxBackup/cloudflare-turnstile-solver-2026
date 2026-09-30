# stop_services.ps1 - stops the service and any Chrome instances it spawned.
$ErrorActionPreference = "SilentlyContinue"

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*server.mjs*" -or $_.CommandLine -like "*solver.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Solver-spawned Chrome (default + fallback + per-proxy profiles live under
# .state\). Two sweeps: killing the main browser process leaves its children
# running for a moment, so re-list and force-kill anything left.
for ($pass = 0; $pass -lt 2; $pass++) {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -like "*.state*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
}

Write-Host "Stopped service and solver-spawned Chrome instances."
