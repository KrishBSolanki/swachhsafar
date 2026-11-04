# Serves the production PWA (dist) over HTTPS on the local network: https://192.168.1.9:4173
# and forwards /api to the local backend (start-backend.ps1, 127.0.0.1:8000).
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-pwa.ps1          # serve the existing build
#   powershell -ExecutionPolicy Bypass -File scripts\start-pwa.ps1 -Build   # rebuild first (production, not demo)
#
# Keep the address, port and certificate unchanged: the phone's local database belongs to this exact origin.
param([switch] $Build)
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..' | Resolve-Path
Push-Location $root
try {
    if (-not (Test-Path '.cert\dev-cert.pem') -or -not (Test-Path '.cert\dev-key.pem')) { throw ".cert\dev-cert.pem / dev-key.pem missing." }
    if ($Build) {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "Build failed." }
    }
    if (-not (Test-Path 'dist\index.html')) { throw "dist\index.html missing: run with -Build." }
    npm run preview:lan
} finally {
    Pop-Location
}
