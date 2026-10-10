/**
 * MeshCore hop SNR read route (#5722) on the real route harness: gated by the
 * per-source `traceroute:read` grant; another source's grant does not help.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import traceRoutes from './meshcoreTraceRoutes.js';
import type { MeshCoreHopSnrRow } from '../../db/repositories/meshcoreHopSnr.js';

const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);

const row = (sourceId: string, over: Partial<MeshCoreHopSnrRow> = {}): MeshCoreHopSnrRow => ({
  sourceId, traceTag: 1, authCode: 0, hopIndex: 0, hopCount: 2, hashBytes: 1,
  senderPublicKey: K1, senderHash: 'aa', senderCandidates: 1,
  receiverPublicKey: K2, receiverHash: 'bb', receiverCandidates: 1,
  snrQuarterDb: 20, initiated: false, timestamp: Date.now() - 60_000, ...over,
});

describe('MeshCore hop SNR route (#5722)', () => {
  let harness: RouteTestHarness;
  const url = (sourceId: string, q = '') => `/api/sources/${sourceId}/meshcore/hop-snr${q}`;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app: express.Express) => app.use('/api/sources/:id/meshcore', traceRoutes),
    });
    await harness.db.meshcoreHopSnr.insertHops(harness.sourceA, [
      row(harness.sourceA),
      row(harness.sourceA, { snrQuarterDb: -8, timestamp: Date.now() - 30_000 }),
      row(harness.sourceA, { senderPublicKey: K2, senderHash: 'bb', receiverPublicKey: K1, receiverHash: 'aa', snrQuarterDb: 4 }),
    ]);
    await harness.db.meshcoreHopSnr.insertHops(harness.sourceB, [row(harness.sourceB, { snrQuarterDb: 100 })]);
  });

  afterEach(async () => {
    await harness.db.meshcoreHopSnr.deleteBySourceId(harness.sourceA);
    await harness.db.meshcoreHopSnr.deleteBySourceId(harness.sourceB);
    await harness.cleanup();
  });

  it('needs traceroute:read on THIS source', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    expect((await agent.get(url(harness.sourceA))).status).toBe(403);
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    const res = await agent.get(url(harness.sourceA));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Two directional links on source A; source B's row never leaks in.
    expect(res.body.data.links).toHaveLength(2);
    expect(res.body.data.links.some((l: { maxSnr: number }) => l.maxSnr === 25)).toBe(false);
  });

  it('returns directional links with stats and points', async () => {
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.get(url(harness.sourceA, `?publicKey=${K1}`));
    const k1HeardByK2 = res.body.data.links.find((l: { sender: { publicKey: string } }) => l.sender.publicKey === K1);
    expect(k1HeardByK2).toMatchObject({
      receiver: { publicKey: K2, candidates: 1 }, count: 2, lastSnr: -2, minSnr: -2, maxSnr: 5, avgSnr: 1.5,
    });
    expect(k1HeardByK2.points).toHaveLength(2);
    const reverse = res.body.data.links.find((l: { sender: { publicKey: string } }) => l.sender.publicKey === K2);
    expect(reverse).toMatchObject({ receiver: { publicKey: K1 }, count: 1, lastSnr: 1 });
  });

  it('validates publicKey and hours', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect((await admin.get(url(harness.sourceA, '?publicKey=zz'))).body.code).toBe('INVALID_PUBLIC_KEY');
    expect((await admin.get(url(harness.sourceA, '?hours=0'))).body.code).toBe('INVALID_HOURS');
    expect((await admin.get(url(harness.sourceA, '?hours=99999'))).body.code).toBe('INVALID_HOURS');
    expect((await admin.get(url(harness.sourceA, '?hours=1'))).status).toBe(200);
  });

  it('anonymous follows the anonymous account grants', async () => {
    await harness.revokeAll(harness.anonymous.id);
    const anon = await harness.loginAs(null);
    expect((await anon.get(url(harness.sourceA))).status).toBe(403);
    await harness.grant(harness.anonymous.id, 'traceroute', 'read', harness.sourceA);
    expect((await anon.get(url(harness.sourceA))).status).toBe(200);
  });
});
