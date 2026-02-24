# Release Notes - v3.0.1 Hotfix

## Overview

MeshMonitor 3.0.1 is a hotfix release addressing several bugs reported after the v3.0.0 "MultiDatabase" release.

---

## Bug Fixes

### Desktop Application
- [#1509](https://github.com/Yeraze/meshmonitor/pull/1509) - **Fix Windows desktop app startup crash** - Include missing `db` directory in Tauri bundle, fixing "Cannot find module 'dist/db/drivers/sqlite.js'" error (Fixes [#1508](https://github.com/Yeraze/meshmonitor/issues/1508))

### User Interface
- [#1507](https://github.com/Yeraze/meshmonitor/pull/1507) - **Fix Audit Logs "Invalid Date" display** - Correctly handle timestamp format in audit log entries (Fixes [#1505](https://github.com/Yeraze/meshmonitor/issues/1505))
- [#1507](https://github.com/Yeraze/meshmonitor/pull/1507) - **Hide Database Maintenance section for PostgreSQL/MySQL** - The maintenance feature is SQLite-specific; now correctly hidden for other database backends
- [#1507](https://github.com/Yeraze/meshmonitor/pull/1507) - **Fix SQLite notification preferences save error** - Correct Drizzle schema column names to match actual SQLite table structure
- [#1512](https://github.com/Yeraze/meshmonitor/pull/1512) - **Fix accuracy circles showing for hidden nodes** - Apply same filters (hide incomplete nodes, hide MQTT nodes) to accuracy and uncertainty circles (Fixes [#1411](https://github.com/Yeraze/meshmonitor/issues/1411))

### Enhancements
- [#1511](https://github.com/Yeraze/meshmonitor/pull/1511) - **Increase font size for hop count and message time** - Improved readability in Channels panel (Fixes [#1433](https://github.com/Yeraze/meshmonitor/issues/1433))

---

## Upgrade Instructions

### Docker
```bash
docker pull ghcr.io/yeraze/meshmonitor:3.0.1
docker compose down && docker compose up -d
```

### Helm
```bash
helm repo update
helm upgrade meshmonitor meshmonitor/meshmonitor --version 3.0.1
```

### Desktop
Download the latest installer from the [Releases page](https://github.com/Yeraze/meshmonitor/releases/tag/v3.0.1).

---

## Previous Release

For the full v3.0.0 "MultiDatabase" release notes including multi-database support, see the [v3.0.0 Release](https://github.com/Yeraze/meshmonitor/releases/tag/v3.0.0).
