/**
 * Tests for the {LAST_HOP} relay-name resolution wiring on MeshtasticManager
 * (issue #3318). The pure resolution logic is covered by utils/lastHop.test.ts;
 * here we verify the manager helper short-circuits on no-relay and otherwise
 * resolves against recently-active nodes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn();
const mockGetActiveNodes = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    getSetting: mockGetSetting,
    setSetting: vi.fn(),
    settings: {
      getSetting: mockGetSetting,
      getSettingForSource: vi.fn((_s: string, key: string) => mockGetSetting(key)),
    },
    nodes: {
      getActiveNodes: mockGetActiveNodes,
      getNode: vi.fn().mockResolvedValue(null),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
    telemetry: { insertTelemetry: vi.fn().mockResolvedValue(undefined) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('MeshtasticManager - {LAST_HOP} resolution', () => {
  let manager: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import('./meshtasticManager.js');
    manager = module.fallbackManager;
  });

  it("returns 'unknown' without touching the DB when there is no relay info", async () => {
    expect(await manager.getLastHopName(undefined)).toBe('unknown');
    expect(await manager.getLastHopName(null)).toBe('unknown');
    expect(await manager.getLastHopName(0)).toBe('unknown');
    expect(mockGetActiveNodes).not.toHaveBeenCalled();
  });

  it('resolves the relay byte to a matching active node short name', async () => {
    mockGetActiveNodes.mockResolvedValue([
      { nodeNum: 0xaabbcc4f, shortName: 'RLY1', role: 2, hopsAway: 0, lastHeard: 123 },
    ]);
    expect(await manager.getLastHopName(0x4f)).toBe('RLY1');
    expect(mockGetActiveNodes).toHaveBeenCalled();
  });

  it('falls back to the hex byte when no active node matches the relay byte', async () => {
    mockGetActiveNodes.mockResolvedValue([
      { nodeNum: 0x11111111, shortName: 'OTHER', role: 2, hopsAway: 0, lastHeard: 123 },
    ]);
    expect(await manager.getLastHopName(0x4f)).toBe('0x4F');
  });

  it('falls back to the hex byte when the node query fails', async () => {
    mockGetActiveNodes.mockRejectedValue(new Error('db down'));
    expect(await manager.getLastHopName(0x4f)).toBe('0x4F');
  });
});
