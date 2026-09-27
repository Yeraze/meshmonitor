import { describe, it, expect, vi, beforeEach } from 'vitest';

const settingsStore = new Map<string, string>();
const localNodeNums = new Map<string, string>();
const nodeRows = new Map<string, Record<string, unknown>>();

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSettingForSource: vi.fn(async (sourceId: string, key: string) => settingsStore.get(`${sourceId}:${key}`) ?? null),
      getLocalNodeNumForSource: vi.fn(async (sourceId: string) => localNodeNums.get(sourceId) ?? null),
    },
    nodes: {
      getNode: vi.fn(async (nodeNum: number, sourceId: string) => nodeRows.get(`${sourceId}:${nodeNum}`) ?? null),
    },
  },
}));

const managers = new Map<string, { sourceType: string; getLocalNode?: () => unknown }>();
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: (id: string) => managers.get(id) },
}));

import {
  correctRoutePositionsJson,
  applySignFlipToTraceroute,
  applySignFlipToTraceroutes,
  applySignFlipToMeshCoreRows,
  applySignFlipCorrection,
  loadSignFlipContext,
  createSignFlipResolver,
  getDisplayDbNodePosition,
  loadSignFlipContexts,
  rowSourceId,
  SIGN_FLIP_SETTING_KEYS,
  type SignFlipContext,
} from './signFlipCorrection';

const TAMPA = { latitude: 27.95, longitude: -82.46 };
const CTX: SignFlipContext = { reference: TAMPA, rangeKm: 500 };

function setSetting(sourceId: string, key: string, value: string) {
  settingsStore.set(`${sourceId}:${key}`, value);
}

beforeEach(() => {
  settingsStore.clear();
  localNodeNums.clear();
  nodeRows.clear();
  managers.clear();
});

describe('applySignFlipCorrection', () => {
  it('corrects the nested DeviceInfo position and keeps the reported pair', () => {
    const node = { nodeNum: 1, position: { latitude: 27.9, longitude: 82.5, altitude: 10 } };
    const out = applySignFlipCorrection(node, CTX);
    expect(out.position).toEqual({ latitude: 27.9, longitude: -82.5, altitude: 10 });
    expect(out.positionSignFlipCorrected).toBe(true);
    expect(out.reportedLatitude).toBe(27.9);
    expect(out.reportedLongitude).toBe(82.5);
    // Input untouched.
    expect(node.position.longitude).toBe(82.5);
  });

  it('corrects the flat dashboard shape (and a nested copy when present)', () => {
    const out = applySignFlipCorrection(
      { latitude: 27.9, longitude: 82.5, position: { latitude: 27.9, longitude: 82.5 } },
      CTX,
    );
    expect(out.latitude).toBe(27.9);
    expect(out.longitude).toBe(-82.5);
    expect(out.position).toEqual({ latitude: 27.9, longitude: -82.5 });
  });

  it('never touches an override or an estimate', () => {
    const override = { positionIsOverride: true, position: { latitude: 27.9, longitude: 82.5 } };
    const estimate = { positionIsEstimated: true, position: { latitude: 27.9, longitude: 82.5 } };
    expect(applySignFlipCorrection(override, CTX)).toBe(override);
    expect(applySignFlipCorrection(estimate, CTX)).toBe(estimate);
  });

  it('returns the node unchanged with no context or no flip', () => {
    const node = { position: { latitude: 27.9, longitude: 82.5 } };
    expect(applySignFlipCorrection(node, null)).toBe(node);
    const near = { position: { latitude: 28, longitude: -82 } };
    expect(applySignFlipCorrection(near, CTX)).toBe(near);
  });

  it('passes precision bits through so an obscured Null Island is skipped', () => {
    const offset = Math.pow(2, 31 - 14) * 1e-7;
    const ctx = { reference: { latitude: -offset, longitude: -offset }, rangeKm: 1 };
    const node = { positionPrecisionBits: 14, position: { latitude: offset, longitude: offset } };
    expect(applySignFlipCorrection(node, ctx)).toBe(node);
  });
});

describe('loadSignFlipContext', () => {
  it('is null when the feature is off (the default)', async () => {
    expect(await loadSignFlipContext('src-a')).toBeNull();
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.enabled, 'false');
    expect(await loadSignFlipContext('src-a')).toBeNull();
    expect(await loadSignFlipContext(null)).toBeNull();
  });

  it("uses the source's own node position by default", async () => {
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    localNodeNums.set('src-a', '123');
    nodeRows.set('src-a:123', { latitude: 27.95, longitude: -82.46 });
    expect(await loadSignFlipContext('src-a')).toEqual({ reference: TAMPA, rangeKm: 500 });
  });

  it("honours the own node's position override", async () => {
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    localNodeNums.set('src-a', '123');
    nodeRows.set('src-a:123', {
      latitude: 1, longitude: 1,
      positionOverrideEnabled: true, latitudeOverride: 27.95, longitudeOverride: -82.46,
    });
    expect((await loadSignFlipContext('src-a'))?.reference).toEqual(TAMPA);
  });

  it('prefers a manual reference and reads the range', async () => {
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.rangeKm, '250');
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.referenceLat, '-33.87');
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.referenceLon, '151.21');
    localNodeNums.set('src-a', '123');
    nodeRows.set('src-a:123', { latitude: 27.95, longitude: -82.46 });
    expect(await loadSignFlipContext('src-a')).toEqual({
      reference: { latitude: -33.87, longitude: 151.21 },
      rangeKm: 250,
    });
  });

  it('is null when no reference is known (no local node, or it has no fix)', async () => {
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    expect(await loadSignFlipContext('src-a')).toBeNull();
    localNodeNums.set('src-a', '123');
    nodeRows.set('src-a:123', { latitude: null, longitude: null });
    expect(await loadSignFlipContext('src-a')).toBeNull();
    nodeRows.set('src-a:123', { latitude: 0, longitude: 0 });
    expect(await loadSignFlipContext('src-a')).toBeNull();
  });

  it('keeps sources separate', async () => {
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    localNodeNums.set('src-a', '1');
    localNodeNums.set('src-b', '2');
    nodeRows.set('src-a:1', { latitude: 27.95, longitude: -82.46 });
    nodeRows.set('src-b:2', { latitude: 27.95, longitude: -82.46 });
    const contexts = await loadSignFlipContexts(['src-a', 'src-b', 'src-a', undefined]);
    expect(contexts.get('src-a')).not.toBeNull();
    expect(contexts.get('src-b')).toBeNull();
    expect(contexts.size).toBe(2);
  });
});

describe('createSignFlipResolver', () => {
  it('loads each source once per resolver', async () => {
    const db = (await import('../../services/database.js')).default as any;
    db.settings.getSettingForSource.mockClear();
    const resolve = createSignFlipResolver();
    await Promise.all([resolve('src-a'), resolve('src-a'), resolve('src-a')]);
    expect(db.settings.getSettingForSource).toHaveBeenCalledTimes(1);
  });
});

describe('getDisplayDbNodePosition', () => {
  it('corrects a device fix but not an override', () => {
    expect(getDisplayDbNodePosition({ latitude: 27.9, longitude: 82.5 }, CTX)).toMatchObject({
      latitude: 27.9, longitude: -82.5, isOverride: false,
    });
    expect(getDisplayDbNodePosition({
      latitude: 1, longitude: 1, positionOverrideEnabled: true, latitudeOverride: 27.9, longitudeOverride: 82.5,
    }, CTX)).toMatchObject({ latitude: 27.9, longitude: 82.5, isOverride: true });
  });
});

describe('rowSourceId', () => {
  it('reads a string sourceId only', () => {
    expect(rowSourceId({ sourceId: 'x' })).toBe('x');
    expect(rowSourceId({ sourceId: '' })).toBeUndefined();
    expect(rowSourceId({})).toBeUndefined();
    expect(rowSourceId(null)).toBeUndefined();
  });
});

describe('traceroute routePositions snapshots (#5363)', () => {
  const snapshot = JSON.stringify({
    100: { lat: 27.95, lng: -82.46, alt: 5 }, // near the reference: untouched
    111: { lat: 27.9, lng: 82.5 },            // flipped longitude: corrected
  });

  it('corrects only the flipped points and keeps other fields', () => {
    const out = JSON.parse(correctRoutePositionsJson(snapshot, CTX)!);
    expect(out['100']).toEqual({ lat: 27.95, lng: -82.46, alt: 5 });
    expect(out['111'].lat).toBeCloseTo(27.9);
    expect(out['111'].lng).toBeCloseTo(-82.5);
  });

  it('returns the input when correction is off, nothing changes, or it does not parse', () => {
    expect(correctRoutePositionsJson(snapshot, null)).toBe(snapshot);
    const near = JSON.stringify({ 1: { lat: 28, lng: -82 } });
    expect(correctRoutePositionsJson(near, CTX)).toBe(near);
    expect(correctRoutePositionsJson('not json', CTX)).toBe('not json');
    expect(correctRoutePositionsJson(null, CTX)).toBeNull();
  });

  it('copies the traceroute row only when a point changed', () => {
    const tr = { id: 1, routePositions: snapshot };
    const out = applySignFlipToTraceroute(tr, CTX);
    expect(out).not.toBe(tr);
    expect(tr.routePositions).toBe(snapshot); // stored row untouched
    const plain = { id: 2, routePositions: JSON.stringify({ 1: { lat: 28, lng: -82 } }) };
    expect(applySignFlipToTraceroute(plain, CTX)).toBe(plain);
  });

  it('corrects each row against its own source', async () => {
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.referenceLat, '27.95');
    setSetting('src-a', SIGN_FLIP_SETTING_KEYS.referenceLon, '-82.46');
    const rows = [
      { sourceId: 'src-a', routePositions: snapshot },
      { sourceId: 'src-b', routePositions: snapshot },
    ];
    const [a, b] = await applySignFlipToTraceroutes(rows);
    expect(JSON.parse(a.routePositions!)['111'].lng).toBeCloseTo(-82.5);
    expect(b.routePositions).toBe(snapshot);
  });
});

describe('MeshCore (#5363)', () => {
  it("uses a MeshCore companion's own advertised position as the reference", async () => {
    managers.set('mc-1', { sourceType: 'meshcore', getLocalNode: () => ({ latitude: 27.95, longitude: -82.46 }) });
    setSetting('mc-1', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    expect((await loadSignFlipContext('mc-1'))?.reference).toEqual(TAMPA);
  });

  it('has no own-node reference for a MeshCore MQTT ingest source, or a companion without a fix', async () => {
    managers.set('mc-mqtt', { sourceType: 'meshcore_mqtt' });
    setSetting('mc-mqtt', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    expect(await loadSignFlipContext('mc-mqtt')).toBeNull();
    managers.set('mc-2', { sourceType: 'meshcore', getLocalNode: () => ({ latitude: null, longitude: null }) });
    setSetting('mc-2', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    expect(await loadSignFlipContext('mc-2')).toBeNull();
  });

  it('corrects MeshCore contact rows (flat lat/lon) when on, and leaves them when off', async () => {
    managers.set('mc-1', { sourceType: 'meshcore', getLocalNode: () => ({ latitude: 27.95, longitude: -82.46 }) });
    const rows = [{ publicKey: 'ab', latitude: 27.9, longitude: 82.5 }];
    expect(await applySignFlipToMeshCoreRows(rows, 'mc-1')).toBe(rows); // off
    setSetting('mc-1', SIGN_FLIP_SETTING_KEYS.enabled, 'true');
    const [row] = await applySignFlipToMeshCoreRows(rows, 'mc-1');
    expect(row.longitude).toBeCloseTo(-82.5);
    expect(row.positionSignFlipCorrected).toBe(true);
    expect(row.reportedLongitude).toBeCloseTo(82.5);
  });
});
