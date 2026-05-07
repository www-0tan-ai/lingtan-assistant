# Build Hermes native Qt GUI (PyInstaller onedir, no browser).
# Run from repo root:
#   .\scripts\build_windows_gui.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$Py = if (Test-Path (Join-Path $Root ".venv\Scripts\python.exe")) {
    Join-Path $Root ".venv\Scripts\python.exe"
} else { "python" }

& $Py -m pip install -q -e ".[cli,desktop]" "pyinstaller>=6.3,<7"
& $Py -m PyInstaller --noconfirm --clean (Join-Path $Root "packaging\pyinstaller\hermes_gui.spec")

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Output: $(Join-Path $Root 'dist\hermes-gui\hermes-gui.exe')"
