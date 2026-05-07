# Build Hermes as a Windows onedir executable (PyInstaller).
# Run from repository root in PowerShell:
#   .\scripts\build_windows_exe.ps1
#
# Prerequisites: Python 3.11+ with project deps installed (editable install recommended).

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$Py = $null
if (Test-Path (Join-Path $Root ".venv\Scripts\python.exe")) {
    $Py = Join-Path $Root ".venv\Scripts\python.exe"
} else {
    $Py = "python"
}

Write-Host "Using Python: $Py"
& $Py -m pip install -q -e ".[cli,web,pty]" "pyinstaller>=6.3,<7"

$Spec = Join-Path $Root "packaging\pyinstaller\hermes.spec"
& $Py -m PyInstaller --noconfirm --clean $Spec

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Done. Run: $(Join-Path $Root 'dist\hermes\hermes.exe') --help"
