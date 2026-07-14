/**
 * versionCheckService unit tests (Auto-Upgrade Retirement, v4.13).
 *
 * Covers: cache behavior, on-demand refresh freshness window, the
 * versionCheckDisabled short-circuit, the headless `upgrade-available` event
 * firing once per version, and GitHub-failure tolerance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({ versionCheckDisabled: false }));
vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: vi.fn(() => mockEnv),
}));

const mockNotify = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./automation/automationEngineSingleton.js', () => ({
  notifyUpgradeAvailable: mockNotify,
}));

const mockSystemInfo = vi.hoisted(() => ({
  compareVersions: vi.fn(),
  checkDockerImageExists: vi.fn(),
}));
vi.mock('../utils/systemInfo.js', () => mockSystemInfo);

import { versionCheckService } from './versionCheckService.js';

function releaseResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: 'v9.9.9',
      html_url: 'https://example/release',
      name: 'Release 9.9.9',
      published_at: '2026-01-01T00:00:00Z',
      ...overrides,
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.versionCheckDisabled = false;
  versionCheckService.__resetForTests();
});

afterEach(() => {
  versionCheckService.__resetForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('getStatus()', () => {
  it('reports an available update and fires the automation event once per version', async () => {
    mockSystemInfo.compareVersions.mockReturnValue(1);
    mockSystemInfo.checkDockerImageExists.mockResolvedValue(true);
    const fetchMock = vi.fn().mockResolvedValue(releaseResponse());
    vi.stubGlobal('fetch', fetchMock);

    const status = await versionCheckService.getStatus();
    expect(status.updateAvailable).toBe(true);
    expect(status.latestVersion).toBe('9.9.9');
    expect(status.imageReady).toBe(true);
    expect(status.releaseUrl).toBe('https://example/release');
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: '9.9.9' }),
    );

    // A repeated refresh for the SAME version must not re-fire the event.
    await versionCheckService.refresh();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('does not fire the event when no newer version / image not ready', async () => {
    mockSystemInfo.compareVersions.mockReturnValue(-1);
    mockSystemInfo.checkDockerImageExists.mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(releaseResponse({ tag_name: 'v0.0.1' })));

    const status = await versionCheckService.getStatus();
    expect(status.updateAvailable).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('serves from cache within the freshness window (no refetch)', async () => {
    mockSystemInfo.compareVersions.mockReturnValue(1);
    mockSystemInfo.checkDockerImageExists.mockResolvedValue(true);
    const fetchMock = vi.fn().mockResolvedValue(releaseResponse());
    vi.stubGlobal('fetch', fetchMock);

    await versionCheckService.getStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await versionCheckService.getStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1); // second read served from cache
  });
});

describe('GitHub failure tolerance', () => {
  it('tolerates a non-OK GitHub response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const status = await versionCheckService.getStatus();
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toBe('Unable to check for updates');
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('tolerates a fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const status = await versionCheckService.getStatus();
    expect(status.updateAvailable).toBe(false);
    expect(status.error).toBe('Unable to check for updates');
  });

  it('does not cache failures (last-good cache is preserved)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await versionCheckService.getStatus();
    expect(versionCheckService.getCached()).toBeNull();
  });
});

describe('start() / versionCheckDisabled', () => {
  it('does not poll when version check is disabled', async () => {
    vi.useFakeTimers();
    mockEnv.versionCheckDisabled = true;
    const fetchMock = vi.fn().mockResolvedValue(releaseResponse());
    vi.stubGlobal('fetch', fetchMock);

    versionCheckService.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(versionCheckService.getCached()).toBeNull();
  });

  it('performs the first check ~60s after start when enabled', async () => {
    vi.useFakeTimers();
    mockSystemInfo.compareVersions.mockReturnValue(-1);
    mockSystemInfo.checkDockerImageExists.mockResolvedValue(false);
    const fetchMock = vi.fn().mockResolvedValue(releaseResponse({ tag_name: 'v1.0.0' }));
    vi.stubGlobal('fetch', fetchMock);

    versionCheckService.start();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    versionCheckService.stop();
  });
});
