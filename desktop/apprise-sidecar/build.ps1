<#
.SYNOPSIS
    Build the frozen Apprise sidecar binary for the MeshMonitor desktop bundle (Windows).

.DESCRIPTION
    Produces apprise-api.exe (self-contained, no system Python required) and copies
    it into desktop/resources/binaries/ where the Tauri bundle picks it up alongside
    the Node sidecar. PyInstaller does not cross-compile, so this runs on the Windows
    CI runner to produce the Windows binary.

.EXAMPLE
    ./build.ps1
#>
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvDir   = Join-Path $ScriptDir '.venv'
$DestDir   = Join-Path $ScriptDir '..\resources\binaries'

Write-Host "==> Creating build venv at $VenvDir"
python -m venv $VenvDir
$Py = Join-Path $VenvDir 'Scripts\python.exe'

Write-Host "==> Installing build dependencies (apprise + pyinstaller)"
& $Py -m pip install --upgrade pip | Out-Null
& $Py -m pip install -r (Join-Path $ScriptDir 'requirements.txt')

Write-Host "==> Freezing apprise-api.py with PyInstaller"
Push-Location $ScriptDir
try {
    Remove-Item -Recurse -Force build, dist -ErrorAction SilentlyContinue
    & $Py -m PyInstaller --clean --noconfirm apprise-api.spec

    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    Copy-Item 'dist\apprise-api.exe' (Join-Path $DestDir 'apprise-api.exe') -Force

    $Size = [math]::Round((Get-Item (Join-Path $DestDir 'apprise-api.exe')).Length / 1MB, 1)
    Write-Host "==> Done. apprise-api.exe (${Size} MB) -> $DestDir\apprise-api.exe"
}
finally {
    Pop-Location
}
