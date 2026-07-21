/**
 * #4244 — Copy NodeInfo per-field selection.
 *
 * The original loop copied a field only when the TARGET was null/empty:
 *
 *   if (donorVal != null && donorVal !== '' && (targetVal == null || targetVal === ''))
 *
 * which made the feature useless in its most common case. MeshMonitor
 * auto-populates longName/shortName with a derived placeholder ("Node
 * !383c3519"), and a placeholder is a non-empty string — so real incoming
 * NodeInfo was blocked forever. Same for any field an earlier copy had already
 * filled (e.g. a role that has since changed upstream: 11 -> 12).
 *
 * An explicit `fields` selection now overwrites regardless. Omitting `fields`
 * must keep the legacy fill-empty-only behavior so other callers are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getNode = vi.fn();
const upsertNode = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    nodes: {
      getNode: (...args: unknown[]) => getNode(...args),
      upsertNode: (...args: unknown[]) => upsertNode(...args),
    },
    sources: { getAllSources: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: () => null },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { copyNodeInfo, isNodeInfoField, NODE_INFO_FIELDS } =
  await import('./nodeInfoCopyService.js');

const DONOR = {
  nodeNum: 943881497,
  nodeId: '!383c3519',
  longName: 'Real Name',
  shortName: 'REAL',
  hwModel: 43,
  role: 12,
  macaddr: 'aabbccddeeff',
  publicKey: 'donorkey',
  hasPKC: true,
  firmwareVersion: '2.7.4',
};

/** Target already fully populated — every field would be blocked pre-fix. */
const POPULATED_TARGET = {
  nodeNum: 943881497,
  nodeId: '!383c3519',
  longName: 'Node !383c3519', // derived placeholder, not real NodeInfo
  shortName: '3519',
  hwModel: 1,
  role: 11, // stale: upstream has since moved to 12
  macaddr: '112233445566',
  publicKey: 'oldkey',
  hasPKC: false,
  firmwareVersion: '2.7.0',
};

function wire(donor: unknown, target: unknown) {
  getNode.mockReset();
  upsertNode.mockReset().mockResolvedValue(undefined);
  // copyNodeInfo reads donor first, then target.
  getNode.mockImplementationOnce(async () => donor)
         .mockImplementationOnce(async () => target);
}

beforeEach(() => {
  getNode.mockReset();
  upsertNode.mockReset();
});

describe('copyNodeInfo field selection (#4244)', () => {
  it('overwrites a populated field when explicitly selected', () => {
    wire(DONOR, POPULATED_TARGET);
    return copyNodeInfo(943881497, 'src-a', 'src-b', false, ['longName']).then(res => {
      expect(res.copiedFields).toEqual(['longName']);
      const [payload] = upsertNode.mock.calls[0];
      expect(payload.longName).toBe('Real Name');
    });
  });

  it('refreshes a stale role that the old rule refused to touch (11 -> 12)', async () => {
    wire(DONOR, POPULATED_TARGET);
    const res = await copyNodeInfo(943881497, 'src-a', 'src-b', false, ['role']);
    expect(res.copiedFields).toEqual(['role']);
    expect(upsertNode.mock.calls[0][0].role).toBe(12);
  });

  it('copies ONLY the selected fields, leaving unchecked ones untouched', async () => {
    wire(DONOR, POPULATED_TARGET);
    const res = await copyNodeInfo(943881497, 'src-a', 'src-b', false, ['longName', 'shortName']);
    expect(res.copiedFields.sort()).toEqual(['longName', 'shortName']);
    const payload = upsertNode.mock.calls[0][0];
    expect(payload.role).toBeUndefined();
    expect(payload.macaddr).toBeUndefined();
  });

  it('copies macaddr when selected even though the target already has one', async () => {
    // The reported case: target's real MAC was hidden by the modal, so the user
    // saw "—" and expected a copy that the server then silently skipped.
    wire(DONOR, POPULATED_TARGET);
    const res = await copyNodeInfo(943881497, 'src-a', 'src-b', false, ['macaddr']);
    expect(res.copiedFields).toEqual(['macaddr']);
    expect(upsertNode.mock.calls[0][0].macaddr).toBe('aabbccddeeff');
  });

  it('still skips a selected field when the DONOR has nothing to give', async () => {
    wire({ ...DONOR, longName: null }, POPULATED_TARGET);
    const res = await copyNodeInfo(943881497, 'src-a', 'src-b', false, ['longName']);
    expect(res.copiedFields).toEqual([]);
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('treats an empty-string donor value as nothing to give', async () => {
    wire({ ...DONOR, shortName: '' }, POPULATED_TARGET);
    const res = await copyNodeInfo(943881497, 'src-a', 'src-b', false, ['shortName']);
    expect(res.copiedFields).toEqual([]);
  });

  it('preserves legacy fill-empty-only behavior when fields is omitted', async () => {
    wire(DONOR, POPULATED_TARGET);
    const res = await copyNodeInfo(943881497, 'src-a', 'src-b', false);
    // Every target field is populated, so the legacy rule copies nothing.
    expect(res.copiedFields).toEqual([]);
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('legacy path still fills genuinely empty target fields', async () => {
    wire(DONOR, { ...POPULATED_TARGET, macaddr: null, firmwareVersion: '' });
    const res = await copyNodeInfo(943881497, 'src-a', 'src-b', false);
    expect(res.copiedFields.sort()).toEqual(['firmwareVersion', 'macaddr']);
  });

  it('an empty fields array falls back to legacy rather than copying nothing', async () => {
    // Guards the `fields.length > 0` check: [] must not be read as "select all"
    // nor silently produce a no-op that looks like success.
    wire(DONOR, { ...POPULATED_TARGET, macaddr: null });
    const res = await copyNodeInfo(943881497, 'src-a', 'src-b', false, []);
    expect(res.copiedFields).toEqual(['macaddr']);
  });
});

describe('isNodeInfoField (#4244 request validation)', () => {
  it('accepts every known field name', () => {
    for (const f of NODE_INFO_FIELDS) expect(isNodeInfoField(f)).toBe(true);
  });

  it('rejects unknown names and non-strings so client typos surface as 400s', () => {
    for (const bad of ['nodeNum', 'nodeId', '__proto__', '', 1, null, undefined, {}]) {
      expect(isNodeInfoField(bad)).toBe(false);
    }
  });
});
