/**
 * SSRF-03 (issue #6078): every outbound call to the operator-configured Apprise
 * API server now runs through the SSRF guard (safeFetch with
 * { strict: false, allowLoopback: true }). A stored `appriseApiServerUrl` /
 * per-source `apprise_url` pointing at cloud metadata or a link-local address
 * must never reach fetch(), while the bundled loopback default and LAN targets
 * keep working.
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';

// Literal IPs never hit DNS, but stub the resolver so nothing escapes to a real
// network if a hostname is ever used.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

const mockFetch = vi.fn() as MockInstance;
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../services/database.js', () => ({
  default: {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSettingForSource: vi.fn(),
      getSetting: vi.fn(),
    },
  },
}));
vi.mock('../meshtasticManager.js', () => ({ fallbackManager: {} }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));

import databaseService from '../../services/database.js';
import { appriseNotificationService } from './appriseNotificationService.js';

/** Configure the resolver to return `url` as the source's apprise endpoint. */
function configureAppriseUrl(url: string) {
  (databaseService as any).settings.getSettingForSource.mockImplementation(
    async (_sourceId: string, key: string) => {
      if (key === 'apprise_enabled') return 'true';
      if (key === 'apprise_url') return url;
      return null;
    },
  );
  (databaseService as any).settings.getSetting.mockResolvedValue(null);
}

describe('AppriseNotificationService — SSRF guard on outbound calls (#6078)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  it('blocks a cloud-metadata apprise URL before any fetch', async () => {
    configureAppriseUrl('http://169.254.169.254:8000');

    const res = await appriseNotificationService.notifyDirect({
      sourceId: 'src-1', title: 'hi', body: 'test',
    });

    expect(res.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('blocks the IPv4-mapped IPv6 metadata form before any fetch', async () => {
    configureAppriseUrl('http://[::ffff:a9fe:a9fe]:8000');

    const res = await appriseNotificationService.notifyDirect({
      sourceId: 'src-1', title: 'hi', body: 'test',
    });

    expect(res.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows the bundled loopback apprise server (allowLoopback)', async () => {
    configureAppriseUrl('http://127.0.0.1:8000');

    const res = await appriseNotificationService.notifyDirect({
      sourceId: 'src-1', title: 'hi', body: 'test',
    });

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('allows a LAN (RFC1918) apprise server', async () => {
    configureAppriseUrl('http://192.168.1.100:8000');

    const res = await appriseNotificationService.notifyDirect({
      sourceId: 'src-1', title: 'hi', body: 'test',
    });

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
