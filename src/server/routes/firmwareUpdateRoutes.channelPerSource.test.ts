/**
 * firmwareUpdateRoutes — the release channel and custom URL are per source (#4943).
 *
 * Real `createRouteTestApp` harness, real firmware service and real settings
 * rows in the in-memory DB. A source with no value of its own uses the
 * install-wide value, so existing installs keep the channel they had.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import firmwareUpdateRoutes from './firmwareUpdateRoutes.js';
import { firmwareUpdateService } from '../services/firmwareUpdateService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('firmware release channel is per source (#4943)', () => {
  let harness: RouteTestHarness;

  const clear = async () => {
    await harness.db.settings.deleteSetting('firmwareChannel');
    await harness.db.settings.deleteSetting('firmwareCustomUrl');
    await harness.db.settings.deleteSourceSettings(harness.sourceA);
    await harness.db.settings.deleteSourceSettings(harness.sourceB);
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/api/firmware', firmwareUpdateRoutes) });
    await clear();
  });

  afterEach(async () => {
    await clear();
    await harness.cleanup();
  });

  const admin = () => harness.loginAs(harness.admin);
  const channelOf = async (sourceId?: string) => {
    const q = sourceId ? `?sourceId=${sourceId}` : '';
    const res = await (await admin()).get(`/api/firmware/status${q}`);
    expect(res.status).toBe(200);
    return { channel: res.body.channel, customUrl: res.body.customUrl };
  };

  it('a channel saved for one source does not change another', async () => {
    const res = await (await admin()).post('/api/firmware/channel').send({ channel: 'alpha', sourceId: harness.sourceA });
    expect(res.status).toBe(200);
    expect((await channelOf(harness.sourceA)).channel).toBe('alpha');
    expect((await channelOf(harness.sourceB)).channel).toBe('stable');
    // The releases list follows the same source's channel.
    const rel = await (await admin()).get(`/api/firmware/releases?sourceId=${harness.sourceB}`);
    expect(rel.body.channel).toBe('stable');
  });

  it('a source without its own value uses the install-wide channel', async () => {
    await harness.db.settings.setSetting('firmwareChannel', 'alpha');
    await (await admin()).post('/api/firmware/channel').send({ channel: 'stable', sourceId: harness.sourceA });
    expect((await channelOf(harness.sourceA)).channel).toBe('stable');
    expect((await channelOf(harness.sourceB)).channel).toBe('alpha');
    expect((await channelOf()).channel).toBe('alpha');
  });

  it('keeps the custom URL per source', async () => {
    const url = 'https://example.com/firmware-a.bin';
    const res = await (await admin())
      .post('/api/firmware/channel')
      .send({ channel: 'custom', customUrl: url, sourceId: harness.sourceA });
    expect(res.status).toBe(200);
    expect(await channelOf(harness.sourceA)).toEqual({ channel: 'custom', customUrl: url });
    expect((await channelOf(harness.sourceB)).customUrl ?? null).toBeNull();
    expect(await firmwareUpdateService.getCustomUrl(harness.sourceA)).toBe(url);
  });

  it('refuses a sourceId that names no source', async () => {
    const res = await (await admin()).post('/api/firmware/channel').send({ channel: 'alpha', sourceId: 'no-such-source' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SOURCE_NOT_FOUND');
    const get = await (await admin()).get('/api/firmware/status?sourceId=no-such-source');
    expect(get.status).toBe(404);
  });

  it('fetches nightly when any one source is on the nightly channel', async () => {
    expect(await firmwareUpdateService.anySourceOnChannel('nightly')).toBe(false);
    await firmwareUpdateService.setChannel('nightly', harness.sourceB);
    expect(await firmwareUpdateService.anySourceOnChannel('nightly')).toBe(true);
  });
});
