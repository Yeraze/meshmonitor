/**
 * Grouped / receptions packet-monitor routes (#5040 Phase 2b).
 *
 * Uses `createRouteTestApp()` per CLAUDE.md, so `requirePermission` runs for
 * real against seeded permission rows rather than a hand-rolled lambda.
 *
 * The behaviour most worth pinning is the one a UI can silently get wrong:
 * `observerCount === 0` means "our own radio heard it", because
 * COUNT(DISTINCT) skips the NULL observerId a local reception carries. If that
 * ever started meaning "no observers", the monitor would report every locally
 * heard packet as unheard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcorePacketRoutes from './meshcorePacketRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
  },
}));

const FRAME_A = '0500deadbeef';
const FRAME_B = '0500cafebabe';
const OBS_1 = 'AA'.repeat(32);
const OBS_2 = 'BB'.repeat(32);

async function insert(sourceId: string, over: Record<string, unknown> = {}) {
  const now = Date.now();
  await databaseService.meshcore.insertPacket({
    sourceId,
    timestamp: now,
    payloadType: 2,
    payloadTypeName: 'TXT_MSG',
    routeType: 1,
    routeTypeName: 'FLOOD',
    hopCount: 0,
    snr: 1,
    rssi: -100,
    payloadSize: 12,
    rawHex: FRAME_A,
    createdAt: now,
    ...over,
  } as never);
}

describe('MeshCore packet monitor — grouped routes (#5040 Phase 2b)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/:id/meshcore', meshcorePacketRoutes),
    });
    await databaseService.settings.setSetting('meshcore_packet_log_enabled', '1');
    // Rows created through the harness persist for the life of its DB, so a
    // later test would otherwise see the previous test's packets and read as a
    // grouping bug rather than a fixture leak. (Same trap as the Phase 1
    // duplicate-source tests.)
    await databaseService.meshcore.deleteAllPackets();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('collapses per-observer receptions into one grouped row', async () => {
    await insert(harness.sourceA, { observerId: OBS_1, snr: -8 });
    await insert(harness.sourceA, { observerId: OBS_2, snr: 2.5 });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/meshcore/packets/grouped`);

    expect(res.status).toBe(200);
    expect(res.body.packets).toHaveLength(1);
    expect(Number(res.body.packets[0].observerCount)).toBe(2);
    expect(Number(res.body.packets[0].receptionCount)).toBe(2);
    expect(Number(res.body.packets[0].bestSnr)).toBe(2.5);
  });

  it('reports observerCount 0 for a locally-heard frame — "local", not "nobody"', async () => {
    await insert(harness.sourceA, { observerId: null });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/meshcore/packets/grouped`);

    expect(Number(res.body.packets[0].observerCount)).toBe(0);
    expect(Number(res.body.packets[0].receptionCount)).toBe(1);
  });

  it('counts GROUPS in total, not rows', async () => {
    await insert(harness.sourceA, { observerId: OBS_1, rawHex: FRAME_A });
    await insert(harness.sourceA, { observerId: OBS_2, rawHex: FRAME_A });
    await insert(harness.sourceA, { observerId: OBS_1, rawHex: FRAME_B });

    const agent = await harness.loginAs(harness.admin);
    const grouped = await agent.get(`/${harness.sourceA}/meshcore/packets/grouped`);
    const flat = await agent.get(`/${harness.sourceA}/meshcore/packets`);

    expect(Number(grouped.body.total)).toBe(2);
    // The flat view still shows every reception — the collapse is a read mode,
    // not a change to what is stored.
    expect(Number(flat.body.total)).toBe(3);
  });

  it('never groups across sources', async () => {
    await insert(harness.sourceA, { observerId: OBS_1 });
    await insert(harness.sourceB, { observerId: OBS_1 });

    const agent = await harness.loginAs(harness.admin);
    const a = await agent.get(`/${harness.sourceA}/meshcore/packets/grouped`);
    expect(a.body.packets).toHaveLength(1);
  });

  it('expands a group into its per-observer receptions, oldest-first', async () => {
    await insert(harness.sourceA, { observerId: OBS_1, timestamp: 2000 });
    await insert(harness.sourceA, { observerId: OBS_2, timestamp: 1000 });
    await insert(harness.sourceA, { observerId: OBS_1, rawHex: FRAME_B });

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(
      `/${harness.sourceA}/meshcore/packets/receptions?raw_hex=${FRAME_A}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.receptions).toHaveLength(2);
    expect(res.body.receptions.map((r: { observerId: string }) => r.observerId)).toEqual([OBS_2, OBS_1]);
  });

  it('rejects a receptions call with no raw_hex', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/meshcore/packets/receptions`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/raw_hex/i);
  });

  it('enforces per-source packetmonitor:read on both routes', async () => {
    await harness.grant(harness.limited.id, 'packetmonitor', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    expect((await agent.get(`/${harness.sourceA}/meshcore/packets/grouped`)).status).toBe(200);
    expect((await agent.get(`/${harness.sourceB}/meshcore/packets/grouped`)).status).toBe(403);
    expect(
      (await agent.get(`/${harness.sourceB}/meshcore/packets/receptions?raw_hex=${FRAME_A}`)).status,
    ).toBe(403);
  });
});
