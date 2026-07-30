/**
 * securityDigestService — externalUrl reaches the digest via the GLOBAL
 * setting, not a per-source one (#4437, WP2).
 *
 * `getSettingForSource(sourceId, key)`, when passed a truthy sourceId, reads
 * ONLY the `source:<id>:<key>` row and does NOT fall back to the global key
 * (that fallback was deliberately removed for #2839/#2840 — see
 * src/db/repositories/settings.ts's getSettingForSource docstring). Since
 * `externalUrl` has no per-source writer (#4437 gives it a GLOBAL writer
 * only, mirroring `appriseApiServerUrl`), `sendDigestForSource` must resolve
 * it via `getSetting('externalUrl')`, not `getSettingForSource`. Using the
 * latter would make a global `externalUrl` write silently invisible to every
 * digest — this file pins that.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const h = vi.hoisted(() => ({
  getAllManagersMock: vi.fn(),
}));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getAllManagers: h.getAllManagersMock },
}));

vi.mock('../utils/cronScheduler.js', () => ({
  scheduleCron: vi.fn().mockReturnValue({ stop: vi.fn() }),
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { securityDigestService } from './securityDigestService.js';

/**
 * A settings double shaped like the REAL getSettingForSource: per-source keys
 * only, no global fallback. `globalSettings` models rows with no source
 * prefix (a `POST /api/settings` write with no `?sourceId=`).
 */
function makeFakeDb(globalSettings: Record<string, string> = {}) {
  return {
    settings: {
      getSettingForSource: vi.fn(async (_sid: string, key: string) => {
        const perSourceOnly: Record<string, string> = {
          securityDigestAppriseUrl: 'discord://dest',
          securityDigestReportType: 'summary',
        };
        // Deliberately does NOT consult globalSettings — a truthy sourceId
        // must never see a global-only row, matching production.
        return perSourceOnly[key] ?? null;
      }),
      getSetting: vi.fn(async (key: string) => globalSettings[key] ?? null),
    },
    sources: {
      getSource: vi.fn(async (sid: string) => ({ id: sid, name: `Source ${sid}` })),
    },
    getNodesWithKeySecurityIssuesAsync: vi.fn().mockResolvedValue([
      { nodeNum: 1, shortName: 'N', longName: 'Node', duplicateKeyDetected: false, keyIsLowEntropy: true, publicKey: 'k' },
    ]),
    getNodesWithExcessivePacketsAsync: vi.fn().mockResolvedValue([]),
    getNodesWithTimeOffsetIssuesAsync: vi.fn().mockResolvedValue([]),
    getTopBroadcastersAsync: vi.fn().mockResolvedValue([]),
  };
}

describe('securityDigestService — externalUrl resolution (#4437)', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    (globalThis as any).fetch = fetchMock;
  });

  afterAll(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it('a global externalUrl setting reaches the digest body as an absolute link', async () => {
    const fakeDb = makeFakeDb({ externalUrl: 'https://mesh.example.com' });
    (securityDigestService as any).databaseService = fakeDb;

    const result = await securityDigestService.sendDigest('src-A');

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.body).toContain('View details: https://mesh.example.com/security');
  });

  it('an unset externalUrl keeps the digest link omitted (byte-identical to pre-#4437 behaviour)', async () => {
    const fakeDb = makeFakeDb({});
    (securityDigestService as any).databaseService = fakeDb;

    const result = await securityDigestService.sendDigest('src-A');

    expect(result.success).toBe(true);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.body).not.toContain('View details');
    expect(body.body).not.toContain('/security');
  });
});
