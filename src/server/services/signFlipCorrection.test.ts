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

import {
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
