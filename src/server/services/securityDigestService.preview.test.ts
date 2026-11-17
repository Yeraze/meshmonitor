/**
 * Digest preview (#6453): previewDigest() returns exactly what "Send now"
 * posts, built by the same code from the same saved settings, and never
 * sends anything.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const h = vi.hoisted(() => ({
  getAllManagersMock: vi.fn(),
  getManagerMock: vi.fn(),
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: h.getAllManagersMock, getManager: h.getManagerMock },
}));
vi.mock('../utils/cronScheduler.js', () => ({ scheduleCron: vi.fn().mockReturnValue({ stop: vi.fn() }) }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./meshcoreOwnIdentityTracker.js', () => ({
  meshcoreOwnIdentityTracker: { getChange: vi.fn().mockResolvedValue(null), getCurrentKey: vi.fn().mockResolvedValue(null) },
}));

import { securityDigestService } from './securityDigestService.js';

const flagged = [
  { publicKey: 'ab'.repeat(32), name: 'Chatty', isExcessivePackets: true, packetRatePerHour: 44, advertRatePerHour: 40, packetRateLastChecked: 1_700_000_000_000, lastHeard: 1_700_000_000_000 },
  { publicKey: 'cd'.repeat(32), name: 'Skewed', isTimeOffsetIssue: true, timeOffsetSeconds: 800 * 86400, timeOffsetSource: 'advert', lastHeard: 1_700_000_000_000 },
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

describe('securityDigestService.previewDigest (#6453)', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    (globalThis as any).fetch = fetchMock;
    h.getAllManagersMock.mockReturnValue([{ sourceId: 'mc-1', sourceType: 'meshcore' }]);
    h.getManagerMock.mockImplementation((id: string) => ({ sourceId: id, sourceType: 'meshcore' }));
  });
  afterAll(() => { (globalThis as any).fetch = originalFetch; });

  /** Preview, then Send now, and return both: the preview and the POSTed body. */
  async function previewThenSend(sourceId: string) {
    const preview = await securityDigestService.previewDigest(sourceId);
    expect(fetchMock).not.toHaveBeenCalled();
    await securityDigestService.sendDigest(sourceId);
    const sent = fetchMock.mock.calls.length
      ? JSON.parse((fetchMock.mock.calls[0][1] as any).body)
      : null;
    return { preview, sent };
  }

  it.each(['summary', 'detailed'])('%s: title, body and length match what Send now posts', async (reportType) => {
    (securityDigestService as any).databaseService = makeDb({
      source: { 'mc-1': { securityDigestAppriseUrl: 'discord://own', securityDigestReportType: reportType, securityDigestFormat: 'markdown' } },
    });
    const { preview, sent } = await previewThenSend('mc-1');
    expect(sent).not.toBeNull();
    expect(preview.title).toBe(sent.title);
    expect(preview.body).toBe(sent.body);
    expect(preview.length).toBe(sent.title.length + sent.body.length);
    expect(preview).toMatchObject({ reportType, format: 'markdown', configured: true, combined: false });
    expect(JSON.stringify(preview)).not.toContain('discord://');
  });

  it('detailed is longer than summary for the same issues', async () => {
    const db = makeDb({ source: { 'mc-1': { securityDigestAppriseUrl: 'discord://own' } } });
    (securityDigestService as any).databaseService = db;
    const summary = await securityDigestService.previewDigest('mc-1');
    db.settings.getSettingForSource.mockImplementation(async (_sid: string, key: string) =>
      ({ securityDigestAppriseUrl: 'discord://own', securityDigestReportType: 'detailed' } as Record<string, string>)[key] ?? null);
    const detailed = await securityDigestService.previewDigest('mc-1');
    expect(detailed.body).toContain('Chatty');
    expect(summary.body).not.toContain('Chatty');
    expect(detailed.length).toBeGreaterThan(summary.length);
  });

  it('suppressed: body is null and length is 0 when there are no issues; Send now sends nothing', async () => {
    const db = makeDb({ source: { 'mc-1': { securityDigestAppriseUrl: 'discord://own' } } });
    db.meshcore.getSecurityFlaggedNodes.mockResolvedValue([]);
    (securityDigestService as any).databaseService = db;
    const { preview, sent } = await previewThenSend('mc-1');
    expect(preview.body).toBeNull();
    expect(preview.length).toBe(0);
    expect(sent).toBeNull();
  });

  it('not configured: still renders the body, configured is false, nothing is sent', async () => {
    (securityDigestService as any).databaseService = makeDb();
    const preview = await securityDigestService.previewDigest('mc-1');
    expect(preview.configured).toBe(false);
    expect(preview.body).toContain('Excessive packets');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('combined: a source on the global URL alongside others is flagged; Send now still sends it alone', async () => {
    h.getAllManagersMock.mockReturnValue([
      { sourceId: 'mc-1', sourceType: 'meshcore' },
      { sourceId: 'mc-2', sourceType: 'meshcore' },
      { sourceId: 'mc-own', sourceType: 'meshcore' },
    ]);
    (securityDigestService as any).databaseService = makeDb({
      source: { 'mc-own': { securityDigestAppriseUrl: 'discord://own' } },
      global: { securityDigestAppriseUrl: 'discord://global' },
    });
    const { preview, sent } = await previewThenSend('mc-1');
    expect(preview).toMatchObject({ combined: true, configured: true });
    expect(sent.urls).toEqual(['discord://global']);
    expect(preview.title).toBe(sent.title);
    expect(preview.body).toBe(sent.body);

    fetchMock.mockClear();
    const own = await previewThenSend('mc-own');
    expect(own.preview.combined).toBe(false);
    expect(own.sent.urls).toEqual(['discord://own']);
    expect(own.preview.body).toBe(own.sent.body);
  });

  it('a lone source on the global URL is not combined', async () => {
    (securityDigestService as any).databaseService = makeDb({ global: { securityDigestAppriseUrl: 'discord://global' } });
    const preview = await securityDigestService.previewDigest('mc-1');
    expect(preview).toMatchObject({ combined: false, configured: true });
  });

  it('counts characters, not UTF-16 units', async () => {
    const db = makeDb({ source: { 'mc-1': { securityDigestAppriseUrl: 'discord://own' } } });
    db.sources.getSource.mockResolvedValue({ id: 'mc-1', name: 'Mesh \u{1F4E1}' });
    (securityDigestService as any).databaseService = db;
    const preview = await securityDigestService.previewDigest('mc-1');
    expect(preview.title).toContain('\u{1F4E1}');
    expect(preview.length).toBe(Array.from(preview.title).length + Array.from(preview.body!).length);
    expect(preview.length).toBe(preview.title.length + preview.body!.length - 1);
  });
});
