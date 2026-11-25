import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cellToChildren, cellToLatLng, cellToParent, latLngToCell } from 'h3-js';

const repo = {
  getSession: vi.fn(),
  listSessionsInRange: vi.fn(),
  getReceptionPoints: vi.fn(),
  getSamplePoints: vi.fn(),
};
vi.mock('../../services/database.js', () => ({ default: { coverageWalkabout: repo } }));

const HIDDEN_NUM = 0xdead0001;
const HIDDEN_KEY = 'ab'.repeat(32);
vi.mock('../utils/positionVisibility.js', () => ({
  loadNodesBySource: vi.fn(async () => new Map([['src-a', [
    { nodeNum: 0xaabbccdd, longName: 'Alpha', shortName: 'AL' },
    { nodeNum: 0xbbbbbbbb, longName: null, shortName: null },
  ]]])),
  loadMeshCoreNodesBySource: vi.fn(async () => new Map([['src-a', [{ publicKey: 'cd'.repeat(32), name: 'Repeater' }]]])),
  buildPositionFilter: vi.fn(async () => (p: { nodeNum: number }) => p.nodeNum !== HIDDEN_NUM),
  buildMeshCorePositionFilter: vi.fn(async () => (r: { publicKey: string }) => r.publicKey !== HIDDEN_KEY),
}));
vi.mock('../utils/sourcePermissions.js', () => ({ loadSourcePermissions: vi.fn(async () => ({})) }));

const {
  binWalkaboutCells, clipToSessions, groupCellNodes, getWalkaboutCells, getWalkaboutCellNodes,
  getWalkaboutTrack, resolveWalkaboutRange,
} = await import('./walkaboutCells.js');
const { WALKABOUT_MAX_CELLS, WALKABOUT_MAX_CELL_NODES, WALKABOUT_MAX_DURATION_MS, WALKABOUT_MAX_RX_ROWS } =
  await import('../../utils/walkabout.js');

const T0 = 1_760_000_000_000;
const sess = (o: Record<string, unknown> = {}) => ({
  id: 's1', sourceId: 'src-a', name: null, startedAt: T0, endedAt: T0 + 60_000, endReason: 'user',
  startedBy: 1, createdAt: T0, updatedAt: T0, ...o,
});
const rx = (o: Record<string, unknown> = {}) => ({
  sessionId: 's1', protocol: 'meshtastic' as const, creditedKey: '!aabbccdd', creditedNodeNum: 0xaabbccdd,
  snr: 1, heardAt: T0 + 1000, latitude: 40.1, longitude: -105.1, ...o,
});
const smp = (o: Record<string, unknown> = {}) => ({ sessionId: 's1', fixAt: T0 + 500, latitude: 40.1, longitude: -105.1, ...o });

beforeEach(() => {
  vi.resetAllMocks();
  repo.getSession.mockResolvedValue(sess());
  repo.listSessionsInRange.mockResolvedValue([sess()]);
  repo.getReceptionPoints.mockResolvedValue([]);
  repo.getSamplePoints.mockResolvedValue([]);
});

describe('binWalkaboutCells', () => {
  it('keeps the best non-null SNR, null when all are null', () => {
    const a = binWalkaboutCells([rx({ snr: -7 }), rx({ snr: 2 }), rx({ snr: null })] as never, [], 9);
    expect(a.cells[0]).toMatchObject({ bestSnr: 2, receptionCount: 3 });
    const b = binWalkaboutCells([rx({ snr: null })] as never, [], 9);
    expect(b.cells[0].bestSnr).toBeNull();
  });

  it('counts rows and distinct credited keys', () => {
    const { cells } = binWalkaboutCells(
      [rx(), rx(), rx({ creditedKey: '!bbbbbbbb', creditedNodeNum: 0xbbbbbbbb })] as never, [], 9);
    expect(cells[0]).toMatchObject({ receptionCount: 3, nodeCount: 2 });
  });

  it('a sample-only cell has no receptions', () => {
    const { cells } = binWalkaboutCells([], [smp(), smp()] as never, 9);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ receptionCount: 0, sampleCount: 2, bestSnr: null, nodeCount: 0 });
  });

  it('rolls res-9 cells up to the res-9 parent, merging counts, best and nodes', () => {
    const parent = cellToParent(latLngToCell(40.1, -105.1, 9), 8);
    const kids = cellToChildren(parent, 9);
    // two distinct res-9 children of one res-8 parent, via their centres
    const center = (c: string) => {
      const [lat, lng] = cellToLatLng(c);
      return { latitude: lat, longitude: lng };
    };
    const rows = [
      rx({ ...center(kids[0]), snr: -3, creditedKey: '!aabbccdd' }),
      rx({ ...center(kids[1]), snr: 4, creditedKey: '!bbbbbbbb', creditedNodeNum: 0xbbbbbbbb }),
    ];
    expect(binWalkaboutCells(rows as never, [], 9).cells).toHaveLength(2);
    const r8 = binWalkaboutCells(rows as never, [smp({ ...center(kids[2]) })] as never, 8).cells;
    expect(r8).toHaveLength(1);
    expect(r8[0]).toMatchObject({ cell: parent, receptionCount: 2, bestSnr: 4, nodeCount: 2, sampleCount: 1 });
  });

  it('cuts at the cell cap, sorted by receptions, and flags truncated', () => {
    const rows = [];
    for (let i = 0; i < WALKABOUT_MAX_CELLS + 1; i++) {
      rows.push(rx({ latitude: 10 + Math.floor(i / 100) * 0.01, longitude: 20 + (i % 100) * 0.01 }));
    }
    const heavy = rx({ latitude: 50, longitude: 50 });
    const out = binWalkaboutCells([...rows, heavy, heavy] as never, [], 9);
    expect(out.truncated).toBe(true);
    expect(out.cells).toHaveLength(WALKABOUT_MAX_CELLS);
    expect(out.cells[0].receptionCount).toBe(2);
  });
});

describe('clipToSessions', () => {
  const s = sess();
  const rows = (ts: number[]) => ts.map((t) => ({ sessionId: 's1', t }));
  const at = (r: { t: number }) => r.t;

  it('is inclusive at endedAt and startedAt, drops outside', () => {
    const out = clipToSessions(rows([T0 - 1, T0, T0 + 60_000, T0 + 60_001]), [s] as never, at, 0, Infinity);
    expect(out.map((r) => r.t)).toEqual([T0, T0 + 60_000]);
  });

  it('clips an open session at startedAt + the cap', () => {
    const open = sess({ endedAt: null });
    const out = clipToSessions(
      rows([T0 + WALKABOUT_MAX_DURATION_MS, T0 + WALKABOUT_MAX_DURATION_MS + 1]), [open] as never, at, 0, Infinity);
    expect(out).toHaveLength(1);
  });

  it('drops rows outside [since, until] and of unknown sessions', () => {
    const out = clipToSessions(rows([T0 + 10, T0 + 20, T0 + 30]), [s] as never, at, T0 + 15, T0 + 25);
    expect(out.map((r) => r.t)).toEqual([T0 + 20]);
    expect(clipToSessions([{ sessionId: 'zz', t: T0 }], [s] as never, at, 0, Infinity)).toEqual([]);
  });

  it('clips samples on fixAt, not receivedAt', () => {
    const samples = [
      { sessionId: 's1', fixAt: T0 + 61_000, receivedAt: T0 + 100 },
      { sessionId: 's1', fixAt: T0 + 100, receivedAt: T0 + 99_000 },
    ];
    const out = clipToSessions(samples, [s] as never, (r) => r.fixAt, 0, Infinity);
    expect(out).toEqual([samples[1]]);
  });
});

describe('groupCellNodes', () => {
  const cell = latLngToCell(40.1, -105.1, 9);
  const names = (r: { creditedKey: string }) => ({ longName: r.creditedKey, shortName: null });

  it('groups by key, sorts best SNR desc with nulls last then count', () => {
    const rows = [
      rx({ creditedKey: '!00000001', snr: null }),
      rx({ creditedKey: '!00000002', snr: 3 }), rx({ creditedKey: '!00000002', snr: -1, heardAt: T0 + 9 }),
      rx({ creditedKey: '!00000003', snr: 3 }),
      rx({ creditedKey: '!00000003', snr: 0 }), rx({ creditedKey: '!00000003', snr: 0 }),
    ];
    const { nodes } = groupCellNodes(rows as never, cell, 9, names as never);
    expect(nodes.map((n) => n.nodeId)).toEqual(['!00000003', '!00000002', '!00000001']);
    expect(nodes[1]).toMatchObject({ bestSnr: 3, receptionCount: 2, lastHeardAt: T0 + 1000 > T0 + 9 ? T0 + 1000 : T0 + 9 });
  });

  it('maps MeshCore rows to publicKey and a null nodeId', () => {
    const { nodes } = groupCellNodes(
      [rx({ protocol: 'meshcore', creditedKey: 'cd'.repeat(32), creditedNodeNum: null })] as never, cell, 9, names as never);
    expect(nodes[0]).toMatchObject({ protocol: 'meshcore', nodeId: null, nodeNum: null, publicKey: 'cd'.repeat(32) });
  });

  it('caps at 200 nodes and flags truncated', () => {
    const rows = Array.from({ length: WALKABOUT_MAX_CELL_NODES + 1 }, (_, i) =>
      rx({ creditedKey: `!${i.toString(16).padStart(8, '0')}`, creditedNodeNum: i }));
    const out = groupCellNodes(rows as never, cell, 9, names as never);
    expect(out.nodes).toHaveLength(WALKABOUT_MAX_CELL_NODES);
    expect(out.truncated).toBe(true);
  });

  it('excludes rows inside the bbox that bin to a neighbour cell', () => {
    const kids = cellToChildren(cellToParent(cell, 8), 9).filter((c) => c !== cell);
    const [lat, lng] = cellToLatLng(kids[0]);
    const out = groupCellNodes([rx({ latitude: lat, longitude: lng }), rx()] as never, cell, 9, names as never);
    expect(out.nodes[0].receptionCount).toBe(1);
  });
});

describe('resolveWalkaboutRange', () => {
  it('session: its own span; null when missing', async () => {
    const r = await resolveWalkaboutRange('src-a', { kind: 'session', sessionId: 's1' });
    expect(r).toMatchObject({ sinceMs: T0, untilMs: T0 + 60_000 });
    repo.getSession.mockResolvedValue(null);
    expect(await resolveWalkaboutRange('src-a', { kind: 'session', sessionId: 'x' })).toBeNull();
  });

  it('window: [now - W, now] and applies the exact overlap test', async () => {
    const now = T0 + 10 * 86_400_000;
    repo.listSessionsInRange.mockResolvedValue([sess({ id: 'in', startedAt: now - 1000, endedAt: now - 500 }), sess()]);
    const r = await resolveWalkaboutRange('src-a', { kind: 'window', window: '7d' }, now);
    expect(r!.sinceMs).toBe(now - 7 * 86_400_000);
    expect(r!.sessions.map((s) => s.id)).toEqual(['in']);
  });
});

describe('getWalkaboutCells', () => {
  const q = { kind: 'session', sessionId: 's1' } as const;

  it('drops hidden-node receptions before binning and counts them', async () => {
    repo.getReceptionPoints.mockResolvedValue([
      rx({ snr: -8 }),
      rx({ creditedKey: '!dead0001', creditedNodeNum: HIDDEN_NUM, snr: 9 }),
      rx({ protocol: 'meshcore', creditedKey: HIDDEN_KEY, creditedNodeNum: null, snr: 9 }),
    ]);
    repo.getSamplePoints.mockResolvedValue([smp()]);
    const r = (await getWalkaboutCells({ id: 1 }, 'src-a', q, 9))!;
    expect(r.hiddenReceptionCount).toBe(2);
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0]).toMatchObject({ bestSnr: -8, receptionCount: 1, nodeCount: 1, sampleCount: 1 });
  });

  it('a hidden node=X gives an empty result and a zero count, even with no rows', async () => {
    repo.getSamplePoints.mockResolvedValue([smp()]);
    repo.getReceptionPoints.mockResolvedValue([rx({ creditedKey: '!dead0001', creditedNodeNum: HIDDEN_NUM })]);
    const a = (await getWalkaboutCells({ id: 1 }, 'src-a', { ...q, node: '!dead0001' }, 9))!;
    expect(a).toMatchObject({ cells: [], hiddenReceptionCount: 0, bounds: null });
    repo.getReceptionPoints.mockResolvedValue([]);
    const b = (await getWalkaboutCells({ id: 1 }, 'src-a', { ...q, node: '!dead0001' }, 9))!;
    expect(b).toMatchObject({ cells: [], hiddenReceptionCount: 0 });
  });

  it('passes the node filter to the repo and returns null for a missing session', async () => {
    await getWalkaboutCells({ id: 1 }, 'src-a', { ...q, node: '!aabbccdd' }, 9);
    expect(repo.getReceptionPoints.mock.calls[0][1]).toMatchObject({ creditedKey: '!aabbccdd', limit: WALKABOUT_MAX_RX_ROWS + 1 });
    repo.getSession.mockResolvedValue(null);
    expect(await getWalkaboutCells({ id: 1 }, 'src-a', q, 9)).toBeNull();
  });

  it('a read of limit + 1 rows sets truncated and keeps the newest limit', async () => {
    const many = Array.from({ length: WALKABOUT_MAX_RX_ROWS + 1 }, (_, i) => rx({ heardAt: T0 + 59_000 - i % 1000 }));
    many[WALKABOUT_MAX_RX_ROWS] = rx({ snr: 20 }); // the oldest, past the cap
    repo.getReceptionPoints.mockResolvedValue(many);
    const r = (await getWalkaboutCells({ id: 1 }, 'src-a', q, 9))!;
    expect(r.truncated).toBe(true);
    expect(r.cells[0].receptionCount).toBe(WALKABOUT_MAX_RX_ROWS);
    expect(r.cells[0].bestSnr).toBe(1);
  });

  it('bounds cover raw points and do not change with res; null when empty', async () => {
    repo.getReceptionPoints.mockResolvedValue([rx({ latitude: 40.0, longitude: -105.5 }), rx({ latitude: 40.2, longitude: -105.0 })]);
    repo.getSamplePoints.mockResolvedValue([smp({ latitude: 39.9, longitude: -105.1 })]);
    const [a, b, c] = await Promise.all([7, 8, 9].map((res) => getWalkaboutCells({ id: 1 }, 'src-a', q, res as 7 | 8 | 9)));
    expect(a!.bounds).toEqual({ bboxSouth: 39.9, bboxNorth: 40.2, bboxWest: -105.5, bboxEast: -105.0 });
    expect(b!.bounds).toEqual(a!.bounds);
    expect(c!.bounds).toEqual(a!.bounds);
    repo.getReceptionPoints.mockResolvedValue([]);
    repo.getSamplePoints.mockResolvedValue([]);
    expect((await getWalkaboutCells({ id: 1 }, 'src-a', q, 9))!.bounds).toBeNull();
  });
});

describe('getWalkaboutCellNodes', () => {
  const q = { kind: 'session', sessionId: 's1' } as const;
  const cell = latLngToCell(40.1, -105.1, 9);

  it('passes the cell bbox, skips samples, names nodes, drops hidden', async () => {
    repo.getReceptionPoints.mockResolvedValue([
      rx({ snr: 2 }),
      rx({ creditedKey: '!bbbbbbbb', creditedNodeNum: 0xbbbbbbbb, snr: 1 }),
      rx({ creditedKey: '!dead0001', creditedNodeNum: HIDDEN_NUM }),
      rx({ protocol: 'meshcore', creditedKey: 'cd'.repeat(32), creditedNodeNum: null, snr: 0 }),
    ]);
    const r = (await getWalkaboutCellNodes({ id: 1 }, 'src-a', q, cell, 9))!;
    expect(repo.getSamplePoints).not.toHaveBeenCalled();
    expect(repo.getReceptionPoints.mock.calls[0][1].bbox).toBeTruthy();
    expect(r.nodes.map((n) => [n.longName, n.shortName])).toEqual([['Alpha', 'AL'], [null, null], ['Repeater', null]]);
  });

  it('a hidden node=X returns no nodes; a missing session returns null', async () => {
    const r = await getWalkaboutCellNodes({ id: 1 }, 'src-a', { ...q, node: '!dead0001' }, cell, 9);
    expect(r).toEqual({ cell, nodes: [], truncated: false });
    repo.getSession.mockResolvedValue(null);
    expect(await getWalkaboutCellNodes({ id: 1 }, 'src-a', q, cell, 9)).toBeNull();
  });
});

describe('getWalkaboutTrack', () => {
  it('clips to the session, orders by fixAt ascending, returns pairs', async () => {
    repo.getSamplePoints.mockResolvedValue([
      smp({ fixAt: T0 + 61_000, latitude: 9, longitude: 9 }),
      smp({ fixAt: T0 + 30, latitude: 2, longitude: 3 }),
      smp({ fixAt: T0 + 10, latitude: 1, longitude: 1 }),
    ]);
    const r = (await getWalkaboutTrack('src-a', 's1'))!;
    expect(r).toEqual({ sessionId: 's1', positions: [[1, 1], [2, 3]], truncated: false });
    expect(repo.getSamplePoints.mock.calls[0][1]).toMatchObject({ sinceMs: T0, untilMs: T0 + 60_000, limit: 2001 });
  });

  it('null for a missing session; truncated past 2000 points', async () => {
    repo.getSamplePoints.mockResolvedValue(Array.from({ length: 2001 }, () => smp()));
    expect((await getWalkaboutTrack('src-a', 's1'))!.truncated).toBe(true);
    repo.getSession.mockResolvedValue(null);
    expect(await getWalkaboutTrack('src-a', 'x')).toBeNull();
  });
});
