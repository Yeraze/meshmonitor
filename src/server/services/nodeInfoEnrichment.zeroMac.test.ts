/**
 * Regression tests for #5231 — the enrichment report kept offering a MAC copy
 * that changed nothing.
 *
 * `User.macaddr` was deprecated in firmware 2.1.x, so plenty of nodes broadcast
 * six zero bytes. Hex-encoded that is '000000000000' — a non-empty string. The
 * blank predicate read it as data, so a donor was credited with a MAC it does
 * not have, `copyNodeInfo` reported the field as copied, and the repository
 * (which now maps a zero MAC back to the stored value) dropped it. Same
 * never-converging loop as #5193, a different sentinel.
 *
 * This is the rule from that fix restated: the analyzer's notion of "blank"
 * must match what `NodesRepository.upsertNode` will actually store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getNodeMock: vi.fn(),
  getAllNodesMock: vi.fn(),
  getAllSourcesMock: vi.fn(),
  upsertNodeMock: vi.fn().mockResolvedValue(undefined),
  getManagerMock: vi.fn(),
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  copyNodeInfo,
  isNodeInfoFieldBlank,
  countFilledNodeInfoFields,
} from './nodeInfoCopyService.js';
import { analyzeEnrichment } from './nodeInfoEnrichmentService.js';

const ZERO_MAC = '000000000000';
const REAL_MAC = 'c4d266f1c31d';

const sources = [
  { id: 'mqtt', name: 'Home Mqtt', type: 'mqtt_broker', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {}, displayOrder: 0 },
  { id: 'tcp', name: 'Liligo T3S3', type: 'meshtastic_tcp', enabled: true, createdAt: 0, updatedAt: 0, createdBy: null, config: {}, displayOrder: 1 },
];

const makeRow = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
  nodeNum: 0x433b3de0,
  nodeId: '!433b3de0',
  sourceId,
  longName: 'Dave & Karen',
  shortName: 'SKYB',
  hwModel: 43,
  role: 2,
  macaddr: null,
  publicKey: null,
  hasPKC: null,
  firmwareVersion: '2.8.0',
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

describe('isNodeInfoFieldBlank — zero MAC (#5231)', () => {
  it('reads an all-zero macaddr as blank', () => {
    expect(isNodeInfoFieldBlank(ZERO_MAC, 'macaddr')).toBe(true);
  });

  it('still reads a real macaddr as data', () => {
    expect(isNodeInfoFieldBlank(REAL_MAC, 'macaddr')).toBe(false);
  });

  it('does not extend the zero-is-blank rule to other string fields', () => {
    // A node genuinely named "000000000000" is absurd, but the point is that
    // the rule is keyed on the field, like ZERO_IS_UNSET_FIELDS is.
    expect(isNodeInfoFieldBlank(ZERO_MAC, 'longName')).toBe(false);
  });

  it('does not credit a zero-MAC donor with a filled field', () => {
    const withZero = countFilledNodeInfoFields(makeRow('mqtt', { macaddr: ZERO_MAC }) as never);
    const withNone = countFilledNodeInfoFields(makeRow('mqtt', { macaddr: null }) as never);
    expect(withZero).toBe(withNone);
  });
});

describe('analyzeEnrichment — zero MAC (#5231)', () => {
  it('does not offer a copy when the only donor has a zero MAC', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow('mqtt', { macaddr: null }),
      makeRow('tcp', { macaddr: ZERO_MAC }),
    ]);
    const analysis = await analyzeEnrichment();
    // Both rows now read as blank on macaddr, and nothing else differs, so
    // there is no work to offer. Before the fix the MQTT row was reported as
    // fillable forever.
    expect(analysis.summary.fieldCount).toBe(0);
    expect(analysis.nodes).toHaveLength(0);
  });

  it('reports the MQTT row as fillable when a donor has a real MAC', async () => {
    h.getAllNodesMock.mockResolvedValue([
      makeRow('mqtt', { macaddr: ZERO_MAC }),
      makeRow('tcp', { macaddr: REAL_MAC }),
    ]);
    const analysis = await analyzeEnrichment();
    expect(analysis.nodes).toHaveLength(1);
    const target = analysis.nodes[0].targets.find(t => t.targetSourceId === 'mqtt');
    expect(target?.fillableFields).toEqual(['macaddr']);
    expect(target?.donorSourceId).toBe('tcp');
  });
});

describe('copyNodeInfo — zero MAC (#5231)', () => {
  it('refuses to copy a zero MAC the repository would drop anyway', async () => {
    h.getNodeMock.mockImplementation(async (_num: number, sourceId: string) =>
      sourceId === 'tcp' ? makeRow('tcp', { macaddr: ZERO_MAC }) : makeRow('mqtt', { macaddr: null }),
    );
    const result = await copyNodeInfo(0x433b3de0, 'tcp', 'mqtt');
    expect(result.copiedFields).not.toContain('macaddr');
    expect(h.upsertNodeMock).not.toHaveBeenCalled();
  });

  it('overwrites a stored zero MAC with the donor\'s real one', async () => {
    h.getNodeMock.mockImplementation(async (_num: number, sourceId: string) =>
      sourceId === 'tcp' ? makeRow('tcp', { macaddr: REAL_MAC }) : makeRow('mqtt', { macaddr: ZERO_MAC }),
    );
    const result = await copyNodeInfo(0x433b3de0, 'tcp', 'mqtt');
    expect(result.copiedFields).toContain('macaddr');
    expect(h.upsertNodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ macaddr: REAL_MAC }),
      'mqtt',
    );
  });
});
