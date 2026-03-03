# Gateway OTA Firmware Updates — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow MeshMonitor admins to check for and flash Meshtastic firmware updates to the gateway node via the Meshtastic Python CLI, with a step-by-step confirmation wizard.

**Architecture:** New `FirmwareUpdateService` backend singleton queries GitHub Releases API for firmware, matches to gateway's `hwModel`, and shells out to `meshtastic --host <ip> --export-config` (backup) and `meshtastic --host <ip> --ota-update <firmware.bin>` (flash). Frontend section in SettingsTab renders a version list and multi-step wizard, receiving live progress via Socket.IO.

**Tech Stack:** TypeScript, Express 5, child_process.spawn, Socket.IO (via dataEventEmitter), TanStack Query, React, Meshtastic Python CLI (already installed at `/usr/local/bin/meshtastic` in Docker).

**Design doc:** `docs/plans/2026-03-02-gateway-ota-firmware-updates-design.md`

---

## Reference: Key Codebase Patterns

These patterns are used throughout and referenced in tasks below.

### Backend Singleton Service Pattern
```typescript
// src/server/services/myService.ts
import { logger } from '../../utils/logger.js';

class MyService {
  constructor() { /* init */ }
  // methods...
}

export const myService = new MyService();
export default myService;
```

### Backend Route Pattern
```typescript
// src/server/routes/myRoutes.ts
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';

const router = Router();
router.use(requireAdmin());

router.get('/endpoint', async (_req: Request, res: Response) => {
  res.json({ success: true, data: {} });
});

export default router;
```

### Route Registration (server.ts ~line 764)
```typescript
import firmwareUpdateRoutes from './routes/firmwareUpdateRoutes.js';
// ...
apiRouter.use('/firmware', firmwareUpdateRoutes);
```

### Socket.IO Emit Pattern (auto-forwarded to all clients)
```typescript
import { dataEventEmitter } from './dataEventEmitter.js';

// This automatically reaches all WebSocket clients via webSocketService
dataEventEmitter.emit('data', {
  type: 'firmware:status',
  data: { step: 'downloading', progress: 45 },
  timestamp: Date.now()
});
```

### Frontend Socket.IO Listener (useWebSocket.ts)
```typescript
socket.on('firmware:status', (data) => { /* handle */ });
```

### Settings Storage
```typescript
await databaseService.getSettingAsync('firmwareChannel');        // 'stable' | 'alpha' | 'custom'
await databaseService.setSettingAsync('firmwareChannel', 'stable');
```

### Frontend Settings Section Pattern
```tsx
// Added to SettingsTab.tsx SectionNav items array (~line 785):
{ id: 'settings-firmware', label: t('firmware.title', 'Firmware Updates') }

// Rendered in settings-content div:
<div id="settings-firmware" className="settings-section">
  <FirmwareUpdateSection baseUrl={baseUrl} />
</div>
```

### i18n Keys (flat in public/locales/en.json)
```json
{ "firmware.title": "Firmware Updates", "firmware.check_now": "Check Now" }
```

### CSS Classes
`settings-section`, `setting-item`, `setting-description`, `setting-input`, `save-button`, `danger-btn`

### Meshtastic CLI Commands
```bash
# Config backup (stdout is YAML):
meshtastic --host 192.168.1.100 --export-config > backup.yaml

# OTA flash (added in meshtastic Python 2.7.8, PR #898):
meshtastic --host 192.168.1.100 --ota-update firmware.bin

# Config restore:
meshtastic --host 192.168.1.100 --configure backup.yaml
```

### GitHub Releases API
```
GET https://api.github.com/repos/meshtastic/firmware/releases?per_page=20
```
Each release has: `tag_name` (e.g., `v2.7.19.bb3d6d5`), `prerelease` (bool), `published_at`, `html_url`, `assets[]` array. Each release includes a JSON manifest asset named `firmware-{version}.json` containing:
```json
{
  "version": "2.7.19.bb3d6d5",
  "targets": [
    { "board": "heltec-v3", "platform": "esp32s3" },
    { "board": "heltec-v4", "platform": "esp32s3" }
  ]
}
```
Firmware binaries are inside platform-specific zip assets: `firmware-esp32s3-{version}.zip`.

### hwModel → Board Name Mapping
The gateway's `hwModel` is a numeric enum (e.g., `43` = `HELTEC_V3`). The `HARDWARE_MODELS` map in `src/utils/hardwareModel.ts` has the enum names. These map to firmware board names by lowercasing and replacing `_` with `-` (e.g., `HELTEC_V3` → `heltec-v3`). Some exceptions need manual mapping (e.g., `LILYGO_TBEAM_S3_CORE` → `tbeam-s3-core`).

---

## Task 1: hwModel-to-Board Mapping Utility

**Files:**
- Create: `src/server/services/firmwareHardwareMap.ts`
- Create: `src/server/services/firmwareHardwareMap.test.ts`

This utility maps the numeric `hwModel` enum to the board name used in Meshtastic firmware releases, and determines the platform (esp32, esp32s3, etc.) for zip file selection.

**Step 1: Write the failing test**

Create `src/server/services/firmwareHardwareMap.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { getBoardName, getPlatformForBoard, getHardwareDisplayName, isOtaCapable } from './firmwareHardwareMap.js';

describe('firmwareHardwareMap', () => {
  describe('getBoardName', () => {
    it('maps HELTEC_V3 (43) to heltec-v3', () => {
      expect(getBoardName(43)).toBe('heltec-v3');
    });

    it('maps HELTEC_V4 (heltec-v4 is not in current enum, test with known)', () => {
      // TBEAM = 4
      expect(getBoardName(4)).toBe('tbeam');
    });

    it('maps LILYGO_TBEAM_S3_CORE (12) to tbeam-s3-core', () => {
      expect(getBoardName(12)).toBe('tbeam-s3-core');
    });

    it('maps HELTEC_WSL_V3 (44) to heltec-wsl-v3', () => {
      expect(getBoardName(44)).toBe('heltec-wsl-v3');
    });

    it('maps RAK4631 (9) to rak4631', () => {
      expect(getBoardName(9)).toBe('rak4631');
    });

    it('returns null for UNSET (0)', () => {
      expect(getBoardName(0)).toBeNull();
    });

    it('returns null for unknown hardware model', () => {
      expect(getBoardName(99999)).toBeNull();
    });
  });

  describe('getPlatformForBoard', () => {
    it('returns esp32s3 for heltec-v3', () => {
      expect(getPlatformForBoard('heltec-v3')).toBe('esp32s3');
    });

    it('returns nrf52840 for rak4631', () => {
      expect(getPlatformForBoard('rak4631')).toBe('nrf52840');
    });

    it('returns esp32 for tbeam', () => {
      expect(getPlatformForBoard('tbeam')).toBe('esp32');
    });
  });

  describe('isOtaCapable', () => {
    it('returns true for ESP32 platforms', () => {
      expect(isOtaCapable('esp32')).toBe(true);
      expect(isOtaCapable('esp32s3')).toBe(true);
      expect(isOtaCapable('esp32c3')).toBe(true);
      expect(isOtaCapable('esp32c6')).toBe(true);
    });

    it('returns false for non-ESP32 platforms', () => {
      expect(isOtaCapable('nrf52840')).toBe(false);
      expect(isOtaCapable('rp2040')).toBe(false);
      expect(isOtaCapable('stm32')).toBe(false);
    });
  });

  describe('getHardwareDisplayName', () => {
    it('returns human-readable name for known models', () => {
      expect(getHardwareDisplayName(43)).toBe('Heltec V3');
    });

    it('returns "Unknown" for unknown models', () => {
      expect(getHardwareDisplayName(99999)).toBe('Unknown');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/services/firmwareHardwareMap.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/server/services/firmwareHardwareMap.ts`:
```typescript
import { HARDWARE_MODELS } from '../../utils/hardwareModel.js';

/**
 * Maps hwModel enum names to Meshtastic firmware board names.
 * Derived from the firmware JSON manifest `targets[].board` values.
 * Only includes boards that differ from the simple lowercase+hyphen conversion.
 */
const BOARD_NAME_OVERRIDES: Record<string, string> = {
  'LILYGO_TBEAM_S3_CORE': 'tbeam-s3-core',
  'TBEAM': 'tbeam',
  'TBEAM_V0P7': 'tbeam-v0p7',
  'T_ECHO': 't-echo',
  'T_ECHO_PLUS': 't-echo-plus',
  'T_DECK': 't-deck',
  'T_WATCH_S3': 't-watch-s3',
  'HELTEC_HT62': 'heltec-ht62-esp32c3-sx1262',
  'SENSECAP_INDICATOR': 'seeed-sensecap-indicator',
  'M5STACK': 'm5stack-cores3',
  'EBYTE_ESP32_S3': 'CDEBYTE_EoRa-S3',
  'STATION_G1': 'station-g1',
  'STATION_G2': 'station-g2',
};

/**
 * Maps board names to their platform (architecture).
 * Used to select the correct firmware zip file.
 */
const BOARD_PLATFORMS: Record<string, string> = {
  // ESP32 (original)
  'tbeam': 'esp32',
  'tbeam-v0p7': 'esp32',
  'tlora-v2': 'esp32',
  'tlora-v1': 'esp32',
  'tlora-v2-1-1p6': 'esp32',
  'tlora-v1-1p3': 'esp32',
  'tlora-v2-1-1p8': 'esp32',
  'heltec-v2-0': 'esp32',
  'heltec-v2-1': 'esp32',
  'heltec-v1': 'esp32',
  'heltec-wireless-bridge': 'esp32',
  'station-g1': 'esp32',
  'nano-g1': 'esp32',
  'nano-g1-explorer': 'esp32',
  'wiphone': 'esp32',
  // ESP32-S3
  'tbeam-s3-core': 'esp32s3',
  'heltec-v3': 'esp32s3',
  'heltec-v4': 'esp32s3',
  'heltec-v4-tft': 'esp32s3',
  'heltec-wsl-v3': 'esp32s3',
  'heltec-wireless-tracker': 'esp32s3',
  'heltec-wireless-tracker-v2': 'esp32s3',
  'heltec-wireless-paper': 'esp32s3',
  'heltec-capsule-sensor-v3': 'esp32s3',
  'heltec-vision-master-t190': 'esp32s3',
  'heltec-vision-master-e213': 'esp32s3',
  'heltec-vision-master-e290': 'esp32s3',
  'heltec-mesh-node-t114': 'esp32s3',
  'heltec_sensor_hub': 'esp32s3',
  't-deck': 'esp32s3',
  't-deck-tft': 'esp32s3',
  't-deck-pro': 'esp32s3',
  't-watch-s3': 'esp32s3',
  'picomputer-s3': 'esp32s3',
  'picomputer-s3-tft': 'esp32s3',
  'station-g2': 'esp32s3',
  'seeed-sensecap-indicator': 'esp32s3',
  'seeed-sensecap-indicator-tft': 'esp32s3',
  'seeed-xiao-s3': 'esp32s3',
  'CDEBYTE_EoRa-S3': 'esp32s3',
  'unphone': 'esp32s3',
  'tlora-t3s3-v1': 'esp32s3',
  'tlora-pager': 'esp32s3',
  't-beam-1w': 'esp32s3',
  't-eth-elite': 'esp32s3',
  'm5stack-cores3': 'esp32s3',
  'tracksenger': 'esp32s3',
  // ESP32-C3
  'heltec-ht62-esp32c3-sx1262': 'esp32c3',
  'heltec-hru-3601': 'esp32c3',
  // ESP32-C6
  // (add as needed)
  // NRF52840 (not OTA-capable via WiFi)
  'rak4631': 'nrf52840',
  'rak4631_eink': 'nrf52840',
  't-echo': 'nrf52840',
  't-echo-plus': 'nrf52840',
  'wio-tracker-wm1110': 'nrf52840',
  'canaryone': 'nrf52840',
  // RP2040 (not OTA-capable via WiFi)
  'rpi-pico': 'rp2040',
};

/**
 * Convert hwModel enum name to firmware board name.
 * Default: lowercase, replace _ with -.
 */
function enumNameToBoardName(enumName: string): string {
  return enumName.toLowerCase().replace(/_/g, '-');
}

/**
 * Get the firmware board name for a given hwModel number.
 * Returns null if model is unknown, UNSET, or not mappable.
 */
export function getBoardName(hwModel: number): string | null {
  const enumName = HARDWARE_MODELS[hwModel];
  if (!enumName || enumName === 'UNSET' || enumName === 'ANDROID_SIM' || enumName === 'PORTDUINO') {
    return null;
  }

  if (BOARD_NAME_OVERRIDES[enumName]) {
    return BOARD_NAME_OVERRIDES[enumName];
  }

  return enumNameToBoardName(enumName);
}

/**
 * Get the platform (architecture) for a given board name.
 * Used to select which firmware zip to download.
 */
export function getPlatformForBoard(boardName: string): string | null {
  return BOARD_PLATFORMS[boardName] || null;
}

/**
 * Check if a platform supports WiFi OTA updates.
 * Only ESP32 variants support WiFi OTA.
 */
export function isOtaCapable(platform: string): boolean {
  return platform.startsWith('esp32');
}

/**
 * Get a human-readable display name for a hardware model.
 */
export function getHardwareDisplayName(hwModel: number): string {
  const enumName = HARDWARE_MODELS[hwModel];
  if (!enumName || enumName === 'UNSET') return 'Unknown';
  // Convert HELTEC_V3 -> Heltec V3
  return enumName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/services/firmwareHardwareMap.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/services/firmwareHardwareMap.ts src/server/services/firmwareHardwareMap.test.ts
git commit -m "feat(firmware-ota): add hwModel-to-board mapping utility (#2108)"
```

---

## Task 2: FirmwareUpdateService — GitHub Releases Fetching

**Files:**
- Create: `src/server/services/firmwareUpdateService.ts`
- Create: `src/server/services/firmwareUpdateService.test.ts`

Core service with release fetching, channel filtering, and hardware matching. This task covers the data-fetching half; Task 3 adds the OTA execution.

**Step 1: Write the failing test**

Create `src/server/services/firmwareUpdateService.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock database service
vi.mock('../../services/database.js', () => ({
  default: {
    getSettingAsync: vi.fn().mockResolvedValue(null),
    setSettingAsync: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { FirmwareUpdateService } from './firmwareUpdateService.js';
import databaseService from '../../services/database.js';

const MOCK_RELEASE_STABLE = {
  tag_name: 'v2.6.1.abcdef',
  prerelease: false,
  published_at: '2026-01-15T00:00:00Z',
  html_url: 'https://github.com/meshtastic/firmware/releases/tag/v2.6.1.abcdef',
  assets: [
    {
      name: 'firmware-2.6.1.abcdef.json',
      browser_download_url: 'https://github.com/meshtastic/firmware/releases/download/v2.6.1.abcdef/firmware-2.6.1.abcdef.json',
    },
    {
      name: 'firmware-esp32s3-2.6.1.abcdef.zip',
      size: 50000000,
      browser_download_url: 'https://github.com/meshtastic/firmware/releases/download/v2.6.1.abcdef/firmware-esp32s3-2.6.1.abcdef.zip',
    },
  ],
};

const MOCK_RELEASE_ALPHA = {
  tag_name: 'v2.7.0.abc123',
  prerelease: true,
  published_at: '2026-02-01T00:00:00Z',
  html_url: 'https://github.com/meshtastic/firmware/releases/tag/v2.7.0.abc123',
  assets: [
    {
      name: 'firmware-2.7.0.abc123.json',
      browser_download_url: 'https://github.com/meshtastic/firmware/releases/download/v2.7.0.abc123/firmware-2.7.0.abc123.json',
    },
    {
      name: 'firmware-esp32s3-2.7.0.abc123.zip',
      size: 52000000,
      browser_download_url: 'https://github.com/meshtastic/firmware/releases/download/v2.7.0.abc123/firmware-esp32s3-2.7.0.abc123.zip',
    },
  ],
};

const MOCK_MANIFEST = {
  version: '2.6.1.abcdef',
  targets: [
    { board: 'heltec-v3', platform: 'esp32s3' },
    { board: 'heltec-v4', platform: 'esp32s3' },
    { board: 'heltec-v4-tft', platform: 'esp32s3' },
    { board: 'rak4631', platform: 'nrf52840' },
  ],
};

describe('FirmwareUpdateService', () => {
  let service: FirmwareUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FirmwareUpdateService();
  });

  afterEach(() => {
    service.stopPolling();
  });

  describe('fetchReleases', () => {
    it('fetches releases from GitHub API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [MOCK_RELEASE_STABLE, MOCK_RELEASE_ALPHA],
        headers: new Map([['etag', '"abc123"']]),
      });

      const releases = await service.fetchReleases();
      expect(releases).toHaveLength(2);
      expect(releases[0].tagName).toBe('v2.6.1.abcdef');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('api.github.com/repos/meshtastic/firmware/releases'),
        expect.any(Object)
      );
    });

    it('handles GitHub API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'rate limited' });

      const releases = await service.fetchReleases();
      expect(releases).toEqual([]);
    });
  });

  describe('getReleasesForChannel', () => {
    it('returns only stable releases when channel is stable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [MOCK_RELEASE_ALPHA, MOCK_RELEASE_STABLE],
        headers: new Map([['etag', '"abc"']]),
      });

      const releases = await service.fetchReleases();
      const stable = service.filterByChannel(releases, 'stable');
      expect(stable).toHaveLength(1);
      expect(stable[0].tagName).toBe('v2.6.1.abcdef');
    });

    it('returns all releases when channel is alpha', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [MOCK_RELEASE_ALPHA, MOCK_RELEASE_STABLE],
        headers: new Map([['etag', '"abc"']]),
      });

      const releases = await service.fetchReleases();
      const alpha = service.filterByChannel(releases, 'alpha');
      expect(alpha).toHaveLength(2);
    });
  });

  describe('findFirmwareAsset', () => {
    it('finds the correct zip for an ESP32-S3 board', () => {
      const asset = service.findFirmwareZipAsset(MOCK_RELEASE_STABLE, 'esp32s3');
      expect(asset).toBeDefined();
      expect(asset!.name).toContain('esp32s3');
    });

    it('returns null when no matching platform zip exists', () => {
      const asset = service.findFirmwareZipAsset(MOCK_RELEASE_STABLE, 'stm32');
      expect(asset).toBeNull();
    });
  });

  describe('checkBoardInManifest', () => {
    it('returns true when board is in manifest', () => {
      expect(service.checkBoardInManifest(MOCK_MANIFEST, 'heltec-v3')).toBe(true);
    });

    it('returns false when board is not in manifest', () => {
      expect(service.checkBoardInManifest(MOCK_MANIFEST, 'nonexistent-board')).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns idle status initially', () => {
      const status = service.getStatus();
      expect(status.state).toBe('idle');
      expect(status.step).toBeNull();
    });
  });

  describe('channel settings', () => {
    it('reads channel from database settings', async () => {
      (databaseService.getSettingAsync as any).mockResolvedValueOnce('alpha');
      const channel = await service.getChannel();
      expect(channel).toBe('alpha');
    });

    it('defaults to stable when no setting exists', async () => {
      (databaseService.getSettingAsync as any).mockResolvedValueOnce(null);
      const channel = await service.getChannel();
      expect(channel).toBe('stable');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/server/services/firmwareUpdateService.ts`:
```typescript
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { dataEventEmitter } from './dataEventEmitter.js';
import { getBoardName, getPlatformForBoard, isOtaCapable, getHardwareDisplayName } from './firmwareHardwareMap.js';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/meshtastic/firmware/releases';
const DEFAULT_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const FIRMWARE_BACKUP_DIR = path.join(process.env.DATA_DIR || '/data', 'firmware-backups');
const CLI_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export interface FirmwareRelease {
  tagName: string;
  version: string;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
  assets: FirmwareAsset[];
}

export interface FirmwareAsset {
  name: string;
  size: number;
  downloadUrl: string;
}

export interface FirmwareManifest {
  version: string;
  targets: Array<{ board: string; platform: string }>;
}

export type FirmwareChannel = 'stable' | 'alpha' | 'custom';

export type UpdateStep = 'preflight' | 'backup' | 'download' | 'extract' | 'flash' | 'verify';
export type UpdateState = 'idle' | 'awaiting-confirm' | 'in-progress' | 'success' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  step: UpdateStep | null;
  message: string;
  progress?: number;
  logs: string[];
  targetVersion?: string;
  error?: string;
  // Preflight info shown to user for confirmation
  preflightInfo?: {
    currentVersion: string;
    targetVersion: string;
    gatewayIp: string;
    hwModel: string;
    boardName: string;
    platform: string;
  };
  // Backup info
  backupPath?: string;
  // Download info
  downloadUrl?: string;
  downloadSize?: number;
  // Extract info
  matchedFile?: string;
  rejectedFiles?: Array<{ name: string; reason: string }>;
}

export class FirmwareUpdateService {
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private cachedReleases: FirmwareRelease[] = [];
  private lastFetchTime: number = 0;
  private etag: string | null = null;
  private status: UpdateStatus = { state: 'idle', step: null, message: '', logs: [] };
  private activeProcess: ChildProcess | null = null;
  private tempDir: string | null = null;

  /**
   * Start background polling for firmware releases.
   */
  startPolling(): void {
    const enabled = process.env.FIRMWARE_CHECK_ENABLED !== 'false';
    if (!enabled) {
      logger.info('[FirmwareUpdate] Background polling disabled');
      return;
    }

    const interval = parseInt(process.env.FIRMWARE_CHECK_INTERVAL || '', 10) || DEFAULT_CHECK_INTERVAL;
    logger.info(`[FirmwareUpdate] Starting background polling (interval: ${interval / 1000}s)`);

    // Initial check after 30s delay (let the system start up first)
    setTimeout(() => {
      this.fetchReleases().catch(err => logger.error('[FirmwareUpdate] Initial fetch error:', err));
    }, 30000);

    this.pollingTimer = setInterval(() => {
      this.fetchReleases().catch(err => logger.error('[FirmwareUpdate] Polling fetch error:', err));
    }, interval);
  }

  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Fetch releases from GitHub API. Uses ETag for conditional requests.
   */
  async fetchReleases(): Promise<FirmwareRelease[]> {
    try {
      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'MeshMonitor',
      };
      if (this.etag) {
        headers['If-None-Match'] = this.etag;
      }

      const response = await fetch(`${GITHUB_RELEASES_URL}?per_page=20`, { headers });

      if (response.status === 304) {
        // Not modified — return cached
        return this.cachedReleases;
      }

      if (!response.ok) {
        logger.warn(`[FirmwareUpdate] GitHub API returned ${response.status}: ${response.statusText}`);
        return this.cachedReleases.length > 0 ? this.cachedReleases : [];
      }

      // Store ETag for conditional requests
      const newEtag = response.headers.get('etag');
      if (newEtag) this.etag = newEtag;

      const data = await response.json() as any[];
      this.cachedReleases = data.map((r: any) => ({
        tagName: r.tag_name,
        version: r.tag_name.replace(/^v/, ''),
        prerelease: r.prerelease,
        publishedAt: r.published_at,
        htmlUrl: r.html_url,
        assets: (r.assets || []).map((a: any) => ({
          name: a.name,
          size: a.size || 0,
          downloadUrl: a.browser_download_url,
        })),
      }));
      this.lastFetchTime = Date.now();

      logger.info(`[FirmwareUpdate] Fetched ${this.cachedReleases.length} releases`);
      return this.cachedReleases;
    } catch (err) {
      logger.error('[FirmwareUpdate] Failed to fetch releases:', err);
      return this.cachedReleases.length > 0 ? this.cachedReleases : [];
    }
  }

  /**
   * Filter releases by channel.
   */
  filterByChannel(releases: FirmwareRelease[], channel: FirmwareChannel): FirmwareRelease[] {
    if (channel === 'alpha') return releases; // alpha includes everything
    if (channel === 'stable') return releases.filter(r => !r.prerelease);
    return releases; // custom channel shows all releases too
  }

  /**
   * Find the firmware zip asset for a given platform in a release.
   */
  findFirmwareZipAsset(release: FirmwareRelease, platform: string): FirmwareAsset | null {
    const pattern = new RegExp(`^firmware-${platform}-.*\\.zip$`);
    return release.assets.find(a => pattern.test(a.name)) || null;
  }

  /**
   * Check if a board name exists in a firmware manifest.
   */
  checkBoardInManifest(manifest: FirmwareManifest, boardName: string): boolean {
    return manifest.targets.some(t => t.board === boardName);
  }

  /**
   * Find the correct firmware binary for a board inside an extracted zip directory.
   * Uses strict regex matching — rejects factory, screen variants, bootloader files.
   */
  findFirmwareBinary(extractedDir: string, boardName: string, version: string): {
    matched: string | null;
    rejected: Array<{ name: string; reason: string }>;
  } {
    const files = fs.readdirSync(extractedDir);
    const rejected: Array<{ name: string; reason: string }> = [];
    let matched: string | null = null;

    // Build strict regex: firmware-<board>-<version>.bin
    // Reject: .factory.bin, -tft, -oled, -inkhud variants (unless the board name itself includes them)
    const exactPattern = new RegExp(
      `^firmware-${boardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\.\\d+\\.\\d+\\.[a-f0-9]+\\.bin$`
    );

    for (const file of files) {
      if (!file.endsWith('.bin')) continue;

      if (file.includes('.factory.')) {
        rejected.push({ name: file, reason: 'Factory image — not suitable for OTA' });
        continue;
      }

      if (exactPattern.test(file)) {
        matched = file;
      } else if (file.includes(boardName)) {
        // Contains board name but doesn't match exact pattern (variant)
        rejected.push({ name: file, reason: 'Screen/display variant — does not match exact board' });
      }
    }

    return { matched, rejected };
  }

  /**
   * Get the current firmware update channel from settings.
   */
  async getChannel(): Promise<FirmwareChannel> {
    const channel = await databaseService.getSettingAsync('firmwareChannel');
    if (channel === 'alpha' || channel === 'custom') return channel;
    return 'stable';
  }

  /**
   * Set the firmware update channel.
   */
  async setChannel(channel: FirmwareChannel): Promise<void> {
    await databaseService.setSettingAsync('firmwareChannel', channel);
  }

  /**
   * Get the custom firmware URL from settings.
   */
  async getCustomUrl(): Promise<string | null> {
    return databaseService.getSettingAsync('firmwareCustomUrl');
  }

  /**
   * Set the custom firmware URL.
   */
  async setCustomUrl(url: string): Promise<void> {
    await databaseService.setSettingAsync('firmwareCustomUrl', url);
  }

  /**
   * Get current update status.
   */
  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  /**
   * Emit status update via Socket.IO and update internal state.
   */
  private updateStatus(partial: Partial<UpdateStatus>): void {
    Object.assign(this.status, partial);
    dataEventEmitter.emit('data', {
      type: 'firmware:status',
      data: this.getStatus(),
      timestamp: Date.now(),
    });
  }

  private appendLog(message: string): void {
    this.status.logs.push(message);
    this.updateStatus({});
  }

  /**
   * Reset status to idle.
   */
  resetStatus(): void {
    this.status = { state: 'idle', step: null, message: '', logs: [] };
  }

  /**
   * Get cached releases (from last fetch).
   */
  getCachedReleases(): FirmwareRelease[] {
    return this.cachedReleases;
  }

  getLastFetchTime(): number {
    return this.lastFetchTime;
  }

  /**
   * Cancel an in-progress update.
   */
  cancelUpdate(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
    this.cleanupTempDir();
    this.updateStatus({ state: 'idle', step: null, message: 'Update cancelled' });
  }

  private cleanupTempDir(): void {
    if (this.tempDir && fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
      this.tempDir = null;
    }
  }

  /**
   * Run a CLI command and stream output. Returns stdout as string.
   */
  runCliCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { timeout: CLI_TIMEOUT });
      this.activeProcess = proc;
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        this.appendLog(text.trim());
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        this.appendLog(`[stderr] ${text.trim()}`);
      });

      proc.on('close', (code) => {
        this.activeProcess = null;
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', (err) => {
        this.activeProcess = null;
        reject(err);
      });
    });
  }

  /**
   * Ensure the firmware-backups directory exists.
   */
  ensureBackupDir(): void {
    if (!fs.existsSync(FIRMWARE_BACKUP_DIR)) {
      fs.mkdirSync(FIRMWARE_BACKUP_DIR, { recursive: true });
    }
  }

  /**
   * List existing config backups.
   */
  listBackups(): Array<{ filename: string; path: string; timestamp: number; size: number }> {
    this.ensureBackupDir();
    try {
      return fs.readdirSync(FIRMWARE_BACKUP_DIR)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map(f => {
          const fullPath = path.join(FIRMWARE_BACKUP_DIR, f);
          const stat = fs.statSync(fullPath);
          return {
            filename: f,
            path: fullPath,
            timestamp: stat.mtimeMs,
            size: stat.size,
          };
        })
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }
}

export const firmwareUpdateService = new FirmwareUpdateService();
export default firmwareUpdateService;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/services/firmwareUpdateService.ts src/server/services/firmwareUpdateService.test.ts
git commit -m "feat(firmware-ota): add FirmwareUpdateService with GitHub release fetching (#2108)"
```

---

## Task 3: FirmwareUpdateService — OTA Execution Pipeline

**Files:**
- Modify: `src/server/services/firmwareUpdateService.ts`
- Modify: `src/server/services/firmwareUpdateService.test.ts`

Add the multi-step update pipeline: preflight → backup → download → extract → flash → verify.

**Step 1: Write failing tests for the pipeline**

Append to `src/server/services/firmwareUpdateService.test.ts`:
```typescript
describe('Update Pipeline', () => {
  describe('startPreflight', () => {
    it('sets status to awaiting-confirm with preflight info', () => {
      service.startPreflight({
        currentVersion: '2.5.0.aaa',
        targetVersion: '2.6.1.abcdef',
        targetRelease: MOCK_RELEASE_STABLE,
        gatewayIp: '192.168.1.100',
        hwModel: 43,
      });

      const status = service.getStatus();
      expect(status.state).toBe('awaiting-confirm');
      expect(status.step).toBe('preflight');
      expect(status.preflightInfo?.targetVersion).toBe('2.6.1.abcdef');
      expect(status.preflightInfo?.boardName).toBe('heltec-v3');
    });

    it('rejects if hwModel is not OTA-capable', () => {
      expect(() => {
        service.startPreflight({
          currentVersion: '2.5.0.aaa',
          targetVersion: '2.6.1.abcdef',
          targetRelease: MOCK_RELEASE_STABLE,
          gatewayIp: '192.168.1.100',
          hwModel: 9, // RAK4631 — nrf52840, not OTA-capable
        });
      }).toThrow('not supported');
    });
  });

  describe('cancelUpdate', () => {
    it('resets status to idle', () => {
      service.startPreflight({
        currentVersion: '2.5.0.aaa',
        targetVersion: '2.6.1.abcdef',
        targetRelease: MOCK_RELEASE_STABLE,
        gatewayIp: '192.168.1.100',
        hwModel: 43,
      });

      service.cancelUpdate();
      expect(service.getStatus().state).toBe('idle');
    });
  });
});
```

**Step 2: Run tests to verify failures**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts`
Expected: FAIL — `startPreflight` not found

**Step 3: Implement the pipeline methods**

Add to `FirmwareUpdateService` class in `firmwareUpdateService.ts`:
```typescript
  /**
   * Step 1: Start preflight check. Validates hardware and sets up update state.
   * After this, frontend shows preflight info and user confirms.
   */
  startPreflight(params: {
    currentVersion: string;
    targetVersion: string;
    targetRelease: FirmwareRelease;
    gatewayIp: string;
    hwModel: number;
  }): void {
    if (this.status.state !== 'idle') {
      throw new Error('Update already in progress');
    }

    const boardName = getBoardName(params.hwModel);
    if (!boardName) {
      throw new Error(`Hardware model ${params.hwModel} is not recognized`);
    }

    const platform = getPlatformForBoard(boardName);
    if (!platform || !isOtaCapable(platform)) {
      throw new Error(`Hardware ${boardName} (${platform || 'unknown platform'}) is not supported for WiFi OTA`);
    }

    const zipAsset = this.findFirmwareZipAsset(params.targetRelease, platform);
    if (!zipAsset) {
      throw new Error(`No firmware zip found for platform ${platform} in release ${params.targetVersion}`);
    }

    this.status = {
      state: 'awaiting-confirm',
      step: 'preflight',
      message: 'Review update details and confirm to proceed',
      logs: [`Preflight check passed for ${boardName} (${platform})`],
      targetVersion: params.targetVersion,
      preflightInfo: {
        currentVersion: params.currentVersion,
        targetVersion: params.targetVersion,
        gatewayIp: params.gatewayIp,
        hwModel: getHardwareDisplayName(params.hwModel),
        boardName,
        platform,
      },
    };
    this.updateStatus({});
  }

  /**
   * Step 2: Backup node configuration.
   */
  async executeBackup(gatewayIp: string, nodeId: string): Promise<string> {
    this.updateStatus({ state: 'in-progress', step: 'backup', message: 'Backing up node configuration...' });

    this.ensureBackupDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `config-${nodeId}-${timestamp}.yaml`;
    const backupPath = path.join(FIRMWARE_BACKUP_DIR, backupFilename);

    try {
      const result = await this.runCliCommand('meshtastic', ['--host', gatewayIp, '--export-config']);

      if (result.exitCode !== 0) {
        throw new Error(`Config export failed (exit code ${result.exitCode}): ${result.stderr}`);
      }

      fs.writeFileSync(backupPath, result.stdout, 'utf-8');
      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'backup',
        message: `Configuration backed up to ${backupFilename}`,
        backupPath,
      });

      return backupPath;
    } catch (err: any) {
      this.updateStatus({
        state: 'error',
        message: `Backup failed: ${err.message}`,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Step 3: Download firmware zip.
   */
  async executeDownload(downloadUrl: string): Promise<string> {
    this.updateStatus({ state: 'in-progress', step: 'download', message: 'Downloading firmware...', downloadUrl });

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshmonitor-firmware-'));
    const zipPath = path.join(this.tempDir, 'firmware.zip');

    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(zipPath, buffer);

      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'download',
        message: `Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`,
        downloadSize: buffer.length,
      });

      return zipPath;
    } catch (err: any) {
      this.cleanupTempDir();
      this.updateStatus({
        state: 'error',
        message: `Download failed: ${err.message}`,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Step 4: Extract zip and find correct firmware binary.
   */
  async executeExtract(zipPath: string, boardName: string, version: string): Promise<string> {
    this.updateStatus({ state: 'in-progress', step: 'extract', message: 'Extracting firmware...' });

    const extractDir = path.join(path.dirname(zipPath), 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    try {
      // Use unzip command (available in Alpine)
      const result = await this.runCliCommand('unzip', ['-o', zipPath, '-d', extractDir]);
      if (result.exitCode !== 0) {
        throw new Error(`Extraction failed (exit code ${result.exitCode})`);
      }

      const { matched, rejected } = this.findFirmwareBinary(extractDir, boardName, version);
      if (!matched) {
        throw new Error(`No matching firmware binary found for board ${boardName} in release ${version}`);
      }

      const firmwarePath = path.join(extractDir, matched);
      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'extract',
        message: `Found firmware: ${matched}`,
        matchedFile: matched,
        rejectedFiles: rejected,
      });

      return firmwarePath;
    } catch (err: any) {
      this.cleanupTempDir();
      this.updateStatus({
        state: 'error',
        message: `Extraction failed: ${err.message}`,
        error: err.message,
      });
      throw err;
    }
  }

  /**
   * Step 5: Flash firmware via meshtastic --ota-update.
   */
  async executeFlash(gatewayIp: string, firmwarePath: string): Promise<void> {
    this.updateStatus({ state: 'in-progress', step: 'flash', message: 'Flashing firmware...' });

    try {
      const result = await this.runCliCommand('meshtastic', [
        '--host', gatewayIp,
        '--ota-update', firmwarePath,
      ]);

      if (result.exitCode !== 0) {
        throw new Error(`Flash failed (exit code ${result.exitCode}): ${result.stderr}`);
      }

      this.updateStatus({
        state: 'awaiting-confirm',
        step: 'flash',
        message: 'Flash complete. Node is rebooting...',
      });
    } catch (err: any) {
      this.updateStatus({
        state: 'error',
        message: `Flash failed: ${err.message}`,
        error: err.message,
      });
      throw err;
    } finally {
      this.cleanupTempDir();
    }
  }

  /**
   * Step 6: Verify firmware version after reconnect.
   */
  verifyUpdate(newFirmwareVersion: string, targetVersion: string): void {
    const matches = newFirmwareVersion.includes(targetVersion) ||
                    targetVersion.includes(newFirmwareVersion);
    if (matches) {
      this.updateStatus({
        state: 'success',
        step: 'verify',
        message: `Update verified! Firmware: ${newFirmwareVersion}`,
      });
    } else {
      this.updateStatus({
        state: 'error',
        step: 'verify',
        message: `Version mismatch: expected ${targetVersion}, got ${newFirmwareVersion}`,
        error: 'Version mismatch after flash',
      });
    }
  }

  /**
   * Restore a config backup to the node.
   */
  async restoreBackup(gatewayIp: string, backupPath: string): Promise<void> {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup file not found: ${backupPath}`);
    }

    const result = await this.runCliCommand('meshtastic', ['--host', gatewayIp, '--configure', backupPath]);
    if (result.exitCode !== 0) {
      throw new Error(`Config restore failed (exit code ${result.exitCode}): ${result.stderr}`);
    }
  }
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/services/firmwareUpdateService.ts src/server/services/firmwareUpdateService.test.ts
git commit -m "feat(firmware-ota): add OTA execution pipeline (backup, download, extract, flash, verify) (#2108)"
```

---

## Task 4: Firmware Update REST Routes

**Files:**
- Create: `src/server/routes/firmwareUpdateRoutes.ts`
- Create: `src/server/routes/firmwareUpdateRoutes.test.ts`
- Modify: `src/server/server.ts` (import + mount)

**Step 1: Write the failing test**

Create `src/server/routes/firmwareUpdateRoutes.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock dependencies
vi.mock('../services/firmwareUpdateService.js', () => ({
  firmwareUpdateService: {
    fetchReleases: vi.fn().mockResolvedValue([]),
    filterByChannel: vi.fn().mockReturnValue([]),
    getCachedReleases: vi.fn().mockReturnValue([]),
    getLastFetchTime: vi.fn().mockReturnValue(0),
    getStatus: vi.fn().mockReturnValue({ state: 'idle', step: null, message: '', logs: [] }),
    getChannel: vi.fn().mockResolvedValue('stable'),
    setChannel: vi.fn().mockResolvedValue(undefined),
    getCustomUrl: vi.fn().mockResolvedValue(null),
    setCustomUrl: vi.fn().mockResolvedValue(undefined),
    startPreflight: vi.fn(),
    cancelUpdate: vi.fn(),
    listBackups: vi.fn().mockReturnValue([]),
    resetStatus: vi.fn(),
  },
}));

vi.mock('../services/firmwareHardwareMap.js', () => ({
  getBoardName: vi.fn().mockReturnValue('heltec-v3'),
  getPlatformForBoard: vi.fn().mockReturnValue('esp32s3'),
  isOtaCapable: vi.fn().mockReturnValue(true),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    findUserByIdAsync: vi.fn().mockResolvedValue({ id: 1, username: 'admin', isAdmin: true }),
    findUserByUsernameAsync: vi.fn().mockResolvedValue(null),
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    getUserPermissionSetAsync: vi.fn().mockResolvedValue({ resources: {}, isAdmin: true }),
    auditLog: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock auth middleware to inject test user
vi.mock('../auth/authMiddleware.js', () => ({
  requireAuth: () => (_req: any, _res: any, next: any) => {
    _req.user = { id: 1, username: 'admin', isAdmin: true };
    next();
  },
  requireAdmin: () => (_req: any, _res: any, next: any) => {
    _req.user = { id: 1, username: 'admin', isAdmin: true };
    next();
  },
}));

import firmwareUpdateRoutes from './firmwareUpdateRoutes.js';
import { firmwareUpdateService } from '../services/firmwareUpdateService.js';

const app = express();
app.use(express.json());
app.use('/api/firmware', firmwareUpdateRoutes);

describe('firmwareUpdateRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/firmware/status', () => {
    it('returns current status and channel', async () => {
      const res = await request(app).get('/api/firmware/status');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status.state).toBe('idle');
      expect(res.body.channel).toBe('stable');
    });
  });

  describe('GET /api/firmware/releases', () => {
    it('returns filtered releases', async () => {
      (firmwareUpdateService.getCachedReleases as any).mockReturnValue([
        { tagName: 'v2.6.1', prerelease: false },
      ]);
      (firmwareUpdateService.filterByChannel as any).mockReturnValue([
        { tagName: 'v2.6.1', prerelease: false },
      ]);

      const res = await request(app).get('/api/firmware/releases');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.releases).toHaveLength(1);
    });
  });

  describe('POST /api/firmware/check', () => {
    it('triggers a release check', async () => {
      (firmwareUpdateService.fetchReleases as any).mockResolvedValue([]);
      const res = await request(app).post('/api/firmware/check');
      expect(res.status).toBe(200);
      expect(firmwareUpdateService.fetchReleases).toHaveBeenCalled();
    });
  });

  describe('POST /api/firmware/update/cancel', () => {
    it('cancels an in-progress update', async () => {
      const res = await request(app).post('/api/firmware/update/cancel');
      expect(res.status).toBe(200);
      expect(firmwareUpdateService.cancelUpdate).toHaveBeenCalled();
    });
  });

  describe('GET /api/firmware/backups', () => {
    it('returns list of backups', async () => {
      (firmwareUpdateService.listBackups as any).mockReturnValue([
        { filename: 'config-abc-2026.yaml', timestamp: 1000, size: 500 },
      ]);

      const res = await request(app).get('/api/firmware/backups');
      expect(res.status).toBe(200);
      expect(res.body.backups).toHaveLength(1);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/routes/firmwareUpdateRoutes.test.ts`
Expected: FAIL — module not found

**Step 3: Write the routes**

Create `src/server/routes/firmwareUpdateRoutes.ts`:
```typescript
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import { firmwareUpdateService, FirmwareChannel } from '../services/firmwareUpdateService.js';
import { logger } from '../../utils/logger.js';

const router = Router();
router.use(requireAdmin());

// GET /api/firmware/status
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const [status, channel, customUrl] = await Promise.all([
      firmwareUpdateService.getStatus(),
      firmwareUpdateService.getChannel(),
      firmwareUpdateService.getCustomUrl(),
    ]);
    res.json({
      success: true,
      status,
      channel,
      customUrl,
      lastChecked: firmwareUpdateService.getLastFetchTime(),
    });
  } catch (err: any) {
    logger.error('[FirmwareRoutes] Error getting status:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/firmware/releases
router.get('/releases', async (_req: Request, res: Response) => {
  try {
    const channel = await firmwareUpdateService.getChannel();
    const releases = firmwareUpdateService.getCachedReleases();
    const filtered = firmwareUpdateService.filterByChannel(releases, channel);
    res.json({ success: true, releases: filtered, channel });
  } catch (err: any) {
    logger.error('[FirmwareRoutes] Error getting releases:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/firmware/check — force a release check
router.post('/check', async (_req: Request, res: Response) => {
  try {
    const releases = await firmwareUpdateService.fetchReleases();
    const channel = await firmwareUpdateService.getChannel();
    const filtered = firmwareUpdateService.filterByChannel(releases, channel);
    res.json({ success: true, releases: filtered, channel });
  } catch (err: any) {
    logger.error('[FirmwareRoutes] Error checking releases:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/firmware/channel — set release channel
router.post('/channel', async (req: Request, res: Response) => {
  try {
    const { channel, customUrl } = req.body;
    if (!['stable', 'alpha', 'custom'].includes(channel)) {
      return res.status(400).json({ success: false, error: 'Invalid channel. Must be stable, alpha, or custom.' });
    }

    await firmwareUpdateService.setChannel(channel as FirmwareChannel);
    if (channel === 'custom' && customUrl) {
      await firmwareUpdateService.setCustomUrl(customUrl);
    }

    res.json({ success: true, channel });
  } catch (err: any) {
    logger.error('[FirmwareRoutes] Error setting channel:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/firmware/update — start preflight for a specific version
router.post('/update', async (req: Request, res: Response) => {
  try {
    const { targetVersion, gatewayIp, hwModel, currentVersion } = req.body;
    if (!targetVersion || !gatewayIp || hwModel === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields: targetVersion, gatewayIp, hwModel' });
    }

    // Find the release
    const releases = firmwareUpdateService.getCachedReleases();
    const targetRelease = releases.find(r => r.version === targetVersion || r.tagName === targetVersion);
    if (!targetRelease) {
      return res.status(404).json({ success: false, error: `Release ${targetVersion} not found. Try checking for updates first.` });
    }

    firmwareUpdateService.startPreflight({
      currentVersion: currentVersion || 'unknown',
      targetVersion: targetRelease.version,
      targetRelease,
      gatewayIp,
      hwModel: Number(hwModel),
    });

    res.json({ success: true, status: firmwareUpdateService.getStatus() });
  } catch (err: any) {
    logger.error('[FirmwareRoutes] Error starting update:', err);
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/firmware/update/confirm — confirm current wizard step
router.post('/update/confirm', async (req: Request, res: Response) => {
  try {
    const status = firmwareUpdateService.getStatus();
    if (status.state !== 'awaiting-confirm') {
      return res.status(400).json({ success: false, error: 'No step awaiting confirmation' });
    }

    const { gatewayIp, nodeId } = req.body;

    switch (status.step) {
      case 'preflight':
        // Move to backup step
        await firmwareUpdateService.executeBackup(gatewayIp, nodeId || 'unknown');
        break;
      case 'backup': {
        // Move to download step
        const preflightInfo = status.preflightInfo!;
        const releases = firmwareUpdateService.getCachedReleases();
        const release = releases.find(r => r.version === status.targetVersion);
        if (!release) throw new Error('Release not found');
        const zipAsset = firmwareUpdateService.findFirmwareZipAsset(release, preflightInfo.platform);
        if (!zipAsset) throw new Error('Firmware zip not found');
        await firmwareUpdateService.executeDownload(zipAsset.downloadUrl);
        break;
      }
      case 'download': {
        // Move to extract step — need to know temp dir path from service internals
        // The service tracks tempDir internally, construct expected path
        const preflightInfo = status.preflightInfo!;
        // Re-trigger extract; service knows the temp dir
        await firmwareUpdateService.executeExtract(
          // The download step saved to tempDir/firmware.zip
          // We pass it through req.body or derive from service state
          req.body.zipPath || '',
          preflightInfo.boardName,
          status.targetVersion || ''
        );
        break;
      }
      case 'extract':
        // Move to flash step
        await firmwareUpdateService.executeFlash(gatewayIp, req.body.firmwarePath || '');
        break;
      case 'flash':
        // Move to verify step — this happens automatically on reconnect
        firmwareUpdateService.updateStatus({
          state: 'in-progress',
          step: 'verify',
          message: 'Waiting for node to reconnect...',
        });
        break;
      default:
        return res.status(400).json({ success: false, error: `Unknown step: ${status.step}` });
    }

    res.json({ success: true, status: firmwareUpdateService.getStatus() });
  } catch (err: any) {
    logger.error('[FirmwareRoutes] Error confirming step:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/firmware/update/cancel
router.post('/update/cancel', async (_req: Request, res: Response) => {
  firmwareUpdateService.cancelUpdate();
  res.json({ success: true, message: 'Update cancelled' });
});

// GET /api/firmware/backups
router.get('/backups', async (_req: Request, res: Response) => {
  try {
    const backups = firmwareUpdateService.listBackups();
    res.json({ success: true, backups });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/firmware/restore
router.post('/restore', async (req: Request, res: Response) => {
  try {
    const { gatewayIp, backupPath } = req.body;
    if (!gatewayIp || !backupPath) {
      return res.status(400).json({ success: false, error: 'Missing required fields: gatewayIp, backupPath' });
    }
    await firmwareUpdateService.restoreBackup(gatewayIp, backupPath);
    res.json({ success: true, message: 'Configuration restored successfully' });
  } catch (err: any) {
    logger.error('[FirmwareRoutes] Error restoring backup:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
```

**Step 4: Register routes in server.ts**

Add import near line 678 (alongside other route imports):
```typescript
import firmwareUpdateRoutes from './routes/firmwareUpdateRoutes.js';
```

Add mount near line 764 (alongside other apiRouter.use calls):
```typescript
apiRouter.use('/firmware', firmwareUpdateRoutes);
```

Also import and start the service in the server initialization (near where `upgradeService` is used):
```typescript
import { firmwareUpdateService } from './services/firmwareUpdateService.js';
// In the server startup section:
firmwareUpdateService.startPolling();
```

**Step 5: Run tests**

Run: `npx vitest run src/server/routes/firmwareUpdateRoutes.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/server/routes/firmwareUpdateRoutes.ts src/server/routes/firmwareUpdateRoutes.test.ts src/server/server.ts
git commit -m "feat(firmware-ota): add REST API routes and register in server (#2108)"
```

---

## Task 5: Socket.IO Event Wiring + useWebSocket Listener

**Files:**
- Modify: `src/hooks/useWebSocket.ts`

The backend already emits `firmware:status` events via `dataEventEmitter` (which `webSocketService` auto-forwards). We need the frontend to listen for them.

**Step 1: Add firmware:status listener to useWebSocket**

In `src/hooks/useWebSocket.ts`, inside the socket event registration block (near the other `socket.on(...)` handlers), add:

```typescript
socket.on('firmware:status', (data: any) => {
  // Store firmware status in a dedicated query key for components to consume
  queryClient.setQueryData(['firmware', 'liveStatus'], data);
});
```

**Step 2: Commit**

```bash
git add src/hooks/useWebSocket.ts
git commit -m "feat(firmware-ota): add firmware:status Socket.IO listener (#2108)"
```

---

## Task 6: Frontend — FirmwareUpdateSection Component

**Files:**
- Create: `src/components/configuration/FirmwareUpdateSection.tsx`
- Modify: `src/components/SettingsTab.tsx` (add section nav + render)
- Modify: `public/locales/en.json` (add i18n keys)

**Step 1: Add i18n keys**

Append to `public/locales/en.json`:
```json
"firmware.title": "Firmware Updates",
"firmware.description": "Manage firmware updates for your gateway node.",
"firmware.current_version": "Current Firmware",
"firmware.hardware_model": "Hardware Model",
"firmware.channel": "Release Channel",
"firmware.channel_stable": "Stable",
"firmware.channel_alpha": "Alpha (Pre-release)",
"firmware.channel_custom": "Custom URL",
"firmware.custom_url_placeholder": "https://example.com/firmware.bin",
"firmware.last_checked": "Last Checked",
"firmware.never_checked": "Never",
"firmware.check_now": "Check Now",
"firmware.checking": "Checking...",
"firmware.no_releases": "No releases found for your hardware.",
"firmware.version": "Version",
"firmware.release_date": "Release Date",
"firmware.release_notes": "Release Notes",
"firmware.install": "Install",
"firmware.current_label": "Current",
"firmware.update_available": "Update Available",
"firmware.older_version": "Older Version",
"firmware.not_ota_capable": "Your gateway hardware does not support WiFi OTA updates.",
"firmware.wizard_preflight_title": "Pre-flight Check",
"firmware.wizard_preflight_desc": "Review the update details below before proceeding.",
"firmware.wizard_backup_title": "Configuration Backup",
"firmware.wizard_backup_desc": "Backing up your node's current configuration.",
"firmware.wizard_download_title": "Download Firmware",
"firmware.wizard_download_desc": "Downloading firmware from GitHub.",
"firmware.wizard_extract_title": "Extract & Verify",
"firmware.wizard_extract_desc": "Extracting firmware and matching to your hardware.",
"firmware.wizard_flash_title": "Flash Firmware",
"firmware.wizard_flash_desc": "Flashing firmware to your gateway node.",
"firmware.wizard_verify_title": "Verify Update",
"firmware.wizard_verify_desc": "Waiting for node to reconnect and verifying firmware version.",
"firmware.wizard_confirm": "Confirm & Proceed",
"firmware.wizard_cancel": "Cancel Update",
"firmware.wizard_success": "Firmware update successful!",
"firmware.wizard_error": "Firmware update failed.",
"firmware.matched_file": "Selected Firmware",
"firmware.rejected_files": "Rejected Files",
"firmware.backup_saved": "Config backup saved",
"firmware.downgrade_warning": "Warning: Downgrading firmware may cause compatibility issues.",
"firmware.reboot_warning": "The node will reboot during the update and be briefly unavailable.",
"firmware.backups_title": "Configuration Backups",
"firmware.restore_backup": "Restore",
"firmware.no_backups": "No configuration backups found.",
"firmware.save_channel": "Save"
```

**Step 2: Create the FirmwareUpdateSection component**

Create `src/components/configuration/FirmwareUpdateSection.tsx`. This is a large component — here is the structure:

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useToast } from '../../hooks/useToast';

interface FirmwareUpdateSectionProps {
  baseUrl: string;
}

// Types matching backend
interface FirmwareRelease {
  tagName: string;
  version: string;
  prerelease: boolean;
  publishedAt: string;
  htmlUrl: string;
}

interface UpdateStatus {
  state: 'idle' | 'awaiting-confirm' | 'in-progress' | 'success' | 'error';
  step: string | null;
  message: string;
  logs: string[];
  targetVersion?: string;
  preflightInfo?: {
    currentVersion: string;
    targetVersion: string;
    gatewayIp: string;
    hwModel: string;
    boardName: string;
    platform: string;
  };
  backupPath?: string;
  downloadUrl?: string;
  downloadSize?: number;
  matchedFile?: string;
  rejectedFiles?: Array<{ name: string; reason: string }>;
  error?: string;
}

const FirmwareUpdateSection: React.FC<FirmwareUpdateSectionProps> = ({ baseUrl }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const showToast = useToast();
  const queryClient = useQueryClient();

  const [channel, setChannel] = useState<string>('stable');
  const [customUrl, setCustomUrl] = useState<string>('');
  const [checking, setChecking] = useState(false);

  // Fetch status + channel on mount
  const { data: statusData } = useQuery({
    queryKey: ['firmware', 'status'],
    queryFn: async () => {
      const res = await csrfFetch(`${baseUrl}/api/firmware/status`);
      if (!res.ok) throw new Error('Failed to fetch status');
      return res.json();
    },
    refetchInterval: 5000, // Poll every 5s when wizard is active
  });

  // Live status from Socket.IO (overrides REST polling when available)
  const liveStatus = queryClient.getQueryData<UpdateStatus>(['firmware', 'liveStatus']);
  const currentStatus: UpdateStatus = liveStatus || statusData?.status || { state: 'idle', step: null, message: '', logs: [] };

  // Fetch releases
  const { data: releasesData } = useQuery({
    queryKey: ['firmware', 'releases'],
    queryFn: async () => {
      const res = await csrfFetch(`${baseUrl}/api/firmware/releases`);
      if (!res.ok) throw new Error('Failed to fetch releases');
      return res.json();
    },
    staleTime: 60000,
  });

  // Fetch backups
  const { data: backupsData } = useQuery({
    queryKey: ['firmware', 'backups'],
    queryFn: async () => {
      const res = await csrfFetch(`${baseUrl}/api/firmware/backups`);
      if (!res.ok) throw new Error('Failed to fetch backups');
      return res.json();
    },
  });

  useEffect(() => {
    if (statusData?.channel) setChannel(statusData.channel);
    if (statusData?.customUrl) setCustomUrl(statusData.customUrl);
  }, [statusData]);

  const handleCheckNow = useCallback(async () => {
    setChecking(true);
    try {
      await csrfFetch(`${baseUrl}/api/firmware/check`, { method: 'POST' });
      queryClient.invalidateQueries({ queryKey: ['firmware', 'releases'] });
    } catch (err) {
      showToast?.('Failed to check for updates', 'error');
    } finally {
      setChecking(false);
    }
  }, [baseUrl, csrfFetch, queryClient, showToast]);

  const handleSaveChannel = useCallback(async () => {
    try {
      await csrfFetch(`${baseUrl}/api/firmware/channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, customUrl }),
      });
      queryClient.invalidateQueries({ queryKey: ['firmware'] });
      showToast?.('Channel updated', 'success');
    } catch {
      showToast?.('Failed to update channel', 'error');
    }
  }, [baseUrl, csrfFetch, channel, customUrl, queryClient, showToast]);

  const handleInstall = useCallback(async (release: FirmwareRelease) => {
    try {
      // TODO: Get gatewayIp, hwModel, currentVersion from app state
      // These will come from the SettingsTab props or a context
      await csrfFetch(`${baseUrl}/api/firmware/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetVersion: release.version,
          gatewayIp: '', // filled from props/context
          hwModel: 0,    // filled from props/context
          currentVersion: '', // filled from props/context
        }),
      });
      queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
    } catch (err: any) {
      showToast?.(err.message || 'Failed to start update', 'error');
    }
  }, [baseUrl, csrfFetch, queryClient, showToast]);

  const handleConfirm = useCallback(async () => {
    try {
      await csrfFetch(`${baseUrl}/api/firmware/update/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gatewayIp: currentStatus.preflightInfo?.gatewayIp || '',
          nodeId: '', // from context
        }),
      });
      queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
    } catch (err: any) {
      showToast?.(err.message || 'Step failed', 'error');
    }
  }, [baseUrl, csrfFetch, currentStatus, queryClient, showToast]);

  const handleCancel = useCallback(async () => {
    await csrfFetch(`${baseUrl}/api/firmware/update/cancel`, { method: 'POST' });
    queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
  }, [baseUrl, csrfFetch, queryClient]);

  const releases = releasesData?.releases || [];
  const backups = backupsData?.backups || [];

  // Render: Status Card + Channel Selector + Version List + Wizard + Backups
  return (
    <div id="settings-firmware" className="settings-section">
      <h3>{t('firmware.title', 'Firmware Updates')}</h3>
      <p className="setting-description">{t('firmware.description', 'Manage firmware updates for your gateway node.')}</p>

      {/* Channel Selector */}
      <div className="setting-item">
        <label>{t('firmware.channel', 'Release Channel')}</label>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <select className="setting-input" value={channel} onChange={e => setChannel(e.target.value)}>
            <option value="stable">{t('firmware.channel_stable', 'Stable')}</option>
            <option value="alpha">{t('firmware.channel_alpha', 'Alpha (Pre-release)')}</option>
            <option value="custom">{t('firmware.channel_custom', 'Custom URL')}</option>
          </select>
          <button className="save-button" onClick={handleSaveChannel}>{t('firmware.save_channel', 'Save')}</button>
        </div>
      </div>

      {channel === 'custom' && (
        <div className="setting-item">
          <label>{t('firmware.channel_custom', 'Custom URL')}</label>
          <input
            className="setting-input"
            type="url"
            value={customUrl}
            onChange={e => setCustomUrl(e.target.value)}
            placeholder={t('firmware.custom_url_placeholder', 'https://example.com/firmware.bin')}
          />
        </div>
      )}

      {/* Check Now */}
      <div className="setting-item">
        <button className="save-button" onClick={handleCheckNow} disabled={checking}>
          {checking ? t('firmware.checking', 'Checking...') : t('firmware.check_now', 'Check Now')}
        </button>
        {statusData?.lastChecked > 0 && (
          <span className="setting-description" style={{ marginLeft: '1rem' }}>
            {t('firmware.last_checked', 'Last Checked')}: {new Date(statusData.lastChecked).toLocaleString()}
          </span>
        )}
      </div>

      {/* Update Wizard (when active) */}
      {currentStatus.state !== 'idle' && (
        <div style={{ border: '1px solid var(--ctp-surface2)', borderRadius: '8px', padding: '1rem', margin: '1rem 0' }}>
          <h4>{currentStatus.step ? t(`firmware.wizard_${currentStatus.step}_title`, currentStatus.step) : 'Update'}</h4>
          <p>{currentStatus.message}</p>

          {/* Preflight info */}
          {currentStatus.preflightInfo && currentStatus.step === 'preflight' && (
            <div style={{ margin: '0.5rem 0', padding: '0.5rem', background: 'var(--ctp-surface0)', borderRadius: '4px' }}>
              <div><strong>Current:</strong> {currentStatus.preflightInfo.currentVersion}</div>
              <div><strong>Target:</strong> {currentStatus.preflightInfo.targetVersion}</div>
              <div><strong>Gateway IP:</strong> {currentStatus.preflightInfo.gatewayIp}</div>
              <div><strong>Hardware:</strong> {currentStatus.preflightInfo.hwModel} ({currentStatus.preflightInfo.boardName})</div>
              <div><strong>Platform:</strong> {currentStatus.preflightInfo.platform}</div>
            </div>
          )}

          {/* Extract results */}
          {currentStatus.step === 'extract' && currentStatus.matchedFile && (
            <div style={{ margin: '0.5rem 0' }}>
              <div><strong>{t('firmware.matched_file', 'Selected Firmware')}:</strong> {currentStatus.matchedFile}</div>
              {currentStatus.rejectedFiles && currentStatus.rejectedFiles.length > 0 && (
                <details>
                  <summary>{t('firmware.rejected_files', 'Rejected Files')} ({currentStatus.rejectedFiles.length})</summary>
                  <ul>
                    {currentStatus.rejectedFiles.map((f, i) => (
                      <li key={i}>{f.name} — {f.reason}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {/* Log output */}
          {currentStatus.logs.length > 0 && (
            <pre style={{
              maxHeight: '200px', overflow: 'auto', fontSize: '0.8rem',
              background: 'var(--ctp-surface0)', padding: '0.5rem', borderRadius: '4px',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {currentStatus.logs.join('\n')}
            </pre>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            {currentStatus.state === 'awaiting-confirm' && (
              <button className="save-button" onClick={handleConfirm}>
                {t('firmware.wizard_confirm', 'Confirm & Proceed')}
              </button>
            )}
            {currentStatus.state !== 'success' && (
              <button className="danger-btn" onClick={handleCancel}>
                {t('firmware.wizard_cancel', 'Cancel Update')}
              </button>
            )}
            {currentStatus.state === 'success' && (
              <button className="save-button" onClick={() => {
                csrfFetch(`${baseUrl}/api/firmware/update/cancel`, { method: 'POST' }); // resets to idle
                queryClient.invalidateQueries({ queryKey: ['firmware'] });
              }}>
                Done
              </button>
            )}
          </div>
        </div>
      )}

      {/* Version List */}
      {currentStatus.state === 'idle' && releases.length > 0 && (
        <div style={{ margin: '1rem 0' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--ctp-surface2)' }}>
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>{t('firmware.version', 'Version')}</th>
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>{t('firmware.release_date', 'Release Date')}</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}></th>
              </tr>
            </thead>
            <tbody>
              {releases.map((release: FirmwareRelease) => (
                <tr key={release.tagName} style={{ borderBottom: '1px solid var(--ctp-surface1)' }}>
                  <td style={{ padding: '0.5rem' }}>
                    {release.version}
                    {release.prerelease && <span style={{ color: 'var(--ctp-peach)', marginLeft: '0.5rem', fontSize: '0.8rem' }}>alpha</span>}
                  </td>
                  <td style={{ padding: '0.5rem' }}>{new Date(release.publishedAt).toLocaleDateString()}</td>
                  <td style={{ padding: '0.5rem', textAlign: 'right' }}>
                    <a href={release.htmlUrl} target="_blank" rel="noopener noreferrer" style={{ marginRight: '1rem', color: 'var(--accent-color)' }}>
                      {t('firmware.release_notes', 'Release Notes')}
                    </a>
                    <button className="save-button" onClick={() => handleInstall(release)}>
                      {t('firmware.install', 'Install')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {currentStatus.state === 'idle' && releases.length === 0 && (
        <p className="setting-description">{t('firmware.no_releases', 'No releases found for your hardware.')}</p>
      )}

      {/* Config Backups */}
      {backups.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <h4>{t('firmware.backups_title', 'Configuration Backups')}</h4>
          {backups.map((backup: any) => (
            <div key={backup.filename} className="setting-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{backup.filename} ({(backup.size / 1024).toFixed(1)} KB)</span>
              <button className="save-button" onClick={async () => {
                try {
                  await csrfFetch(`${baseUrl}/api/firmware/restore`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gatewayIp: '', backupPath: backup.path }),
                  });
                  showToast?.('Configuration restored', 'success');
                } catch {
                  showToast?.('Failed to restore', 'error');
                }
              }}>
                {t('firmware.restore_backup', 'Restore')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default FirmwareUpdateSection;
```

**Step 3: Add section to SettingsTab.tsx**

Add import at top of `SettingsTab.tsx`:
```typescript
import FirmwareUpdateSection from './configuration/FirmwareUpdateSection';
```

Add to `SectionNav` items array (line ~796, before the danger zone entry):
```typescript
...(isAdmin ? [{ id: 'settings-firmware', label: t('firmware.title', 'Firmware Updates') }] : []),
```

Add rendering inside `<div className="settings-content">` (before the danger zone section):
```tsx
{isAdmin && <FirmwareUpdateSection baseUrl={baseUrl} />}
```

**Step 4: Run frontend build to verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/components/configuration/FirmwareUpdateSection.tsx src/components/SettingsTab.tsx public/locales/en.json
git commit -m "feat(firmware-ota): add FirmwareUpdateSection frontend component (#2108)"
```

---

## Task 7: Wire Gateway Info into Frontend Component

**Files:**
- Modify: `src/components/configuration/FirmwareUpdateSection.tsx`
- Modify: `src/components/SettingsTab.tsx` (pass props)

The `FirmwareUpdateSection` needs access to the gateway node's `firmwareVersion`, `hwModel`, and the gateway IP. These come from different sources:

- `firmwareVersion` and `hwModel` from the connected node info (available via `usePoll` / server data)
- Gateway IP from settings (`nodeIp`)

**Step 1: Update FirmwareUpdateSection props**

Add to `FirmwareUpdateSectionProps`:
```typescript
interface FirmwareUpdateSectionProps {
  baseUrl: string;
  gatewayIp: string;
  gatewayHwModel: number;
  gatewayFirmwareVersion: string;
  gatewayNodeId: string;
}
```

Update `handleInstall` and `handleConfirm` to use these props instead of empty strings.

**Step 2: Pass props from SettingsTab**

In `SettingsTab.tsx`, get the gateway info from the existing `localNodeInfo` or settings context and pass it down:
```tsx
<FirmwareUpdateSection
  baseUrl={baseUrl}
  gatewayIp={nodeIp || ''}
  gatewayHwModel={localNodeInfo?.hwModel || 0}
  gatewayFirmwareVersion={localNodeInfo?.firmwareVersion || ''}
  gatewayNodeId={String(localNodeInfo?.num || '')}
/>
```

**Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/components/configuration/FirmwareUpdateSection.tsx src/components/SettingsTab.tsx
git commit -m "feat(firmware-ota): wire gateway node info into firmware update UI (#2108)"
```

---

## Task 8: Dockerfile — Add unzip Dependency

**Files:**
- Modify: `Dockerfile`

The `executeExtract` method uses `unzip` to extract firmware zips. Alpine may not have it by default.

**Step 1: Add unzip to Dockerfile apk install**

In the `Dockerfile` production stage (line ~48), add `unzip` to the `apk add` list:
```dockerfile
RUN apk add --no-cache \
    curl \
    unzip \
    python3 \
    ...
```

**Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat(firmware-ota): add unzip to Docker image for firmware extraction (#2108)"
```

---

## Task 9: Integration Testing

**Files:**
- No new files — manual testing via the running dev container

**Step 1: Build and start dev container**

```bash
docker compose -f docker-compose.dev.yml build && docker compose -f docker-compose.dev.yml up -d
```

**Step 2: Verify meshtastic CLI is available**

```bash
docker compose -f docker-compose.dev.yml exec meshmonitor meshtastic --version
```
Expected: Version string (>= 2.7.8)

**Step 3: Verify firmware API endpoints**

```bash
./scripts/api-test.sh login
./scripts/api-test.sh get /api/firmware/status
./scripts/api-test.sh post /api/firmware/check
./scripts/api-test.sh get /api/firmware/releases
./scripts/api-test.sh get /api/firmware/backups
```

**Step 4: Verify frontend renders**

Navigate to `http://localhost:8080/meshmonitor` → Settings → scroll to "Firmware Updates" section. Verify:
- Channel selector shows (Stable/Alpha/Custom URL)
- Check Now button works
- Version list populates after checking
- Admin-only visibility (not shown for non-admin users)

**Step 5: Run unit tests**

```bash
npx vitest run src/server/services/firmwareHardwareMap.test.ts src/server/services/firmwareUpdateService.test.ts src/server/routes/firmwareUpdateRoutes.test.ts
```
Expected: All PASS

**Step 6: Run system tests**

```bash
# Stop dev containers first
docker compose -f docker-compose.dev.yml down
tests/system-tests.sh
```

**Step 7: Commit any fixes**

```bash
git add -A && git commit -m "fix(firmware-ota): integration test fixes (#2108)"
```

---

## Task 10: Final Cleanup and PR

**Step 1: Run full test suite**

```bash
npx vitest run
```

**Step 2: Update design doc status**

In `docs/plans/2026-03-02-gateway-ota-firmware-updates-design.md`, change:
```
**Status:** Approved
```
to:
```
**Status:** Implemented
```

**Step 3: Commit**

```bash
git add docs/plans/2026-03-02-gateway-ota-firmware-updates-design.md
git commit -m "docs: mark firmware OTA design as implemented (#2108)"
```

**Step 4: Create PR**

Create a PR targeting `main` with a summary of all changes. Reference issue #2108.
