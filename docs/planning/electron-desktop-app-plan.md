# Electron Desktop Application Implementation Plan

**Status:** Planning Phase
**Target Release:** Post-2.4.0 (after bug stabilization)
**Last Updated:** 2025-10-12

## Overview

Add Electron packaging to MeshMonitor to create Windows .exe installers (and Mac/Linux builds) for novice users who are unfamiliar with Docker. The solution will be integrated with GitHub Actions for automated builds on releases.

## Research Summary

### Solution Selection: Electron + electron-builder

After evaluating multiple options, Electron was selected for the following reasons:

**Alternatives Considered:**
- **Node.js Native SEA** - Cannot cross-compile from Linux/Mac to Windows
- **pkg** - Deprecated, no longer maintained
- **boxednode** - Takes hours to compile, 10GB+ disk space required
- **caxa** - Original project abandoned
- **NeutralinoJS** - Lightweight (~2MB) but no auto-update, no installer bundler, smaller ecosystem

**Why Electron:**
- ✅ Mature, widely-used solution with excellent tooling
- ✅ Cross-platform builds from Linux/Mac via Docker
- ✅ Built-in auto-update support via electron-updater
- ✅ Professional NSIS installer for Windows
- ✅ Official GitHub Action: `samuelmeuli/action-electron-builder`
- ✅ Handles native modules (better-sqlite3) properly
- ✅ Can provide GUI configuration for novice users
- ✅ System tray integration possible
- ❌ Large file size (~150-200 MB) - acceptable tradeoff for UX

### GitHub Actions Integration

**Cross-Platform Building:**
- ✅ Can build Windows .exe from Linux runners using Docker
- ✅ Can build Mac .dmg from macos-latest runners
- ✅ Matrix strategy allows parallel builds across platforms
- ✅ Average build time: 5-10 minutes for all platforms

**Workflow Integration:**
- Will add new job to existing `.github/workflows/release.yml`
- Builds run in parallel with Docker image builds
- Artifacts automatically uploaded to GitHub Releases
- Uses existing test suite validation

## Implementation Plan

### Phase 1: Electron Setup & Configuration

**1.1 Install Dependencies**
```bash
npm install --save-dev electron electron-builder
npm install --save-dev @types/electron
```

**1.2 Create Electron Main Process**
- Create `src/electron/main.ts`
  - Window management (BrowserWindow creation)
  - Start embedded Express server
  - Handle app lifecycle events
  - Menu bar and system tray setup
- Create `src/electron/preload.ts`
  - Secure IPC bridge between renderer and main
  - Expose safe APIs to frontend
- Create `tsconfig.electron.json`
  - TypeScript configuration for Electron
  - Target Node.js environment

**1.3 Configuration UI**
- Create first-run setup dialog
- Configuration fields:
  - Meshtastic Node IP (required)
  - Meshtastic TCP Port (default: 4403)
  - Server Port (default: 3001)
  - Auto-start on system boot (optional)
- Store config in `app.getPath('userData')/config.json`
- Allow manual editing of config file
- Provide "Edit Settings" menu option

**1.4 Update package.json**

Add scripts:
```json
{
  "scripts": {
    "electron:dev": "concurrently \"npm run dev\" \"electron .\"",
    "electron:build": "electron-builder",
    "electron:build:win": "electron-builder --windows",
    "electron:build:mac": "electron-builder --mac",
    "electron:build:linux": "electron-builder --linux"
  }
}
```

Add electron-builder configuration:
```json
{
  "build": {
    "appId": "com.meshmonitor.app",
    "productName": "MeshMonitor",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**/*",
      "package.json"
    ],
    "win": {
      "target": "nsis",
      "icon": "assets/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    },
    "mac": {
      "target": "dmg",
      "icon": "assets/icon.icns"
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "icon": "assets/icon.png",
      "category": "Network"
    }
  }
}
```

### Phase 2: Server Integration

**2.1 Embed Express Server**
- Import and start Express server from `main.ts`
- Handle server lifecycle:
  - Start on app ready
  - Graceful shutdown on app quit
- Capture server logs and display in console
- Handle port conflicts gracefully

**2.2 Bundle Assets**
- Configure electron-builder to include:
  - `dist/` - frontend build
  - `dist/server/` - backend build
  - Database migrations/schema
- Handle file paths properly:
  - Use `app.getPath('userData')` for database
  - Use `app.getAppPath()` for static assets
  - Update database service to detect Electron environment

**2.3 Configuration Migration**
- Move from environment variables to config file
- Support both methods for backward compatibility
- Priority: config file > environment variables > defaults
- Config schema:
```json
{
  "meshtastic": {
    "nodeIp": "192.168.1.100",
    "tcpPort": 4403
  },
  "server": {
    "port": 3001
  },
  "app": {
    "autoStart": false,
    "minimizeToTray": true
  }
}
```

### Phase 3: GitHub Actions Integration

**3.1 Update Release Workflow**

Add to `.github/workflows/release.yml` after `test-suite` job:

```yaml
build-desktop-apps:
  name: Build Desktop Apps
  needs: [validate-release, test-suite]
  strategy:
    matrix:
      os: [windows-latest, macos-latest, ubuntu-latest]
  runs-on: ${{ matrix.os }}

  steps:
    - name: Checkout code
      uses: actions/checkout@v5

    - name: Setup Node.js
      uses: actions/setup-node@v5
      with:
        node-version: '22.x'
        cache: 'npm'

    - name: Install dependencies
      run: npm ci

    - name: Update version
      run: |
        VERSION="${{ needs.validate-release.outputs.version }}"
        VERSION_NO_V="${VERSION#v}"
        npm version "$VERSION_NO_V" --no-git-tag-version --allow-same-version

    - name: Build frontend
      run: npm run build

    - name: Build server
      run: npm run build:server

    - name: Build Electron app
      uses: samuelmeuli/action-electron-builder@v1
      with:
        github_token: ${{ secrets.GITHUB_TOKEN }}
        release: ${{ github.event_name == 'release' }}
        mac_certs: ${{ secrets.MAC_CERTS }}
        mac_certs_password: ${{ secrets.MAC_CERTS_PASSWORD }}

    - name: Upload artifacts
      uses: actions/upload-artifact@v4
      with:
        name: desktop-${{ matrix.os }}
        path: |
          release/*.exe
          release/*.dmg
          release/*.AppImage
          release/*.deb
        retention-days: 7
```

**3.2 Update Release Assets**

Modify `update-release` job to include desktop apps:

```yaml
- name: Download desktop artifacts
  uses: actions/download-artifact@v5
  with:
    pattern: desktop-*
    merge-multiple: true

- name: Upload release assets
  uses: softprops/action-gh-release@v2
  with:
    files: |
      meshmonitor-*.tar.gz
      release/*.exe
      release/*.dmg
      release/*.AppImage
      release/*.deb
```

**3.3 Update Release Notes**

Add desktop app section to generated release notes:

```markdown
### 🖥️ Desktop Applications

**Windows:**
- Download `MeshMonitor-Setup-${VERSION}.exe`
- Double-click to install
- Follow setup wizard to configure node IP

**macOS:**
- Download `MeshMonitor-${VERSION}.dmg`
- Drag to Applications folder

**Linux:**
- Download `MeshMonitor-${VERSION}.AppImage`
- Make executable: `chmod +x MeshMonitor-*.AppImage`
- Run: `./MeshMonitor-*.AppImage`
```

### Phase 4: Documentation & Polish

**4.1 Create Documentation**
- `docs/installation/desktop-app.md` - Installation guide
- `docs/configuration/desktop-app-config.md` - Configuration options
- Update main README.md with desktop app section
- Add screenshots of configuration UI
- Troubleshooting section for common issues

**4.2 App Metadata**
- Create icons:
  - `assets/icon.ico` - Windows (256x256)
  - `assets/icon.icns` - macOS (1024x1024)
  - `assets/icon.png` - Linux (512x512)
- Set proper app metadata in electron-builder config:
  - Version info
  - Copyright notice
  - Company name
  - Description
- Add About dialog showing:
  - App version
  - Node.js version
  - Electron version
  - Links to documentation/GitHub

**4.3 User Experience Enhancements**
- Add menu bar:
  - File → Settings
  - File → Quit
  - View → Reload
  - View → Toggle DevTools
  - Help → Documentation
  - Help → About
- System tray integration:
  - Minimize to tray option
  - Right-click menu (Show/Hide, Quit)
  - Tray tooltip showing connection status
- Auto-update support:
  - Integrate electron-updater
  - Check for updates on startup
  - Notify user when update available
  - Download and install in background

## Configuration Approach for Novice Users

### First-Run Experience
1. User downloads and installs `MeshMonitor-Setup.exe`
2. App launches and shows setup wizard
3. Wizard prompts for Meshtastic Node IP
4. Optional: Advanced settings (ports, auto-start)
5. App saves config and starts server
6. Browser opens automatically to `localhost:3001`

### Configuration File Location
- **Windows:** `%APPDATA%\MeshMonitor\config.json`
- **macOS:** `~/Library/Application Support/MeshMonitor/config.json`
- **Linux:** `~/.config/MeshMonitor/config.json`

### Manual Configuration
Users can edit `config.json` manually:
```json
{
  "meshtastic": {
    "nodeIp": "192.168.5.106",
    "tcpPort": 4403
  },
  "server": {
    "port": 3001
  },
  "app": {
    "autoStart": false,
    "minimizeToTray": true,
    "checkForUpdates": true
  }
}
```

## Expected File Sizes
- **Windows .exe installer:** ~150-200 MB
- **macOS .dmg:** ~150-200 MB
- **Linux .AppImage:** ~150-200 MB

## Testing Strategy

### Manual Testing
1. Test on clean Windows 10/11 system
2. Verify installer works without Node.js installed
3. Test configuration UI functionality
4. Verify server starts correctly
5. Test native modules (better-sqlite3) work in packaged app
6. Test auto-update mechanism

### Automated Testing
- Add Electron tests using Spectron or Playwright
- Test main process startup/shutdown
- Test IPC communication
- Test configuration persistence
- Add to CI pipeline

## Timeline Estimate

- **Phase 1:** 2-3 days (Electron setup)
- **Phase 2:** 2-3 days (Server integration)
- **Phase 3:** 1-2 days (GitHub Actions)
- **Phase 4:** 1-2 days (Documentation & polish)
- **Testing & Refinement:** 2-3 days

**Total:** 8-13 days of development work

## Dependencies

### NPM Packages to Add
```json
{
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.9.0",
    "@types/electron": "^1.6.10"
  },
  "dependencies": {
    "electron-updater": "^6.1.7"
  }
}
```

### GitHub Secrets Required (Optional)
- `MAC_CERTS` - macOS code signing certificate
- `MAC_CERTS_PASSWORD` - Certificate password
- `WINDOWS_CERTS` - Windows code signing certificate (optional)
- `WINDOWS_CERTS_PASSWORD` - Certificate password (optional)

Note: Code signing is optional but recommended for professional releases

## Success Criteria

- ✅ Windows users can download single .exe installer
- ✅ Installer works on systems without Node.js or Docker
- ✅ Configuration UI is intuitive for novice users
- ✅ App starts automatically on system boot (optional)
- ✅ GitHub Actions automatically build all platforms on release
- ✅ Installers are attached to GitHub Releases
- ✅ Documentation is clear and comprehensive
- ✅ Native modules (SQLite) work correctly in packaged app
- ✅ Auto-update mechanism works reliably

## Notes

- This will be implemented **after 2.4.0 stabilization**
- Wait for any critical bugs to be resolved before starting
- Consider creating a feature branch for this work
- May want to release as experimental/beta initially
- File size (~200 MB) is acceptable tradeoff for novice user experience
- Can offer both Docker and desktop app options - users choose preferred method

## References

- [Electron Documentation](https://www.electronjs.org/docs)
- [electron-builder Documentation](https://www.electron.build/)
- [samuelmeuli/action-electron-builder](https://github.com/samuelmeuli/action-electron-builder)
- [electron-updater Guide](https://www.electron.build/auto-update.html)
