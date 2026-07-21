/**
 * #4240 follow-up — MeshCore favorites must survive the dashboard projection.
 *
 * `buildSourceNodes` hardcoded `isFavorite: false` for MeshCore nodes, throwing
 * away the flag `meshcoreManager.getAllNodes()` already returns from
 * `meshcore_nodes.isFavorite` (migration 094).
 *
 * That matters because every map surface gates on
 * `isFavorite || (lastHeard >= cutoff)` — favorites deliberately bypass the
 * staleness cutoff. With the flag forced false, a favorited MeshCore node fell
 * back to the age gate and disappeared from the map once it aged past the
 * window: the same "favorited node missing from map" symptom as #4240, from a
 * different cause.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAllNodes = vi.fn();
const getManager = vi.fn();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (...a: unknown[]) => getManager(...a) },
}));

vi.mock('../sourceManagerTypes.js', () => ({
  isMeshCoreManager: (m: unknown) => Boolean(m),
  isMeshtasticManager: () => false,
}));

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: { getAllNodes: vi.fn().mockResolvedValue([]) },
    getSettingAsync: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { buildSourceNodes } = await import('./sourceDashboardData.js');

const SOURCE = { id: 'mc-1', name: 'MeshCore', type: 'meshcore' } as never;
const ADMIN = { id: 1, isAdmin: true } as never;

/** A positioned MeshCore contact; `favorite` toggles the flag under test. */
function mcNode(favorite: boolean, overrides: Record<string, unknown> = {}) {
  return {
    publicKey: 'aabbccddeeff00112233',
    name: 'Repeater One',
    advType: 2,
    latitude: 30.1,
    longitude: -90.2,
    lastHeard: 1_700_000_000_000,
    isFavorite: favorite,
    ...overrides,
  };
}

beforeEach(() => {
  getAllNodes.mockReset();
  getManager.mockReset().mockReturnValue({ sourceId: 'mc-1', getAllNodes });
});

describe('buildSourceNodes — MeshCore favorites (#4240 follow-up)', () => {
  it('propagates isFavorite=true from the manager', async () => {
    getAllNodes.mockResolvedValue([mcNode(true)]);
    const nodes = await buildSourceNodes(SOURCE, ADMIN);
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as { isFavorite: boolean }).isFavorite).toBe(true);
  });

  it('propagates isFavorite=false for a non-favorited node', async () => {
    getAllNodes.mockResolvedValue([mcNode(false)]);
    const nodes = await buildSourceNodes(SOURCE, ADMIN);
    expect((nodes[0] as { isFavorite: boolean }).isFavorite).toBe(false);
  });

  it('defaults to false when the manager omits the flag entirely', async () => {
    const { isFavorite: _omitted, ...withoutFlag } = mcNode(true);
    getAllNodes.mockResolvedValue([withoutFlag]);
    const nodes = await buildSourceNodes(SOURCE, ADMIN);
    expect((nodes[0] as { isFavorite: boolean }).isFavorite).toBe(false);
  });

  it('keeps isIgnored false — MeshCore has no ignore concept', async () => {
    // Not a placeholder: meshcoreManager has no isIgnored anywhere, so false is
    // the accurate value. Pinned so it is not "fixed" into something invented.
    getAllNodes.mockResolvedValue([mcNode(true)]);
    const nodes = await buildSourceNodes(SOURCE, ADMIN);
    expect((nodes[0] as { isIgnored: boolean }).isIgnored).toBe(false);
  });

  it('preserves the favorite flag across several nodes independently', async () => {
    getAllNodes.mockResolvedValue([
      mcNode(true, { publicKey: 'aaaa1111', name: 'Fav' }),
      mcNode(false, { publicKey: 'bbbb2222', name: 'Plain' }),
    ]);
    const nodes = await buildSourceNodes(SOURCE, ADMIN) as Array<{ isFavorite: boolean; longName: string }>;
    const byName = Object.fromEntries(nodes.map((n) => [n.longName, n.isFavorite]));
    expect(byName).toEqual({ Fav: true, Plain: false });
  });
});
