# TODO List

## Current Sprint

### PostgreSQL Read Tracking Fix

**Completed:**
- [x] Add mark-as-read methods to NotificationsRepository (markChannelMessagesAsRead, markDMMessagesAsRead, markAllDMMessagesAsRead, markMessagesAsReadByIds)
- [x] Update database.ts to call async repo methods for PostgreSQL/MySQL instead of returning 0
- [x] Build and deploy to Docker container

**Summary:**
Fixed a bug where unread message indicators wouldn't clear when viewing channels/DMs on PostgreSQL databases. The mark-as-read functions were returning 0 immediately for PostgreSQL/MySQL with "not yet implemented" comments. Added proper implementations using raw SQL for efficient INSERT...SELECT operations with ON CONFLICT DO NOTHING.

---

### Server Start Notification Timing Fix

**Completed:**
- [x] Identified timing bug: server start notification sent before PostgreSQL database fully initialized
- [x] Added `await databaseService.waitForReady()` before sending server start notification
- [x] Wrapped notification code in async IIFE with error handling
- [x] Build and deploy to Docker container

**Summary:**
Fixed a bug where server start notifications (via Apprise/Pushover) weren't being sent to PostgreSQL users. The notification was being sent before the database was fully initialized, so the query for users with `notifyOnServerEvents` enabled returned 0 results. Now the notification waits for the database to be ready.

---

### Remote Admin LoRa Config Missing txEnabled Fields (#1328)

**Completed:**
- [x] Add txEnabled, overrideDutyCycle, paFanDisabled to LoRaConfigState interface
- [x] Add defaults to initial state (txEnabled: true to prevent accidental TX disable)
- [x] Update setLoRaConfig calls when loading config from remote node
- [x] Update handleSetLoRaConfig to include the new fields when saving
- [x] Add UI controls for txEnabled, overrideDutyCycle, paFanDisabled in Remote Admin
- [x] Add translation keys for new settings

**Summary:**
Fixed a bug where saving Remote Admin LoRa configuration would silently disable transmission (txEnabled=false). The issue was that txEnabled, overrideDutyCycle, and paFanDisabled were missing from the Remote Admin LoRa state, causing protobuf to default boolean fields to false when saving. Added all three fields to the state interface, load callbacks, save handler, and UI.

---

### Outgoing Mesh Commands in Packet Monitor (#1322)

**Completed:**
- [x] Database migration 045 - Add direction column to packet_log table
- [x] Update DbPacketLog interface with direction field
- [x] Update insertPacketLog to include direction in INSERT
- [x] Add logOutgoingPacket helper method to meshtasticManager
- [x] Add logging to sendTextMessage (TEXT_MESSAGE_APP)
- [x] Add logging to sendTraceroute (TRACEROUTE_APP)
- [x] Add logging to sendPositionRequest (POSITION_APP)
- [x] Add logging to sendNodeInfoRequest (NODEINFO_APP)
- [x] Add logging to sendAdminCommand (ADMIN_APP - remote only)
- [x] Update existing incoming packet logging with direction: 'rx'
- [x] Update PacketLog type definition with direction field
- [x] Update Packet Monitor UI with direction indicator column (TX/RX)
- [x] Add CSS styles for direction indicators (green RX, orange TX)
- [x] Add translation keys for direction column and tooltips

**Summary:**
Users can now see outgoing mesh commands (text messages, traceroutes, position/nodeinfo exchanges, and remote admin commands) in the Packet Monitor. A new "Dir" column displays TX (transmitted) or RX (received) with color coding. Local IP commands to the node (like wantConfig) are intentionally not logged.

---

### MQTT Client Proxy Integration (#1244)

**Completed:**
- [x] Add MQTT Proxy option to Docker Compose Configurator
  - New checkbox in Additional Settings section
  - Auto-enables Virtual Node when MQTT Proxy is selected
  - Generates sidecar container configuration
- [x] Add helper text to MQTT Client Proxy checkbox in Device Configuration
  - New translation key for MeshMonitor-specific instructions
  - Links to MQTT Proxy documentation
- [x] Create comprehensive MQTT Proxy documentation page
  - Overview and architecture diagram
  - Setup instructions with prerequisites
  - Configuration options table
  - Troubleshooting guide
  - Comparison with node's built-in MQTT
- [x] Update device.md with complete MQTT configuration documentation
  - Added TLS Enabled section
  - Added Proxy to Client (Client Proxy Mode) section
  - Added Map Reporting, Map Publish Interval, Map Position Precision sections
- [x] Update translation files (en, de, fr, es, ru, zh_Hans)
- [x] Add MQTT Proxy to VitePress sidebar navigation
- [x] Update configurator.md with MQTT Proxy information
- [x] Ensure LN4CY attribution throughout (credit in docker-compose, docs, UI)

**Summary:**
Integrated [LN4CY's MQTT Proxy](https://github.com/LN4CY/mqtt-proxy) as an optional Docker sidecar. The proxy routes MQTT traffic through MeshMonitor's Virtual Node instead of the node's WiFi, providing more reliable connectivity for nodes with poor WiFi (T-Deck, portable devices) or Serial/BLE connections.

---

### Node List Filter on Messages Page (#1185)

**Completed:**
- [x] Add new filter options to Messages page dropdown
  - "By Hops (Nearest First)" - sorts by hop count ascending, ignores favorites
  - "Favorites Only" - shows only favorite nodes, sorted by hops
  - "With Position" - shows only nodes with valid GPS position, sorted by hops
  - "Exclude Infrastructure" - hides Router, Repeater, Router Client, Router Late roles, sorted by hops
- [x] Add `isInfrastructureNode()` helper function to nodeHelpers.ts (roles 2, 3, 4, 11)
- [x] Add `hasValidPosition()` helper function to nodeHelpers.ts
- [x] Update dmFilter type in UIContext.tsx to include new filter values
- [x] Update MessagesTab.tsx with new filter/sort logic
- [x] Add translation strings to en.json
- [x] Build and deploy successful

**Summary:**
Added 4 new filter options to the Messages page node list, similar to what exists on the Node Map. Users can now filter by hops (nearest first), favorites only, nodes with position, or exclude infrastructure nodes. All new filters sort by hop count ascending.

---

### Replace GPL-licensed Session Store (#1177)

**Priority: HIGH** - License compatibility issue

The `better-sqlite3-session-store` package is GPL-3.0-only licensed, which conflicts with MeshMonitor's BSD-3-Clause license. This is actual code being imported and linked, not just data definitions.

**Tasks:**
- [ ] Write custom SQLite session store using `better-sqlite3` (MIT licensed)
- [ ] Implement express-session Store interface: `get`, `set`, `destroy`, `touch`
- [ ] Add session cleanup for expired sessions
- [ ] Remove `better-sqlite3-session-store` dependency
- [ ] Update `src/server/auth/sessionConfig.ts` to use new store
- [ ] Test session persistence across restarts
- [ ] Run system tests

**Reference:** The existing store is ~72 lines. We already use `better-sqlite3` directly (MIT licensed).

---

### WebSocket Real-Time Updates (#1184)

**Completed:**
- [x] Add socket.io and socket.io-client dependencies to package.json
- [x] Create dataEventEmitter.ts - server-side event emitter for mesh data changes
  - Batched telemetry emissions (1 second window) to reduce WebSocket traffic
  - Typed events: node:updated, message:new, channel:updated, telemetry:batch, connection:status, traceroute:complete, routing:update
- [x] Create webSocketService.ts - Socket.io server initialization
  - Share Express session for authentication
  - Respect BASE_URL for socket.io path
- [x] Modify server.ts to initialize WebSocket after HTTP server starts
- [x] Add event emissions to meshtasticManager.ts at key data insertion points
  - Emit on new text messages
  - Emit on node info updates
  - Emit on connection status changes
  - Emit on traceroute completion
  - Emit routing updates for ACK/NAK delivery status
- [x] Create useWebSocket.ts - client hook for WebSocket connection
  - Automatically update TanStack Query cache when events received
  - Handle reconnection and error states
- [x] Create WebSocketContext.tsx - React context for WebSocket state
  - Only enable WebSocket when user is authenticated
- [x] Modify usePoll.ts for hybrid polling
  - Poll every 30 seconds when WebSocket connected (backup)
  - Poll every 5 seconds when WebSocket disconnected (real-time fallback)
- [x] Modify App.tsx to integrate WebSocket
  - Add WebSocketProvider in main.tsx
  - Pass webSocketConnected to usePoll
- [x] Add WebSocket/polling status indicator to AppHeader
- [x] TypeScript compilation successful
- [x] Build successful (client + server)
- [x] All 7 system tests passed

**Summary:**
Implemented Socket.io WebSocket support for real-time mesh data updates. When the WebSocket is connected, the polling interval is reduced from 5 seconds to 30 seconds as real-time updates come via WebSocket. Events are emitted when messages, nodes, channels, or connection status change. Telemetry updates are batched to reduce traffic. Falls back to frequent polling when WebSocket is disconnected.

---
### MQTT Traceroute Visualization (#893)

**Completed:**
- [x] Add overlay0 color to ThemeColors interface (useTraceroutePaths.tsx)
- [x] Update App.tsx to include overlay0 in theme colors
- [x] Track MQTT segments (SNR = 0.0 dB indicates MQTT traversal)
- [x] Render MQTT segments with dotted line and different color (overlay0)
- [x] Add "via MQTT" indicator badge to route segment popup
- [x] Update useMemo dependency array for themeColors.overlay0
- [x] TypeScript typecheck passed
- [x] Unit tests passed (81 test files, 1784 tests)
- [x] Build successful

**Summary:**
Traceroute segments that report 0.0 dB SNR (indicating MQTT traversal) are now rendered differently on the map. MQTT segments display as dotted lines in a muted gray color (overlay0 from Catppuccin theme) with reduced opacity. The route segment popup also shows a "via MQTT" badge for these segments.

### Infinite Scroll for Messages (#853)

**Completed:**
- [x] Add offset parameter to `getMessagesByChannel` in database.ts
- [x] Add offset parameter to `getDirectMessages` in database.ts
- [x] Add offset query parameter to `/api/messages/channel/:channel` endpoint
- [x] Add offset query parameter to `/api/messages/direct/:nodeId1/:nodeId2` endpoint
- [x] Add `getChannelMessages` and `getDirectMessages` API client functions
- [x] Add pagination state to DataContext (channelHasMore, channelLoadingMore, dmHasMore, dmLoadingMore)
- [x] Implement `isScrolledNearTop` detection in App.tsx
- [x] Implement `loadMoreChannelMessages` with scroll position preservation
- [x] Implement `loadMoreDirectMessages` with scroll position preservation
- [x] Add loading indicator UI for both channel and DM views
- [x] Add CSS styles for loading spinner animation
- [x] Docker build successful
- [x] TypeScript type check passed
- [x] Unit tests passed

**In Progress:**
- [x] System tests passed (7/7)

**Summary:**
Implemented infinite scroll for both channel messages and direct messages. When users scroll to the top of a message list, older messages are automatically loaded from the database. Scroll position is preserved so users don't experience a jump when new messages are prepended. Loading indicator shows while fetching.

---

### Version 2.16.0 (In Progress)

#### System Backup & Restore (#488)

**Completed:**
- [x] Database migration 021 - system_backup_history table
- [x] systemBackupService - JSON export with SHA-256 checksums for 17 tables
- [x] systemRestoreService - Validates integrity, migrates schemas, atomically restores
- [x] Extended backupSchedulerService for independent system backup scheduling
- [x] System backup API endpoints (create, list, download as tar.gz, delete, settings)
- [x] RESTORE_FROM_BACKUP environment variable bootstrap logic
- [x] SystemBackupSection UI component in Settings page
- [x] Integrated audit logging for all backup/restore events
- [x] Added archiver dependency for tar.gz creation
- [x] Extend tests/system-tests.sh with full backup/restore verification
  - tests/test-backup-restore.sh created with docker compose approach
  - Tests backup creation, restore with RESTORE_FROM_BACKUP env var
  - Verifies data integrity (nodes, messages, settings)
  - Handles containers without Meshtastic node connection
- [x] Fix TypeScript compilation errors
  - Commented out audit logger calls in server.ts (auditLogger not yet implemented)
  - Commented out audit log insertions in systemRestoreService.ts (schema issues)
  - Removed unused imports in systemBackupService.ts and systemRestoreService.ts

- [x] Update docker-compose.yml with RESTORE_FROM_BACKUP example
- [x] Write system backup feature documentation
  - docs/features/system-backup.md - Complete feature guide with API reference
  - docs/operations/disaster-recovery.md - Step-by-step recovery procedures
  - Updated main README.md with new feature

- [x] Run full system tests
  - All 7 tests passed including new backup/restore test
- [x] Create pull request
  - PR #491: feat: Add system backup & restore functionality
- [x] Merge PR #491 to main
- [x] Complete audit logging integration
  - Added audit logging for all backup/restore operations
  - Added bootstrap audit log after restore completion
- [x] Implement re-restore protection mechanism
  - Marker file at /data/.restore-completed prevents accidental data loss
  - Different backups can still be restored by changing env var
- [x] Move System Backup UI to General Settings page
- [x] Update button styling to match application standards

**Remaining:**
- [ ] Update Device Configurator with system backup settings (optional)
- [x] Update package.json to 2.17.0
- [x] Update Helm chart to 2.17.0
- [x] Regenerate package-lock.json
- [x] Run system tests
- [ ] Create release (v2.17.0)

#### Packet Monitor Infinite Loop Fix (#820)

**Completed:**
- [x] Investigate packet monitor infinite loop bug
  - Root cause: Missing `useCallback` wrapper on `loadMore` function
  - Caused infinite re-renders when virtualizer state changed
  - Effect at line 115-135 depended on `loadMore` but didn't include it in deps
  - React created new `loadMore` function on every render
  - Triggered after ~8 hours when packet list grew large enough
- [x] Fix infinite re-render loop
  - Wrapped `loadMore` in `useCallback` with proper dependencies
  - Added `loadMore` to effect dependency array
  - Prevents function from being recreated unnecessarily
- [x] Add circuit breaker for rate limit errors
  - Added `rateLimitError` state and `rateLimitResetTimerRef`
  - `loadMore` now checks for rate limit errors and stops loading
  - Automatically resets after 15 minutes (matches rate limit window)
  - Shows user-friendly warning message when rate limited
  - Prevents infinite loop from continuing if rate limits are hit
- [x] Build and test changes
  - All builds successful (server and frontend)
  - All system tests passed (7/7)

#### Bug Fixes

**Completed:**
- [x] Implement missing /api/server-info endpoint
  - Added endpoint to return timezone configuration
  - Returns { timezone, timezoneProvided } from environment config
  - Used by InfoTab to display server timezone information
  - Placed after /api/health endpoint in server.ts

#### Packet Monitor Improvements (#661)

**Completed:**
- [x] Fix filter settings persisting across reloads and page swaps
  - Added localStorage persistence for portnum, encrypted, hideOwnPackets, showFilters filters
  - Filter settings now saved automatically and restored on page load
  - Fixes issue where filters would revert to defaults when navigating away
- [x] Ensure all packets are shown without restriction
  - Changed packet fetch limit from 100 to 10000 (backend max)
  - All available packets now displayed in monitor
- [x] Update popup to show entire packet as pretty JSON
  - Replaced detailed field-by-field view with complete JSON dump
  - Shows full packet object with all fields and metadata
  - Better for debugging and understanding packet structure
  - Modal title changed to "Packet Details (Full JSON)"
- [x] Show encrypted payload bytes in JSON popup
  - Added encrypted_payload field to metadata (hex string of encrypted bytes)
  - List view still shows padlock and <ENCRYPTED> text
  - JSON popup displays the actual encrypted payload bytes for inspection
  - Enables debugging and analysis of encrypted packets
- [x] Add JSONL export functionality
  - Added export button (📥) to Packet Monitor header
  - Exports currently displayed packets (respects active filters)
  - JSONL format: one JSON object per line
  - Filename includes timestamp and filter status
  - Metadata is automatically parsed from string to object in export
  - Button disabled when no packets available
  - Example: packet-monitor-filtered-2025-11-20T15-30-45.jsonl

#### Delete Node Functionality (#666)

**Completed:**
- [x] Database service deleteNode method (src/services/database.ts:2023-2045)
- [x] Backend DELETE /api/messages/nodes/:nodeNum endpoint (src/server/routes/messageRoutes.ts:341-395)
- [x] Frontend handleDeleteNode handler (src/App.tsx:2472-2506)
- [x] Delete Node button in Purge Data modal (src/App.tsx:5623-5644)
- [x] Deletes node from local database with all associated data (messages, traceroutes, telemetry)
- [x] Removes node from map and node lists
- [x] Audit logging for node deletion events

**Admin Message Infrastructure - "Purge from Device" Feature:**
- [x] createRemoveNodeMessage in protobufService (src/server/protobufService.ts:624-650)
  - Creates AdminMessage with remove_by_nodenum field (proto field 38)
  - Supports optional session passkey for authentication
- [x] sendRemoveNode method in meshtasticManager (src/server/meshtasticManager.ts:5412-5434)
  - Sends admin message to connected Meshtastic device
  - Uses empty passkey for local TCP connections (known session key bug workaround)
  - Comprehensive logging for tracking admin command execution
- [x] Backend POST /api/messages/nodes/:nodeNum/purge-from-device endpoint (src/server/routes/messageRoutes.ts:397-470)
  - Sends remove_by_nodenum admin command to device
  - Also deletes node from local database
  - Requires messages:write permission
  - Audit logging for device purge events
- [x] Frontend handlePurgeNodeFromDevice handler (src/App.tsx:2508-2542)
  - Confirmation dialog with clear warning about device AND database deletion
  - Calls device purge endpoint
  - Error handling and user feedback
  - Refreshes UI after successful purge
- [x] "Purge from Device AND Database" button in UI (src/App.tsx:5645-5666)
  - Darker red color (#5a0a0a) to distinguish from local-only deletion
  - Clear labeling: "🗑️ Purge from Device AND Database"
  - Full-width button for better mobile experience

#### DM Conversation Enhancements (#490)

**Completed:**
- [x] Add dmFilter state to UIContext (all/unread/recent)
- [x] Implement automatic sorting by most recent message
- [x] Calculate and display last message preview (50 char truncation)
- [x] Add filter dropdown for All/Unread/Recent conversations
- [x] Display relative time for last message
- [x] Full-width single-line layout with message preview
- [x] Red border indicator on time display for unread messages
- [x] Remove inline unread badge in favor of time display indicator
- [x] Run system tests (all 6 passed)
- [x] Create pull request (PR #494)
- [x] Merge PR #494 to main

## Completed Tasks

### Auto Announce NodeInfo Broadcasting (#1174)

- [x] Add NodeInfo broadcasting UI to AutoAnnounceSection.tsx
  - Checkbox to enable NodeInfo broadcasting
  - Multi-select checkboxes for channel selection (all configured channels)
  - Configurable delay between channel broadcasts (10-300 seconds)
- [x] Add translation strings for NodeInfo section
- [x] Update UIContext with nodeInfoEnabled, nodeInfoChannels, nodeInfoDelaySeconds state
- [x] Update App.tsx to pass NodeInfo props and load settings
- [x] Add backend broadcastNodeInfoToChannel method (uses broadcast address 0xFFFFFFFF)
- [x] Add backend broadcastNodeInfoToChannels method (iterates with delays)
- [x] Integrate NodeInfo broadcasting into sendAutoAnnouncement scheduler
- [x] System tests passed (7/7)

**Summary:** Users can now optionally broadcast NodeInfo to selected channels when auto-announce triggers. Useful for users with private primary channels who want to share their node info on secondary public channels.

### Auto-Traceroute Active Node Filter & Logging (PR #1169)

- [x] Fix `getNodeNeedingTraceroute()` to filter by `maxNodeAgeHours` setting
- [x] Fix time unit bug: `lastHeard` is seconds, not milliseconds
- [x] Create migration 041 for `auto_traceroute_log` table
- [x] Add database functions for logging auto-traceroute attempts
- [x] Add tracking Set in meshtasticManager for pending auto-traceroutes
- [x] Create API endpoint `GET /api/settings/traceroute-log`
- [x] Add Recent Auto-Traceroutes section in AutoTracerouteSection.tsx
- [x] Add translation strings for log section
- [x] PR merged

**Summary:** Fixed auto-traceroute to only target "active" nodes (heard within `maxNodeAgeHours` setting). Added "Recent Auto-Traceroutes" section in Automation tab showing last 10 attempts with status indicators.

---

### Version 2.16.3

#### Stale Connection Detection (#492, PR #510)
- [x] Implement application-level stale connection monitoring
  - Track `lastDataReceived` timestamp on all incoming data
  - Periodic health check every 60 seconds
  - Configurable timeout via `MESHTASTIC_STALE_CONNECTION_TIMEOUT` (default: 5 minutes)
  - Automatic reconnection when no data received within timeout period
  - Emit 'stale-connection' event before forcing reconnect
  - Validation warning for timeout values < 60 seconds
- [x] Fix "zombie connection" syndrome where TCP sockets appear alive but device stops sending data
  - Addresses serial port half-open states
  - Handles USB disconnects that don't trigger TCP errors
  - Accounts for Meshtastic devices freezing without closing socket
  - Mitigates Docker serial passthrough failure points
- [x] Update documentation in ARCHITECTURE_LESSONS.md
  - Added comprehensive "Stale Connection Detection" section
  - Documented symptoms, configuration, and why it's needed
- [x] Code review feedback addressed
  - Fixed log message consistency ("minute(s)")
  - Added validation for dangerously low timeout values
  - Improved user feedback for misconfiguration
- [x] PR #510 merged to main

### Version 2.15.3

- [x] Add audit logging for upgrade events (#486)
  - Upgrade trigger events with version information (who initiated, when, from/to versions)
  - Upgrade cancellation events with full context
  - User attribution and IP address tracking
  - Upgrade script deployment logged with SHA256 hash for verification
- [x] Fix critical auto-upgrade container recreation bug (#487)
  - Fixed bug where upgrades failed with "Unable to find image 'profile:latest'" error
  - Root cause: Port mappings included protocol suffixes (`-p 8080:3001/tcp`) invalid for `docker run`
  - Root cause: Docker Compose env vars (`COMPOSE_PROFILES`) passed through, causing misparse
  - Strip `/tcp` and `/udp` protocol suffixes from port mappings
  - Filter out `COMPOSE_*`, `DOCKER_*`, `PATH`, `HOME`, `HOSTNAME` env vars
  - Added comprehensive environment variable filtering
- [x] Update version to 2.15.3 in package.json, package-lock.json, and Helm chart
- [x] Run system tests - all passed
- [x] Create pull request (#487)
- [x] Merge and create release (v2.15.3)

### Version 2.15.2

- [x] Fix auto-upgrade timing issues (#485)
  - Fixed premature upgrade prompts appearing before container images were built
  - Implemented time-based heuristic (15-minute wait after release publication)
  - Replaced reliance on GHCR's ambiguous HTTP 401 responses
- [x] Fix excessive API polling (#485)
  - Fixed upgrade status endpoint being polled twice per second
  - Properly memoized `authFetch` function with `useCallback`
  - Increased polling intervals (10s base, 30s max during active upgrades)
- [x] Run system tests
- [x] Create release (v2.15.2)

### Version 2.15.1

- [x] UI improvements and bug fixes
- [x] Create release (v2.15.1)

### Version 2.15.0

- [x] Implement automatic self-upgrade functionality
- [x] Create release (v2.15.0)

### Auto-Upgrade Functionality (#480)
- [x] Implement automatic self-upgrade functionality for Docker deployments
  - Backend: upgradeService for orchestration and pre-flight checks
  - Backend: upgrade API endpoints (trigger, status, history, cancel)
  - Backend: Backup/restore and automatic rollback on failure
  - Frontend: Upgrade state management and UI with real-time progress
  - Docker: upgrade-watchdog.sh sidecar for monitoring and execution
  - Docker: Watchdog performs backup → pull → recreate → health check → rollback
  - Helm: autoupgrade.enabled configuration option
  - Documentation: Comprehensive auto-upgrade guide
- [x] Fix TypeScript type errors
  - Fixed Database.run() calls to use prepare().run() pattern
  - Prefixed unused parameters with underscore
  - Added missing uuid dependency
  - Fixed React imports and NodeJS.Timeout types
  - Converted require() to ES6 imports
- [x] Fix documentation build issues
  - Removed dead links to non-existent pages
- [x] Address critical security and reliability issues from code review
  - Fixed CSRF vulnerability by using authFetch consistently
  - Added comprehensive input validation (version format, UUID, bounded integers)
  - Added error handling for JSON.parse operations with proper fallbacks
  - Implemented atomic file writes to prevent race conditions
  - Added exponential backoff for upgrade polling (5s → 15s max)
  - Fixed memory leaks with proper interval cleanup
- [x] All CI tests passing
- [x] PR reviewed and merged

### Version 2.14.2

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
