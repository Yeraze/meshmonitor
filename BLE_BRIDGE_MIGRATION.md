# BLE Bridge Migration to Separate Repository

The Meshtastic BLE Bridge has been extracted to its own repository.

## New Repository

**URL:** https://github.com/Yeraze/meshtastic-ble-bridge

## What Was Done

### Removed from MeshMonitor
- ✅ `tools/ble_tcp_bridge.py` - Main bridge application
- ✅ `tools/Dockerfile` - Container build
- ✅ `tools/.dockerignore` - Build exclusions
- ✅ `tools/README_BLE_BRIDGE.md` - User documentation
- ✅ `tools/CLAUDE_BLE_BRIDGE.md` - Claude context
- ✅ `docs/BLE_TCP_BRIDGE_ANALYSIS.md` - Technical analysis
- ✅ `DEPLOY_BLE_BRIDGE.md` - Deployment guide

### Updated in MeshMonitor
- ✅ `docker-compose.ble.yml` - Now references external image `ghcr.io/yeraze/meshtastic-ble-bridge:latest`
- ✅ `tools/README.md` - Created to explain the move and point to new repo

### Package for New Repository
- ✅ `meshmonitor-ble-bridge.tar.gz` - Complete source and docs (17 KB)
- ✅ `TARBALL_MANIFEST.md` - Package documentation

## Setting Up the New Repository

1. **Create GitHub Repository**
   ```bash
   # On GitHub: Create new repo "meshtastic-ble-bridge"
   ```

2. **Initialize from Tarball**
   ```bash
   mkdir meshtastic-ble-bridge
   cd meshtastic-ble-bridge
   tar -xzf ../meshmonitor-ble-bridge.tar.gz --strip-components=1
   git init
   git add .
   git commit -m "Initial commit: BLE bridge extracted from MeshMonitor"
   git remote add origin git@github.com:Yeraze/meshtastic-ble-bridge.git
   git push -u origin main
   ```

3. **Set Up GitHub Container Registry**
   - Enable GitHub Actions in the repository
   - Create `.github/workflows/docker-publish.yml` for automatic builds
   - Images will be published to `ghcr.io/yeraze/meshtastic-ble-bridge`

## Integration with MeshMonitor

Users can now use the BLE bridge with MeshMonitor in two ways:

### Option 1: Pre-built Image (Recommended)
```bash
# Create .env file
echo "BLE_ADDRESS=AA:BB:CC:DD:EE:FF" > .env

# Start with overlay
docker compose -f docker-compose.yml -f docker-compose.ble.yml up -d
```

### Option 2: Build Locally
```bash
# Clone both repositories
git clone https://github.com/Yeraze/meshmonitor.git
git clone https://github.com/Yeraze/meshtastic-ble-bridge.git

# Update docker-compose.ble.yml to use local build
# (uncomment the build section)

# Start services
cd meshmonitor
docker compose -f docker-compose.yml -f docker-compose.ble.yml up -d
```

## Benefits of Separation

1. **Independent Development:** BLE bridge can evolve independently
2. **Separate Issues/PRs:** Clearer separation of concerns
3. **Easier Testing:** Can test bridge in isolation
4. **Reusability:** Other projects can use the BLE bridge
5. **Smaller MeshMonitor Repo:** Focused on core functionality
6. **Dedicated Claude Instance:** Separate context for BLE bridge work

## Documentation

All BLE bridge documentation now lives in the new repository:
- README.md - Overview and quick start
- QUICK_START.md - 5-minute setup guide
- docs/CLAUDE_BLE_BRIDGE.md - Technical context for Claude Code
- docs/BLE_TCP_BRIDGE_ANALYSIS.md - Comprehensive analysis
- docs/README_BLE_BRIDGE.md - User guide
- docs/DEPLOY_BLE_BRIDGE.md - Production deployment

## Cleanup Completed

- [x] Remove BLE bridge source files from MeshMonitor
- [x] Remove BLE bridge documentation from MeshMonitor
- [x] Update docker-compose.ble.yml to reference external image
- [x] Create tools/README.md pointing to new repo
- [x] Package complete BLE bridge in tarball
- [x] Document migration process

## Next Steps (For New Repository)

1. Extract tarball to new repository
2. Set up GitHub Actions for automated builds
3. Configure GitHub Container Registry
4. Add repository description and topics
5. Create initial release (v1.0.0)
6. Add links back to MeshMonitor in README
