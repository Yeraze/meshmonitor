# Changelog

All notable changes to MeshMonitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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