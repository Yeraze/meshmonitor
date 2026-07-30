/**
 * securityDigestService — Apprise delivery endpoint resolution (#4442).
 *
 * Prior to this fix, `sendDigestForSource` POSTed to a hardcoded
 * `http://localhost:8000/notify`, ignoring the documented Apprise resolver
 * chain (`appriseApiServerUrl` setting / `APPRISE_URL` env var) that every
 * other Apprise dispatch path already honors
 * (`appriseNotificationService.ts`'s `resolveAppriseConfig`). An operator who
 * moved their Apprise API server got every other notification delivered and
 * every security digest silently dropped.
 *
 * Nothing anywhere previously asserted the digest's actual delivery
 * endpoint — `securityDigestService.perSource.test.ts` asserts per-source
 * dispatch (which source, which destination Apprise URL in the body) but
 * never inspects the fetch target itself. This file closes that gap.
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

function makeFakeDb(overrides: { appriseApiServerUrl?: string | null } = {}) {
  return {
    settings: {
      getSettingForSource: vi.fn(async (_sid: string, key: string) => {
        const values: Record<string, string> = {
          securityDigestAppriseUrl: 'discord://dest',
          securityDigestReportType: 'summary',
        };
        return values[key] ?? null;
      }),
      getSetting: vi.fn(async (key: string) =>
        key === 'appriseApiServerUrl' ? (overrides.appriseApiServerUrl ?? null) : null
      ),
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

describe('securityDigestService — Apprise delivery endpoint (#4442)', () => {
  const fetchMock = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
    (globalThis as any).fetch = fetchMock;
    delete process.env.APPRISE_URL;
  });

  afterAll(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it('POSTs to the configured appriseApiServerUrl, not the hardcoded localhost default', async () => {
    const fakeDb = makeFakeDb({ appriseApiServerUrl: 'https://apprise.example.com' });
    (securityDigestService as any).databaseService = fakeDb;

    const result = await securityDigestService.sendDigest('src-A');

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://apprise.example.com/notify');
  });

  it('strips a trailing slash from appriseApiServerUrl before appending /notify', async () => {
    const fakeDb = makeFakeDb({ appriseApiServerUrl: 'https://apprise.example.com/' });
    (securityDigestService as any).databaseService = fakeDb;

    await securityDigestService.sendDigest('src-A');

    expect(fetchMock.mock.calls[0][0]).toBe('https://apprise.example.com/notify');
    expect(fetchMock.mock.calls[0][0]).not.toContain('//notify');
  });

  it('falls back to the bundled http://localhost:8000 default when nothing is configured', async () => {
    const fakeDb = makeFakeDb();
    (securityDigestService as any).databaseService = fakeDb;

    await securityDigestService.sendDigest('src-A');

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8000/notify');
  });
});
