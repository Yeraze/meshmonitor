# Gateway OTA Firmware Updates — Design Document

**Issue:** #2108
**Date:** 2026-03-02
**Status:** Approved

## Scope

Allow MeshMonitor admins to check for, download, and flash Meshtastic firmware updates to the directly-connected gateway node via the Meshtastic Python CLI.

**In scope:**
- Gateway node only (the node MeshMonitor connects to via TCP/IP)
- Manual trigger with step-by-step confirmation wizard
- Background polling for available updates (configurable, default 6h)
- Release channels: Stable, Alpha, Custom URL
- Version list with upgrade and rollback support
- Config backup before flashing
- Live progress streaming via Socket.IO

**Out of scope:**
- Remote node OTA (nodes only reachable via LoRa mesh)
- Fully automatic updates (no unattended flash)

## Architecture

### Approach: Backend Service + Python CLI

A new `FirmwareUpdateService` on the backend shells out to the `meshtastic` Python CLI for OTA delivery. This leverages the officially supported OTA mechanism, which handles hardware quirks, error recovery, and protocol details. The Docker image already has a Python venv for Apprise notifications — we extend it (or create a parallel one) with the `meshtastic` pip package.

### New Files

| File | Purpose |
|------|---------|
| `src/server/services/firmwareUpdateService.ts` | Core service: polling, download, extract, flash, status |
| `src/server/routes/firmwareUpdateRoutes.ts` | REST API endpoints |
| `src/components/FirmwareUpdate/` | Frontend components for the settings page section |

### Backend Service: `FirmwareUpdateService`

Singleton class, modeled after the existing `UpgradeService` pattern.

**Responsibilities:**
- Poll the Meshtastic GitHub Releases API (`https://api.github.com/repos/meshtastic/firmware/releases`) on a configurable interval
- Match firmware assets to the gateway's `hwModel` using strict regex
- Download release `.zip`, extract the correct `.bin` to a temp directory
- Run `meshtastic --host <ip> --export-config` for config backup before flash
- Run `meshtastic --host <ip> --ota <firmware.bin>` via `child_process.spawn`
- Stream stdout/stderr to the frontend via Socket.IO
- Track update state in memory (idle, checking, downloading, extracting, backing-up, flashing, verifying, success, error)
- After flash, verify new firmware version on node reconnect

**Hardware matching:**
- Map `hwModel` enum to Meshtastic firmware naming convention
- Use strict regex per hardware type, e.g.: `firmware-heltec-v4-\d+\.\d+\.\d+\.[a-f0-9]+\.bin$`
- Explicitly reject `.factory.bin`, screen variants (`-tft`, `-oled`), and bootloader files

### REST API

All endpoints require admin authentication (`requireAdmin` middleware).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/firmware/status` | Current update state, available version info, channel config |
| `GET` | `/api/firmware/releases` | List available releases for current hardware on selected channel |
| `POST` | `/api/firmware/check` | Force an immediate check for new firmware |
| `POST` | `/api/firmware/update` | Trigger download + flash for a specific version |
| `POST` | `/api/firmware/update/confirm` | Confirm current wizard step to proceed |
| `POST` | `/api/firmware/update/cancel` | Cancel in-progress update |
| `GET` | `/api/firmware/backups` | List stored config backups |
| `POST` | `/api/firmware/restore` | Restore a config backup to the node |

### Socket.IO Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `firmware:status` | Server → Client | `{ step, state, message, progress?, logs? }` |
| `firmware:available` | Server → Client | `{ version, releaseDate, channel }` (emitted when polling finds a new version) |

### Release Channels

Stored in app settings (existing settings mechanism):

- **Stable**: Latest non-prerelease from GitHub Releases API
- **Alpha**: Latest release including prereleases
- **Custom URL**: User-provided URL pointing to a firmware `.bin` or `.zip`

## Frontend Design

### Location

New "Firmware Updates" section in the System Settings page.

### UI Components

**Status Card:**
- Current gateway firmware version (from `localNodeInfo`)
- Hardware model name
- Channel selector dropdown (Stable / Alpha / Custom URL)
- Custom URL input (visible when Custom URL selected)
- Last checked timestamp + "Check Now" button

**Version List:**
- Recent releases for current hardware (last 10-20 per channel)
- Each row: version, release date, release notes link, "Install" button
- Current version highlighted
- Newer versions labeled "Update available"
- Older versions available for rollback

**Update Wizard (step-by-step confirmation):**

| Step | Action | User Sees |
|------|--------|-----------|
| 1. Pre-flight | Validate | Target version, gateway IP, hardware model, current version |
| 2. Config backup | `meshtastic --export-config` | "Backing up config..." → backup file path, download link |
| 3. Download | Fetch `.zip` from GitHub | Download URL, file size, progress bar |
| 4. Extract & Match | Unzip, regex match | Matched `.bin` filename, rejected files with reasons |
| 5. Flash | `meshtastic --ota` | Live CLI log stream, progress |
| 6. Verify | Wait for reconnect | Reconnection status → firmware version match/mismatch |

Each step has a "Confirm" button to proceed and a "Cancel" button to abort. Cancel cleans up temp files.

The wizard is non-blocking: the backend does the work and streams status via Socket.IO, so the user can navigate away and return to see progress.

**State Management:**
- TanStack Query for REST endpoints (releases list, status, backups)
- Socket.IO listener for real-time progress during updates
- Same patterns used throughout the existing frontend

## Docker & Infrastructure

### Python Dependency

- Add `meshtastic` pip package to the Docker image
- The existing Python venv (`lib/python3.12/`) is used for Apprise; either extend it or create a parallel venv
- Ensure `meshtastic` CLI binary is on `PATH` for `child_process.spawn`

### Config Backup Storage

- Backups stored in `data/firmware-backups/config-<nodeId>-<timestamp>.yaml`
- Retained indefinitely (user manages via UI or filesystem)
- The `data/` directory is already volume-mounted in Docker

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FIRMWARE_CHECK_INTERVAL` | `21600000` (6h ms) | Background polling interval |
| `FIRMWARE_CHECK_ENABLED` | `true` | Enable/disable background polling |

### No Database Changes

Firmware update state is transient (in-memory on the service). Channel preference is stored in the existing app settings mechanism. No new tables or migrations needed.

## Safety & Error Handling

- **Strict hardware regex**: Per `hwModel`, reject `.factory.bin`, screen variants, bootloader files
- **Config backup before flash**: `meshtastic --export-config` saves node configuration; restorable if flash causes config loss
- **Step-by-step confirmation**: User confirms at each stage with full visibility into what's happening
- **Timeout**: If Python CLI doesn't complete within 5 minutes (configurable), kill the process and report failure
- **No concurrent updates**: Only one firmware update at a time; reject new requests while in progress
- **Reconnect handling**: After flash, expect gateway reboot. Existing TCP reconnect logic handles this. Service compares new `firmwareVersion` to verify success
- **Rollback warning**: Confirmation dialog notes that downgrading may have compatibility implications
- **GitHub API rate limiting**: Respect rate limits; cache release metadata between polls. Use conditional requests (`If-None-Match` / `ETag`) to minimize API usage
