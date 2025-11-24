# Reset the dev container environment (clean and rebuild)
# Usage: .\reset.ps1

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Resetting dev container environment..."

# Run clean script
& "$ScriptDir\clean.ps1"

Write-Host "Rebuilding container image (no cache)..."
docker compose -f "$ScriptDir\..\docker-compose.yml" build --no-cache

Write-Host "Reset complete. You can now reopen the project in the container."
