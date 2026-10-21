/**
 * MeshCore Auto-Responder save route, trigger syntax (#5924) — real session +
 * real permission checks via the route harness. Each trigger is validated in
 * its own syntax (missing = regex); emoji is accepted, control characters and
 * unknown syntax values are not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import automationRoutes from './meshcoreAutomationRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

const KEY = 'meshcoreAutoResponderTriggers';
const url = (sourceId: string) => `/api/sources/${sourceId}/meshcore/automation/responder`;

const trigger = (over: Record<string, unknown>) => ({
  id: 't1', name: 'T', enabled: true, pattern: 'ping', response: 'pong',
  channels: [], listenDMs: true, replyAsDM: false, cooldownSeconds: 60, ...over,
});

describe('meshcoreAutomationRoutes — auto-responder syntax (#5924)', () => {
  let harness: RouteTestHarness;
  const resetCache = vi.fn();

  beforeEach(async () => {
    resetCache.mockClear();
    harness = await createRouteTestApp({
      // The router-level guard (not mounted here) puts the source's manager in
      // res.locals; the save handler clears its compiled-trigger cache.
      mount: (app) => app.use(
        '/api/sources/:id/meshcore',
        (_req, res, next) => { res.locals.meshcoreManager = { resetAutoResponderRegexCache: resetCache }; next(); },
        automationRoutes,
      ),
    });
    await databaseService.auth.createPermission({
      userId: harness.limited.id,
      resource: 'automation',
      canRead: true,
      canWrite: true,
      canViewOnMap: false,
      sourceId: harness.sourceA,
      grantedAt: Date.now(),
      grantedBy: null,
    });
  });

  afterEach(async () => {
    await databaseService.settings.deleteSourceSettings(harness.sourceA);
    await databaseService.settings.deleteSourceSettings(harness.sourceB);
    await harness.cleanup();
  });

  const post = async (triggers: unknown[]) => {
    const agent = await harness.loginAs(harness.limited);
    return agent.post(url(harness.sourceA)).send({ triggers });
  };

  it('saves and reads back both modes, emoji included', async () => {
    const triggers = [
      trigger({ id: 'legacy', pattern: '!(signal|chat)\\b' }),
      trigger({ id: 'rx', syntax: 'regex', pattern: '👋\\s*hi' }),
      trigger({ id: 'dsl', syntax: 'pattern', pattern: 'weather {city}, 🔋 {level:\\d+}' }),
    ];
    const res = await post(triggers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(resetCache).toHaveBeenCalledTimes(1);

    const agent = await harness.loginAs(harness.limited);
    const read = await agent.get(url(harness.sourceA));
    expect(read.body.data.triggers).toEqual(triggers);
    expect(JSON.parse((await databaseService.settings.getSettingForSource(harness.sourceA, KEY))!)).toEqual(triggers);
  });

  it.each([
    ['a control character (legacy regex)', trigger({ pattern: 'ping\u0007' }), /Invalid regex .*disallowed characters/],
    ['a control character (pattern mode)', trigger({ syntax: 'pattern', pattern: 'ping\u0001' }), /Invalid pattern .*disallowed characters/],
    ['a ReDoS shape (regex mode)', trigger({ syntax: 'regex', pattern: '(a+)+' }), /catastrophic/],
    ['an over-long pattern', trigger({ syntax: 'regex', pattern: 'a'.repeat(101) }), /too long/],
    ['a param regex that does not compile', trigger({ syntax: 'pattern', pattern: 'zip {z:(}' }), /invalid regex/],
    ['an unknown syntax value', trigger({ syntax: 'glob' }), /must be "pattern" or "regex"/],
  ])('rejects %s and stores nothing', async (_label, tr, msg) => {
    const res = await post([tr]);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('INVALID_REGEX');
    expect(res.body.error).toMatch(msg);
    expect(await databaseService.settings.getSettingForSource(harness.sourceA, KEY)).toBeNull();
  });

  it('a DSL pattern is checked as a DSL, not as a regex', async () => {
    // In the DSL `{2,}` is a placeholder; in a regex `a{2,}` is an unbounded
    // repeat, which the ReDoS shape check refuses.
    expect((await post([trigger({ syntax: 'pattern', pattern: 'say a{2,}' })])).status).toBe(200);
    expect((await post([trigger({ syntax: 'regex', pattern: 'say a{2,}' })])).status).toBe(400);
  });

  it('needs write permission on the source', async () => {
    await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceB)).send({ triggers: [trigger({ syntax: 'pattern' })] });
    expect(res.status).toBe(403);
  });
});
