# v2.13.3 - Map Customization & Security Scanner Improvements

This release introduces customizable map pin styles, fixes security scanner counting issues, and includes dependency updates.

## 🚀 Features

### Map Pin Style Customization
**[#451](https://github.com/Yeraze/meshmonitor/pull/451) - Add Map Pin Style setting and fix map label display**

New map visualization options with two pin styles:

- **New Map Pin Style setting** in Settings > Display Preferences
- **MeshMonitor style** (default): Pin/tower markers with zoom-based labels (labels appear at zoom level ≥ 13)
- **Official Meshtastic style**: Circle markers with always-visible short names in center
- **Fixed map label display** by restoring accidentally deleted `ZoomHandler.tsx` component
- Setting persists across browser sessions with database storage
- Improved icon anchoring for both styles

## 🐛 Bug Fixes

### Security Scanner Improvements
**[#450](https://github.com/Yeraze/meshmonitor/pull/450) - fix: Clear orphaned duplicate key flags in security scanner**

Fixed counting mismatch on Security page:

- **Resolved discrepancy** where backend reported more duplicate nodes than displayed in UI
- **Clears orphaned duplicate flags** when a node's duplicate partner disappears from network
- **Accurate counts** that match what's displayed in the UI
- Updated `duplicateKeySchedulerService.ts` to maintain flag consistency

## 🔧 Dependencies

- **[#441](https://github.com/Yeraze/meshmonitor/pull/441)** - chore(deps): Bump express-rate-limit from 8.1.0 to 8.2.1
- **[#438](https://github.com/Yeraze/meshmonitor/pull/438)** - chore(deps-dev): Bump the production-dependencies group with 3 updates
- **[#437](https://github.com/Yeraze/meshmonitor/pull/437)** - chore(deps-dev): Bump the development-dependencies group with 4 updates

## 💡 What's Changed

Full Changelog: [v2.13.2...v2.13.3](https://github.com/Yeraze/meshmonitor/compare/v2.13.2...v2.13.3)

## 🚀 MeshMonitor v2.13.3

### 📦 Installation

**Docker (recommended):**
```bash
docker run -d \
  --name meshmonitor \
  -p 8080:3001 \
  -v meshmonitor-data:/data \
  ghcr.io/yeraze/meshmonitor:v2.13.3
```

**Docker Compose:**
```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:v2.13.3
    container_name: meshmonitor
    ports:
      - "8080:3001"
    volumes:
      - meshmonitor-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.1.100  # Change to your node's IP
    restart: unless-stopped

volumes:
  meshmonitor-data:
```

### 🧪 Testing
All system tests passed:
- Configuration Import: ✓ PASSED
- Quick Start Test: ✓ PASSED
- Security Test: ✓ PASSED
- Reverse Proxy Test: ✓ PASSED
- Reverse Proxy + OIDC: ✓ PASSED
- Virtual Node CLI Test: ✓ PASSED

✅ TypeScript checks passed
✅ Docker images built for linux/amd64, linux/arm64, linux/arm/v7
