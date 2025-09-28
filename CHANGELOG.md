# Changelog

All notable changes to MeshMonitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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