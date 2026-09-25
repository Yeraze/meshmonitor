/**
 * Coverage Survey per-source isolation test (#5277 Coverage Report epic,
 * Phase 4b WP2, spec §3 "coverageSurveys.perSource.test.ts").
 *
 * Two sources, a sender that only exists (and only has receptions) on
 * sourceA. A user permitted on sourceB alone must see:
 *   - no survey for that sender in `GET /surveys` (visibility gate, §2b.5) —
 *   - no rows for that sender's window from `GET /receptions` (pre-existing
 *     P1 gate, untouched by this work package — asserted here as a
 *     cross-endpoint regression guard, not because this WP changed it).
 *
 * Mounts the full `coverageRoutes` router (not just `coverageSurveyRoutes`)
 * so both endpoints are exercised through the same mount this epic ships —
 * `coverageRoutes.ts` mounts `coverageSurveyRoutes` at `/surveys` itself.
 *
 * `databaseService.coverageSurveys` doesn't exist in this worktree yet (WP1,
 * parallel worktree) — stood in with `createFakeCoverageSurveysRepo()`; see
 * that file's header. Everything else (auth, permissions, nodes,
 * coverage_receptions) is real.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import coverageRoutes from './coverageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { createFakeCoverageSurveysRepo, type FakeCoverageSurveysRepo } from '../test-helpers/fakeCoverageSurveysRepo.js';

function nodeIdFor(num: number): string {
  return `!${num.toString(16).padStart(8, '0')}`;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('Coverage surveys — per-source isolation (#5277 P4b WP2)', () => {
  let harness: RouteTestHarness;
  let fakeSurveys: FakeCoverageSurveysRepo;

  const A_RECEIVER = 0x64000001;
  const A_SENDER = 0x64000002;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', coverageRoutes) });
    fakeSurveys = createFakeCoverageSurveysRepo();
    (databaseService as unknown as { coverageSurveys: FakeCoverageSurveysRepo }).coverageSurveys = fakeSurveys;

    // limited is permitted on sourceB only — NOT sourceA, where the sender lives.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);

    await harness.db.nodes.upsertNode({
      nodeNum: A_RECEIVER, nodeId: nodeIdFor(A_RECEIVER), longName: 'A Receiver', shortName: 'AR',
      channel: 0, latitude: 5.0, longitude: 6.0, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: A_SENDER, nodeId: nodeIdFor(A_SENDER), longName: 'A Sender', shortName: 'AS',
      channel: 0, lastHeard: nowSec(),
    } as any, harness.sourceA);

    await databaseService.coverageReceptions.recordReception({
      sourceId: harness.sourceA,
      protocol: 'meshtastic',
      receiverKind: 'local',
      receiverId: nodeIdFor(A_RECEIVER),
      receiverNodeNum: A_RECEIVER,
      receiverLatitude: 5.0,
      receiverLongitude: 6.0,
      senderId: nodeIdFor(A_SENDER),
      senderNodeNum: A_SENDER,
      packetKey: 'pkt-a',
      pathKey: 'r0:h0',
      latitude: 5.5,
      longitude: 6.5,
      receivedAt: Date.now(),
    });

    await fakeSurveys.createSurvey({
      name: 'sourceA-only survey',
      senderId: nodeIdFor(A_SENDER),
      startAt: Date.now() - 3600_000,
      endAt: Date.now(),
      receivers: null,
      intervalSec: null,
      notes: null,
      createdBy: harness.admin.id, // not the limited user — visibility must gate it, not "own survey"
    });
  });

  afterEach(async () => {
    await databaseService.coverageReceptions.deleteForSource(harness.sourceA).catch(() => {});
    await harness.cleanup();
  });

  it('a user limited to sourceB sees no survey for the sourceA-only sender', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/surveys');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('the same user gets no /receptions rows for that sender/window', async () => {
    const agent = await harness.loginAs(harness.limited);
    const since = Date.now() - 3600_000;
    const until = Date.now();
    const res = await agent.get(`/receptions?sender=${encodeURIComponent(nodeIdFor(A_SENDER))}&since=${since}&until=${until}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it('an admin (or a sourceA-permitted user) sees both the survey and its receptions', async () => {
    const agent = await harness.loginAs(harness.admin);
    const surveysRes = await agent.get('/surveys');
    expect(surveysRes.body.data).toHaveLength(1);

    const since = Date.now() - 3600_000;
    const until = Date.now();
    const receptionsRes = await agent.get(
      `/receptions?sender=${encodeURIComponent(nodeIdFor(A_SENDER))}&since=${since}&until=${until}`,
    );
    expect(receptionsRes.body.data.items).toHaveLength(1);
  });
});
