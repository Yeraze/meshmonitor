/**
 * FirmwareUpdateService Tests
 *
 * Tests GitHub release fetching, channel filtering, asset matching,
 * manifest checking, status management, and settings persistence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------- mock data ----------
const MOCK_RELEASE_STABLE = {
  tag_name: 'v2.6.1.abcdef',
  prerelease: false,
  published_at: '2026-01-15T00:00:00Z',
  html_url: 'https://github.com/meshtastic/firmware/releases/tag/v2.6.1.abcdef',
  assets: [
    {
      name: 'firmware-2.6.1.abcdef.json',
      browser_download_url: 'https://github.com/meshtastic/firmware/releases/download/v2.6.1.abcdef/firmware-2.6.1.abcdef.json',
      size: 8000,
    },
    {
      name: 'firmware-esp32s3-2.6.1.abcdef.zip',
      browser_download_url: 'https://github.com/meshtastic/firmware/releases/download/v2.6.1.abcdef/firmware-esp32s3-2.6.1.abcdef.zip',
      size: 50000000,
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
      name: 'firmware-esp32s3-2.7.0.abc123.zip',
      browser_download_url: 'https://github.com/meshtastic/firmware/releases/download/v2.7.0.abc123/firmware-esp32s3-2.7.0.abc123.zip',
      size: 52000000,
    },
  ],
};

// ---------- hoisted mocks ----------
const mockGetSettingAsync = vi.fn();
const mockSetSettingAsync = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    getSettingAsync: (...args: unknown[]) => mockGetSettingAsync(...args),
    setSettingAsync: (...args: unknown[]) => mockSetSettingAsync(...args),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emit: vi.fn(),
  },
}));

vi.mock('./firmwareHardwareMap.js', () => ({
  getBoardName: vi.fn(),
  getPlatformForBoard: vi.fn(),
  isOtaCapable: vi.fn(),
  getHardwareDisplayName: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks
import {
  FirmwareUpdateService,
  firmwareUpdateService,
  getBoardName,
  getPlatformForBoard,
  isOtaCapable,
  getHardwareDisplayName,
} from './firmwareUpdateService.js';
import type {
  FirmwareRelease,
  FirmwareManifest,
  FirmwareChannel,
} from './firmwareUpdateService.js';

describe('FirmwareUpdateService', () => {
  let service: FirmwareUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FirmwareUpdateService();
  });

  afterEach(() => {
    service.stopPolling();
  });

  // ---- fetchReleases ----
  describe('fetchReleases', () => {
    it('should fetch releases from GitHub and map them correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['etag', '"abc123"']]),
        json: async () => [MOCK_RELEASE_STABLE, MOCK_RELEASE_ALPHA],
      });

      const releases = await service.fetchReleases();

      expect(releases).toHaveLength(2);

      // Verify stable release mapping
      expect(releases[0]).toEqual({
        tagName: 'v2.6.1.abcdef',
        version: '2.6.1.abcdef',
        prerelease: false,
        publishedAt: '2026-01-15T00:00:00Z',
        htmlUrl: 'https://github.com/meshtastic/firmware/releases/tag/v2.6.1.abcdef',
        assets: [
          {
            name: 'firmware-2.6.1.abcdef.json',
            downloadUrl: 'https://github.com/meshtastic/firmware/releases/download/v2.6.1.abcdef/firmware-2.6.1.abcdef.json',
            size: 8000,
          },
          {
            name: 'firmware-esp32s3-2.6.1.abcdef.zip',
            downloadUrl: 'https://github.com/meshtastic/firmware/releases/download/v2.6.1.abcdef/firmware-esp32s3-2.6.1.abcdef.zip',
            size: 50000000,
          },
        ],
      });

      // Verify alpha release mapping
      expect(releases[1]).toEqual({
        tagName: 'v2.7.0.abc123',
        version: '2.7.0.abc123',
        prerelease: true,
        publishedAt: '2026-02-01T00:00:00Z',
        htmlUrl: 'https://github.com/meshtastic/firmware/releases/tag/v2.7.0.abc123',
        assets: [
          {
            name: 'firmware-esp32s3-2.7.0.abc123.zip',
            downloadUrl: 'https://github.com/meshtastic/firmware/releases/download/v2.7.0.abc123/firmware-esp32s3-2.7.0.abc123.zip',
            size: 52000000,
          },
        ],
      });
    });

    it('should return cached releases on 304 Not Modified', async () => {
      // First fetch populates cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['etag', '"abc123"']]),
        json: async () => [MOCK_RELEASE_STABLE],
      });
      const firstResult = await service.fetchReleases();
      expect(firstResult).toHaveLength(1);

      // Second fetch returns 304
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 304,
        headers: new Map(),
      });
      const secondResult = await service.fetchReleases();
      expect(secondResult).toHaveLength(1);
      expect(secondResult).toEqual(firstResult);
    });

    it('should return cached releases on fetch error', async () => {
      // First fetch populates cache
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['etag', '"abc123"']]),
        json: async () => [MOCK_RELEASE_STABLE],
      });
      await service.fetchReleases();

      // Second fetch errors
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const result = await service.fetchReleases();
      expect(result).toHaveLength(1);
    });

    it('should return empty array on error with no cache', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const result = await service.fetchReleases();
      expect(result).toEqual([]);
    });

    it('should send ETag header on subsequent requests', async () => {
      // First fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['etag', '"etag-value-1"']]),
        json: async () => [MOCK_RELEASE_STABLE],
      });
      await service.fetchReleases();

      // Second fetch — check that ETag is sent
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['etag', '"etag-value-2"']]),
        json: async () => [MOCK_RELEASE_STABLE, MOCK_RELEASE_ALPHA],
      });
      await service.fetchReleases();

      const secondCallArgs = mockFetch.mock.calls[1];
      expect(secondCallArgs[1]).toHaveProperty('headers');
      expect(secondCallArgs[1].headers['If-None-Match']).toBe('"etag-value-1"');
    });
  });

  // ---- filterByChannel ----
  describe('filterByChannel', () => {
    const releases: FirmwareRelease[] = [
      {
        tagName: 'v2.6.1.abcdef',
        version: '2.6.1.abcdef',
        prerelease: false,
        publishedAt: '2026-01-15T00:00:00Z',
        htmlUrl: '',
        assets: [],
      },
      {
        tagName: 'v2.7.0.abc123',
        version: '2.7.0.abc123',
        prerelease: true,
        publishedAt: '2026-02-01T00:00:00Z',
        htmlUrl: '',
        assets: [],
      },
    ];

    it('should filter to stable-only for stable channel', () => {
      const filtered = service.filterByChannel(releases, 'stable');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].tagName).toBe('v2.6.1.abcdef');
    });

    it('should return all releases for alpha channel', () => {
      const filtered = service.filterByChannel(releases, 'alpha');
      expect(filtered).toHaveLength(2);
    });

    it('should return all releases for custom channel', () => {
      const filtered = service.filterByChannel(releases, 'custom');
      expect(filtered).toHaveLength(2);
    });
  });

  // ---- findFirmwareZipAsset ----
  describe('findFirmwareZipAsset', () => {
    const release: FirmwareRelease = {
      tagName: 'v2.6.1.abcdef',
      version: '2.6.1.abcdef',
      prerelease: false,
      publishedAt: '2026-01-15T00:00:00Z',
      htmlUrl: '',
      assets: [
        { name: 'firmware-2.6.1.abcdef.json', downloadUrl: 'https://example.com/json', size: 8000 },
        { name: 'firmware-esp32s3-2.6.1.abcdef.zip', downloadUrl: 'https://example.com/esp32s3.zip', size: 50000000 },
        { name: 'firmware-esp32-2.6.1.abcdef.zip', downloadUrl: 'https://example.com/esp32.zip', size: 40000000 },
        { name: 'firmware-nrf52840-2.6.1.abcdef.zip', downloadUrl: 'https://example.com/nrf.zip', size: 30000000 },
      ],
    };

    it('should find the matching zip for esp32s3', () => {
      const asset = service.findFirmwareZipAsset(release, 'esp32s3');
      expect(asset).not.toBeNull();
      expect(asset!.name).toBe('firmware-esp32s3-2.6.1.abcdef.zip');
    });

    it('should find the matching zip for esp32', () => {
      const asset = service.findFirmwareZipAsset(release, 'esp32');
      expect(asset).not.toBeNull();
      expect(asset!.name).toBe('firmware-esp32-2.6.1.abcdef.zip');
    });

    it('should return null for missing platform', () => {
      const asset = service.findFirmwareZipAsset(release, 'rp2040');
      expect(asset).toBeNull();
    });

    it('should not match non-zip files', () => {
      const jsonOnlyRelease: FirmwareRelease = {
        tagName: 'v2.6.1.abcdef',
        version: '2.6.1.abcdef',
        prerelease: false,
        publishedAt: '',
        htmlUrl: '',
        assets: [
          { name: 'firmware-esp32s3-2.6.1.abcdef.json', downloadUrl: '', size: 100 },
        ],
      };
      const asset = service.findFirmwareZipAsset(jsonOnlyRelease, 'esp32s3');
      expect(asset).toBeNull();
    });
  });

  // ---- checkBoardInManifest ----
  describe('checkBoardInManifest', () => {
    const manifest: FirmwareManifest = {
      version: '2.6.1.abcdef',
      targets: [
        { board: 'heltec-v3', platform: 'esp32s3' },
        { board: 'tbeam-s3-core', platform: 'esp32s3' },
        { board: 'rak4631', platform: 'nrf52840' },
      ],
    };

    it('should return true when board exists in manifest', () => {
      expect(service.checkBoardInManifest(manifest, 'heltec-v3')).toBe(true);
    });

    it('should return true for another existing board', () => {
      expect(service.checkBoardInManifest(manifest, 'tbeam-s3-core')).toBe(true);
    });

    it('should return false when board is not in manifest', () => {
      expect(service.checkBoardInManifest(manifest, 'nonexistent-board')).toBe(false);
    });

    it('should return false for empty targets', () => {
      const emptyManifest: FirmwareManifest = { version: '2.6.1', targets: [] };
      expect(service.checkBoardInManifest(emptyManifest, 'heltec-v3')).toBe(false);
    });
  });

  // ---- findFirmwareBinary ----
  describe('findFirmwareBinary', () => {
    it('should match correct firmware binary', () => {
      const files = [
        'firmware-heltec-v3-2.6.1.abcdef.bin',
        'firmware-heltec-v3-2.6.1.abcdef.factory.bin',
        'bleota.bin',
        'littlefs-2.6.1.abcdef.bin',
      ];
      const result = service.findFirmwareBinary(files, 'heltec-v3', '2.6.1.abcdef');
      expect(result.matched).toBe('firmware-heltec-v3-2.6.1.abcdef.bin');
      expect(result.rejected.length).toBeGreaterThan(0);
    });

    it('should reject factory binaries', () => {
      const files = [
        'firmware-heltec-v3-2.6.1.abcdef.factory.bin',
      ];
      const result = service.findFirmwareBinary(files, 'heltec-v3', '2.6.1.abcdef');
      expect(result.matched).toBeNull();
      expect(result.rejected).toContainEqual(
        expect.objectContaining({ name: 'firmware-heltec-v3-2.6.1.abcdef.factory.bin' })
      );
    });

    it('should reject non-matching board binaries', () => {
      const files = [
        'firmware-tbeam-s3-core-2.6.1.abcdef.bin',
      ];
      const result = service.findFirmwareBinary(files, 'heltec-v3', '2.6.1.abcdef');
      expect(result.matched).toBeNull();
    });

    it('should return null matched with empty file list', () => {
      const result = service.findFirmwareBinary([], 'heltec-v3', '2.6.1.abcdef');
      expect(result.matched).toBeNull();
      expect(result.rejected).toEqual([]);
    });
  });

  // ---- getStatus ----
  describe('getStatus', () => {
    it('should return idle status initially', () => {
      const status = service.getStatus();
      expect(status.state).toBe('idle');
      expect(status.step).toBeNull();
      expect(status.message).toBe('');
      expect(status.logs).toEqual([]);
    });

    it('should return a copy so external mutations do not affect internal state', () => {
      const status1 = service.getStatus();
      status1.logs.push('injected');
      const status2 = service.getStatus();
      expect(status2.logs).toEqual([]);
    });
  });

  // ---- resetStatus ----
  describe('resetStatus', () => {
    it('should reset status back to idle', () => {
      // We cannot easily set internal state, but we can confirm resetStatus doesn't throw
      // and returns idle after being called
      service.resetStatus();
      const status = service.getStatus();
      expect(status.state).toBe('idle');
    });
  });

  // ---- channel settings ----
  describe('channel settings', () => {
    it('should return stable as default channel', async () => {
      mockGetSettingAsync.mockResolvedValueOnce(null);
      const channel = await service.getChannel();
      expect(channel).toBe('stable');
      expect(mockGetSettingAsync).toHaveBeenCalledWith('firmwareChannel');
    });

    it('should return stored channel from database', async () => {
      mockGetSettingAsync.mockResolvedValueOnce('alpha');
      const channel = await service.getChannel();
      expect(channel).toBe('alpha');
    });

    it('should write channel to database', async () => {
      mockSetSettingAsync.mockResolvedValueOnce(undefined);
      await service.setChannel('alpha');
      expect(mockSetSettingAsync).toHaveBeenCalledWith('firmwareChannel', 'alpha');
    });

    it('should read custom URL from database', async () => {
      mockGetSettingAsync.mockResolvedValueOnce('https://my-firmware.example.com');
      const url = await service.getCustomUrl();
      expect(url).toBe('https://my-firmware.example.com');
      expect(mockGetSettingAsync).toHaveBeenCalledWith('firmwareCustomUrl');
    });

    it('should return null when no custom URL is set', async () => {
      mockGetSettingAsync.mockResolvedValueOnce(null);
      const url = await service.getCustomUrl();
      expect(url).toBeNull();
    });

    it('should write custom URL to database', async () => {
      mockSetSettingAsync.mockResolvedValueOnce(undefined);
      await service.setCustomUrl('https://custom.example.com/firmware');
      expect(mockSetSettingAsync).toHaveBeenCalledWith('firmwareCustomUrl', 'https://custom.example.com/firmware');
    });
  });

  // ---- getCachedReleases / getLastFetchTime ----
  describe('cache accessors', () => {
    it('should return empty array for getCachedReleases initially', () => {
      expect(service.getCachedReleases()).toEqual([]);
    });

    it('should return 0 for getLastFetchTime initially', () => {
      expect(service.getLastFetchTime()).toBe(0);
    });

    it('should return cached releases after a successful fetch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['etag', '"abc"']]),
        json: async () => [MOCK_RELEASE_STABLE],
      });
      await service.fetchReleases();

      const cached = service.getCachedReleases();
      expect(cached).toHaveLength(1);
      expect(cached[0].tagName).toBe('v2.6.1.abcdef');
    });

    it('should update lastFetchTime after a successful fetch', async () => {
      const before = Date.now();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map([['etag', '"abc"']]),
        json: async () => [MOCK_RELEASE_STABLE],
      });
      await service.fetchReleases();
      const after = Date.now();

      const fetchTime = service.getLastFetchTime();
      expect(fetchTime).toBeGreaterThanOrEqual(before);
      expect(fetchTime).toBeLessThanOrEqual(after);
    });
  });

  // ---- singleton export ----
  describe('singleton export', () => {
    it('should export a singleton instance', () => {
      expect(firmwareUpdateService).toBeInstanceOf(FirmwareUpdateService);
    });
  });

  // ---- Update Pipeline ----
  describe('Update Pipeline', () => {
    // Helper to build a release matching expected zip asset pattern
    const makeRelease = (version: string): FirmwareRelease => ({
      tagName: `v${version}`,
      version,
      prerelease: false,
      publishedAt: '2026-02-15T00:00:00Z',
      htmlUrl: `https://github.com/meshtastic/firmware/releases/tag/v${version}`,
      assets: [
        {
          name: `firmware-esp32s3-${version}.zip`,
          downloadUrl: `https://github.com/meshtastic/firmware/releases/download/v${version}/firmware-esp32s3-${version}.zip`,
          size: 50000000,
        },
      ],
    });

    describe('startPreflight', () => {
      it('should set status to awaiting-confirm with preflight info for an OTA-capable board', () => {
        // hwModel 58 = Heltec V3 (esp32s3)
        const mockGetBoardName = getBoardName as ReturnType<typeof vi.fn>;
        const mockGetPlatform = getPlatformForBoard as ReturnType<typeof vi.fn>;
        const mockIsOta = isOtaCapable as ReturnType<typeof vi.fn>;
        const mockDisplayName = getHardwareDisplayName as ReturnType<typeof vi.fn>;

        mockGetBoardName.mockReturnValue('heltec-v3');
        mockGetPlatform.mockReturnValue('esp32s3');
        mockIsOta.mockReturnValue(true);
        mockDisplayName.mockReturnValue('Heltec V3');

        const release = makeRelease('2.6.1.abcdef');

        service.startPreflight({
          currentVersion: '2.7.18.111111',
          targetVersion: '2.6.1.abcdef',
          targetRelease: release,
          gatewayIp: '192.168.1.100',
          hwModel: 58,
        });

        const status = service.getStatus();
        expect(status.state).toBe('awaiting-confirm');
        expect(status.step).toBe('preflight');
        expect(status.preflightInfo).toBeDefined();
        expect(status.preflightInfo!.currentVersion).toBe('2.7.18.111111');
        expect(status.preflightInfo!.targetVersion).toBe('2.6.1.abcdef');
        expect(status.preflightInfo!.gatewayIp).toBe('192.168.1.100');
        expect(status.preflightInfo!.boardName).toBe('heltec-v3');
        expect(status.preflightInfo!.platform).toBe('esp32s3');
        expect(status.preflightInfo!.hwModel).toBe('Heltec V3');
      });

      it('should reject if hwModel is not OTA-capable (e.g., RAK4631=9)', () => {
        const mockGetBoardName = getBoardName as ReturnType<typeof vi.fn>;
        const mockGetPlatform = getPlatformForBoard as ReturnType<typeof vi.fn>;
        const mockIsOta = isOtaCapable as ReturnType<typeof vi.fn>;

        mockGetBoardName.mockReturnValue('rak4631');
        mockGetPlatform.mockReturnValue('nrf52840');
        mockIsOta.mockReturnValue(false);

        const release = makeRelease('2.6.1.abcdef');

        expect(() =>
          service.startPreflight({
            currentVersion: '2.7.18.111111',
            targetVersion: '2.6.1.abcdef',
            targetRelease: release,
            gatewayIp: '192.168.1.100',
            hwModel: 9,
          })
        ).toThrow(/not OTA capable/i);
      });

      it('should reject if state is not idle', () => {
        // First, get into awaiting-confirm state
        const mockGetBoardName = getBoardName as ReturnType<typeof vi.fn>;
        const mockGetPlatform = getPlatformForBoard as ReturnType<typeof vi.fn>;
        const mockIsOta = isOtaCapable as ReturnType<typeof vi.fn>;
        const mockDisplayName = getHardwareDisplayName as ReturnType<typeof vi.fn>;

        mockGetBoardName.mockReturnValue('heltec-v3');
        mockGetPlatform.mockReturnValue('esp32s3');
        mockIsOta.mockReturnValue(true);
        mockDisplayName.mockReturnValue('Heltec V3');

        const release = makeRelease('2.6.1.abcdef');

        service.startPreflight({
          currentVersion: '2.7.18.111111',
          targetVersion: '2.6.1.abcdef',
          targetRelease: release,
          gatewayIp: '192.168.1.100',
          hwModel: 58,
        });

        // Now try to start preflight again — should reject
        expect(() =>
          service.startPreflight({
            currentVersion: '2.7.18.111111',
            targetVersion: '2.6.1.abcdef',
            targetRelease: release,
            gatewayIp: '192.168.1.100',
            hwModel: 58,
          })
        ).toThrow(/not idle/i);
      });

      it('should reject if hwModel has no board name', () => {
        const mockGetBoardName = getBoardName as ReturnType<typeof vi.fn>;
        mockGetBoardName.mockReturnValue(null);

        const release = makeRelease('2.6.1.abcdef');

        expect(() =>
          service.startPreflight({
            currentVersion: '2.7.18.111111',
            targetVersion: '2.6.1.abcdef',
            targetRelease: release,
            gatewayIp: '192.168.1.100',
            hwModel: 999,
          })
        ).toThrow(/unknown hardware/i);
      });

      it('should reject if no firmware zip asset found for platform', () => {
        const mockGetBoardName = getBoardName as ReturnType<typeof vi.fn>;
        const mockGetPlatform = getPlatformForBoard as ReturnType<typeof vi.fn>;
        const mockIsOta = isOtaCapable as ReturnType<typeof vi.fn>;

        mockGetBoardName.mockReturnValue('heltec-v3');
        mockGetPlatform.mockReturnValue('esp32s3');
        mockIsOta.mockReturnValue(true);

        // Release with no matching zip for esp32s3
        const release: FirmwareRelease = {
          tagName: 'v2.6.1.abcdef',
          version: '2.6.1.abcdef',
          prerelease: false,
          publishedAt: '2026-02-15T00:00:00Z',
          htmlUrl: '',
          assets: [
            { name: 'firmware-nrf52840-2.6.1.abcdef.zip', downloadUrl: 'https://example.com/nrf.zip', size: 30000000 },
          ],
        };

        expect(() =>
          service.startPreflight({
            currentVersion: '2.7.18.111111',
            targetVersion: '2.6.1.abcdef',
            targetRelease: release,
            gatewayIp: '192.168.1.100',
            hwModel: 58,
          })
        ).toThrow(/no firmware zip/i);
      });
    });

    describe('cancelUpdate', () => {
      it('should reset status to idle after preflight was started', () => {
        const mockGetBoardName = getBoardName as ReturnType<typeof vi.fn>;
        const mockGetPlatform = getPlatformForBoard as ReturnType<typeof vi.fn>;
        const mockIsOta = isOtaCapable as ReturnType<typeof vi.fn>;
        const mockDisplayName = getHardwareDisplayName as ReturnType<typeof vi.fn>;

        mockGetBoardName.mockReturnValue('heltec-v3');
        mockGetPlatform.mockReturnValue('esp32s3');
        mockIsOta.mockReturnValue(true);
        mockDisplayName.mockReturnValue('Heltec V3');

        const release = makeRelease('2.6.1.abcdef');

        service.startPreflight({
          currentVersion: '2.7.18.111111',
          targetVersion: '2.6.1.abcdef',
          targetRelease: release,
          gatewayIp: '192.168.1.100',
          hwModel: 58,
        });

        expect(service.getStatus().state).toBe('awaiting-confirm');

        service.cancelUpdate();

        const status = service.getStatus();
        expect(status.state).toBe('idle');
        expect(status.step).toBeNull();
      });
    });

    describe('firmware version check', () => {
      it('should reject if current firmware is below 2.7.18', () => {
        const mockGetBoardName = getBoardName as ReturnType<typeof vi.fn>;
        const mockGetPlatform = getPlatformForBoard as ReturnType<typeof vi.fn>;
        const mockIsOta = isOtaCapable as ReturnType<typeof vi.fn>;
        const mockDisplayName = getHardwareDisplayName as ReturnType<typeof vi.fn>;

        mockGetBoardName.mockReturnValue('heltec-v3');
        mockGetPlatform.mockReturnValue('esp32s3');
        mockIsOta.mockReturnValue(true);
        mockDisplayName.mockReturnValue('Heltec V3');

        const release = makeRelease('2.7.19.abcdef');

        expect(() => {
          service.startPreflight({
            currentVersion: '2.7.15.567b8ea',
            targetVersion: '2.7.19.abcdef',
            targetRelease: release,
            gatewayIp: '192.168.1.100',
            hwModel: 43,
          });
        }).toThrow('WiFi OTA requires firmware >= 2.7.18');
      });

      it('should allow firmware >= 2.7.18', () => {
        const mockGetBoardName = getBoardName as ReturnType<typeof vi.fn>;
        const mockGetPlatform = getPlatformForBoard as ReturnType<typeof vi.fn>;
        const mockIsOta = isOtaCapable as ReturnType<typeof vi.fn>;
        const mockDisplayName = getHardwareDisplayName as ReturnType<typeof vi.fn>;

        mockGetBoardName.mockReturnValue('heltec-v3');
        mockGetPlatform.mockReturnValue('esp32s3');
        mockIsOta.mockReturnValue(true);
        mockDisplayName.mockReturnValue('Heltec V3');

        const release = makeRelease('2.7.19.abcdef');

        service.startPreflight({
          currentVersion: '2.7.18.aaaaaa',
          targetVersion: '2.7.19.abcdef',
          targetRelease: release,
          gatewayIp: '192.168.1.100',
          hwModel: 43,
        });

        expect(service.getStatus().state).toBe('awaiting-confirm');
      });
    });

    describe('verifyUpdate', () => {
      it('should set success when versions match', () => {
        service.verifyUpdate('2.6.1.abcdef', '2.6.1.abcdef');
        const status = service.getStatus();
        expect(status.state).toBe('success');
        expect(status.step).toBe('verify');
      });

      it('should set success when new version contains the target version', () => {
        service.verifyUpdate('2.6.1.abcdef (extra info)', '2.6.1.abcdef');
        const status = service.getStatus();
        expect(status.state).toBe('success');
        expect(status.step).toBe('verify');
      });

      it('should set error when versions do not match', () => {
        service.verifyUpdate('2.7.18.111111', '2.6.1.abcdef');
        const status = service.getStatus();
        expect(status.state).toBe('error');
        expect(status.step).toBe('verify');
        expect(status.error).toBeDefined();
      });
    });
  });

  // ---- appendLog ----
  describe('appendLog', () => {
    it('should cap logs at 1000 entries and trim to 500', () => {
      const service = firmwareUpdateService as any;
      service.status.logs = Array.from({ length: 1000 }, (_, i) => `log-${i}`);
      service.appendLog('overflow-entry');
      expect(service.status.logs.length).toBe(501);
      expect(service.status.logs[0]).toBe('log-500');
      expect(service.status.logs[500]).toBe('overflow-entry');
    });

    it('should not trim when under 1000 entries', () => {
      const service = firmwareUpdateService as any;
      service.status.logs = ['a', 'b', 'c'];
      service.appendLog('d');
      expect(service.status.logs).toEqual(['a', 'b', 'c', 'd']);
    });
  });
});
