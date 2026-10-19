/**
 * POST /api/settings — `hopEmojiZeroHop` / `hopEmojiMqtt` (#5890): blank or one
 * short glyph, stored per source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('POST /api/settings — tapback glyphs', () => {
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

  it('stores both glyphs on that source only', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post(`/api/settings?sourceId=${harness.sourceA}`)
      .send({ hopEmojiZeroHop: '0️⃣', hopEmojiMqtt: '*️⃣' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'hopEmojiZeroHop')).toBe('0️⃣');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'hopEmojiMqtt')).toBe('*️⃣');
    expect(await harness.db.settings.getSettingForSource(harness.sourceB, 'hopEmojiZeroHop')).toBeNull();
  });

  it('accepts blank, meaning the built-in glyph', async () => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, { hopEmojiZeroHop: '0️⃣' });
    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ hopEmojiZeroHop: '' });

    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'hopEmojiZeroHop')).toBe('');
  });

  it.each(['hello world', ' 0️⃣', 'x'.repeat(17)])('rejects %j and writes nothing', async (value) => {
    const agent = await harness.loginAs(harness.admin);
    await harness.db.settings.setSourceSettings(harness.sourceA, { hopEmojiMqtt: '🌐' });

    const res = await agent.post(`/api/settings?sourceId=${harness.sourceA}`).send({ hopEmojiMqtt: value });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(await harness.db.settings.getSettingForSource(harness.sourceA, 'hopEmojiMqtt')).toBe('🌐');
  });
});
