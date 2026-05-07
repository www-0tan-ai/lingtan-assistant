# Build 0tan desktop: PyInstaller sidecar + electron-builder portable EXE (Windows x64).
# Run from repository root:
#   .\scripts\build_windows_electron_desktop.ps1
#
# Output:
#   dist\hermes-electron-sidecar\   — Python sidecar (embedded under resources\sidecar)
#   dist-electron-pack\0tan-*-portable.exe  — single-file portable launcher
#
# First run creates 0tan_data\ next to the EXE (defaults from bundled otan_desk templates).

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$Py = if (Test-Path (Join-Path $Root ".venv\Scripts\python.exe")) {
    Join-Path $Root ".venv\Scripts\python.exe"
} else { "python" }

Write-Host "==> Python: $Py"

Write-Host "==> pip install (cli + electron-shell + builder deps)"
& $Py -m pip install -q -e ".[cli,electron-shell]" "pyinstaller>=6.3,<7"

Write-Host "==> PyInstaller: hermes-electron-sidecar"
& $Py -m PyInstaller --noconfirm --clean (Join-Path $Root "packaging\pyinstaller\hermes_electron_sidecar.spec")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ElectronDir = Join-Path $Root "electron"
Set-Location $ElectronDir

Write-Host "==> npm install (electron + electron-builder)"
& npm install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> electron-builder portable"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
& npm run pack:win
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location $Root
Write-Host ""
Write-Host "Done. Portable EXE under: $(Join-Path $Root 'dist-electron-pack')"
Get-ChildItem (Join-Path $Root "dist-electron-pack") -Filter "0tan*.exe" | ForEach-Object { Write-Host "  $($_.FullName)" }
