/**
 * appriseNotificationService — Apprise API URL resolver tests (#3012).
 *
 * Exercises the precedence chain in `resolveAppriseConfig`:
 *   1. Per-source `apprise_url` setting (DB)
 *   2. Global `appriseApiServerUrl` setting (DB) — added in #3012
 *   3. `APPRISE_URL` env var
 *   4. `http://localhost:8000` (bundled default)
 *
 * We hit the resolver via the public `testConnection(sourceId)` path and
 * inspect which base URL `fetch` was called with.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  getSettingMock: vi.fn(),
  getSettingForSourceMock: vi.fn(),
  waitForReadyMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    waitForReady: h.waitForReadyMock,
    settings: {
      getSetting: h.getSettingMock,
      getSettingForSource: h.getSettingForSourceMock,
    },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../meshtasticManager.js', () => ({
  default: {
    getLocalNodeInfo: vi.fn(() => ({ longName: 'TestNode' })),
  },
}));

vi.mock('../utils/notificationFiltering.js', () => ({
  getUserNotificationPreferencesAsync: vi.fn().mockResolvedValue(null),
  getUsersWithServiceEnabledAsync: vi.fn().mockResolvedValue([]),
  shouldFilterNotificationAsync: vi.fn().mockResolvedValue(false),
  applyNodeNamePrefixAsync: vi.fn(async (_uid: number, body: string) => body),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { appriseNotificationService } from './appriseNotificationService.js';

describe('appriseNotificationService — resolver precedence (#3012)', () => {
  const SOURCE = 'src-A';

  beforeEach(async () => {
    h.getSettingMock.mockReset();
    h.getSettingForSourceMock.mockReset();
    fetchMock.mockReset();
    delete process.env.APPRISE_URL;

    // Default healthy response from the Apprise API.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    // Ensure the singleton finished its async init before each case so the
    // resolver path runs with our mocks attached.
    await appriseNotificationService.waitForInit();
  });

  afterEach(() => {
    delete process.env.APPRISE_URL;
  });

  it('uses the per-source apprise_url setting when present', async () => {
    h.getSettingForSourceMock.mockImplementation(async (_src: string, key: string) => {
      if (key === 'apprise_url') return 'http://per-source.example.com:9000';
      return null;
    });
    h.getSettingMock.mockResolvedValue('http://global.example.com:8000');
    process.env.APPRISE_URL = 'http://env.example.com:8000';

    await appriseNotificationService.testConnection(SOURCE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://per-source.example.com:9000/health');
  });

  it('falls back to the global appriseApiServerUrl setting when no per-source value', async () => {
    h.getSettingForSourceMock.mockResolvedValue(null);
    h.getSettingMock.mockImplementation(async (key: string) => {
      if (key === 'appriseApiServerUrl') return 'http://global.example.com:8000';
      return null;
    });
    process.env.APPRISE_URL = 'http://env.example.com:8000';

    await appriseNotificationService.testConnection(SOURCE);

    expect(fetchMock.mock.calls[0][0]).toBe('http://global.example.com:8000/health');
  });

  it('falls back to APPRISE_URL env var when no per-source and no global setting', async () => {
    h.getSettingForSourceMock.mockResolvedValue(null);
    h.getSettingMock.mockResolvedValue(null);
    process.env.APPRISE_URL = 'http://env.example.com:8000';

    await appriseNotificationService.testConnection(SOURCE);

    expect(fetchMock.mock.calls[0][0]).toBe('http://env.example.com:8000/health');
  });

  it('falls back to http://localhost:8000 when nothing else is configured', async () => {
    h.getSettingForSourceMock.mockResolvedValue(null);
    h.getSettingMock.mockResolvedValue(null);

    await appriseNotificationService.testConnection(SOURCE);

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/health');
  });

  it('treats an empty-string global setting as "not set" and falls through to env/default', async () => {
    h.getSettingForSourceMock.mockResolvedValue(null);
    h.getSettingMock.mockImplementation(async (key: string) => {
      if (key === 'appriseApiServerUrl') return '';
      return null;
    });
    process.env.APPRISE_URL = 'http://env.example.com:8000';

    await appriseNotificationService.testConnection(SOURCE);

    expect(fetchMock.mock.calls[0][0]).toBe('http://env.example.com:8000/health');
  });
});
