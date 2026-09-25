/**
 * Coverage Report saved-survey API tests (#5277 Coverage Report epic, Phase
 * 4b WP2).
 *
 * Uses the real-middleware harness (`createRouteTestApp`) for
 * session/auth/permissions and the real `nodes` / `meshcore` tables — same
 * template as `coverageRoutes.test.ts` / `sourceRoutes.permissions.test.ts`.
 * `databaseService.coverageSurveys` does not exist in this worktree yet
 * (WP1, built in a separate worktree in parallel), so it is stood in with
 * `createFakeCoverageSurveysRepo()` (`../test-helpers/fakeCoverageSurveysRepo.js`)
 * assigned directly onto the live singleton — see that file's header for the
 * WP1 hand-off note. Everything else in this test (auth, sessions,
 * permissions, node visibility) is real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import coverageSurveyRoutes from './coverageSurveyRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { createFakeCoverageSurveysRepo, type FakeCoverageSurveysRepo } from '../test-helpers/fakeCoverageSurveysRepo.js';
import {
  COVERAGE_SURVEY_MAX_RANGE_MS, COVERAGE_SURVEY_MAX_PER_USER, COVERAGE_SURVEY_MAX_TOTAL,
} from '../../utils/coverage.js';

function nodeIdFor(num: number): string {
  return `!${num.toString(16).padStart(8, '0')}`;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('Coverage Survey Routes (#5277 P4b WP2)', () => {
  let harness: RouteTestHarness;
  let fakeSurveys: FakeCoverageSurveysRepo;
  let otherUserCounter = 0;

  const SENDER = 0x63000001;
  const SENDER_HIDDEN = 0x63000002; // channel 1 — limited user has no grant there
  const MC_SENDER = 'a1'.repeat(32); // 64-hex MeshCore pubkey

  async function createOtherUser(): Promise<number> {
    otherUserCounter += 1;
    return harness.db.auth.createUser({
      username: `rt-cvsv-other-${Date.now()}-${otherUserCounter}`,
      passwordHash: null,
      authMethod: 'local',
      isAdmin: false,
      isActive: true,
      createdAt: Date.now(),
    });
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', coverageSurveyRoutes) });
    fakeSurveys = createFakeCoverageSurveysRepo();
    // WP1 dependency stand-in (see file header) — `coverageSurveys` isn't a
    // typed property of DatabaseService in this worktree yet.
    (databaseService as unknown as { coverageSurveys: FakeCoverageSurveysRepo }).coverageSurveys = fakeSurveys;

    // One `permissions` row per (userId, resource, sourceId) — canRead and
    // canViewOnMap live on the SAME row, so granting both in one call (rather
    // than two `harness.grant()` calls for the same resource) avoids a
    // unique-constraint conflict. `nodes:read` gates `resolvePermittedSourceIds`
    // (Meshtastic AND MeshCore); `nodes:viewOnMap` additionally gates
    // `buildMeshCorePositionFilter`'s per-source MeshCore check.
    await harness.db.auth.createPermission({
      userId: harness.limited.id, resource: 'nodes', sourceId: harness.sourceA,
      canRead: true, canViewOnMap: true, grantedAt: Date.now(), grantedBy: null,
    });
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);

    await harness.db.nodes.upsertNode({
      nodeNum: SENDER, nodeId: nodeIdFor(SENDER), longName: 'Sender', shortName: 'SN',
      channel: 0, lastHeard: nowSec(),
    } as any, harness.sourceA);
    await harness.db.nodes.upsertNode({
      nodeNum: SENDER_HIDDEN, nodeId: nodeIdFor(SENDER_HIDDEN), longName: 'Hidden Sender', shortName: 'HS',
      channel: 1, lastHeard: nowSec(),
    } as any, harness.sourceA);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  // ── GET / (list) ─────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('anonymous gets an empty list', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('own survey is visible to its creator even when the sender is not', async () => {
      const otherUserId = await createOtherUser();
      const created = await fakeSurveys.createSurvey({
        name: 'Hidden sender survey', senderId: nodeIdFor(SENDER_HIDDEN),
        startAt: Date.now() - 60_000, endAt: Date.now(), receivers: null, intervalSec: null, notes: null,
        createdBy: otherUserId,
      });

      const agent = await harness.loginAs(otherUserId);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      expect(res.body.data.map((s: any) => s.id)).toContain(created.id);
      expect(res.body.data[0].createdByMe).toBe(true);
      expect(res.body.data[0].canEdit).toBe(true);
    });

    it('a non-creator without visibility into the sender does not see the survey', async () => {
      const otherUserId = await createOtherUser();
      await fakeSurveys.createSurvey({
        name: 'Hidden sender survey', senderId: nodeIdFor(SENDER_HIDDEN),
        startAt: Date.now() - 60_000, endAt: Date.now(), receivers: null, intervalSec: null, notes: null,
        createdBy: otherUserId,
      });

      // limited has no channel_1 grant, so SENDER_HIDDEN is not visible to it.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('a non-creator WITH visibility into the sender sees the survey (but cannot edit)', async () => {
      const otherUserId = await createOtherUser();
      const created = await fakeSurveys.createSurvey({
        name: 'Visible sender survey', senderId: nodeIdFor(SENDER),
        startAt: Date.now() - 60_000, endAt: Date.now(), receivers: null, intervalSec: null, notes: null,
        createdBy: otherUserId,
      });

      // limited has nodes:read + channel_0:viewOnMap on sourceA, and SENDER is channel 0.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      const dto = res.body.data.find((s: any) => s.id === created.id);
      expect(dto).toBeDefined();
      expect(dto.createdByMe).toBe(false);
      expect(dto.canEdit).toBe(false);
    });

    it('admin sees every survey, including ones for invisible/nonexistent senders', async () => {
      await fakeSurveys.createSurvey({
        name: 'Ghost sender', senderId: MC_SENDER, // no meshcore_nodes row at all
        startAt: Date.now() - 60_000, endAt: Date.now(), receivers: null, intervalSec: null, notes: null,
        createdBy: null,
      });

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('never exposes the raw createdBy user id', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'S', senderId: nodeIdFor(SENDER),
        startAt: Date.now() - 60_000, endAt: Date.now(), receivers: null, intervalSec: null, notes: null,
        createdBy: harness.limited.id,
      });
      void created;

      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/');
      expect(res.body.data[0]).not.toHaveProperty('createdBy');
    });
  });

  // ── POST / (create) ──────────────────────────────────────────────────────

  describe('POST /', () => {
    it('anonymous → 401', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/').send({ name: 'X', senderId: nodeIdFor(SENDER), live: true });
      expect(res.status).toBe(401);
    });

    it('a logged-in user who can see the sender creates a live survey', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'My Survey', senderId: nodeIdFor(SENDER), live: true });
      expect(res.status).toBe(200);
      expect(res.body.data.senderId).toBe(nodeIdFor(SENDER));
      expect(res.body.data.endAt).toBeNull();
      expect(res.body.data.isLive).toBe(true);
      expect(res.body.data.createdByMe).toBe(true);
      expect(res.body.data.canEdit).toBe(true);
    });

    it('SENDER_NOT_VISIBLE for a non-admin who cannot see the sender', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'X', senderId: nodeIdFor(SENDER_HIDDEN), live: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SENDER_NOT_VISIBLE');
    });

    it('MeshCore sender with no meshcore_nodes row is invisible even to a non-admin creator', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'MC', senderId: MC_SENDER, live: true });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SENDER_NOT_VISIBLE');
    });

    it('MeshCore sender becomes visible once it has a meshcore_nodes row (nodes:viewOnMap already granted)', async () => {
      await harness.db.meshcore.upsertNode({ publicKey: MC_SENDER, name: 'MC Node' }, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'MC', senderId: MC_SENDER, live: true });
      expect(res.status).toBe(200);
      expect(res.body.data.senderId).toBe(MC_SENDER);
    });

    it('admin can create a survey for a MeshCore sender with no meshcore_nodes row', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/').send({ name: 'Ghost', senderId: MC_SENDER, live: true });
      expect(res.status).toBe(200);
    });

    it('SURVEY_ALREADY_LIVE when the sender already has a live survey', async () => {
      const agent = await harness.loginAs(harness.limited);
      const first = await agent.post('/').send({ name: 'First', senderId: nodeIdFor(SENDER), live: true });
      expect(first.status).toBe(200);

      const second = await agent.post('/').send({ name: 'Second', senderId: nodeIdFor(SENDER), live: true });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('SURVEY_ALREADY_LIVE');
    });

    it('a second SAVED (non-live) survey for the same sender is allowed', async () => {
      const agent = await harness.loginAs(harness.limited);
      const now = Date.now();
      const first = await agent.post('/').send({
        name: 'First', senderId: nodeIdFor(SENDER), startAt: now - 120_000, endAt: now - 60_000,
      });
      expect(first.status).toBe(200);
      const second = await agent.post('/').send({
        name: 'Second', senderId: nodeIdFor(SENDER), startAt: now - 60_000, endAt: now,
      });
      expect(second.status).toBe(200);
    });

    it('SURVEY_LIMIT_REACHED when the per-user cap is hit', async () => {
      vi.spyOn(fakeSurveys, 'countSurveysByUser').mockResolvedValue(COVERAGE_SURVEY_MAX_PER_USER);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'Over cap', senderId: nodeIdFor(SENDER), live: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SURVEY_LIMIT_REACHED');
    });

    it('SURVEY_LIMIT_REACHED when the total cap is hit', async () => {
      vi.spyOn(fakeSurveys, 'countSurveys').mockResolvedValue(COVERAGE_SURVEY_MAX_TOTAL);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'Over cap', senderId: nodeIdFor(SENDER), live: true });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SURVEY_LIMIT_REACHED');
    });

    it('INVALID_SURVEY when neither live nor a startAt/endAt pair is given', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'X', senderId: nodeIdFor(SENDER) });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SURVEY');
    });

    it('INVALID_SURVEY when endAt is before startAt', async () => {
      const agent = await harness.loginAs(harness.limited);
      const now = Date.now();
      const res = await agent.post('/').send({ name: 'X', senderId: nodeIdFor(SENDER), startAt: now, endAt: now - 1000 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SURVEY');
    });

    it('INVALID_SURVEY when endAt is in the future', async () => {
      const agent = await harness.loginAs(harness.limited);
      const now = Date.now();
      const res = await agent.post('/').send({ name: 'X', senderId: nodeIdFor(SENDER), startAt: now, endAt: now + 3600_000 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SURVEY');
    });

    it('INVALID_SURVEY when the range exceeds COVERAGE_SURVEY_MAX_RANGE_MS', async () => {
      const agent = await harness.loginAs(harness.limited);
      const now = Date.now();
      const startAt = now - (COVERAGE_SURVEY_MAX_RANGE_MS + 3600_000);
      const res = await agent.post('/').send({ name: 'X', senderId: nodeIdFor(SENDER), startAt, endAt: now });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SURVEY');
    });

    it('INVALID_SURVEY for an empty or over-length name', async () => {
      const agent = await harness.loginAs(harness.limited);
      const tooLong = 'x'.repeat(121);
      const res1 = await agent.post('/').send({ name: '', senderId: nodeIdFor(SENDER), live: true });
      expect(res1.status).toBe(400);
      const res2 = await agent.post('/').send({ name: tooLong, senderId: nodeIdFor(SENDER), live: true });
      expect(res2.status).toBe(400);
    });

    it('INVALID_SURVEY for senderId that does not parse', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'X', senderId: 'not-a-sender', live: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SURVEY');
    });

    it('INVALID_RECEIVERS for a malformed receivers wire string', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({
        name: 'X', senderId: nodeIdFor(SENDER), live: true, receivers: 'not;;valid::garbage',
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_RECEIVERS');
    });

    it('a well-formed receivers string is stored verbatim', async () => {
      const agent = await harness.loginAs(harness.limited);
      const wire = `${harness.sourceA}:+${nodeIdFor(SENDER)}`;
      const res = await agent.post('/').send({ name: 'X', senderId: nodeIdFor(SENDER), live: true, receivers: wire });
      expect(res.status).toBe(200);
      expect(res.body.data.receivers).toBe(wire);
    });

    it('INVALID_SURVEY for intervalSec out of [15, 3600]', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({ name: 'X', senderId: nodeIdFor(SENDER), live: true, intervalSec: 5 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SURVEY');
    });

    it('INVALID_SURVEY for notes over 2000 characters', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/').send({
        name: 'X', senderId: nodeIdFor(SENDER), live: true, notes: 'x'.repeat(2001),
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SURVEY');
    });
  });

  // ── PATCH /:id ────────────────────────────────────────────────────────────

  describe('PATCH /:id', () => {
    it('SURVEY_NOT_FOUND for an unknown id', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.patch('/does-not-exist').send({ name: 'New name' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SURVEY_NOT_FOUND');
    });

    it('creator can edit name/notes/intervalSec/receivers', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'Old', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.patch(`/${created.id}`).send({ name: 'New name', notes: 'note', intervalSec: 30 });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('New name');
      expect(res.body.data.notes).toBe('note');
      expect(res.body.data.intervalSec).toBe(30);
    });

    it('a non-creator, non-admin gets FORBIDDEN', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'Old', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const otherUserId = await createOtherUser();
      const agent = await harness.loginAs(otherUserId);
      const res = await agent.patch(`/${created.id}`).send({ name: 'Hijacked' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('admin can edit any survey', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'Old', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.patch(`/${created.id}`).send({ name: 'Admin edit' });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Admin edit');
    });

    it('cannot rename to an empty or over-length name', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'Old', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.patch(`/${created.id}`).send({ name: '' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SURVEY');
    });
  });

  // ── POST /:id/stop ────────────────────────────────────────────────────────

  describe('POST /:id/stop', () => {
    it('creator can stop a live survey', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'Live', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(`/${created.id}/stop`).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.isLive).toBe(false);
      expect(res.body.data.endAt).not.toBeNull();
    });

    it('SURVEY_NOT_LIVE for an already-stopped survey', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'Stopped', senderId: nodeIdFor(SENDER), startAt: Date.now() - 2000, endAt: Date.now() - 1000,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(`/${created.id}/stop`).send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SURVEY_NOT_LIVE');
    });

    it('a non-creator, non-admin gets FORBIDDEN', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'Live', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const otherUserId = await createOtherUser();
      const agent = await harness.loginAs(otherUserId);
      const res = await agent.post(`/${created.id}/stop`).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('SURVEY_NOT_FOUND for an unknown id', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/does-not-exist/stop').send({});
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SURVEY_NOT_FOUND');
    });
  });

  // ── DELETE /:id ───────────────────────────────────────────────────────────

  describe('DELETE /:id', () => {
    it('creator can delete their survey', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'To delete', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/${created.id}`);
      expect(res.status).toBe(200);
      expect(await fakeSurveys.getSurvey(created.id)).toBeNull();
    });

    it('a non-creator, non-admin gets FORBIDDEN and the row survives', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'To delete', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const otherUserId = await createOtherUser();
      const agent = await harness.loginAs(otherUserId);
      const res = await agent.delete(`/${created.id}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(await fakeSurveys.getSurvey(created.id)).not.toBeNull();
    });

    it('admin can delete any survey', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'To delete', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete(`/${created.id}`);
      expect(res.status).toBe(200);
      expect(await fakeSurveys.getSurvey(created.id)).toBeNull();
    });

    it('SURVEY_NOT_FOUND for an unknown id', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete('/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SURVEY_NOT_FOUND');
    });

    it('anonymous → 401', async () => {
      const created = await fakeSurveys.createSurvey({
        name: 'To delete', senderId: nodeIdFor(SENDER), startAt: Date.now() - 1000, endAt: null,
        receivers: null, intervalSec: null, notes: null, createdBy: harness.limited.id,
      });
      const agent = await harness.loginAs(null);
      const res = await agent.delete(`/${created.id}`);
      expect(res.status).toBe(401);
    });
  });
});
