# Changelog

All notable changes to MeshMonitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Admin Commands Tab** ([#911](https://github.com/Yeraze/meshmonitor/pull/911)): Comprehensive remote node management and administrative commands
  - **New Admin Tab**: Dedicated interface for managing both local and remote Meshtastic nodes
  - **Node Selection**: Search and select any node in the mesh network (local or remote)
  - **Device Management Commands**:
    - **Reboot Device**: Reboot with configurable delay (0-60 seconds)
    - **Factory Reset**: Complete device reset to factory defaults
    - **Set Owner**: Configure node owner information (long name, short name, unmessagable status)
    - **Set Device Config**: Configure device role (CLIENT, CLIENT_MUTE, ROUTER) and node info broadcast interval
    - **Set LoRa Config**: Full LoRa radio configuration including presets, bandwidth, spread factor, coding rate, region, hop limit, TX power, and more
    - **Set Position Config**: Configure position broadcasting (interval, smart position, fixed position with coordinates)
    - **Set MQTT Config**: Configure MQTT broker settings (address, credentials, encryption, JSON mode, root topic)
  - **Channel Management**:
    - **Load Channels**: Fetch and display all channels from remote nodes
    - **Edit Channels**: Modify channel settings (name, PSK, role, uplink/downlink, position precision)
    - **Import Channels**: Import channel configurations from Meshtastic URLs
    - **Export Channels**: Export channel configurations to Meshtastic URLs with QR codes
  - **Configuration Import/Export**:
    - **Full Configuration Import**: Import complete device configuration (channels + LoRa settings) from Meshtastic URLs
    - **Full Configuration Export**: Export complete device configuration to Meshtastic URLs with QR codes
    - Works seamlessly with both local and remote nodes
  - **Remote Node Support**:
    - **Session Passkey Management**: Automatic session passkey handling for remote node authentication
    - **Per-Node Configuration Storage**: Isolated configuration storage prevents data conflicts between nodes
    - **Remote Channel Loading**: Load and manage channels from nodes not directly connected to MeshMonitor
    - **Remote Config Loading**: Fetch device, LoRa, and position configurations from remote nodes
  - **Database Management**:
    - **Purge Node Database**: Remove all nodes from the device's node database
  - **UI Features**:
    - Consistent styling matching Device Configuration page
    - Real-time loading states and progress indicators
    - Comprehensive error handling with user-friendly messages
    - Confirmation dialogs for destructive operations
    - Search functionality for node selection
  - **Security**: Admin-only access with proper authentication and session management
  - **Backend API**: New `/api/admin/*` endpoints for remote node operations
    - `/api/admin/commands` - Generic admin command execution
    - `/api/admin/load-config` - Load device/LoRa/position config from remote nodes
    - `/api/admin/get-channel` - Fetch individual channel from remote node
    - `/api/admin/export-config` - Export configuration for remote nodes
    - `/api/admin/import-config` - Import configuration to remote nodes
    - `/api/admin/ensure-session-passkey` - Manage remote node authentication
  - **Protobuf Enhancements**: Improved AdminMessage decoding with proper nested object conversion
  - **Boolean Normalization**: Consistent boolean handling for channel uplink/downlink settings across local and remote nodes
- **Node Favorites & Ignored Management** ([#940](https://github.com/Yeraze/meshmonitor/issues/940)): Complete support for managing favorite and ignored nodes
  - **Local Node Management**: Toggle favorite and ignored status directly from the nodes page
  - **Remote Node Management**: Manage favorite and ignored nodes on remote devices via Admin Commands tab
  - **Device Synchronization**: Two-way sync between MeshMonitor database and Meshtastic device
  - **Database Migration**: Automatic migration to add `isIgnored` column to nodes table
  - **Optimistic UI Updates**: Immediate visual feedback with proper polling reconciliation
  - **Firmware Compatibility**: Gracefully handles devices running firmware < 2.7.0 (feature requires 2.7.0+)
  - **API Endpoints**: New `/api/nodes/:nodeId/favorite` and `/api/nodes/:nodeId/ignored` endpoints
- **Draggable UI Components** ([#940](https://github.com/Yeraze/meshmonitor/issues/940)): Enhanced user experience with movable and resizable interface elements
  - **Nodes Sidebar**: Draggable and resizable nodes list with position and size persistence
  - **Map Legend**: Draggable Hops legend that doesn't interfere with map panning
  - **Map Controls**: Draggable Features box with improved positioning
  - **localStorage Persistence**: All component positions and sizes saved across sessions
  - **Smooth Interactions**: Proper event handling to prevent conflicts with Leaflet map controls

### Fixed
- **Auto-Upgrade**: Fixed version check endpoint to prevent multiple upgrade triggers when an upgrade is already in progress
  - Added pre-check using `isUpgradeInProgress()` before calling `triggerUpgrade()`
  - Prevents unnecessary upgrade attempts when polling the version check endpoint frequently
  - Handles race conditions where an upgrade might start between the check and trigger call
  - Made `isUpgradeInProgress()` public to allow external status checks
- **Protobuf Error Messages**: Fixed `requestRemoteOwner()` to provide clear error message when protobuf definitions are not loaded
  - Added explicit null check for `getProtobufRoot()` before use
  - Now matches the error handling pattern used in `requestRemoteSessionPasskey()` and `requestRemoteChannel()`
  - Provides informative "Protobuf definitions not loaded" error instead of misleading "AdminMessage type not found"
- **Channel Import**: Fixed boolean normalization for `uplinkEnabled` and `downlinkEnabled` to default to `true` (enabled) for consistency with local node behavior
- **Export Modal**: Fixed `useEffect` dependency array to prevent unwanted resets of user channel selections
- **Error Handling**: Fixed `handleLoadChannels` and `handleLoadLoRaConfig` to properly re-throw errors for `Promise.all` rejection handling
- **Config Structure**: Fixed remote node configuration loading to correctly assign `getConfigResponse` without incorrect object spreading
- **Protobuf Root**: Added explicit null checks for `getProtobufRoot()` with informative error messages
- **Button States**: Fixed Edit, Export, and Import channel buttons to properly disable when no node is selected
- **API Authentication**: Added `credentials: 'include'` to admin API calls to ensure session cookies are sent
- **Hop Count Calculation**: Fixed `hopCount` assignment to verify `routeArray` is actually an array before accessing `.length`
  - Prevents `undefined` hopCount values for malformed route data
  - Added `Array.isArray()` check in all traceroute endpoints
- **Race Condition in Remote Requests**: Fixed data clearing order in `requestRemoteConfig`, `requestRemoteChannel`, and `requestRemoteOwner`
  - Data is now cleared *before* sending requests instead of after
  - Prevents race conditions where incoming responses are immediately deleted, causing polling timeouts
- **Tapback Routing**: Fixed tapback emoji reactions to respect `alwaysUseDM` flag
  - Tapbacks now correctly route via DM when `alwaysUseDM` is enabled, matching message reply behavior
- **CORS Configuration**: Fixed development environment CORS check to correctly recognize localhost origins
  - Prevents false positive CORS error banners in development mode
- **Remote Node Favorite/Ignored Management** ([#950](https://github.com/Yeraze/meshmonitor/issues/950)): Fixed incorrect status display and management for remote nodes
  - Added separate state tracking for remote node favorite/ignored status
  - UI now correctly displays and manages favorite/ignored status for remote nodes independently from local node status
  - Fixed button disable conditions to allow management of remote nodes even when local node has different status
  - Remote node status is cleared when switching target nodes to prevent stale data
  - Prevents incorrect UI state and disabled buttons when managing favorite/ignored status on remote devices

## [2.18.1] - 2025-11-15

### Added
- **Clickable URL Rendering in Messages** ([#614](https://github.com/Yeraze/meshmonitor/pull/614)): Automatic URL detection with rich link previews
  - **Automatic URL Detection**: Detects HTTP/HTTPS URLs in all message text using regex pattern
  - **Clickable Links**: URLs converted to clickable links that open in new tabs with security (`rel="noopener noreferrer"`)
  - **Rich Link Previews**: Display preview cards with metadata (title, description, image, site name)
    - Fetches Open Graph, Twitter Card, and standard meta tags from target URLs
    - Beautiful card-based layout with responsive design (max-width 400px)
    - Displays website favicons, titles, descriptions, and preview images
    - Styled with Catppuccin theme variables for consistency
  - **Lazy Loading with Intersection Observer**: Performance-optimized preview fetching
    - Only fetches previews for messages in or near the viewport (100px margin)
    - Prevents excessive API calls on initial page load
    - One-time fetch per message with URL
    - Smooth UX with loading states and animations
  - **Backend Link Preview Endpoint**: New `/api/link-preview` endpoint
    - Fetches and parses HTML metadata from URLs
    - 5-second timeout to prevent hanging requests
    - Protocol validation (only HTTP/HTTPS allowed)
    - HTML entity decoding for safe text display
    - Resolves relative URLs to absolute
  - **BASE_URL Support**: Properly respects BASE_URL configuration via ApiService
  - **Security Features**:
    - Links open in new tabs with security attributes
    - URL protocol validation
    - Request timeouts
    - Safe HTML entity handling
  - **Works in All Message Types**: Channel messages, direct messages, and traceroute messages

## [2.12.2] - 2025-10-31

### Added
- **Auto Welcome Functionality** ([#412](https://github.com/Yeraze/meshmonitor/pull/412)): Automatically send personalized welcome messages to new nodes joining the mesh network
  - **Dynamic Token System**: 7 customizable tokens for personalized messages
    - `{LONG_NAME}`, `{SHORT_NAME}` - Node identification
    - `{VERSION}` - MeshMonitor version
    - `{DURATION}` - Time since node first seen
    - `{FEATURES}` - Enabled automation features with emojis
    - `{NODECOUNT}`, `{DIRECTCOUNT}` - Network statistics
  - **Smart Welcome Logic**: 24-hour cooldown to prevent spam
  - **Wait for Name Feature**: Skip nodes with default names until personalized
  - **Routing Options**: Send as DM or to specific channel
  - **Database Migration**: Automatic migration prevents "thundering herd" of welcome messages on first boot
  - **Comprehensive Testing**: 27 new tests covering integration and migration scenarios

- **Auto Announce Scheduled Sends** ([#413](https://github.com/Yeraze/meshmonitor/pull/413)): Precise time-based scheduling using cron expressions as alternative to fixed intervals
  - **Cron Expression Scheduling**: Schedule announcements at specific times (e.g., daily at 9 AM)
  - **Live Validation**: Real-time validation with visual feedback (green checkmark/red error)
  - **Integrated Help**: Direct link to [crontab.guru](https://crontab.guru/) for cron expression assistance
  - **Smart UI**: Conditional display of interval OR cron input based on selected mode
  - **Immediate Apply**: Schedule changes restart scheduler instantly - no container restart needed
  - **Default Expression**: `0 */6 * * *` (every 6 hours at top of hour)
  - **Dual-Mode Scheduler**: Supports both interval-based and cron-based execution
  - **New Dependencies**: `node-cron` for backend scheduling, `cron-validator` for frontend validation

- **Security Monitoring Page** ([#414](https://github.com/Yeraze/meshmonitor/pull/414)): Comprehensive mesh network security monitoring
  - **New Security Tab**: Dedicated interface for monitoring encryption key security
  - **Low-Entropy Key Detection**: Identifies nodes using weak encryption keys vulnerable to brute-force attacks
    - Displays key entropy scores with severity indicators (High Risk, Medium Risk, Low Risk)
    - Shows hardware model information for affected nodes
    - Direct links to detailed remediation documentation
  - **Duplicate Key Detection**: Identifies nodes sharing the same encryption key
    - Groups nodes by duplicate encryption keys
    - Highlights privacy violations between devices
    - Shows impacted node count per duplicate key
    - Links to comprehensive fix instructions
  - **Security Permission**: New granular permission for accessing security monitoring
    - Read permission for viewing security scan results
    - Write permission for initiating security scans
    - Integrated into user management UI with proper Read/Write checkboxes
  - **Comprehensive Documentation**: User-facing guides for fixing security issues
    - `docs/security-low-entropy-keys.md` (257 lines) - Complete guide to fixing weak keys
    - `docs/security-duplicate-keys.md` (355 lines) - Complete guide to resolving duplicate keys
    - Platform-specific instructions for iOS, Android, and CLI
    - Real-world security scenarios and attack explanations
    - Step-by-step remediation instructions
    - FAQ sections addressing common concerns

### Fixed
- **Permission UI**: Fixed Security permission displaying incorrect text in Users panel
  - Changed from "Can initiate traceroutes" to proper Read/Write checkboxes
  - Security permission now displays consistently with other resources

### Changed
- **User Management**: Enhanced permission model to include security resource
  - Added 'security' to default admin permissions
  - Security resource excluded from default user permissions
- **Auto Announce Architecture**: Enhanced scheduler to support both interval and cron-based execution modes

## [2.11.3] - 2025-10-28

### Added
- **Enhanced Node Details Block** (#366, #384): Added comprehensive node information display on Messages page
  - New "Node Details" block displays between message conversation and telemetry graphs
  - **Node ID display in hex and decimal formats** (e.g., 0x43588558 and 1129874776)
  - Shows battery level with voltage (color-coded: green >75%, yellow 25-75%, red <25%)
  - Displays signal quality metrics (SNR and RSSI with quality indicators)
  - Shows network utilization (channel utilization and air utilization TX)
  - Displays device information (hardware model with image, role, firmware version)
  - Hardware images fetched from Meshtastic web-flasher repository (70+ device images)
  - Friendly hardware names (e.g., "STATION G2" instead of "STATION_G2")
  - Shows network position (hops away, MQTT connection status)
  - Displays last heard timestamp with relative time formatting
  - Responsive grid layout (2 columns on desktop, 1 column on mobile)
  - Graceful handling of missing metrics (shows "N/A" for unavailable data)
  - Color-coded indicators for battery, signal quality, and utilization levels
  - Comprehensive hardware model decoder (116 device types from Meshtastic protobufs)
  - Device role decoder (Client, Router, Tracker, Sensor, etc.)

- **Device Configuration Backup Improvements** (#381): Enhanced backup functionality and user experience
  - Improved backup filename format with timestamp (NodeID-YYYY-MM-DD-HH-MM-SS.yaml)
  - Enhanced backup modal UI with clearer instructions
  - Better error handling and user feedback

### Fixed
- **Map Popup Visibility** (#383, #386): Improved popup centering when clicking node markers
  - Dynamic viewport-relative offset (1/4 of map height) adapts to different screen sizes
  - Single smooth animation instead of competing pan operations
  - Popup consistently centers in viewport without being cut off
  - Eliminated "fighting" animations between map controller and popup opening

- **Connection Status Detection** (#378, #387): Added timeout to detect backend unavailability
  - 10-second timeout on fetch requests prevents indefinite hanging
  - Connection status updates to "Disconnected" within 10-15 seconds when backend unavailable
  - Improved browser compatibility with DOMException and Error handling
  - Memory leak prevention with proper timeout cleanup in finally block

- **Apprise URL Validation** (#385): Loosened URL validation to support special characters
  - Improved compatibility with Apprise notification services
  - Supports special characters in Apprise URLs
  - Better error messages for invalid URLs

## [2.10.4] - 2025-10-25

### Added
- **Traceroute History**: View complete traceroute history for any node pair
  - New "View History" button in Messages tab for nodes with traceroute data
  - Displays all traceroute attempts including successful and failed attempts
  - Shows both forward and return routes with SNR values
  - Includes calculated total distance for each route
  - Tracks auto-traceroute and manual user-initiated traceroutes
  - Persistent storage with configurable history limit (50 records per node pair)

### Fixed
- Improved database performance with dedicated index for traceroute queries
- Fixed potential race condition in traceroute recording with database transactions
- Enhanced API input validation for better security

### Changed
- Replaced magic numbers with configuration constants for improved maintainability
- Optimized traceroute display performance with memoized route formatting

## [2.10.3] - 2025-10-25

### Added
- **Telemetry Dashboard Enhancements**: Enhanced telemetry dashboard with advanced data management
  - Filter telemetry by node name or ID with instant search
  - Sort nodes by name, ID, battery level, voltage, or last update time
  - Drag-and-drop to reorder telemetry cards for personalized layout
  - Persistent card order saved to local storage
  - Clear visual indicators for search and sort states

### Fixed
- **Session Management**: Added SESSION_ROLLING option for improved user experience
  - When enabled, active users stay logged in indefinitely by resetting session expiry on each request
  - Defaults to `true` for better UX - users won't be logged out while actively using the app
  - Configurable via `SESSION_ROLLING` environment variable
  - Works in conjunction with `SESSION_MAX_AGE` for flexible session control

### Changed
- Enhanced telemetry card layout with better visual hierarchy
- Improved UX for managing large numbers of nodes
- Updated README with SESSION_ROLLING documentation

## [2.4.6] - 2025-01-13

### Fixed
- **OIDC Callback Parameter Preservation**: Fixed OIDC authentication failure with RFC 9207-compliant providers (PocketID, etc.) that include the `iss` (issuer) parameter in authorization callbacks
  - Modified callback handler to preserve all query parameters from authorization callback instead of reconstructing URL with only code/state
  - Now passes complete callback URL to openid-client's authorizationCodeGrant function
  - Maintains full backward compatibility with existing OIDC providers (Authentik, Keycloak, Auth0, Okta, Azure AD)
  - Resolves "response parameter iss (issuer) missing" error
  - Fixes #197

## [2.1.0] - 2025-10-10

### Added
- **Connection Control**: Manual disconnect/reconnect from Meshtastic node with permission control
  - Disconnect button in header to manually stop connection to node
  - Reconnect button appears when user has manually disconnected
  - New `connection` permission resource to control access to disconnect/reconnect functionality
  - Cached data remains accessible while disconnected (read-only mode)
  - Prevents automatic reconnection when user has manually disconnected
  - Connection state preserved through page refreshes

- **Traceroute Permission**: Fine-grained control over traceroute initiation
  - New `traceroute` permission resource to control who can initiate traceroute requests
  - Separate permission from viewing traceroute results (which uses `info:read`)
  - Traceroute button in Messages tab now requires `traceroute:write` permission
  - Default permissions: admins can initiate, regular users can view only

- **Permission UI Enhancements**:
  - Single-checkbox UI for binary permissions (connection, traceroute)
  - Intuitive "Can Control Connection" and "Can Initiate Traceroutes" labels
  - Simplified permission management for action-based resources

- **Header Improvements**:
  - Display connected node name in header: "LongName (ShortName) - !ID"
  - IP address shown in tooltip on hover
  - Better visibility of which node you're connected to

### Changed
- Traceroute endpoint now requires `traceroute:write` permission instead of `info:write`
- Connection status now includes `user-disconnected` state
- Frontend polling respects user-disconnected state
- Route segments and neighbor info remain accessible when disconnected

### Technical Improvements
- Database migrations 003 and 004 for new permission resources
- User disconnected state management in MeshtasticManager
- Comprehensive test coverage for new connection control endpoints
- Permission model tests updated for connection and traceroute resources
- All test suites (515 tests) passing successfully

### Fixed
- Data display when manually disconnected from node
- Route segments functionality while disconnected
- Page refresh behavior when in disconnected state

## [2.0.1] - 2025-10-09

### Fixed
- Cookie security configuration with `COOKIE_SECURE` and `COOKIE_SAMESITE` environment variables

## [2.0.0] - 2025-10-08

### Added
- Authentication and user management system
- Role-based access control with granular permissions
- Update notification system with GitHub release checking

## [1.15.0] - 2025-10-06

### Added
- **Two-Way Favorites Sync**: Synchronize favorite nodes to Meshtastic device
  - Send `set_favorite_node` and `remove_favorite_node` admin messages to device
  - Session passkey management with automatic refresh (300 second expiry)
  - Graceful degradation: database updates succeed even if device sync fails
  - Device sync status reporting in API responses
  - Frontend displays sync success/failure status in console

### Changed
- **Favorites API Enhancement**: `/api/nodes/:nodeId/favorite` endpoint now supports device sync
  - Added `syncToDevice` parameter (default: true) to toggle device synchronization
  - Response includes `deviceSync` object with status ('success', 'failed', 'skipped') and optional error message
  - Database update and device sync are independent operations

### Technical Improvements
- Admin message creation methods in protobufService:
  - `createGetOwnerRequest()` - Request session passkey from device
  - `createSetFavoriteNodeMessage()` - Send favorite node to device
  - `createRemoveFavoriteNodeMessage()` - Remove favorite from device
  - `decodeAdminMessage()` - Parse admin message responses
  - `createAdminPacket()` - Wrap admin messages in ToRadio packets
- Session passkey lifecycle management in meshtasticManager
- Admin message processing for extracting session passkey from responses
- Automatic passkey refresh with 290-second buffer before expiry

## [1.4.0] - 2025-09-29

### Added
- **Telemetry Favorites Dashboard**: Pin your favorite telemetry metrics for quick access
  - Star/unstar nodes to mark as favorites
  - Dedicated favorites dashboard showing only starred nodes
  - Persistent favorites storage in database
  - Quick toggle between all nodes and favorites view

### Changed
- **Major Dependency Updates**:
  - Upgraded to React 19 with improved performance and features
  - Upgraded to react-leaflet v5 for better map functionality
  - Upgraded to Express 5 for enhanced server capabilities
  - Upgraded to Node.js 22 (deprecated Node 18 support)
  - Upgraded to ESLint 9 and TypeScript ESLint 8
  - Upgraded to Vite 6 for faster builds

### Fixed
- Express 5 wildcard route compatibility issue preventing server startup
- Docker build issues with missing @meshtastic/protobufs dependency
- Server test failures after jsdom v27 upgrade
- Various dependency vulnerabilities through updates

### Technical Improvements
- Modernized entire dependency stack for better security and performance
- Improved build times with updated tooling
- Enhanced type safety with latest TypeScript ESLint
- Better development experience with latest Vite and React

## [1.1.0] - 2025-09-28

### Added
- **GitHub Container Registry Publishing**: Pre-built Docker images now available
  - Automated Docker image building and publishing to `ghcr.io/yeraze/meshmonitor`
  - GitHub Actions workflow for continuous image publishing
  - Multi-tag strategy: `latest`, version tags (`1.1.0`, `1.1`, `1`), and branch names
  - Docker buildx with layer caching for optimal build performance
  - No local build step required for deployment

- **Enhanced Deployment Options**:
  - Pre-built images available at GitHub Container Registry
  - Updated docker-compose.yml to use GHCR images by default
  - Documented local build option for developers
  - Version pinning support for production stability

- **Improved Documentation**:
  - Docker image version and size badges in README
  - Comprehensive deployment instructions for both pre-built and local builds
  - Available image tags documentation
  - Quick start guide updated with GHCR instructions

### Changed
- docker-compose.yml now uses `ghcr.io/yeraze/meshmonitor:latest` by default
- Enhanced .dockerignore for optimized build context
- Updated Docker support feature list

### Technical Improvements
- GitHub Actions workflow with PR build validation
- Automated multi-architecture image builds
- Layer caching for faster subsequent builds
- Public GHCR package for easy access

## [1.0.0] - 2025-09-28

This is the initial stable release of MeshMonitor, a comprehensive web application for monitoring Meshtastic mesh networks over IP.

### Features Included in 1.0.0

### Added
- **Automatic Traceroute Scheduler**: Intelligent network topology discovery
  - Runs every 3 minutes to discover mesh network routes
  - Selects nodes needing traceroutes (no data or oldest traceroute)
  - Stores complete route paths with SNR data for each hop
  - Traceroute messages filtered from Primary channel display

- **Network Mapping & Route Visualization**:
  - Interactive map with \"Show Routes\" toggle checkbox
  - Weighted route lines (2-8px thickness based on segment usage)
  - Routes appearing in multiple traceroutes shown with thicker lines
  - Purple polylines matching Catppuccin theme
  - Real-time route data refresh every 10 seconds

- **Node Role Display**:
  - Role information displayed in node list (Client, Router, Repeater, etc.)
  - Role badges shown next to node names
  - Database schema updated with `role` column

- **Hops Away Tracking**:
  - Network distance display for each node
  - Shows how many hops away each node is from local node
  - Database schema updated with `hopsAway` column

- **Traceroute API Endpoints**:
  - `GET /api/traceroutes/recent` - Retrieve recent traceroutes with filtering
  - `POST /api/traceroutes/send` - Manually trigger traceroute to specific node

- **Database Enhancements**:
  - New `traceroutes` table with route path and SNR storage
  - `role` and `hopsAway` columns added to `nodes` table
  - Foreign key relationships for data integrity
  - Automatic schema migration on startup

### Changed
- Map controls repositioned to right side of interface
- Route visualization made toggleable for cleaner map view
- Traceroute data persistence for historical network analysis

### Technical Improvements
- Protobuf parsing enhanced for traceroute response handling
- Intelligent node selection algorithm for traceroute scheduling
- Optimized database queries for traceroute data retrieval

- **iPhone Messages-Style UI**: Complete redesign of channel messaging interface
  - Message bubbles with proper left/right alignment based on sender
  - Sender identification dots showing shortName with longName tooltips
  - Real-time delivery status indicators (⏳ pending → ✓ delivered)
  - Optimistic UI updates for instant message feedback

- **Enhanced Channel Management**:
  - Whitelist-based channel filtering to prevent invalid channels
  - Automatic cleanup of inappropriate channel names (WiFi SSIDs, random strings)
  - Support for known Meshtastic channels: Primary, admin, gauntlet, telemetry, Secondary, LongFast, VeryLong
  - Channel cleanup API endpoint (`POST /api/cleanup/channels`)

- **Message Acknowledgment System**:
  - Content-based message matching for accurate delivery confirmation
  - Temporary message ID handling for optimistic updates
  - Automatic replacement of temporary messages with server-confirmed ones
  - Message persistence across sessions

- **Full Docker Support**:
  - Multi-stage Docker builds for optimized production images
  - Docker Compose configuration for easy deployment
  - Persistent data volumes for database storage
  - Environment-based configuration

- **Enhanced Database Operations**:
  - Export/import functionality for data backup
  - Message and node cleanup utilities
  - Better SQLite performance with WAL mode
  - Comprehensive indexing for faster queries

- **API Improvements**:
  - RESTful endpoint structure
  - Health check and connection status endpoints
  - Comprehensive error handling and logging
  - CORS support for cross-origin requests

- **Core Functionality**:
  - Real-time Meshtastic node monitoring via HTTP API
  - Node discovery and telemetry data collection
  - Text message sending and receiving
  - Channel-based message organization

- **User Interface**:
  - React-based single-page application
  - Catppuccin Mocha dark theme
  - Responsive design for mobile and desktop
  - Real-time connection status indicator
  - Interactive telemetry graphs and node indicators
  - Node list sorting and filtering

- **Data Persistence**:
  - SQLite database for messages, nodes, and traceroutes
  - Automatic data deduplication
  - Cross-restart persistence
  - Node relationship tracking
  - Foreign key relationships for data integrity

- **Meshtastic Integration**:
  - HTTP API client for node communication
  - Enhanced protobuf message parsing
  - Automatic node discovery
  - Configuration and device data retrieval

### Fixed
- Message persistence issues (sent messages no longer disappear)
- Channel detection and invalid channel creation
- ShortName display logic improvements
- Database connection stability
- Memory leaks in protobuf parsing
- Graceful error handling for network issues
- Telemetry parsing and direct message handling
- Environment telemetry storage

### Changed
- Migrated to TypeScript for better type safety
- Enhanced message UI with iPhone Messages aesthetic
- More restrictive channel detection algorithm
- Improved project structure and organization
- Enhanced development workflow with hot reloading

### Technical Foundation
- React 18 with modern hooks and TypeScript
- Express.js backend with comprehensive API
- Better-sqlite3 for high-performance database operations
- Vite for fast development and optimized builds
- Docker with multi-stage builds for production deployment
- Comprehensive TypeScript type safety
- Enhanced error handling and logging throughout

---

## Future Enhancements

### Planned Features
- **Real-time WebSocket Updates**: Replace polling with WebSocket connections
- **Message Search**: Full-text search across message history
- **Advanced Analytics**: Network statistics and visualization dashboards
- **Mobile Application**: React Native companion app
- **Multi-node Support**: Connect to multiple Meshtastic nodes simultaneously
- **Advanced Channel Management**: Custom channel creation and PSK management
- **Plugin System**: Extensible architecture for custom functionality
- **Enhanced Authentication**: Built-in user authentication and access control