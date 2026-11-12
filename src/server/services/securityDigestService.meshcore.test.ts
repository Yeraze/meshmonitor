/**
 * MeshCore digest (#6281): sections, per-source dispatch, global settings
 * fallback and the "skipped" result for an unconfigured source.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const h = vi.hoisted(() => ({
  getAllManagersMock: vi.fn(),
  getManagerMock: vi.fn(),
  getChangeMock: vi.fn(),
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: h.getAllManagersMock, getManager: h.getManagerMock },
}));
vi.mock('../utils/cronScheduler.js', () => ({ scheduleCron: vi.fn().mockReturnValue({ stop: vi.fn() }) }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./meshcoreOwnIdentityTracker.js', () => ({
  meshcoreOwnIdentityTracker: { getChange: h.getChangeMock, getCurrentKey: vi.fn().mockResolvedValue(null) },
}));

import {
  securityDigestService,
  formatSummarySections,
  formatDetailedSections,
  meshcoreDigestSections,
  meshcoreDigestTotal,
} from './securityDigestService.js';
import { collectSecurityIssues } from './securityIssuesService.js';

const K1 = 'ab'.repeat(32);
const K2 = 'cd'.repeat(32);

const flagged = [
  { publicKey: K1, name: 'Chatty', isExcessivePackets: true, packetRatePerHour: 44, advertRatePerHour: 40, packetRateLastChecked: 1_700_000_000_000, lastHeard: 1_700_000_000_000 },
  { publicKey: K2, name: 'Skewed', isTimeOffsetIssue: true, timeOffsetSeconds: 800 * 86400, timeOffsetSource: 'advert', lastHeard: 1_700_000_000_000 },
];

function makeDb(settings: { source?: Record<string, Record<string, string>>; global?: Record<string, string> } = {}) {
  return {
    settings: {
      getSettingForSource: vi.fn(async (sid: string, key: string) => settings.source?.[sid]?.[key] ?? null),
      getSetting: vi.fn(async (key: string) => settings.global?.[key] ?? null),
    },
    sources: { getSource: vi.fn(async (sid: string) => ({ id: sid, name: `Source ${sid}` })) },
    getNodesWithKeySecurityIssuesAsync: vi.fn().mockResolvedValue([]),
    getNodesWithExcessivePacketsAsync: vi.fn().mockResolvedValue([]),
    getNodesWithTimeOffsetIssuesAsync: vi.fn().mockResolvedValue([]),
    getTopBroadcastersAsync: vi.fn().mockResolvedValue([]),
    meshcore: {
      getSecurityFlaggedNodes: vi.fn().mockResolvedValue(flagged),
      getNodesBySource: vi.fn().mockResolvedValue([]),
    },
  };
}

describe('MeshCore digest sections', () => {
  beforeEach(() => h.getChangeMock.mockResolvedValue(null));

  it('summary and detailed output list the MeshCore sections', async () => {
    const issues = await collectSecurityIssues(makeDb() as never, 'mc-1', { protocol: 'meshcore', topBroadcasters: 10 });
    const sections = meshcoreDigestSections(issues);
    expect(sections.map((s) => s.title)).toEqual([
      'Excessive packets',
      'Clock offset',
      'Advert signature failed',
      'Name reused under new key',
      'Own key changed (pending acknowledge)',
    ]);
    const summary = formatSummarySections(sections, meshcoreDigestTotal(issues), '', true, 'text')!;
    expect(summary).toContain('2 issue types detected across 2 nodes');
    expect(summary).toContain('Excessive packets:');
    const detailed = formatDetailedSections(sections, meshcoreDigestTotal(issues), '', true, 'markdown')!;
    expect(detailed).toContain('- **Chatty** — 44 pkt/hr');
    expect(detailed).toContain('- **Skewed** — clock not set');
    expect(detailed).toContain('## Advert signature failed\n*None*');
    // Collisions are a config matter, not a security issue: no section for them.
    expect(detailed.toLowerCase()).not.toContain('collision');
  });

  it('an unacknowledged own-key change counts and prints', async () => {
    h.getChangeMock.mockResolvedValue({ previousKey: K1, currentKey: K2, detectedAt: 1 });
    const db = makeDb();
    db.meshcore.getSecurityFlaggedNodes.mockResolvedValue([]);
    const issues = await collectSecurityIssues(db as never, 'mc-1', { protocol: 'meshcore' });
    expect(meshcoreDigestTotal(issues)).toBe(1);
    const out = formatDetailedSections(meshcoreDigestSections(issues), 1, '', true, 'text')!;
    expect(out).toContain('--- Own key changed (pending acknowledge) ---');
    expect(out).toContain('abababab -> cdcdcdcd');
  });

  it('suppresses an empty MeshCore digest', async () => {
    const db = makeDb();
    db.meshcore.getSecurityFlaggedNodes.mockResolvedValue([]);
    const issues = await collectSecurityIssues(db as never, 'mc-1', { protocol: 'meshcore' });
    expect(formatSummarySections(meshcoreDigestSections(issues), meshcoreDigestTotal(issues), '', true, 'text')).toBeNull();
  });
});

describe('securityDigestService MeshCore dispatch (#6281)', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    h.getChangeMock.mockResolvedValue(null);
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    (globalThis as any).fetch = fetchMock;
    h.getAllManagersMock.mockReturnValue([
      { sourceId: 'mc-1', sourceType: 'meshcore' },
      { sourceId: 'mt-1', sourceType: 'meshtastic_tcp' },
    ]);
    h.getManagerMock.mockImplementation((id: string) =>
      id === 'mc-1' ? { sourceId: id, sourceType: 'meshcore' } : { sourceId: id, sourceType: 'meshtastic_tcp' });
  });
  afterAll(() => { (globalThis as any).fetch = originalFetch; });

  it('sends a MeshCore digest per source, using per-source settings', async () => {
    const db = makeDb({ source: { 'mc-1': { securityDigestAppriseUrl: 'discord://mc' } } });
    (securityDigestService as any).databaseService = db;
    const r = await securityDigestService.sendDigest();
    expect(r.success).toBe(true);
    expect(r.message).toContain('mt-1:skipped');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.urls).toEqual(['discord://mc']);
    expect(body.title).toContain('Source mc-1');
    expect(body.body).toContain('Excessive packets');
    expect(db.meshcore.getSecurityFlaggedNodes).toHaveBeenCalledWith('mc-1');
  });

  it('falls back to the global row for the four per-source keys', async () => {
    const db = makeDb({
      global: { securityDigestAppriseUrl: 'discord://global', securityDigestReportType: 'detailed', securityDigestFormat: 'markdown' },
    });
    (securityDigestService as any).databaseService = db;
    const r = await securityDigestService.sendDigest('mc-1');
    expect(r.success).toBe(true);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.urls).toEqual(['discord://global']);
    expect(body.format).toBe('markdown');
    expect(body.body).toContain('## Clock offset');
  });

  it('a source without an Apprise URL is skipped, not failed', async () => {
    (securityDigestService as any).databaseService = makeDb();
    const r = await securityDigestService.sendDigest('mc-1');
    expect(r).toMatchObject({ success: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a per-source value wins over the global one', async () => {
    const db = makeDb({
      source: { 'mc-1': { securityDigestAppriseUrl: 'discord://own' } },
      global: { securityDigestAppriseUrl: 'discord://global' },
    });
    (securityDigestService as any).databaseService = db;
    await securityDigestService.sendDigest('mc-1');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body).urls).toEqual(['discord://own']);
  });

  describe('global URL fallback sends ONE combined digest (4.17.3 review L14)', () => {
    beforeEach(() => {
      h.getAllManagersMock.mockReturnValue([
        { sourceId: 'mc-1', sourceType: 'meshcore' },
        { sourceId: 'mc-2', sourceType: 'meshcore' },
        { sourceId: 'mc-own', sourceType: 'meshcore' },
      ]);
      h.getManagerMock.mockImplementation((id: string) => ({ sourceId: id, sourceType: 'meshcore' }));
    });

    it('sources on the global URL share one digest; a source with its own URL gets its own', async () => {
      const db = makeDb({
        source: { 'mc-own': { securityDigestAppriseUrl: 'discord://own' } },
        global: { securityDigestAppriseUrl: 'discord://global' },
      });
      (securityDigestService as any).databaseService = db;
      const r = await securityDigestService.sendDigest();
      expect(r.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c[1] as any).body));
      const combined = bodies.find((b) => b.urls[0] === 'discord://global')!;
      const own = bodies.find((b) => b.urls[0] === 'discord://own')!;
      expect(own.title).toContain('Source mc-own');
      expect(combined.title).toContain('(2 sources)');
      expect(combined.body).toContain('=== Source mc-1 ===');
      expect(combined.body).toContain('=== Source mc-2 ===');
      expect(combined.body).not.toContain('Source mc-own');
      // The per-source title line is not repeated inside the combined body.
      expect(combined.body).not.toContain('MeshMonitor Security Digest');
      expect(combined.type).toBe('warning');
    });

    it('suppressEmpty: an empty source is left out, and nothing is sent when every source is empty', async () => {
      const db = makeDb({ global: { securityDigestAppriseUrl: 'discord://global' } });
      db.meshcore.getSecurityFlaggedNodes.mockImplementation(async (sid: string) => (sid === 'mc-1' ? flagged : []));
      (securityDigestService as any).databaseService = db;
      await securityDigestService.sendDigest();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      expect(body.body).toContain('Source mc-1');
      expect(body.body).not.toContain('Source mc-2');

      fetchMock.mockClear();
      db.meshcore.getSecurityFlaggedNodes.mockResolvedValue([]);
      const r = await securityDigestService.sendDigest();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(r.success).toBe(true);
    });

    it('suppressEmpty off: every fallback source appears, empty ones say so', async () => {
      const db = makeDb({ global: { securityDigestAppriseUrl: 'discord://global', securityDigestSuppressEmpty: 'false' } });
      db.meshcore.getSecurityFlaggedNodes.mockResolvedValue([]);
      (securityDigestService as any).databaseService = db;
      await securityDigestService.sendDigest();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      expect(body.title).toContain('(3 sources)');
      expect(body.body.match(/No security issues detected\./g)).toHaveLength(3);
      expect(body.type).toBe('info');
    });

    it('one source failing to build does not stop the combined digest', async () => {
      const db = makeDb({ global: { securityDigestAppriseUrl: 'discord://global' } });
      db.meshcore.getSecurityFlaggedNodes.mockImplementation(async (sid: string) => {
        if (sid === 'mc-2') throw new Error('db down');
        return flagged;
      });
      (securityDigestService as any).databaseService = db;
      const r = await securityDigestService.sendDigest();
      expect(r.success).toBe(false);
      expect(r.message).toContain('mc-2:db down');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      expect(body.body).toContain('Source mc-1');
      expect(body.body).toContain('Source mc-own');
    });

    it('a manual send for one source is unchanged: its own digest to the global URL', async () => {
      const db = makeDb({ global: { securityDigestAppriseUrl: 'discord://global' } });
      (securityDigestService as any).databaseService = db;
      await securityDigestService.sendDigest('mc-2');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body).title).toContain('Source mc-2');
    });
  });
});
