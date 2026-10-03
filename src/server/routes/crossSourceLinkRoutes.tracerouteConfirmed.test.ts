/**
 * GET /api/analysis/cross-source-links/traceroute-confirmed (#5580) —
 * real-middleware harness.
 *
 * The rules under test: a source contributes only when the caller can read
 * BOTH `nodes` and `traceroute` on it; a caller with one source learns nothing
 * of another; and both endpoints must pass the map's position gates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crossSourceLinkRoutes, { CONFIRMED_LINKS_SCAN_LIMIT } from './crossSourceLinkRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { localNodeNumSettingKey } from '../utils/localNodeNums.js';
import { TX_LORA, TX_MQTT } from '../../utils/nodeTransport.js';

const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;
const nowSec = (): number => Math.floor(Date.now() / 1000);
const URL = '/traceroute-confirmed';

describe('Traceroute-confirmed link route (#5580)', () => {
  let harness: RouteTestHarness;
  const LOCAL_A = 0x6a000001;
  const REMOTE_A = 0x6a000002;
  const RELAY_A = 0x6a000003;
  const LOCAL_B = 0x6b000001;
  const REMOTE_B = 0x6b000002;

  const seedNode = (sourceId: string, nodeNum: number, name: string, lat: number, extra: Record<string, unknown> = {}) =>
    harness.db.nodes.upsertNode({
      nodeNum, nodeId: nodeIdFor(nodeNum), longName: name, shortName: name.slice(0, 4), channel: 0,
      latitude: lat, longitude: -90 - (lat - 30), lastHeard: nowSec(),
      // Node rows outlive a test (the harness DB is shared), so reset the two
      // visibility flags a previous test may have set.
      hideFromMap: false, positionOverrideIsPrivate: false,
      ...extra,
    } as any, sourceId);

  /** A completed traceroute our radio ran. Zero-hop unless route/routeBack are given. */
  const run = (sourceId: string, local: number, remote: number, o: Record<string, unknown> = {}) =>
    databaseService.traceroutes.insertTraceroute({
      fromNodeNum: remote, toNodeNum: local,
      fromNodeId: nodeIdFor(remote), toNodeId: nodeIdFor(local),
      route: '[]', routeBack: '[]', snrTowards: '[-33]', snrBack: '[-45]',
      channel: 0, transportMechanism: TX_LORA,
      timestamp: Date.now() - 60_000, createdAt: Date.now() - 60_000,
      ...o,
    } as any, sourceId);

  const grant = async (userId: number, sourceId: string, resources: string[]) => {
    for (const r of resources) {
      await harness.grant(userId, r as any, r.startsWith('channel_') ? 'viewOnMap' : 'read', sourceId);
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', crossSourceLinkRoutes) });
    await databaseService.settings.setSetting(localNodeNumSettingKey(harness.sourceA), String(LOCAL_A));
    await databaseService.settings.setSetting(localNodeNumSettingKey(harness.sourceB), String(LOCAL_B));
    await seedNode(harness.sourceA, LOCAL_A, 'Radio A', 30.1);
    await seedNode(harness.sourceA, REMOTE_A, 'Hilltop', 30.2);
    await seedNode(harness.sourceA, RELAY_A, 'Relay', 30.3);
    await seedNode(harness.sourceB, LOCAL_B, 'Radio B', 31.1);
    await seedNode(harness.sourceB, REMOTE_B, 'Valley', 31.2);
    await run(harness.sourceA, LOCAL_A, REMOTE_A);
    await run(harness.sourceB, LOCAL_B, REMOTE_B);
  });

  afterEach(async () => {
    await databaseService.traceroutes.deleteAllTraceroutes(ALL_SOURCES).catch(() => {});
    await databaseService.settings.deleteSetting(localNodeNumSettingKey(harness.sourceA)).catch(() => {});
    await databaseService.settings.deleteSetting(localNodeNumSettingKey(harness.sourceB)).catch(() => {});
    await harness.cleanup();
  });

  it('admin: returns each source\'s confirmed link with both positions, names and SNR each way', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(URL);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const links = res.body.data.links;
    expect(links).toHaveLength(2);
    expect(links.find((l: any) => l.sourceId === harness.sourceA)).toMatchObject({
      localNodeNum: LOCAL_A, localNodeId: nodeIdFor(LOCAL_A), localName: 'Radio A',
      neighborNodeNum: REMOTE_A, neighborNodeId: nodeIdFor(REMOTE_A), neighborName: 'Hilltop',
      transportClass: 'rf', count: 1, directCount: 1, snrOutAvg: -8.25, snrBackAvg: -11.25,
      from: [30.1, -90.1], to: [30.2, -90.2],
    });
    expect(res.body.data.truncated).toBe(false);
    expect(res.body.data.historyLimitPerPair).toBeGreaterThan(0);
  });

  it('groups by transport class and counts repeat runs', async () => {
    await run(harness.sourceA, LOCAL_A, REMOTE_A, { snrTowards: '[-25]', snrBack: '[-37]' });
    await run(harness.sourceA, LOCAL_A, REMOTE_A, { transportMechanism: TX_MQTT });
    const agent = await harness.loginAs(harness.admin);
    const links = (await agent.get(`${URL}?sources=${harness.sourceA}`)).body.data.links;
    expect(links).toHaveLength(2);
    expect(links.find((l: any) => l.transportClass === 'rf')).toMatchObject({ count: 2, snrOutAvg: -7.25, snrBackAvg: -10.25 });
    expect(links.find((l: any) => l.transportClass === 'mqtt')).toMatchObject({ count: 1 });
  });

  it('a relayed run confirms the link to the relay, not to the destination', async () => {
    await databaseService.traceroutes.deleteAllTraceroutes(ALL_SOURCES);
    await run(harness.sourceA, LOCAL_A, REMOTE_A, {
      route: JSON.stringify([RELAY_A]), snrTowards: '[20, 8]',
      routeBack: JSON.stringify([RELAY_A]), snrBack: '[4, 28]',
    });
    const agent = await harness.loginAs(harness.admin);
    const links = (await agent.get(URL)).body.data.links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ neighborName: 'Relay', directCount: 0, snrOutAvg: 5, snrBackAvg: 7, to: [30.3, -90.3] });
  });

  it('a run with no return path, or out and back through different neighbours, yields no line', async () => {
    await databaseService.traceroutes.deleteAllTraceroutes(ALL_SOURCES);
    await run(harness.sourceA, LOCAL_A, REMOTE_A, { routeBack: '[]', snrBack: '[]' });
    await run(harness.sourceA, LOCAL_A, REMOTE_A, { route: JSON.stringify([RELAY_A]), snrTowards: '[4, 8]' });
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.get(URL)).body.data.links).toEqual([]);
  });

  it('needs BOTH permissions: nodes:read alone gets nothing', async () => {
    await grant(harness.limited.id, harness.sourceA, ['nodes', 'channel_0']);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(URL);
    expect(res.status).toBe(200);
    expect(res.body.data.links).toEqual([]);
  });

  it('needs BOTH permissions: traceroute:read alone gets nothing', async () => {
    await grant(harness.limited.id, harness.sourceA, ['traceroute', 'channel_0']);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(URL)).body.data.links).toEqual([]);
  });

  it('with both permissions on one source: that source\'s link, and no trace of the other', async () => {
    await grant(harness.limited.id, harness.sourceA, ['nodes', 'traceroute', 'channel_0']);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(URL);
    expect(res.body.data.links).toHaveLength(1);
    expect(res.body.data.links[0]).toMatchObject({ sourceId: harness.sourceA, neighborName: 'Hilltop' });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(harness.sourceB);
    expect(body).not.toContain('Valley');
    expect(body).not.toContain('Radio B');
    // Asking for the other source by name does not help.
    expect((await agent.get(`${URL}?sources=${harness.sourceB}`)).body.data.links).toEqual([]);
  });

  it('split permissions across sources (nodes on A, traceroute on B) get nothing', async () => {
    await grant(harness.limited.id, harness.sourceA, ['nodes', 'channel_0']);
    await grant(harness.limited.id, harness.sourceB, ['traceroute', 'channel_0']);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(URL)).body.data.links).toEqual([]);
  });

  it('anonymous with no grants gets nothing', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get(URL);
    expect(res.status).toBe(200);
    expect(res.body.data.links).toEqual([]);
  });

  it('a position the user may not see yields no line', async () => {
    // Both read permissions, but no channel viewOnMap: every position is hidden.
    await grant(harness.limited.id, harness.sourceA, ['nodes', 'traceroute']);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(URL)).body.data.links).toEqual([]);
  });

  it('a node hidden from the map yields no line, even for an admin', async () => {
    await seedNode(harness.sourceA, REMOTE_A, 'Hilltop', 30.2, { hideFromMap: true });
    const agent = await harness.loginAs(harness.admin);
    const links = (await agent.get(URL)).body.data.links;
    expect(links.map((l: any) => l.sourceId)).toEqual([harness.sourceB]);
  });

  it('a private position override yields no line without nodes_private:read', async () => {
    await seedNode(harness.sourceA, REMOTE_A, 'Hilltop', 30.2, { positionOverrideIsPrivate: true });
    await grant(harness.limited.id, harness.sourceA, ['nodes', 'traceroute', 'channel_0']);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(URL)).body.data.links).toEqual([]);
  });

  it('an endpoint with no position yields no line', async () => {
    await databaseService.traceroutes.deleteAllTraceroutes(ALL_SOURCES);
    const NOPOS = 0x6a0000ff;
    await harness.db.nodes.upsertNode({
      nodeNum: NOPOS, nodeId: nodeIdFor(NOPOS), longName: 'Nowhere', shortName: 'N', channel: 0, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await run(harness.sourceA, LOCAL_A, NOPOS);
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.get(URL)).body.data.links).toEqual([]);
  });

  it('a source with no local radio contributes nothing', async () => {
    await databaseService.settings.setSetting(localNodeNumSettingKey(harness.sourceA), '');
    const agent = await harness.loginAs(harness.admin);
    const links = (await agent.get(URL)).body.data.links;
    expect(links.map((l: any) => l.sourceId)).toEqual([harness.sourceB]);
  });

  it('honours since and rejects junk', async () => {
    const agent = await harness.loginAs(harness.admin);
    expect((await agent.get(`${URL}?since=${Date.now() + 3_600_000}`)).body.data.links).toEqual([]);
    expect((await agent.get(`${URL}?since=1`)).body.data.links).toHaveLength(2);
    const bad = await agent.get(`${URL}?since=abc`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_TIME_RANGE');
  });

  it('reports truncated when the window holds more rows than the scan cap', async () => {
    const one = {
      id: 1, sourceId: harness.sourceA, fromNodeNum: REMOTE_A, toNodeNum: LOCAL_A,
      fromNodeId: nodeIdFor(REMOTE_A), toNodeId: nodeIdFor(LOCAL_A),
      route: '[]', routeBack: '[]', snrTowards: '[-33]', snrBack: '[-45]',
      channel: 0, transportMechanism: TX_LORA, timestamp: Date.now() - 1000, createdAt: Date.now() - 1000,
    };
    const spy = vi.spyOn(databaseService.traceroutes, 'getTraceroutesForSources')
      .mockResolvedValue(Array.from({ length: CONFIRMED_LINKS_SCAN_LIMIT + 1 }, () => one) as any);
    try {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(URL);
      // It asks for one row past the cap, to tell "at the cap" from "over it".
      expect(spy.mock.calls[0][0]).toMatchObject({ limit: CONFIRMED_LINKS_SCAN_LIMIT + 1 });
      expect(res.body.data.truncated).toBe(true);
      // The extra row is dropped, not counted.
      expect(res.body.data.links).toHaveLength(1);
      expect(res.body.data.links[0].count).toBe(CONFIRMED_LINKS_SCAN_LIMIT);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not disturb the sibling route', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('retentionDays');
  });
});
