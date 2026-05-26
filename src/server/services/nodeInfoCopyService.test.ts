import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
  getAllSourcesMock: vi.fn(),
  upsertNodeMock: vi.fn().mockResolvedValue(undefined),
  getManagerMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: {
      getNode: h.getNodeMock,
      upsertNode: h.upsertNodeMock,
    },
    sources: {
      getAllSources: h.getAllSourcesMock,
    },
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: h.getManagerMock,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { findCopyCandidates, copyNodeInfo } from './nodeInfoCopyService.js';

const makeNode = (overrides: Record<string, unknown> = {}) => ({
  nodeNum: 100,
  nodeId: '!00000064',
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

const sources = [
  { id: 'src-A', name: 'Source A', type: 'meshtastic_tcp', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {} },
  { id: 'src-B', name: 'Source B', type: 'meshtastic_tcp', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {} },
  { id: 'src-C', name: 'Source C', type: 'mqtt_bridge', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {} },
];

beforeEach(() => {
  vi.resetAllMocks();
  h.getAllSourcesMock.mockResolvedValue(sources);
  h.upsertNodeMock.mockResolvedValue(undefined);
});

describe('findCopyCandidates', () => {
  it('returns sources that have NodeInfo for the given nodeNum', async () => {
    // src-A is the target so it's skipped; only src-B and src-C are queried
    h.getNodeMock
      .mockResolvedValueOnce(makeNode({ longName: 'TestNode', shortName: 'TN', updatedAt: 2000 })) // src-B
      .mockResolvedValueOnce(null); // src-C: not found

    const result = await findCopyCandidates(100, 'src-A');

    expect(result).toHaveLength(1);
    expect(result[0].sourceId).toBe('src-B');
    expect(result[0].sourceName).toBe('Source B');
    expect(result[0].node.longName).toBe('TestNode');
    expect(result[0].fieldsFilled).toBe(2); // longName + shortName
  });

  it('excludes sources where node has no longName or shortName', async () => {
    h.getNodeMock
      .mockResolvedValueOnce(makeNode()) // src-B: no longName/shortName
      .mockResolvedValueOnce(null); // src-C

    const result = await findCopyCandidates(100, 'src-A');
    expect(result).toHaveLength(0);
  });

  it('sorts candidates by most fields filled first, then by updatedAt', async () => {
    h.getNodeMock
      .mockResolvedValueOnce(makeNode({ longName: 'Fewer', updatedAt: 3000 })) // src-B: 1 field
      .mockResolvedValueOnce(makeNode({ longName: 'More', shortName: 'MR', hwModel: 42, updatedAt: 1000 })); // src-C: 3 fields

    const result = await findCopyCandidates(100, 'src-A');

    expect(result).toHaveLength(2);
    expect(result[0].sourceName).toBe('Source C'); // more fields wins despite older
    expect(result[1].sourceName).toBe('Source B');
  });
});

describe('copyNodeInfo', () => {
  it('copies missing fields from donor to target', async () => {
    const donor = makeNode({
      longName: 'TestNode',
      shortName: 'TN',
      hwModel: 42,
      publicKey: 'abc123',
      hasPKC: true,
    });
    const target = makeNode();

    h.getNodeMock
      .mockResolvedValueOnce(donor) // donor lookup
      .mockResolvedValueOnce(target); // target lookup

    const result = await copyNodeInfo(100, 'src-B', 'src-A');

    expect(result.copiedFields).toContain('longName');
    expect(result.copiedFields).toContain('shortName');
    expect(result.copiedFields).toContain('hwModel');
    expect(result.copiedFields).toContain('publicKey');
    expect(result.copiedFields).toContain('hasPKC');
    expect(result.pushedToDevice).toBe(false);

    expect(h.upsertNodeMock).toHaveBeenCalledOnce();
    const upsertArg = h.upsertNodeMock.mock.calls[0][0];
    expect(upsertArg.longName).toBe('TestNode');
    expect(upsertArg.shortName).toBe('TN');
  });

  it('does not overwrite existing fields on target', async () => {
    const donor = makeNode({ longName: 'DonorName', shortName: 'DN', hwModel: 42 });
    const target = makeNode({ longName: 'ExistingName' });

    h.getNodeMock
      .mockResolvedValueOnce(donor)
      .mockResolvedValueOnce(target);

    const result = await copyNodeInfo(100, 'src-B', 'src-A');

    expect(result.copiedFields).not.toContain('longName');
    expect(result.copiedFields).toContain('shortName');
    expect(result.copiedFields).toContain('hwModel');
  });

  it('returns empty copiedFields when nothing to copy', async () => {
    const donor = makeNode({ longName: 'Name' });
    const target = makeNode({ longName: 'Already' });

    h.getNodeMock
      .mockResolvedValueOnce(donor)
      .mockResolvedValueOnce(target);

    const result = await copyNodeInfo(100, 'src-B', 'src-A');

    expect(result.copiedFields).toHaveLength(0);
    expect(h.upsertNodeMock).not.toHaveBeenCalled();
  });

  it('throws when donor node not found', async () => {
    h.getNodeMock.mockResolvedValueOnce(null);

    await expect(copyNodeInfo(100, 'src-B', 'src-A'))
      .rejects.toThrow('not found in source src-B');
  });

  it('calls sendNodeInfoRequest when pushToNodeDb is true', async () => {
    const sendMock = vi.fn().mockResolvedValue({ packetId: 1, requestId: 1 });
    h.getManagerMock.mockReturnValue({ sendNodeInfoRequest: sendMock });

    const donor = makeNode({ longName: 'TestNode', channel: 3 });
    const target = makeNode();

    h.getNodeMock
      .mockResolvedValueOnce(donor)
      .mockResolvedValueOnce(target);

    const result = await copyNodeInfo(100, 'src-B', 'src-A', true);

    expect(result.pushedToDevice).toBe(true);
    expect(sendMock).toHaveBeenCalledWith(100, 3);
  });

  it('returns pushedToDevice=false when manager not available', async () => {
    h.getManagerMock.mockReturnValue(undefined);

    const donor = makeNode({ longName: 'TestNode' });
    const target = makeNode();

    h.getNodeMock
      .mockResolvedValueOnce(donor)
      .mockResolvedValueOnce(target);

    const result = await copyNodeInfo(100, 'src-B', 'src-A', true);

    expect(result.pushedToDevice).toBe(false);
  });
});
