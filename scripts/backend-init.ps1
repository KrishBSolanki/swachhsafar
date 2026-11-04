# One-time (and safely repeatable) initialisation of the local backend database:
#   1. applies the database migrations,
#   2. creates the division (if it does not exist),
#   3. maps the Super Admin to an EXISTING Firebase account (if not mapped yet).
# Re-running with the same values changes nothing; conflicting values are refused, never overwritten.
# Nothing here creates or modifies Firebase accounts.
#
#   powershell -ExecutionPolicy Bypass -File scripts\backend-init.ps1 `
#     -DivisionCode JBP -DivisionName "Jabalpur Division" `
#     -EmpId SA001 -Name "Full Name" -Email "existing.firebase.user@example.com" [-FirebaseUid <uid>]
#
# Without -FirebaseUid the account links on its first sign-in, provided the Firebase account's e-mail is verified.
param(
    [Parameter(Mandatory)] [string] $DivisionCode,
    [Parameter(Mandatory)] [string] $DivisionName,
    [Parameter(Mandatory)] [string] $EmpId,
    [Parameter(Mandatory)] [string] $Name,
    [Parameter(Mandatory)] [string] $Email,
    [string] $FirebaseUid
)
$ErrorActionPreference = 'Stop'
$backend = Join-Path $PSScriptRoot '..\backend' | Resolve-Path
$python = Join-Path $backend '.venv\Scripts\python.exe'
Push-Location $backend
try {
    & $python -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "Database migration failed (exit $LASTEXITCODE)." }
    & $python -m app.cli create-division --code $DivisionCode --name $DivisionName
    if ($LASTEXITCODE -ne 0) { throw "Division step refused (exit $LASTEXITCODE); see the message above." }
    $admin = @('-m', 'app.cli', 'create-superadmin', '--division-code', $DivisionCode, '--emp-id', $EmpId, '--name', $Name, '--email', $Email)
    if ($FirebaseUid) { $admin += @('--firebase-uid', $FirebaseUid) }
    & $python @admin
    if ($LASTEXITCODE -ne 0) { throw "Super Admin step refused (exit $LASTEXITCODE); see the message above." }
} finally {
    Pop-Location
}
