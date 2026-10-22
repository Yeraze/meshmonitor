/**
 * POST /api/settings — Meshtastic `autoResponderTriggers` syntax (#5924). A
 * regex-mode trigger gets the same store-time checks as a MeshCore one; a
 * trigger with no syntax (pattern mode) saves as it always did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const trigger = (over: Record<string, unknown>) => ({
  id: 't1', trigger: 'ping', responseType: 'text', response: 'pong', channels: ['dm'], ...over,
});

describe('POST /api/settings — auto-responder trigger syntax (#5924)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    await harness.db.settings.deleteSourceSettings(harness.sourceA).catch(() => {});
    await harness.db.settings.deleteSourceSettings(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  const post = async (triggers: unknown[]) => {
    const agent = await harness.loginAs(harness.admin);
    return agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ autoResponderTriggers: JSON.stringify(triggers) });
  };
  const stored = () => harness.db.settings.getSettingForSource(harness.sourceA, 'autoResponderTriggers');

  it('saves both modes, emoji included', async () => {
    const triggers = [
      trigger({ id: 'legacy', trigger: 'weather {city}, w {city}' }),
      trigger({ id: 'dsl', syntax: 'pattern', trigger: '🔋 {level:\\d+}' }),
      trigger({ id: 'rx', syntax: 'regex', trigger: '👋\\s*(?<who>\\w+)' }),
    ];
    const res = await post(triggers);
    expect(res.status).toBe(200);
    expect(JSON.parse((await stored())!)).toEqual(triggers);
  });

  it.each([
    ['a control character', trigger({ syntax: 'regex', trigger: 'ping\u0007' }), /disallowed characters/],
    ['a ReDoS shape', trigger({ syntax: 'regex', trigger: '(a+)+' }), /catastrophic/],
    ['lookaround', trigger({ syntax: 'regex', trigger: '(?=ping)' }), /invalid regex/],
    ['an unknown syntax value', trigger({ syntax: 'glob' }), /must be "pattern" or "regex"/],
  ])('rejects %s in regex mode and writes nothing', async (_label, tr, msg) => {
    const res = await post([tr]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_REGEX');
    expect(res.body.error).toMatch(msg);
    expect(await stored()).toBeNull();
  });
});
