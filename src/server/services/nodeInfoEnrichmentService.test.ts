import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getAllSourcesMock: vi.fn(),
  getAllNodesMock: vi.fn(),
  copyNodeInfoMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    sources: {
      getAllSources: h.getAllSourcesMock,
    },
    nodes: {
      getAllNodes: h.getAllNodesMock,
    },
  },
}));

vi.mock('./nodeInfoCopyService.js', async () => {
  const actual = await vi.importActual<any>('./nodeInfoCopyService.js');
  return {
    ...actual,
    copyNodeInfo: h.copyNodeInfoMock,
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { analyzeEnrichment, applyEnrichment } from './nodeInfoEnrichmentService.js';

const sources = [
  { id: 'src-A', name: 'Source A', type: 'meshtastic_tcp', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {}, displayOrder: 0 },
  { id: 'src-B', name: 'Source B', type: 'mqtt_bridge', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {}, displayOrder: 1 },
  { id: 'src-C', name: 'Source C', type: 'meshcore', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {}, displayOrder: 2 },
];

const makeRow = (nodeNum: number, sourceId: string, overrides: Record<string, unknown> = {}) => ({
  nodeNum,
  nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
  sourceId,
  longName: null,
  shortName: null,
  hwModel: null,
  role: null,
  macaddr: null,
  publicKey: null,
  hasPKC: null,
  firmwareVersion: null,
  updatedAt: 1000,
  lastHeard: 900,
  createdAt: 500,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.getAllSourcesMock.mockResolvedValue(sources);
});

describe('analyzeEnrichment', () => {
  it('lists fillable fields on a target from a fully-populated donor', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow(100, 'src-A', { longName: 'Full Node', shortName: 'FN', hwModel: 42, role: 1, updatedAt: 2000 }),
      makeRow(100, 'src-B', { longName: null, hwModel: null, shortName: 'SB', role: 1, updatedAt: 1000 }),
    ]);

    const result = await analyzeEnrichment();

    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0];
    expect(node.nodeNum).toBe(100);
    expect(node.targets).toHaveLength(1);
    const target = node.targets[0];
    expect(target.targetSourceId).toBe('src-B');
    expect(target.donorSourceId).toBe('src-A');
    expect(target.fillableFields.sort()).toEqual(['hwModel', 'longName'].sort());
    expect(result.summary).toEqual({ nodeCount: 1, targetCount: 1, fieldCount: 2 });
  });

  it('best donor ranking: more filled fields wins', async () => {
    h.getAllNodesMock.mockResolvedValue([
      // Weaker donor: only longName, but newer updatedAt
      makeRow(100, 'src-A', { longName: 'Weak Donor', updatedAt: 5000 }),
      // Stronger donor: longName + hwModel + role, older updatedAt
      makeRow(100, 'src-B', { longName: 'Strong Donor', hwModel: 7, role: 2, updatedAt: 1000 }),
      makeRow(100, 'src-C', { longName: null, shortName: null, hwModel: null, role: null }),
    ]);

    const result = await analyzeEnrichment();

    const target = result.nodes[0].targets.find(t => t.targetSourceId === 'src-C');
    expect(target?.donorSourceId).toBe('src-B'); // more fields filled wins
  });

  it('best donor ranking: tie-break by newer updatedAt', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow(100, 'src-A', { longName: 'Older', shortName: 'A', updatedAt: 1000 }),
      makeRow(100, 'src-B', { longName: 'Newer', shortName: 'B', updatedAt: 9000 }),
      makeRow(100, 'src-C', { longName: null, shortName: null }),
    ]);

    const result = await analyzeEnrichment();

    const target = result.nodes[0].targets.find(t => t.targetSourceId === 'src-C');
    expect(target?.donorSourceId).toBe('src-B'); // same field count (2 each), newer wins
  });

  it('excludes hasPKC from fillableFields and fieldCount even when donor has publicKey+hasPKC', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow(100, 'src-A', { publicKey: 'abc123', hasPKC: true, updatedAt: 2000 }),
      makeRow(100, 'src-B', { publicKey: null, hasPKC: null, updatedAt: 1000 }),
    ]);

    const result = await analyzeEnrichment();

    const target = result.nodes[0].targets[0];
    expect(target.fillableFields).toContain('publicKey');
    expect(target.fillableFields).not.toContain('hasPKC');
    expect(result.summary.fieldCount).toBe(1);
  });

  it('excludes nodes with no blank fields across sources', async () => {
    const full = { longName: 'Same', shortName: 'S', hwModel: 1, role: 1, macaddr: 'AA:BB', publicKey: 'key', hasPKC: true, firmwareVersion: '2.5' };
    h.getAllNodesMock.mockResolvedValue([
      makeRow(100, 'src-A', { ...full }),
      makeRow(100, 'src-B', { ...full }),
    ]);

    const result = await analyzeEnrichment();

    expect(result.nodes).toHaveLength(0);
    expect(result.summary).toEqual({ nodeCount: 0, targetCount: 0, fieldCount: 0 });
  });

  it('excludes nodes present in only a single source', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow(100, 'src-A', { longName: null }),
    ]);

    const result = await analyzeEnrichment();

    expect(result.nodes).toHaveLength(0);
  });

  it('allowedSourceIds filters the source universe (as donor and target)', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow(100, 'src-A', { longName: 'Full Node', shortName: 'FN', updatedAt: 2000 }),
      makeRow(100, 'src-B', { longName: null, shortName: null }),
    ]);

    const restricted = await analyzeEnrichment(['src-A']);
    // src-B dropped entirely, so no cross-source pair remains for node 100
    expect(restricted.nodes).toHaveLength(0);

    const empty = await analyzeEnrichment([]);
    expect(empty).toEqual({ nodes: [], summary: { nodeCount: 0, targetCount: 0, fieldCount: 0 } });
  });

  it('groups rows by Number(nodeNum) even when repo returns bigint-like values', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow(100, 'src-A', { longName: 'Full Node', shortName: 'FN', updatedAt: 2000, nodeNum: 100n as unknown as number }),
      makeRow(100, 'src-B', { longName: null }),
    ]);

    const result = await analyzeEnrichment();

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].nodeNum).toBe(100);
  });
});

describe('applyEnrichment', () => {
  it('delegates to copyNodeInfo fill-blanks-only (no fields arg), pushToNodeDb=false', async () => {
    h.copyNodeInfoMock.mockResolvedValue({ copiedFields: ['longName'], pushedToDevice: false });

    const result = await applyEnrichment(
      [{ nodeNum: 100, targetSourceId: 'src-B', donorSourceId: 'src-A' }],
      { pushToNodeDb: false },
    );

    expect(h.copyNodeInfoMock).toHaveBeenCalledWith(100, 'src-A', 'src-B', false);
    expect(h.copyNodeInfoMock.mock.calls[0]).toHaveLength(4); // no 5th `fields` arg
    expect(result.applied[0].copiedFields).toEqual(['longName']);
    expect(result.applied[0].error).toBeUndefined();
  });

  it('passes pushToNodeDb=true through as the 4th arg', async () => {
    h.copyNodeInfoMock.mockResolvedValue({ copiedFields: ['hwModel'], pushedToDevice: true });

    await applyEnrichment(
      [{ nodeNum: 100, targetSourceId: 'src-B', donorSourceId: 'src-A' }],
      { pushToNodeDb: true },
    );

    expect(h.copyNodeInfoMock).toHaveBeenCalledWith(100, 'src-A', 'src-B', true);
  });

  it('isolates per-item errors: one throwing item does not abort the batch', async () => {
    h.copyNodeInfoMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ copiedFields: ['longName'], pushedToDevice: false });

    const result = await applyEnrichment(
      [
        { nodeNum: 100, targetSourceId: 'src-B', donorSourceId: 'src-A' },
        { nodeNum: 200, targetSourceId: 'src-C', donorSourceId: 'src-A' },
      ],
      { pushToNodeDb: false },
    );

    expect(result.applied).toHaveLength(2);
    expect(result.applied[0].error).toContain('boom');
    expect(result.applied[0].copiedFields).toEqual([]);
    expect(result.applied[1].error).toBeUndefined();
    expect(result.applied[1].copiedFields).toEqual(['longName']);
  });

  it('totalFieldsCopied sums copiedFields across all items', async () => {
    h.copyNodeInfoMock
      .mockResolvedValueOnce({ copiedFields: ['longName', 'hwModel'], pushedToDevice: false })
      .mockResolvedValueOnce({ copiedFields: ['role'], pushedToDevice: false });

    const result = await applyEnrichment(
      [
        { nodeNum: 100, targetSourceId: 'src-B', donorSourceId: 'src-A' },
        { nodeNum: 200, targetSourceId: 'src-C', donorSourceId: 'src-A' },
      ],
      { pushToNodeDb: false },
    );

    expect(result.totalFieldsCopied).toBe(3);
  });
});
