# TODO List

## Current Sprint

## Completed Tasks

### Version 2.14.2 (Current Release)

- [x] Add VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS environment variable (#455, #474)
  - Security-first design with default disabled (false) for backward compatibility
  - Allows admin commands (ADMIN_APP, NODEINFO_APP) through virtual node when enabled
  - Enables multi-service scenarios (e.g., MeshMonitor + Home Assistant)
  - Updated environment.ts with new configuration option
  - Modified VirtualNodeServer to respect allowAdminCommands flag
  - Added comprehensive tests for admin command configuration
  - Updated Docker Compose Configurator with security warning
- [x] Fix hop count calculation in auto-acknowledge (#470, #471)
  - Enhanced hop count validation to check for both null and undefined values
  - Added validation that hopStart >= hopLimit before calculating
  - Added defensive check in RABBIT_HOPS using Math.max(0, numberHops)
  - Falls back to 0 for invalid or missing hop data
  - Prevents RangeError when using {RABBIT_HOPS} token
- [x] Add position precision tracking for multi-channel support (#473)
  - Database migration 020 adds position precision fields to nodes and telemetry tables
  - Track channel, precisionBits, gpsAccuracy, and HDOP for all positions
  - Smart upgrade/downgrade logic: always upgrade to higher precision, only downgrade after 12 hours
  - Enables precise location from secondary channels to be preferred over approximate primary channel positions
  - Logs precision upgrades/downgrades for debugging
- [x] Update TODOS.md documentation (#472, #469)
- [x] Run system tests
- [x] Create GitHub release (v2.14.2)

### Version 2.14.1

- [x] Update version in package.json to 2.14.1
- [x] Update version in Helm chart to 2.14.1
- [x] Regenerate package-lock.json
- [x] Fix missing solar_estimates table migration (#467)
  - Added import for migration 019 in database.ts
  - Added runSolarEstimatesMigration() method
  - Called migration in initialization sequence
- [x] Add manual solar fetch functionality
  - Added "Fetch Estimates Now" button to Settings page
  - Button appears in Solar Monitoring section when enabled
  - Uses existing POST /api/solar/trigger endpoint
  - Provides user feedback via toast notifications
- [x] Fix auto-acknowledge hop count calculation (#470, #471)
  - Enhanced hop count validation to check for both null and undefined values
  - Added validation that hopStart >= hopLimit before calculating
  - Added defensive check in RABBIT_HOPS using Math.max(0, numberHops)
  - Falls back to 0 for invalid or missing hop data
  - Prevents RangeError when using {RABBIT_HOPS} token
  - Fixes incorrect -7 value displayed for {NUMBER_HOPS}
- [x] Run system tests
- [x] Create pull request (#468)
- [x] Merge and create release (v2.14.1)

### Version 2.14.0

- [x] Update version in package.json to 2.14.0
- [x] Update version in Helm chart to 2.14.0
- [x] Regenerate package-lock.json
- [x] Create comprehensive solar monitoring documentation
- [x] Update main documentation page to highlight solar monitoring
- [x] Enhance settings documentation with solar configuration details
- [x] Run system tests
- [x] Create pull request (#465)
- [x] Merge and create release (v2.14.0)

#### Solar Monitoring Integration
- [x] Integration with forecast.solar API for solar production estimates (#463)
- [x] Automated hourly fetching via cron scheduler
- [x] Database migration 019 creating `solar_estimates` table
- [x] API endpoints for accessing solar estimate data
- [x] Translucent yellow overlay visualization on telemetry graphs (#464)
- [x] ComposedChart with dual Y-axes for mixed visualization
- [x] Nearest-neighbor timestamp matching algorithm
- [x] Auto-refresh solar data every 60 seconds
- [x] Solar estimates visible in graph tooltips
- [x] Complete documentation and configuration guide (#465)

#### Telemetry Management Enhancements
- [x] Configurable favorite telemetry storage period (1-365 days) (#462)
- [x] Configurable favorite telemetry viewing period (#462)
- [x] localStorage persistence for "Days to View" setting on Dashboard (#464)

### Version 2.13.4

- [x] Update version in package.json to 2.13.4
- [x] Update version in Helm chart to 2.13.4
- [x] Regenerate package-lock.json
- [x] Run system tests
- [x] Create pull request (#460)
- [x] Merge and create release (v2.13.4)

### Version 2.13.4 (Current Release)

#### Configuration Improvements
- [x] Add localhost to default ALLOWED_ORIGINS configuration (#458)
  - Changed default from empty array to `['http://localhost:8080', 'http://localhost:3001']`
  - Improves out-of-box experience for local development and testing
  - Still requires explicit configuration for production deployments
  - Files: src/server/config/environment.ts:282-288, .env.example, docs/configuration/index.md:81

#### Documentation Enhancements
- [x] Add interactive Docker Compose configurator to documentation (#454)

#### Bug Fixes
- [x] Fix traceroute visualization not updating when clicking different nodes (#457)
  - Issue: NodesTab memo comparison only checked null vs non-null for traceroutes
  - Fixed by adding reference comparison to detect when traceroute content changes (src/components/NodesTab.tsx:1110-1114)

#### Chores
- [x] Update TODOS.md with ALLOWED_ORIGINS configuration improvement (#459)

### Version 2.13.3

### Mobile UI Improvements

- [x] Add unread message indicator to dropdown on Messages page
- [x] Reflow Security page rows to 2 lines for mobile display
- [x] Break Device Backup modal onto 2 lines for mobile compatibility

### Virtual Node Enhancements

- [x] Add Virtual Node status block to Info page showing connection status and number of connected clients
- [x] Display IP addresses of connected Virtual Node clients when authenticated
- [x] Log Virtual Node connections in Audit system
- [x] Fix message status updates for messages sent through Virtual Node (currently showing as Pending despite receiving Ack's)
  - Added `virtualNodeRequestId` to ProcessingContext to preserve packet ID
  - Modified `processTextMessageProtobuf` to accept context parameter
  - Modified `processMeshPacket` to accept and pass context parameter
  - Updated call to `processTextMessageProtobuf` to pass context through (src/server/meshtasticManager.ts:1046)
  - Fixed context parameter passing in `processIncomingData` to `processMeshPacket` (src/server/meshtasticManager.ts:527)
  - Messages now store `requestId`, `wantAck`, and `deliveryState` for Virtual Node messages
- [x] Secure Virtual Node status endpoint to require authentication (src/server/server.ts:899)
