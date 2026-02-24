# Release Notes - v1.16.0

## Overview
This release adds comprehensive device configuration capabilities directly from the web UI, enhanced role display support, and a modern toast notification system for improved user feedback.

## Major Features

### 🎛️ Device Configuration UI
Complete web-based configuration for your Meshtastic devices with real-time validation and user-friendly toast notifications.

**Node Settings**
- Configure device long name and short name
- Set device role (now supports all 13 roles: 0-12)
- Adjust node info broadcast interval (minimum 3600 seconds)

**LoRa Configuration** (#NEW)
- Set modem preset for optimal range/speed tradeoff
- Configure regional frequency settings
- **Hop Limit**: Control mesh routing depth (1-7 hops)

**Position Configuration** (#NEW)
- **Fixed Position Mode**: Set static GPS coordinates for base stations
- Latitude/Longitude inputs with validation (-90 to 90, -180 to 180)
- Altitude configuration in meters
- **GPS Coordinates Helper**: Quick link to https://gps-coordinates.org/
- Position broadcast interval control
- Smart positioning toggle

**MQTT Configuration** (#NEW)
- Enable/disable MQTT connection
- Configure MQTT server address, credentials
- Set encryption and JSON encoding options
- **MQTT Root Topic**: Customize your MQTT topic hierarchy

**Features**
- ✅ Real-time input validation with helpful error messages
- ✅ Toast notifications for success/error feedback
- ✅ Automatic device reboot handling with reconnection
- ✅ Proper admin message ordering (coordinates before config flags)
- ✅ All changes synced to device via Meshtastic admin messages

### 🏷️ Enhanced Role Support
**New Device Roles**
- Role 11: **Router Late** - Router with delayed routing
- Role 12: **Client Base** - Base station client

**Improvements**
- Centralized role name constant for consistency
- Role names displayed correctly throughout the application
- Fixed "Role 12" display issue in node popup and node list
- Unified role handling between `nodeHelpers` and `mapHelpers`

### 🔔 Toast Notification System
Modern, non-intrusive notification system for user feedback.

**Features**
- 4 notification types: Success ✓, Error ✕, Warning ⚠, Info ℹ
- Auto-dismiss with configurable duration (default 5 seconds)
- Manual close button
- Slide-in animation
- Stacked display for multiple notifications
- Fixed positioning in top-right corner

### 📡 Fixed Position Configuration
Proper implementation of Meshtastic's fixed position requirements.

**Technical Details**
- Coordinates sent FIRST via `set_fixed_position` admin message
- Position config flag set SECOND (per Meshtastic firmware requirements)
- 1-second delay between messages for device processing
- Coordinates loaded from `/api/nodes` endpoint
- Pre-populated fields for existing fixed positions

## API Enhancements

### New Configuration Endpoints
```
POST /api/set-node-owner          - Update device names
POST /api/set-device-config        - Configure role and intervals
POST /api/set-lora-config          - Configure LoRa settings
POST /api/set-position-config      - Configure position settings
POST /api/set-mqtt-config          - Configure MQTT settings
POST /api/reboot                   - Reboot device
```

### Parameter Details
- **Hop Limit**: 1-7 (validated, impacts mesh routing)
- **Node Info Broadcast**: Minimum 3600 seconds (enforced)
- **Coordinates**: Validated ranges for lat/lon/alt
- **MQTT Root**: Custom topic prefix configuration

## Testing & Quality

### Test Coverage
- ✅ **293 tests passing** (19 test files)
- ✅ New test suites for:
  - Node helpers (52 tests) - Role names, hardware models, node names
  - Toast components (38 tests) - Rendering, auto-dismiss, interactions
  - Map helpers (8 tests) - Role name consistency
- ✅ All role names (0-12) validated in tests
- ✅ ROLE_NAMES constant completeness verification
- ✅ Toast notification system fully tested

### Code Quality
- TypeScript strict mode compliance
- Comprehensive input validation
- Error handling with graceful degradation
- Accessibility features (keyboard navigation)

## Documentation

### Updated Documentation
- **README.md**: Added Device Configuration features section
- **API Reference**: Documented 6 new configuration endpoints
- **Database Schema**: Added Node Role Reference table
- All 13 device roles documented with descriptions

### Technical Documentation
- Fixed position setup process
- Admin message ordering requirements
- Validation rules and constraints
- GPS coordinates helper integration

## Database & Migrations

### Schema Status
- ✅ **No migration required** - All necessary columns already exist
- ✅ Existing `role` column supports new roles (0-12)
- ✅ Configuration data stored on device, not in database
- ✅ Zero-downtime upgrades for existing users

### Automatic Migrations
The existing migration system handles:
- `nodes.role` (for all 13 device roles)
- `nodes.isFavorite`, `nodes.firmwareVersion`, `nodes.rebootCount`
- `messages.hopStart`, `messages.hopLimit`, `messages.replyId`, `messages.emoji`

## Breaking Changes
None. This release is fully backward compatible.

## Migration Notes
If you're upgrading from a previous version:

1. **Pull latest Docker image**: `docker pull ghcr.io/yeraze/meshmonitor:1.16.0`
2. **No database changes needed**: Migrations run automatically on startup
3. **Existing data preserved**: All nodes, messages, and settings retained
4. **New features immediately available**: Configuration tab now has full device control

## Technical Improvements

### Code Architecture
- Centralized role name constants (single source of truth)
- Refactored `mapHelpers.getRoleName()` to use `ROLE_NAMES`
- Toast provider context for application-wide notifications
- Proper separation of device config vs. UI state

### Device Communication
- Correct admin message ordering for fixed position
- 1-second delay for device processing between messages
- Session passkey handling for local TCP connections
- Graceful error handling with user-friendly messages

### User Experience
- Input validation before submission
- Visual feedback via toast notifications
- Pre-populated forms from current device state
- External link for GPS coordinate lookup

## Known Issues
None at this time.

## Contributors
- @Yeraze - Primary development
- Claude Code - AI-assisted development, testing, and documentation

## Full Changelog
- feat: add device role names and toast notification system
- feat: enhanced device configuration UI with new fields and validation
- docs: update documentation for device configuration features
- test: add comprehensive test coverage for new features

## Upgrade Instructions

### Docker (Recommended)
```bash
# Pull latest version
docker pull ghcr.io/yeraze/meshmonitor:1.16.0

# Update docker-compose.yml to use version 1.16.0
# Then restart:
docker compose down
docker compose up -d
```

### Manual Deployment
```bash
# Pull latest code
git pull origin main

# Install dependencies (if changed)
npm install

# Rebuild application
npm run build
npm run build:server

# Restart application
pm2 restart meshmonitor  # or your process manager
```

## What's Next (v1.17.0 Preview)
Potential upcoming features:
- Additional configuration modules (Display, Power, Network)
- Bulk configuration for multiple devices
- Configuration profiles and templates
- Enhanced telemetry visualizations

---

**MeshMonitor v1.16.0** - Enhanced Device Configuration 🎛️

_Built with [Claude Code](https://claude.com/claude-code)_
