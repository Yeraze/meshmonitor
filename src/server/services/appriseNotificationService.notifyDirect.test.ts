/**
 * Tests for appriseNotificationService.notifyDirect — the automation-engine
 * (#3653 action.notify) dispatch path. Unlike the per-user broadcast paths, this
 * posts straight to the Apprise API server with no preference filtering.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../services/database.js', () => ({
  default: {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSettingForSource: vi.fn().mockResolvedValue(null),
      getSetting: vi.fn().mockResolvedValue(null),
    },
  },
}));
vi.mock('../meshtasticManager.js', () => ({ fallbackManager: { getLocalNodeInfo: vi.fn(() => null) } }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { appriseNotificationService } from './appriseNotificationService.js';
import databaseService from '../../services/database.js';

const settings = (databaseService as any).settings;

describe('appriseNotificationService.notifyDirect', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    settings.getSettingForSource.mockReset().mockResolvedValue(null);
    settings.getSetting.mockReset().mockResolvedValue(null);
  });

  it('posts title/body/type and explicit urls to /notify on the configured server', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    const r = await appriseNotificationService.notifyDirect(
      { sourceId: 'default', title: 'T', body: 'B', type: 'warning' },
      ['discord://x', 'tgram://y'],
    );
    expect(r.ok).toBe(true);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/notify'); // default bundled server
    const body = JSON.parse((init as any).body);
    expect(body).toMatchObject({ title: 'T', body: 'B', type: 'warning', urls: ['discord://x', 'tgram://y'] });
  });

  it('clamps an invalid type to info and omits urls when none are given', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    await appriseNotificationService.notifyDirect({ sourceId: null, title: 'T', body: 'B', type: 'bogus' });
    const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(body.type).toBe('info');
    expect(body.urls).toBeUndefined();
  });

  it('returns ok:false with the HTTP status on a non-2xx response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'no urls configured' });
    const r = await appriseNotificationService.notifyDirect({ sourceId: 'default', title: 'T', body: 'B' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('400');
  });

  it('does not call the API when Apprise is disabled for the source', async () => {
    settings.getSettingForSource.mockImplementation(async (_s: string, key: string) =>
      key === 'apprise_enabled' ? 'false' : null,
    );
    const r = await appriseNotificationService.notifyDirect({ sourceId: 'default', title: 'T', body: 'B' });
    expect(r.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
