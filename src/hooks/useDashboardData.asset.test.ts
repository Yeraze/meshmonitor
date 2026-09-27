/**
 * Asset Tracking (#5354) — the unified-view merge carries `asset` and ORs
 * `isMobile` across sources instead of taking the newest record's value.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../init', () => ({ appBasename: '/meshmonitor' }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ authStatus: { authenticated: true, user: { isAdmin: true } } }),
}));

import { mergeUnifiedSourceData } from './useDashboardData';

const NODE_NUM = 0x1234abcd;

const bundle = (sourceId: string, node: Record<string, unknown>) => ({
  sourceId,
  sourceName: sourceId,
  protocol: 'Meshtastic' as const,
  nodes: [{ nodeNum: NODE_NUM, nodeId: '!1234abcd', ...node }],
  traceroutes: [],
  neighborInfo: [],
  channels: [],
});

describe('mergeUnifiedSourceData asset overlay (#5354)', () => {
  it('ORs isMobile: an older source that saw movement wins over a newer stationary one', () => {
    const merged = mergeUnifiedSourceData([
      bundle('a', { lastHeard: 2000, mobile: 0, isMobile: false }),
      bundle('b', { lastHeard: 1000, mobile: 1, isMobile: true }),
    ]).nodes[0] as { isMobile: boolean };
    expect(merged.isMobile).toBe(true);
  });

  it('carries the asset flag and marks the node mobile', () => {
    const merged = mergeUnifiedSourceData([
      bundle('a', { lastHeard: 2000, mobile: 0, isMobile: true, asset: { retentionDays: 30 } }),
      bundle('b', { lastHeard: 1000, mobile: 0, isMobile: true, asset: { retentionDays: 30 } }),
    ]).nodes[0] as { isMobile: boolean; asset: unknown; mobile: number };
    expect(merged.asset).toEqual({ retentionDays: 30 });
    expect(merged.isMobile).toBe(true);
    expect(merged.mobile).toBe(0);
  });

  it('stays stationary when no source says otherwise', () => {
    const merged = mergeUnifiedSourceData([
      bundle('a', { lastHeard: 2000, mobile: 0, isMobile: false }),
      bundle('b', { lastHeard: 1000, mobile: 0, isMobile: false }),
    ]).nodes[0] as { isMobile: boolean };
    expect(merged.isMobile).toBe(false);
  });
});
