/**
 * Direct RF Contacts routes (#6210).
 *
 * Real harness (real session, real auth middleware, real SQL), so the
 * per-source gate and isolation are the actual ones, not a re-implementation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import directRfContactsRoutes, { parseWindow, parseNodeKey } from './directRfContactsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { localNodeNumSettingKey } from '../../db/repositories/settings.js';
import { directRfDayBucket, type DirectRfContactDelta } from '../../db/repositories/directRfContacts.js';

let harness: RouteTestHarness;

const LOCAL = 0x61000001;
const NODE_A = 0x61000002;
const NODE_HIDDEN_POS = 0x61000003;
const NOW = Date.now();
const DAY0 = directRfDayBucket(NOW);

function delta(sourceId: string, nodeNum: number, over: Partial<DirectRfContactDelta> = {}): DirectRfContactDelta {
  return {
    sourceId, protocol: 'meshtastic', nodeKey: `!${nodeNum.toString(16).padStart(8, '0')}`, nodeNum,
    dayBucket: DAY0, firstHeardAt: NOW - 60_000, lastHeardAt: NOW - 1_000, count: 3,
    bestSnr: 7, bestRssi: -80, snrSum: 15, snrCount: 3, rssiSum: -255, rssiCount: 3,
    ...over,
  };
}

async function seedNode(nodeNum: number, sourceId: string, extra: Record<string, unknown> = {}) {
  await databaseService.upsertNodeAsync({
    nodeNum,
    nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
    longName: `Node ${nodeNum.toString(16)}`,
    shortName: 'ND',
    hwModel: 1,
    lastHeard: Math.floor(NOW / 1000),
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  } as any, sourceId);
}

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: (app) => app.use('/api/sources/:id/direct-rf-contacts', directRfContactsRoutes),
  });
});

afterEach(async () => {
  await databaseService.purgeAllNodesAsync(harness.sourceA).catch(() => {});
  await databaseService.purgeAllNodesAsync(harness.sourceB).catch(() => {});
  await harness.cleanup();
});

const url = (src: string, qs = '') => `/api/sources/${src}/direct-rf-contacts${qs}`;

describe('GET /api/sources/:id/direct-rf-contacts', () => {
  it('returns one row per node with names, averages and distance', async () => {
    await databaseService.settings.setSetting(localNodeNumSettingKey(harness.sourceA), String(LOCAL));
    await seedNode(LOCAL, harness.sourceA, { latitude: 30.0, longitude: -95.0 });
    await seedNode(NODE_A, harness.sourceA, { latitude: 30.1, longitude: -95.0 });
    await databaseService.directRfContacts.applyDelta(delta(harness.sourceA, NODE_A));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.retentionDays).toBe(30);
    const [row] = res.body.data.contacts;
    expect(row).toMatchObject({
      nodeKey: `!${NODE_A.toString(16)}`, nodeNum: NODE_A, protocol: 'meshtastic',
      name: `Node ${NODE_A.toString(16)}`, receptionCount: 3, bestSnr: 7, avgSnr: 5, avgRssi: -85,
    });
    expect(row.distanceKm).toBeGreaterThan(10);
    expect(row.distanceKm).toBeLessThan(12);
  });

  it('returns no distance when the contact position is hidden from the caller', async () => {
    await databaseService.settings.setSetting(localNodeNumSettingKey(harness.sourceA), String(LOCAL));
    await seedNode(LOCAL, harness.sourceA, { latitude: 30.0, longitude: -95.0, channel: 0 });
    // channel 1: the limited user holds viewOnMap on channel 0 only.
    await seedNode(NODE_HIDDEN_POS, harness.sourceA, { latitude: 30.1, longitude: -95.0, channel: 1 });
    await databaseService.directRfContacts.applyDelta(delta(harness.sourceA, NODE_HIDDEN_POS));
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.data.contacts[0].distanceKm).toBeNull();
  });

  it('reads only its own source', async () => {
    await databaseService.directRfContacts.applyDelta(delta(harness.sourceA, NODE_A));
    await databaseService.directRfContacts.applyDelta(delta(harness.sourceB, NODE_A, { count: 9 }));
    const agent = await harness.loginAs(harness.admin);
    const a = await agent.get(url(harness.sourceA));
    const b = await agent.get(url(harness.sourceB));
    expect(a.body.data.contacts.map((c: { receptionCount: number }) => c.receptionCount)).toEqual([3]);
    expect(b.body.data.contacts.map((c: { receptionCount: number }) => c.receptionCount)).toEqual([9]);
  });

  it('requires nodes:read on the source in the path, not on any source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
    expect((await agent.get(url(harness.sourceB))).status).toBe(200);
  });

  it('rejects a bad window with INVALID_RANGE', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(url(harness.sourceA, '?from=10&to=5'));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_RANGE' });
    expect((await agent.get(url(harness.sourceA, '?from=junk'))).status).toBe(400);
  });
});

describe('GET /api/sources/:id/direct-rf-contacts/node/:nodeKey', () => {
  it('returns the summary and the daily series', async () => {
    await seedNode(NODE_A, harness.sourceA);
    await databaseService.directRfContacts.applyDelta(delta(harness.sourceA, NODE_A, {
      dayBucket: DAY0 - 86_400_000, firstHeardAt: DAY0 - 80_000_000, lastHeardAt: DAY0 - 70_000_000, count: 2,
    }));
    await databaseService.directRfContacts.applyDelta(delta(harness.sourceA, NODE_A));
    const agent = await harness.loginAs(harness.admin);
    const key = `!${NODE_A.toString(16)}`;
    const res = await agent.get(url(harness.sourceA, `/node/${encodeURIComponent(key)}?from=${NOW - 3 * 86_400_000}&to=${NOW}`));
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ nodeKey: key, receptionCount: 5, daysHeard: 2 });
    expect(res.body.data.daily.map((d: { receptionCount: number }) => d.receptionCount)).toEqual([2, 3]);
  });

  it('returns a null summary for a node never heard direct, and 400 on a bad key', async () => {
    const agent = await harness.loginAs(harness.admin);
    const ok = await agent.get(url(harness.sourceA, '/node/!0000abcd'));
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ summary: null, daily: [] });
    const bad = await agent.get(url(harness.sourceA, '/node/nope'));
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_NODE_ID');
  });

  it('is gated per source like the list', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA, '/node/!0000abcd'))).status).toBe(403);
  });
});

describe('parseWindow / parseNodeKey', () => {
  it('defaults to the last 7 days ending now', () => {
    expect(parseWindow({}, 10 * 86_400_000)).toEqual({ fromMs: 3 * 86_400_000, toMs: 10 * 86_400_000 });
  });
  it('rejects inverted, negative and over-long windows', () => {
    expect(parseWindow({ from: '5', to: '5' }, 0)).toBeNull();
    expect(parseWindow({ from: '-1', to: '5' }, 0)).toBeNull();
    expect(parseWindow({ from: '0', to: String(400 * 86_400_000) }, 0)).toBeNull();
  });
  it('accepts !hex and 64-hex keys, lowercased', () => {
    expect(parseNodeKey('!DEADBEEF')).toBe('!deadbeef');
    expect(parseNodeKey('AB'.repeat(32))).toBe('ab'.repeat(32));
    expect(parseNodeKey('deadbeef')).toBeNull();
  });
});
