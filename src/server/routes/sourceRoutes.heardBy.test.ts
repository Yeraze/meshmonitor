/**
 * GET /api/sources/:id/messages/:messageId/heard-by (Delivery Diagnostics
 * epic #4816, Phase 4 WP3) — real-SQL harness coverage.
 *
 * Verifies: permission gate (allowed source 200, other source 403), the
 * server-side candidate resolution (relay byte -> node whose
 * `nodeNum & 0xFF` matches), and the honest empty-array response for a
 * message with no recorded heard-by rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('sourceRoutes — GET /:id/messages/:messageId/heard-by', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    // No grant on sourceB.

    // Seed a node on sourceA whose last byte matches relayByte 0xAB (171).
    await harness.db.nodes.upsertNode(
      {
        nodeNum: 0x11AB, // 4523; & 0xFF === 0xAB
        nodeId: '!000011ab',
        longName: 'Repeater One',
        shortName: 'RP1',
        lastHeard: Math.floor(Date.now() / 1000),
      },
      harness.sourceA,
    );

    // Seed two heard-by rows for message 'msg-1' on sourceA.
    await harness.db.meshtasticHeardRepeaters.recordHeardRepeater({
      sourceId: harness.sourceA,
      messageId: 'msg-1',
      relayByte: 0xab,
      snr: 4.5,
      heardAt: 1000,
    });
    await harness.db.meshtasticHeardRepeaters.recordHeardRepeater({
      sourceId: harness.sourceA,
      messageId: 'msg-1',
      relayByte: 0xcd,
      snr: -2.25,
      heardAt: 2000,
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('200 with resolved candidates for an allowed source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/messages/msg-1/heard-by`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const heardBy = res.body.data.heardBy;
    expect(heardBy).toHaveLength(2);

    const matched = heardBy.find((r: { relayByte: number }) => r.relayByte === 0xab);
    expect(matched.relayByteHex).toBe('0xAB');
    expect(matched.snr).toBe(4.5);
    expect(matched.candidates).toHaveLength(1);
    expect(matched.candidates[0]).toMatchObject({ nodeNum: 0x11AB, longName: 'Repeater One', shortName: 'RP1' });

    const unmatched = heardBy.find((r: { relayByte: number }) => r.relayByte === 0xcd);
    expect(unmatched.candidates).toHaveLength(0);
  });

  it('403 for a source the user has no grant on', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceB}/messages/msg-1/heard-by`);
    expect(res.status).toBe(403);
  });

  it('200 with an empty array for a message with no recorded rows', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/messages/no-such-message/heard-by`);
    expect(res.status).toBe(200);
    expect(res.body.data.heardBy).toEqual([]);
  });

  it('admin sees rows without an explicit grant (admin bypass)', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/${harness.sourceA}/messages/msg-1/heard-by`);
    expect(res.status).toBe(200);
    expect(res.body.data.heardBy).toHaveLength(2);
  });
});
