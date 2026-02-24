# Stop the dev container
# Usage: .\stop.ps1

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host 'Stopping dev container...' -ForegroundColor Cyan

docker compose -f "$ScriptDir\..\docker-compose.yml" stop 2>$null

$VscodeContainers = docker ps -q --filter 'label=devcontainer.local_folder'
if ($VscodeContainers) {
    docker stop $VscodeContainers
}

$NameContainers = docker ps -q --filter 'name=meshmonitor_devcontainer'
if ($NameContainers) {
    docker stop $NameContainers
}

Write-Host 'Container(s) stopped successfully!' -ForegroundColor Green
