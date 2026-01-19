# Release Notes - v3.0.0 "MultiDatabase"

## Overview

MeshMonitor 3.0.0 is a major release introducing **multi-database support**, allowing you to choose between SQLite (default), PostgreSQL, or MySQL/MariaDB as your database backend. This release also includes numerous new features, bug fixes, and improvements across the entire application.

## Highlights

- **PostgreSQL and MySQL/MariaDB Support** - Enterprise-ready database options with full feature parity
- **Database Migration Tool** - Seamlessly migrate your existing SQLite database to PostgreSQL or MySQL
- **Customizable Tapback Reactions** - Configure your own set of emoji reactions
- **Script Metadata Support** - Enhanced UI display for user scripts with descriptions and icons
- **Auto-Traceroute for All Databases** - PostgreSQL and MySQL now support automatic traceroute functionality
- **PKI Key Management** - Automatic detection and repair of PKI key mismatches

---

## Breaking Changes

### Database Architecture
- All database methods are now async to support multiple database backends
- If you have custom integrations using the database API, update to use the new async methods

### Node.js Requirements
- Node 18 is no longer officially supported
- Minimum recommended version: Node 20.x
- Officially tested on: Node 20.x and 22.x

---

## Major Features

### Multi-Database Support
- [#1460](https://github.com/Yeraze/meshmonitor/pull/1460) - Release v3.0.0: PostgreSQL and MySQL Database Support
- [#1404](https://github.com/Yeraze/meshmonitor/pull/1404) - Add PostgreSQL support as optional database backend
- [#1405](https://github.com/Yeraze/meshmonitor/pull/1405) - Add MySQL/MariaDB support as database backend

Configure via `DATABASE_URL` environment variable:
```bash
# PostgreSQL
DATABASE_URL=postgres://user:password@host:5432/meshmonitor

# MySQL/MariaDB
DATABASE_URL=mysql://user:password@host:3306/meshmonitor

# SQLite (default - no configuration needed)
```

### Database Migration
- [#1485](https://github.com/Yeraze/meshmonitor/pull/1485) - Drop default before changing column type in PostgreSQL
- [#1489](https://github.com/Yeraze/meshmonitor/pull/1489) - PostgreSQL/MySQL support for auto-traceroute
- [#1473](https://github.com/Yeraze/meshmonitor/pull/1473) - PostgreSQL/MySQL support for API token management
- [#1440](https://github.com/Yeraze/meshmonitor/pull/1440) - PostgreSQL/MySQL support for sync database methods
- [#1438](https://github.com/Yeraze/meshmonitor/pull/1438) - Async methods for PostgreSQL/MySQL traceroute log and audit
- [#1436](https://github.com/Yeraze/meshmonitor/pull/1436) - Update tests for async database methods
- [#1412](https://github.com/Yeraze/meshmonitor/pull/1412) - PostgreSQL/MySQL cache sync for node modification methods

### New Features
- [#1482](https://github.com/Yeraze/meshmonitor/pull/1482) - Customizable tapback emoji reactions in settings
- [#1492](https://github.com/Yeraze/meshmonitor/pull/1492) - Script metadata support for enhanced UI display
- [#1435](https://github.com/Yeraze/meshmonitor/pull/1435) - Show channel ID for encrypted packets in Packet Monitor
- [#1439](https://github.com/Yeraze/meshmonitor/pull/1439) - Show session passkey status for remote nodes
- [#1444](https://github.com/Yeraze/meshmonitor/pull/1444) - Add uptimeSeconds to v1 nodes API response
- [#1403](https://github.com/Yeraze/meshmonitor/pull/1403) - Battery status monitor auto-responder script
- [#1396](https://github.com/Yeraze/meshmonitor/pull/1396) - Add Security configuration section to Device page
- [#1394](https://github.com/Yeraze/meshmonitor/pull/1394) - Add ability to request neighbor info from remote nodes
- [#1389](https://github.com/Yeraze/meshmonitor/pull/1389) - Add Node Hops Calculation setting
- [#1387](https://github.com/Yeraze/meshmonitor/pull/1387) - Add node opacity dimming based on last heard time
- [#1379](https://github.com/Yeraze/meshmonitor/pull/1379) - Display last traceroute in node popup on map
- [#1377](https://github.com/Yeraze/meshmonitor/pull/1377) - Add GPS accuracy circles to map
- [#1376](https://github.com/Yeraze/meshmonitor/pull/1376) - Filter CLIENT_MUTE from relay modal and mark router nodes
- [#1367](https://github.com/Yeraze/meshmonitor/pull/1367) - Add GPS satellites in view as telemetry graph
- [#1357](https://github.com/Yeraze/meshmonitor/pull/1357) - Add PUID/PGID environment variable support for Docker
- [#1352](https://github.com/Yeraze/meshmonitor/pull/1352) - Navigate to channel/DM when clicking push notification
- [#1349](https://github.com/Yeraze/meshmonitor/pull/1349) - Add auto key management for PKI key mismatch repair
- [#1348](https://github.com/Yeraze/meshmonitor/pull/1348) - Detect and display PKI key mismatch errors
- [#1329](https://github.com/Yeraze/meshmonitor/pull/1329) - Log outgoing mesh commands to Packet Monitor
- [#1325](https://github.com/Yeraze/meshmonitor/pull/1325) - Automated database maintenance feature
- [#1398](https://github.com/Yeraze/meshmonitor/pull/1398) - Display MQTT indicator for unknown SNR in traceroutes

---

## Bug Fixes

### Database & Backend
- [#1491](https://github.com/Yeraze/meshmonitor/pull/1491) - Prevent PKI key corruption from addContact messages
- [#1483](https://github.com/Yeraze/meshmonitor/pull/1483) - Wait for database initialization before accepting requests
- [#1479](https://github.com/Yeraze/meshmonitor/pull/1479) - Fix DM routing, SQLite schema, and purge validation
- [#1477](https://github.com/Yeraze/meshmonitor/pull/1477) - Add logging for mark-as-read operations
- [#1476](https://github.com/Yeraze/meshmonitor/pull/1476) - Convert booleans to integers for SQLite binding
- [#1461](https://github.com/Yeraze/meshmonitor/pull/1461) - Address type safety issues from v3.0 PR review
- [#1445](https://github.com/Yeraze/meshmonitor/pull/1445) - Don't send config while radio is restarting
- [#1441](https://github.com/Yeraze/meshmonitor/pull/1441) - Include reset-admin.mjs script in Docker image
- [#1395](https://github.com/Yeraze/meshmonitor/pull/1395) - Improve Remote Admin config load reliability
- [#1393](https://github.com/Yeraze/meshmonitor/pull/1393) - Add detection and logging for virtual node ID mismatches
- [#1385](https://github.com/Yeraze/meshmonitor/pull/1385) - Correct RX/TX direction for packets from local node
- [#1381](https://github.com/Yeraze/meshmonitor/pull/1381) - Use precision_bits for accuracy circles instead of gpsAccuracy
- [#1359](https://github.com/Yeraze/meshmonitor/pull/1359) - Filter out internal ADMIN_APP and ROUTING_APP packets from Packet Monitor
- [#1353](https://github.com/Yeraze/meshmonitor/pull/1353) - Auto Responder replies now work on channels
- [#1347](https://github.com/Yeraze/meshmonitor/pull/1347) - Cache telemetry types query to reduce poll endpoint latency
- [#1346](https://github.com/Yeraze/meshmonitor/pull/1346) - Use WebSocket message data directly instead of cache invalidation
- [#1343](https://github.com/Yeraze/meshmonitor/pull/1343) - Delete broadcast messages when purging node from database
- [#1334](https://github.com/Yeraze/meshmonitor/pull/1334) - Use consistent nullish coalescing for txEnabled config
- [#1333](https://github.com/Yeraze/meshmonitor/pull/1333) - Add missing txEnabled fields to Remote Admin LoRa config

### Frontend & UI
- [#1494](https://github.com/Yeraze/meshmonitor/pull/1494) - Clarify device-reported node counts in graph labels
- [#1486](https://github.com/Yeraze/meshmonitor/pull/1486) - Show most recent message timestamp in Recent Activity
- [#1480](https://github.com/Yeraze/meshmonitor/pull/1480) - Fix orphaned security issue details display
- [#1451](https://github.com/Yeraze/meshmonitor/pull/1451) - Remove duplicate tray icon on Windows
- [#1448](https://github.com/Yeraze/meshmonitor/pull/1448) - Set default height for messages container with internal scroll
- [#1417](https://github.com/Yeraze/meshmonitor/pull/1417) - Improve push notification scroll to message with retries
- [#1419](https://github.com/Yeraze/meshmonitor/pull/1419) - Handle empty/corrupted desktop config files gracefully

### Networking & CORS
- [#1466](https://github.com/Yeraze/meshmonitor/pull/1466) - Correct IP address byte order for static WiFi config
- [#1465](https://github.com/Yeraze/meshmonitor/pull/1465) - Allow X-CSRF-Token header in CORS configuration

### Internationalization
- [#1467](https://github.com/Yeraze/meshmonitor/pull/1467) - Update purge warning to include local database
- [#1450](https://github.com/Yeraze/meshmonitor/pull/1450) - Add missing channel edit translations
- [#1421](https://github.com/Yeraze/meshmonitor/pull/1421) - Add missing channel config translations for Admin Commands
- [#1402](https://github.com/Yeraze/meshmonitor/pull/1402) - Correct incomplete githubPath URLs in user scripts gallery

---

## Documentation

- [#1481](https://github.com/Yeraze/meshmonitor/pull/1481) - Add WX Weather Alerts and Carrier Outage scripts to gallery
- [#1418](https://github.com/Yeraze/meshmonitor/pull/1418) - Add Indiana Mesh to site gallery
- [#1392](https://github.com/Yeraze/meshmonitor/pull/1392) - Add Radio Identity + QTH script to user scripts gallery
- [#1363](https://github.com/Yeraze/meshmonitor/pull/1363) - Fix MESHTASTIC_STALE_CONNECTION_TIMEOUT default value
- [#1361](https://github.com/Yeraze/meshmonitor/pull/1361) - Update documentation for protocol constants and packet filtering
- [#1320](https://github.com/Yeraze/meshmonitor/pull/1320) - Fix meshtasticd documentation with correct CLI options

---

## Translations

Thanks to our translation community on Hosted Weblate for continuous improvements:
- [#1468](https://github.com/Yeraze/meshmonitor/pull/1468), [#1446](https://github.com/Yeraze/meshmonitor/pull/1446), [#1422](https://github.com/Yeraze/meshmonitor/pull/1422), [#1407](https://github.com/Yeraze/meshmonitor/pull/1407)
- [#1388](https://github.com/Yeraze/meshmonitor/pull/1388), [#1380](https://github.com/Yeraze/meshmonitor/pull/1380), [#1369](https://github.com/Yeraze/meshmonitor/pull/1369), [#1365](https://github.com/Yeraze/meshmonitor/pull/1365)
- [#1345](https://github.com/Yeraze/meshmonitor/pull/1345), [#1342](https://github.com/Yeraze/meshmonitor/pull/1342), [#1332](https://github.com/Yeraze/meshmonitor/pull/1332), [#1327](https://github.com/Yeraze/meshmonitor/pull/1327)
- [#1319](https://github.com/Yeraze/meshmonitor/pull/1319)

---

## Refactoring & Infrastructure

- [#1360](https://github.com/Yeraze/meshmonitor/pull/1360) - Extract Meshtastic protocol constants to shared file
- [#1457](https://github.com/Yeraze/meshmonitor/pull/1457) - Use npm install instead of npm ci in CI
- [#1456](https://github.com/Yeraze/meshmonitor/pull/1456) - Add --legacy-peer-deps to npm ci commands

---

## Migration Guide

### Upgrading from v2.x

1. **Backup your database** before upgrading
2. The existing SQLite database will continue to work without changes
3. To migrate to PostgreSQL or MySQL, use the migration tool:
   ```bash
   # Set up target database
   export DATABASE_URL=postgres://user:password@host:5432/meshmonitor

   # Run migration
   npm run migrate-db
   ```

### New Database Support

See the [Multi-Database Documentation](./docs/configuration/database.md) for detailed setup instructions for PostgreSQL and MySQL.

---

## Testing

- All 76+ tests passing
- TypeScript compilation successful
- System tests passing including new database migration tests
- Docker builds tested

---

## Contributors

Thanks to all contributors who made this release possible, including:
- The MeshMonitor core team
- Translation contributors via Hosted Weblate
- Community bug reporters and testers

---

## Full Changelog

For the complete list of changes, see the [GitHub Releases](https://github.com/Yeraze/meshmonitor/releases) page or compare [v2.22.0...v3.0.0](https://github.com/Yeraze/meshmonitor/compare/v2.22.0...v3.0.0).
