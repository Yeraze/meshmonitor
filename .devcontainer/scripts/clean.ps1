# Clean the dev container environment
# Usage: .\clean.ps1

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host 'Cleaning dev container environment...' -ForegroundColor Cyan

docker compose -f "$ScriptDir\..\docker-compose.yml" down -v 2>$null

$VscodeContainers = docker ps -aq --filter 'label=devcontainer.local_folder'
if ($VscodeContainers) {
    docker stop $VscodeContainers 2>$null
    docker rm $VscodeContainers 2>$null
}

$NameContainers = docker ps -aq --filter 'name=meshmonitor_devcontainer'
if ($NameContainers) {
    docker stop $NameContainers 2>$null
    docker rm $NameContainers 2>$null
}

docker volume ls -q --filter 'label=com.docker.compose.project=meshmonitor_devcontainer' | ForEach-Object { docker volume rm $_ 2>$null }
docker volume ls -q --filter 'name=meshmonitor_devcontainer' | ForEach-Object { docker volume rm $_ 2>$null }

Write-Host '' 
Write-Host 'Environment cleaned successfully!' -ForegroundColor Green
