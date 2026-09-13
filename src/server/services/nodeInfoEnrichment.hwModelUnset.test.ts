/**
 * Regression tests for #5193 — "NodeInfo Enrichment count oscillates on
 * repeated Fix All".
 *
 * `hwModel` 0 is `HardwareModel.UNSET`, and `NodesRepository.upsertNode` maps
 * an incoming 0 back to the stored value rather than writing it (#3505). The
 * enrichment analyzer used to read a donor's 0 as real data, so it offered the
 * copy; `copyNodeInfo` reported the field as copied; the repository dropped it;
 * and the next analysis offered the identical copy again. The count could never
 * reach zero, and with "Also push to device NodeDB" enabled every press put
 * another NodeInfo request on the air.
 *
 * The second half of the same bug: the push addressed the target radio on the
 * DONOR row's channel. MQTT rows carry `CHANNEL_DB_OFFSET + channelDatabaseId`
 * (>= 100), not a slot, so the device answered `NO_CHANNEL (6)`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
  getAllNodesMock: vi.fn(),
  getAllSourcesMock: vi.fn(),
  upsertNodeMock: vi.fn().mockResolvedValue(undefined),
  getManagerMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: {
      getNode: h.getNodeMock,
      getAllNodes: h.getAllNodesMock,
      upsertNode: h.upsertNodeMock,
    },
    sources: { getAllSources: h.getAllSourcesMock },
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: h.getManagerMock },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: h.warnMock, error: vi.fn(), debug: vi.fn() },
}));

import { copyNodeInfo, isNodeInfoFieldBlank, countFilledNodeInfoFields } from './nodeInfoCopyService.js';
import { analyzeEnrichment } from './nodeInfoEnrichmentService.js';

const sources = [
  { id: 'mqtt', name: 'Home Mqtt', type: 'mqtt_broker', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {}, displayOrder: 0 },
  { id: 'tcp', name: 'Heltec LF listener', type: 'meshtastic_tcp', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {}, displayOrder: 1 },
];

const makeRow = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
  nodeNum: 181032536,
  nodeId: '!0aca5658',
  sourceId,
  longName: 'Node A',
  shortName: 'NA',
  hwModel: null,
  role: null,
  macaddr: null,
  publicKey: null,
  hasPKC: null,
  firmwareVersion: null,
  channel: null,
  updatedAt: 1000,
  lastHeard: 900,
  createdAt: 500,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.getAllSourcesMock.mockResolvedValue(sources);
  h.upsertNodeMock.mockResolvedValue(undefined);
});

describe('isNodeInfoFieldBlank (#5193)', () => {
  it('treats hwModel 0 as blank — the repository will not store HardwareModel.UNSET', () => {
    expect(isNodeInfoFieldBlank(0, 'hwModel')).toBe(true);
    expect(isNodeInfoFieldBlank(31, 'hwModel')).toBe(false);
  });

  it('keeps role 0 meaningful — Role.CLIENT is a value the repository stores', () => {
    expect(isNodeInfoFieldBlank(0, 'role')).toBe(false);
  });

  it('does not count a donor hwModel of 0 toward donor ranking', () => {
    expect(countFilledNodeInfoFields({ hwModel: 0 } as never)).toBe(0);
    expect(countFilledNodeInfoFields({ hwModel: 31 } as never)).toBe(1);
  });
});

describe('analyzeEnrichment with an UNSET donor hwModel (#5193)', () => {
  it('does not offer a copy that the nodes repository would silently drop', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow('mqtt', { hwModel: 0 }), // donor: HardwareModel.UNSET
      makeRow('tcp', { hwModel: null }), // target: blank
    ]);

    const analysis = await analyzeEnrichment();

    expect(analysis.summary).toEqual({ nodeCount: 0, targetCount: 0, fieldCount: 0 });
  });

  it('still offers the copy when the donor holds a real hardware model', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow('mqtt', { hwModel: 31 }),
      makeRow('tcp', { hwModel: null }),
    ]);

    const analysis = await analyzeEnrichment();

    expect(analysis.summary.fieldCount).toBe(1);
    expect(analysis.nodes[0].targets[0]).toMatchObject({
      targetSourceId: 'tcp',
      donorSourceId: 'mqtt',
      fillableFields: ['hwModel'],
    });
  });

  it('treats a target hwModel of 0 as fillable, since the stored 0 means nothing', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow('mqtt', { hwModel: 31 }),
      makeRow('tcp', { hwModel: 0 }),
    ]);

    const analysis = await analyzeEnrichment();

    expect(analysis.nodes[0].targets[0].fillableFields).toEqual(['hwModel']);
  });
});

describe('copyNodeInfo with an UNSET donor hwModel (#5193)', () => {
  it('reports nothing copied and writes nothing rather than claiming a dropped write', async () => {
    h.getNodeMock
      .mockResolvedValueOnce(makeRow('mqtt', { hwModel: 0 })) // donor
      .mockResolvedValueOnce(makeRow('tcp', { hwModel: null })); // target

    const result = await copyNodeInfo(181032536, 'mqtt', 'tcp');

    expect(result.copiedFields).toEqual([]);
    expect(h.upsertNodeMock).not.toHaveBeenCalled();
  });

  it('overwrites a target hwModel of 0 when the donor has a real model', async () => {
    h.getNodeMock
      .mockResolvedValueOnce(makeRow('mqtt', { hwModel: 31 })) // donor
      .mockResolvedValueOnce(makeRow('tcp', { hwModel: 0 })) // target: UNSET counts as blank
      .mockResolvedValueOnce(makeRow('tcp', { hwModel: 31 })); // verification read-back

    const result = await copyNodeInfo(181032536, 'mqtt', 'tcp');

    expect(result.copiedFields).toEqual(['hwModel']);
    expect(h.upsertNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ hwModel: 31 }),
      'tcp',
    );
  });

  it('warns when a copied field is still blank on read-back', async () => {
    h.getNodeMock
      .mockResolvedValueOnce(makeRow('mqtt', { role: 2 })) // donor
      .mockResolvedValueOnce(makeRow('tcp')) // target
      .mockResolvedValueOnce(makeRow('tcp')); // read-back: the write did not stick

    await copyNodeInfo(181032536, 'mqtt', 'tcp');

    expect(h.warnMock).toHaveBeenCalledWith(expect.stringContaining('did not persist'));
  });
});

describe('pushNodeInfoToDevice channel selection (#5193)', () => {
  const sendNodeInfoRequest = vi.fn().mockResolvedValue({ packetId: 1, requestId: 2 });

  beforeEach(() => {
    sendNodeInfoRequest.mockClear();
    h.getManagerMock.mockReturnValue({ sendNodeInfoRequest });
  });

  it("addresses the target device on the TARGET row's slot, not the donor's", async () => {
    h.getNodeMock
      .mockResolvedValueOnce(makeRow('mqtt', { role: 2, channel: 107 })) // donor: virtual MQTT channel
      .mockResolvedValueOnce(makeRow('tcp', { channel: 3 })) // target: real slot
      .mockResolvedValueOnce(makeRow('tcp', { role: 2, channel: 3 }));

    const result = await copyNodeInfo(181032536, 'mqtt', 'tcp', true);

    expect(result.pushedToDevice).toBe(true);
    expect(sendNodeInfoRequest).toHaveBeenCalledWith(181032536, 3);
  });

  it('falls back to the primary channel rather than sending a virtual channel number', async () => {
    // CHANNEL_DB_OFFSET + channelDatabaseId lands on the node row of any
    // MQTT-ingested source. Handed to a radio it produced NO_CHANNEL (6).
    h.getNodeMock
      .mockResolvedValueOnce(makeRow('tcp', { role: 2, channel: 0 })) // donor
      .mockResolvedValueOnce(makeRow('mqtt', { channel: 107 })) // target: virtual channel
      .mockResolvedValueOnce(makeRow('mqtt', { role: 2, channel: 107 }));

    await copyNodeInfo(181032536, 'tcp', 'mqtt', true);

    expect(sendNodeInfoRequest).toHaveBeenCalledWith(181032536, 0);
  });

  it('falls back to the primary channel when the target row has no channel', async () => {
    h.getNodeMock
      .mockResolvedValueOnce(makeRow('mqtt', { role: 2, channel: 5 }))
      .mockResolvedValueOnce(makeRow('tcp', { channel: null }))
      .mockResolvedValueOnce(makeRow('tcp', { role: 2 }));

    await copyNodeInfo(181032536, 'mqtt', 'tcp', true);

    expect(sendNodeInfoRequest).toHaveBeenCalledWith(181032536, 0);
  });
});
