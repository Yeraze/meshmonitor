---
id: news-2026-02-21-auto-upgrade-sidecar-fix
title: 'Auto-Upgrade Sidecar: One-Time Action Required'
date: '2026-02-21T18:00:00Z'
category: maintenance
priority: important
minVersion: 3.6.5
---
MeshMonitor v3.6.5 fixes a bug where **Docker port mappings were lost after auto-upgrades** via the sidecar watchdog ([#1888](https://github.com/Yeraze/meshmonitor/issues/1888)).

## What Changed

The upgrade watchdog script has been simplified to always use `docker compose up -d --force-recreate` when recreating containers. A fragile legacy code path that attempted to reverse-engineer container configuration from `docker inspect` output has been removed. This eliminates the root cause of lost port mappings, volumes, and environment variables after auto-upgrades.

## Action Required

Because the watchdog script is embedded inside the sidecar container image, **existing sidecar containers must be recreated once** to pick up the fix. Run the following from your Docker Compose directory:

```
docker compose -f docker-compose.yml -f docker-compose.upgrade.yml pull
docker compose -f docker-compose.yml -f docker-compose.upgrade.yml up -d
```

If you use a single combined compose file (e.g., from the Docker Configurator), adjust the command accordingly:

```
docker compose pull
docker compose up -d
```

After this one-time update, all future auto-upgrades will correctly preserve your port mappings, volumes, and environment variables.

## Who Is Affected

Only users who have the **auto-upgrade sidecar** (`meshmonitor-upgrader`) enabled. If you don't use the auto-upgrade feature, no action is needed.
