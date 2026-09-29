/**
 * MeshCore Ignore / Block routes (#5408) — real session + real permission
 * checks via the route harness, and per-source isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import filterRoutes from './meshcoreFilterRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { meshcoreMessageFilter } from '../services/meshcoreMessageFilter.js';

const KEY = 'ab'.repeat(32);
const base = (sourceId: string) => `/api/sources/${sourceId}/meshcore`;

describe('meshcoreFilterRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources/:id/meshcore', filterRoutes),
    });
  });

  afterEach(async () => {
    meshcoreMessageFilter.resetForTests();
    await harness.cleanup();
  });

  describe('permissions', () => {
    it('nodes:read lists ignored nodes on the granted source only', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const a = await agent.get(`${base(harness.sourceA)}/ignored-nodes`);
      expect(a.status).toBe(200);
      expect(a.body).toEqual({ success: true, data: [] });
      expect((await agent.get(`${base(harness.sourceB)}/ignored-nodes`)).status).toBe(403);
    });

    it('nodes:read alone cannot add a node', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const denied = await agent.post(`${base(harness.sourceA)}/ignored-nodes`).send({ publicKey: KEY, mode: 'ignore' });
      expect(denied.status).toBe(403);
    });

    it('nodes:write on the source allows adding, and only on that source', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const okRes = await agent.post(`${base(harness.sourceA)}/ignored-nodes`).send({ publicKey: KEY, mode: 'block', name: 'Spammer' });
      expect(okRes.status).toBe(200);
      expect(okRes.body.data).toMatchObject({ publicKey: KEY, mode: 'block', name: 'Spammer', createdBy: harness.limited.id });
      expect((await agent.post(`${base(harness.sourceB)}/ignored-nodes`).send({ publicKey: KEY, mode: 'block' })).status).toBe(403);
    });

    it('message filters need messages:read / messages:write', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.get(`${base(harness.sourceA)}/message-filters`)).status).toBe(200);
      expect((await agent.get(`${base(harness.sourceB)}/message-filters`)).status).toBe(403);
      const denied = await agent.post(`${base(harness.sourceA)}/message-filters`).send({ mode: 'ignore', matchType: 'exact', pattern: 'x' });
      expect(denied.status).toBe(403);
    });

    it('an anonymous caller cannot write', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post(`${base(harness.sourceA)}/message-filters`).send({ mode: 'ignore', matchType: 'exact', pattern: 'x' });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('behaviour (admin)', () => {
    it('ignored-node lifecycle is per source and refreshes the classifier cache', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.post(`${base(harness.sourceA)}/ignored-nodes`).send({ publicKey: KEY.toUpperCase(), mode: 'ignore', name: 'Spammer' }).expect(200);
      expect(meshcoreMessageFilter.classify(harness.sourceA, { fromPublicKey: KEY, text: 'x', kind: 'dm' }, { countHit: false }).action).toBe('ignore');

      const listA = await agent.get(`${base(harness.sourceA)}/ignored-nodes`).expect(200);
      expect(listA.body.data).toEqual([expect.objectContaining({ publicKey: KEY, mode: 'ignore' })]);
      const listB = await agent.get(`${base(harness.sourceB)}/ignored-nodes`).expect(200);
      expect(listB.body.data).toEqual([]);

      // Deleting on the other source finds nothing.
      await agent.delete(`${base(harness.sourceB)}/ignored-nodes/${KEY}`).expect(404);
      await agent.delete(`${base(harness.sourceA)}/ignored-nodes/${KEY}`).expect(200);
      expect(meshcoreMessageFilter.classify(harness.sourceA, { fromPublicKey: KEY, text: 'x', kind: 'dm' }, { countHit: false }).action).toBe('allow');
    });

    it('validates node bodies', async () => {
      const agent = await harness.loginAs(harness.admin);
      const badKey = await agent.post(`${base(harness.sourceA)}/ignored-nodes`).send({ publicKey: 'abc', mode: 'ignore' });
      expect(badKey.status).toBe(400);
      expect(badKey.body).toMatchObject({ success: false, code: 'INVALID_PUBLIC_KEY' });
      const badMode = await agent.post(`${base(harness.sourceA)}/ignored-nodes`).send({ publicKey: KEY, mode: 'mute' });
      expect(badMode.body.code).toBe('INVALID_MODE');
    });

    it('creates, updates and deletes a rule with defaults', async () => {
      const agent = await harness.loginAs(harness.admin);
      const created = await agent.post(`${base(harness.sourceA)}/message-filters`).send({ mode: 'ignore', matchType: 'wildcard', pattern: '*spam*' }).expect(200);
      const rule = created.body.data;
      expect(rule).toMatchObject({ fields: 'both', caseSensitive: false, enabled: true, hitCount: 0, sourceId: harness.sourceA });
      expect(meshcoreMessageFilter.classify(harness.sourceA, { text: 'spam here', kind: 'channel' }, { countHit: false }).action).toBe('ignore');

      await agent.put(`${base(harness.sourceB)}/message-filters/${rule.id}`).send({ enabled: false }).expect(404);
      const upd = await agent.put(`${base(harness.sourceA)}/message-filters/${rule.id}`).send({ enabled: false }).expect(200);
      expect(upd.body.data.enabled).toBe(false);
      expect(meshcoreMessageFilter.classify(harness.sourceA, { text: 'spam here', kind: 'channel' }, { countHit: false }).action).toBe('allow');

      await agent.delete(`${base(harness.sourceA)}/message-filters/${rule.id}`).expect(200);
      await agent.delete(`${base(harness.sourceA)}/message-filters/${rule.id}`).expect(404);
    });

    it('rejects patterns RE2 refuses, at save time, with a 400', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`${base(harness.sourceA)}/message-filters`).send({ mode: 'block', matchType: 'regex', pattern: '(?=x)y' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_PATTERN' });
      expect(res.body.error).toMatch(/Invalid regular expression/);

      const long = await agent.post(`${base(harness.sourceA)}/message-filters`).send({ mode: 'block', matchType: 'exact', pattern: 'x'.repeat(257) });
      expect(long.body.code).toBe('INVALID_PATTERN');

      // An update that switches an existing rule to an invalid regex is refused too.
      const created = await agent.post(`${base(harness.sourceA)}/message-filters`).send({ mode: 'ignore', matchType: 'exact', pattern: '(a)\\1' }).expect(200);
      const upd = await agent.put(`${base(harness.sourceA)}/message-filters/${created.body.data.id}`).send({ matchType: 'regex' });
      expect(upd.status).toBe(400);
      expect(upd.body.code).toBe('INVALID_PATTERN');
    });

    it('rejects bad enums on rules', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`${base(harness.sourceA)}/message-filters`).send({ mode: 'ignore', matchType: 'glob', pattern: 'x' });
      expect(res.body.code).toBe('INVALID_MATCH_TYPE');
      const fields = await agent.post(`${base(harness.sourceA)}/message-filters`).send({ mode: 'ignore', matchType: 'exact', pattern: 'x', fields: 'all' });
      expect(fields.body.code).toBe('INVALID_FIELDS');
    });
  });
});
