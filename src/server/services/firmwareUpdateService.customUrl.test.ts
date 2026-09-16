/**
 * Custom firmware URL (#5011).
 *
 * The reported bug was "entering a URL does nothing, silently" — for blob AND
 * raw URLs alike. The cause was not URL formatting: `firmwareCustomUrl` was
 * written by setCustomUrl and read back only by /status to refill the text
 * box. Nothing in the install path ever consumed it, and `filterByChannel`
 * treated 'custom' exactly like 'alpha', so the channel listed every GitHub
 * release and installing one fetched that release's zip. The URL was never
 * requested by anything.
 *
 * These cover the wiring that makes it a real install target, plus the two
 * things the issue asked for on top: blob→raw resolution, and an error when
 * the response is a web page rather than a binary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted block runs before ESM imports are bound
  const nodeFs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const nodeOs = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mm-firmware-url-'));
  process.env.DATA_DIR = dir;
});

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./dataEventEmitter.js', () => ({ dataEventEmitter: { emit: vi.fn() } }));

vi.mock('./firmwareHardwareMap.js', () => ({
  getBoardName: vi.fn().mockReturnValue('station-g2'),
  getPlatformForBoard: vi.fn().mockReturnValue('esp32s3'),
  isOtaCapable: vi.fn().mockReturnValue(true),
  getHardwareDisplayName: vi.fn().mockReturnValue('Station G2'),
}));

const mockManager = vi.hoisted(() => ({
  userReconnect: vi.fn().mockResolvedValue(undefined),
  userDisconnect: vi.fn().mockResolvedValue(undefined),
  resetModuleConfigCache: vi.fn(),
  getLocalNodeInfo: vi.fn().mockReturnValue(null),
}));
vi.mock('../meshtasticManager.js', () => ({ fallbackManager: mockManager }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({
  getPrimaryMeshtasticManager: vi.fn(() => undefined as unknown),
}));

import { FirmwareUpdateService } from './firmwareUpdateService.js';
import { resolveFirmwareDownloadUrl } from './firmwareUrl.js';

const RAW_URL =
  'https://raw.githubusercontent.com/meshtastic/meshtastic.github.io/master/firmware-2.8.0.47db0e3/firmware-station-g2-2.8.0.47db0e3.bin';

describe('resolveFirmwareDownloadUrl (#5011)', () => {
  it('rewrites a GitHub blob page URL to raw content', () => {
    // The exact URL from the report — what the address bar shows when you look
    // at the file on GitHub, and the obvious thing to paste.
    const blob =
      'https://github.com/meshtastic/meshtastic.github.io/blob/master/firmware-2.8.0.47db0e3/firmware-station-g2-2.8.0.47db0e3.bin';
    expect(resolveFirmwareDownloadUrl(blob)).toEqual({ url: RAW_URL, rewritten: true });
  });

  it('rewrites the /raw/ variant too', () => {
    const raw =
      'https://github.com/meshtastic/meshtastic.github.io/raw/master/firmware-2.8.0.47db0e3/firmware-station-g2-2.8.0.47db0e3.bin';
    expect(resolveFirmwareDownloadUrl(raw)).toEqual({ url: RAW_URL, rewritten: true });
  });

  it('handles a www. host', () => {
    const blob = 'https://www.github.com/o/r/blob/main/fw.bin';
    expect(resolveFirmwareDownloadUrl(blob)).toEqual({
      url: 'https://raw.githubusercontent.com/o/r/main/fw.bin',
      rewritten: true,
    });
  });

  it('keeps a nested path intact', () => {
    const blob = 'https://github.com/o/r/blob/main/a/b/c/fw.bin';
    expect(resolveFirmwareDownloadUrl(blob).url).toBe(
      'https://raw.githubusercontent.com/o/r/main/a/b/c/fw.bin',
    );
  });

  it('leaves an already-raw URL alone', () => {
    expect(resolveFirmwareDownloadUrl(RAW_URL)).toEqual({ url: RAW_URL, rewritten: false });
  });

  it('leaves a non-GitHub URL alone', () => {
    const other = 'https://builds.example.com/firmware.bin';
    expect(resolveFirmwareDownloadUrl(other)).toEqual({ url: other, rewritten: false });
  });

  it('leaves a GitHub URL that is not a file view alone', () => {
    // Releases, tree views and the repo root are not blob/raw paths.
    for (const url of [
      'https://github.com/o/r',
      'https://github.com/o/r/releases/tag/v1',
      'https://github.com/o/r/tree/main/dir',
    ]) {
      expect(resolveFirmwareDownloadUrl(url)).toEqual({ url, rewritten: false });
    }
  });

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(resolveFirmwareDownloadUrl('not a url')).toEqual({ url: 'not a url', rewritten: false });
  });
});

describe('FirmwareUpdateService — custom URL channel lists nothing (#5011)', () => {
  let service: FirmwareUpdateService;

  beforeEach(() => {
    service = new FirmwareUpdateService();
  });

  const releases = [
    { version: '2.7.0', tagName: 'v2.7.0', prerelease: false, publishedAt: '', htmlUrl: '', assets: [] },
    { version: '2.8.0', tagName: 'v2.8.0', prerelease: true, publishedAt: '', htmlUrl: '', assets: [] },
  ] as never[];

  it('returns no releases for the custom channel', () => {
    // Before #5011 this fell through to `return releases` and listed every
    // GitHub release, identical to alpha — so the channel looked functional
    // while the URL was ignored.
    expect(service.filterByChannel(releases, 'custom')).toEqual([]);
  });

  it('still returns everything for alpha, and only stable for stable', () => {
    expect(service.filterByChannel(releases, 'alpha')).toHaveLength(2);
    expect(service.filterByChannel(releases, 'stable')).toHaveLength(1);
  });
});

describe('FirmwareUpdateService — installing from a custom URL (#5011)', () => {
  let service: FirmwareUpdateService;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FirmwareUpdateService();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const preflight = (url = RAW_URL) =>
    service.startPreflight({
      currentVersion: '2.7.20',
      targetVersion: url,
      targetRelease: null,
      gatewayIp: '192.168.1.50',
      hwModel: 43,
      customUrl: url,
    });

  const binaryResponse = (body: Buffer, contentType = 'application/octet-stream') => ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });

  it('reaches awaiting-confirm with the URL as the target', () => {
    preflight();
    const status = service.getStatus();
    expect(status.state).toBe('awaiting-confirm');
    expect(status.step).toBe('preflight');
    expect(status.downloadUrl).toBe(RAW_URL);
  });

  it('still enforces OTA capability', async () => {
    const hw = await import('./firmwareHardwareMap.js');
    vi.mocked(hw.isOtaCapable).mockReturnValueOnce(false);
    expect(() => preflight()).toThrow(/not OTA capable/);
  });

  it('still enforces the >= 2.7.18 running-firmware gate', () => {
    expect(() =>
      service.startPreflight({
        currentVersion: '2.6.0',
        targetVersion: RAW_URL,
        targetRelease: null,
        gatewayIp: '192.168.1.50',
        hwModel: 43,
        customUrl: RAW_URL,
      }),
    ).toThrow(/2\.7\.18/);
  });

  it('downloads the URL to a loose .bin under extracted/', async () => {
    const bin = Buffer.from('firmware bytes');
    fetchMock.mockResolvedValue(binaryResponse(bin));
    preflight();

    const writtenPath = await service.executeDownload(RAW_URL);

    expect(fetchMock).toHaveBeenCalledWith(RAW_URL);
    expect(fs.existsSync(writtenPath)).toBe(true);
    expect(fs.readFileSync(writtenPath)).toEqual(bin);
    // No zip: the extract step must have nothing to unpack.
    expect(path.basename(path.dirname(writtenPath))).toBe('extracted');
    // Fixed on-disk name — nothing derived from the URL reaches a path.
    expect(path.basename(writtenPath)).toBe('custom-firmware.bin');
  });

  it('rejects an HTML response with an actionable error', async () => {
    // The blob-URL failure mode: 200 OK, but a web page. Previously this was
    // written to disk as "firmware".
    fetchMock.mockResolvedValue(binaryResponse(Buffer.from('<!doctype html>'), 'text/html; charset=utf-8'));
    preflight();

    await expect(service.executeDownload(RAW_URL)).rejects.toThrow(/returned a web page/i);
    expect(service.getStatus().state).toBe('error');
    expect(service.getStatus().message).toMatch(/Raw/);
  });

  it('accepts a response with no content-type at all', async () => {
    // Plenty of servers send nothing; only an obvious document is rejected.
    fetchMock.mockResolvedValue(binaryResponse(Buffer.from('bytes'), ''));
    preflight();
    await expect(service.executeDownload(RAW_URL)).resolves.toContain('custom-firmware.bin');
  });

  it('refuses a body over the 32 MB custom-URL cap', async () => {
    // The cap was tightened from the 256 MB release-zip allowance in review:
    // a custom URL fetches one `.bin`, never a per-platform bundle. Pinning it
    // here so the branch is covered for this mode, not just for release zips.
    fetchMock.mockResolvedValue(binaryResponse(Buffer.alloc(33 * 1024 * 1024)));
    preflight();

    await expect(service.executeDownload(RAW_URL)).rejects.toThrow(/exceeds 33554432 byte limit/);
    expect(service.getStatus().state).toBe('error');
  });

  it('accepts a body under the cap that would be fine either way', async () => {
    fetchMock.mockResolvedValue(binaryResponse(Buffer.alloc(4 * 1024 * 1024)));
    preflight();
    await expect(service.executeDownload(RAW_URL)).resolves.toContain('custom-firmware.bin');
  });

  it('surfaces a non-200 as an error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    preflight();
    await expect(service.executeDownload(RAW_URL)).rejects.toThrow(/HTTP 404/);
    expect(service.getStatus().state).toBe('error');
  });

  it('refuses an SSRF target', async () => {
    // The only download URL a user types, so the existing guard matters most
    // here. Nothing should be fetched at all.
    preflight('http://127.0.0.1:8080/firmware.bin');
    await expect(service.executeDownload('http://127.0.0.1:8080/firmware.bin')).rejects.toThrow(
      /disallowed URL/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the downloaded file back from extract without name matching', async () => {
    fetchMock.mockResolvedValue(binaryResponse(Buffer.from('firmware bytes')));
    preflight();
    const writtenPath = await service.executeDownload(RAW_URL);

    const zipPath = path.join(path.dirname(path.dirname(writtenPath)), 'firmware.zip');
    const firmwarePath = await service.executeExtract(zipPath, 'station-g2', RAW_URL);

    expect(firmwarePath).toBe(writtenPath);
    expect(service.getStatus().message).toMatch(/not verified/i);
  });

  it('sets matchedFile to a usable path component, not the URL', async () => {
    // Regression for a bug this PR's review caught. `matchedFile` is joined
    // into the firmware path by the flash step and by retryFlash:
    //   path.join(tempDir, 'extracted', status.matchedFile)
    // Putting the display name there (a full URL for a custom install) built a
    // nonsense path and would have failed the flash.
    fetchMock.mockResolvedValue(binaryResponse(Buffer.from('firmware bytes')));
    preflight();
    const writtenPath = await service.executeDownload(RAW_URL);
    const tempDir = path.dirname(path.dirname(writtenPath));
    await service.executeExtract(path.join(tempDir, 'firmware.zip'), 'station-g2', RAW_URL);

    const { matchedFile } = service.getStatus();
    expect(matchedFile).toBe('custom-firmware.bin');
    expect(matchedFile).not.toContain('://');
    expect(matchedFile).not.toContain('/');

    // Rebuild the path exactly as the flash route does — it must exist.
    const flashPath = path.join(tempDir, 'extracted', matchedFile as string);
    expect(fs.existsSync(flashPath)).toBe(true);
    expect(flashPath).toBe(writtenPath);
  });

  it('reports success on verify instead of comparing the URL to a version', async () => {
    fetchMock.mockResolvedValue(binaryResponse(Buffer.from('firmware bytes')));
    preflight();

    service.verifyUpdate('2.8.0.47db0e3', RAW_URL);

    const status = service.getStatus();
    expect(status.state).toBe('success');
    expect(status.message).toContain('2.8.0.47db0e3');
    expect(status.message).toMatch(/not verified/i);
  });
});
