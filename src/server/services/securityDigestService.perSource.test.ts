import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const h = vi.hoisted(() => ({
  getAllManagersMock: vi.fn(),
}));
const { getAllManagersMock } = h;
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: h.getAllManagersMock }
}));

vi.mock('../utils/cronScheduler.js', () => ({
  scheduleCron: vi.fn().mockReturnValue({ stop: vi.fn() })
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { securityDigestService } from './securityDigestService.js';

describe('securityDigestService — per-source dispatch', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    (globalThis as any).fetch = fetchMock;

    getAllManagersMock.mockReturnValue([
      { sourceId: 'src-A' },
      { sourceId: 'src-B' },
    ]);

    const fakeDb: any = {
      settings: {
        getSettingForSource: vi.fn(async (sid: string, key: string) => {
          // NOTE: `externalUrl` below is a mock fixture value only — there is NO
          // production write path for this key anywhere in the repo (#4437). This
          // suite's actual subject is per-source dispatch, which is fine and
          // unaffected either way; don't read this fixture as evidence a writer
          // exists.
          const overrides: Record<string, Record<string, string>> = {
            'src-A': {
              securityDigestAppriseUrl: 'discord://a',
              securityDigestReportType: 'summary',
              externalUrl: 'https://a.example',
            },
            'src-B': {
              securityDigestAppriseUrl: 'discord://b',
              securityDigestReportType: 'summary',
              externalUrl: 'https://b.example',
            },
          };
          return overrides[sid]?.[key] ?? null;
        }),
        // WP1 (#4442): sendDigestForSource now resolves the Apprise API server
        // URL via resolveAppriseServerUrl(this.databaseService.settings, sourceId),
        // which calls settings.getSetting('appriseApiServerUrl') as part of the
        // shared resolution chain. Mocked here (unset -> falls through to the
        // bundled localhost default) purely so the double satisfies the
        // AppriseSettingsReader shape; this suite's subject remains per-source
        // dispatch, not endpoint resolution — see securityDigestService.appriseEndpoint.test.ts
        // for that.
        getSetting: vi.fn().mockResolvedValue(null),
      },
      sources: {
        getSource: vi.fn(async (sid: string) => ({ id: sid, name: `Source ${sid}` }))
      },
      getNodesWithKeySecurityIssuesAsync: vi.fn().mockResolvedValue([]),
      getNodesWithExcessivePacketsAsync: vi.fn().mockResolvedValue([]),
      getNodesWithTimeOffsetIssuesAsync: vi.fn().mockResolvedValue([]),
      getTopBroadcastersAsync: vi.fn().mockResolvedValue([]),
      getSetting: vi.fn().mockReturnValue(null),
    };
    // Inject directly — service expects initialize(databaseService)
    (securityDigestService as any).databaseService = fakeDb;
  });

  afterAll(() => { (globalThis as any).fetch = originalFetch; });

  it('iterates sources and calls per-source data methods with sourceId', async () => {
    // Non-empty issues so body is not null & digest is sent
    const fakeDb = (securityDigestService as any).databaseService;
    fakeDb.getNodesWithKeySecurityIssuesAsync.mockResolvedValue([
      { nodeNum: 1, shortName: 'N', longName: 'Node', duplicateKeyDetected: false, keyIsLowEntropy: true, publicKey: 'k' }
    ]);

    const result = await securityDigestService.sendDigest();
    expect(result.success).toBe(true);

    // Per-source data calls
    expect(fakeDb.getNodesWithKeySecurityIssuesAsync).toHaveBeenCalledWith('src-A');
    expect(fakeDb.getNodesWithKeySecurityIssuesAsync).toHaveBeenCalledWith('src-B');
    expect(fakeDb.getTopBroadcastersAsync).toHaveBeenCalledWith(10, 'src-A');
    expect(fakeDb.getTopBroadcastersAsync).toHaveBeenCalledWith(10, 'src-B');

    // Per-source Apprise dispatches, body prefixed with [sourceName]
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(c => JSON.parse((c[1] as any).body));
    const titles = bodies.map(b => b.title);
    expect(titles.some((t: string) => t.includes('Source src-A'))).toBe(true);
    expect(titles.some((t: string) => t.includes('Source src-B'))).toBe(true);
    expect(bodies.every(b => b.body.startsWith('[Source src-'))).toBe(true);
    // Apprise URLs should differ per source (per-source config)
    const urls = bodies.map(b => b.urls[0]);
    expect(urls).toContain('discord://a');
    expect(urls).toContain('discord://b');
  });

  it('sendDigest(sourceId) targets a single source only', async () => {
    const fakeDb = (securityDigestService as any).databaseService;
    fakeDb.getNodesWithKeySecurityIssuesAsync.mockResolvedValue([
      { nodeNum: 1, shortName: 'N', longName: 'Node', duplicateKeyDetected: false, keyIsLowEntropy: true, publicKey: 'k' }
    ]);

    await securityDigestService.sendDigest('src-A');

    expect(fakeDb.getNodesWithKeySecurityIssuesAsync).toHaveBeenCalledWith('src-A');
    expect(fakeDb.getNodesWithKeySecurityIssuesAsync).not.toHaveBeenCalledWith('src-B');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
