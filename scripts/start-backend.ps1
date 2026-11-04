# Starts the local Swachh Safar FastAPI backend on this PC (loopback only: 127.0.0.1:8000).
# The phone never connects to this port directly; the HTTPS PWA host (start-pwa.ps1) forwards /api to it.
#
#   powershell -ExecutionPolicy Bypass -File scripts\start-backend.ps1
#
# Configuration: backend\.env (SQLite database in backend\var\swachh_local.db). Migrations are applied first
# and are a no-op when the database is already current.
$ErrorActionPreference = 'Stop'
$backend = Join-Path $PSScriptRoot '..\backend' | Resolve-Path
$python = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { throw "Python environment missing: create it with  uv venv --python 3.12 backend\.venv  and install the backend dependencies." }
if (-not (Test-Path (Join-Path $backend '.env'))) { throw "backend\.env is missing." }

Push-Location $backend
try {
    & $python -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Database migration failed (exit $LASTEXITCODE). The database was left at its previous version." }
    # One process: SQLite serialises writers; several workers would only queue on the same lock.
    & $python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
} finally {
    Pop-Location
}
