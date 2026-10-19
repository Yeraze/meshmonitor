/**
 * /api/settings — ADS-B flight matching keys (#5374): feed validation, the
 * strict boolean, and the API key never reaching a non-admin.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const KEYS = ['adsbMatchEnabled', 'adsbFeed', 'adsb_api_token', 'adsb_opensky_client_id', 'adsb_opensky_client_secret'];

describe('/api/settings — ADS-B flight matching (#5374)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    for (const k of KEYS) await harness.db.settings.deleteSetting(k).catch(() => {});
    await harness.cleanup();
  });

  it('saves the three keys globally', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent
      .post('/api/settings')
      .send({ adsbMatchEnabled: 'true', adsbFeed: 'adsb.fi', adsb_api_token: 'k-123' });
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('adsbMatchEnabled')).toBe('true');
    expect(await harness.db.settings.getSetting('adsbFeed')).toBe('adsb.fi');
    expect(await harness.db.settings.getSetting('adsb_api_token')).toBe('k-123');
  });

  it.each([['airplanes.live'], ['OpenSky'], ['']])('rejects adsbFeed=%j with 400 INVALID_ADSB_FEED', async (feed) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({ adsbFeed: feed });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ADSB_FEED');
    expect(await harness.db.settings.getSetting('adsbFeed')).toBeNull();
  });

  it('rejects a non-boolean adsbMatchEnabled', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({ adsbMatchEnabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BOOLEAN_SETTING');
  });

  // A non-admin never receives the key, so their Settings save carries it
  // blank; that save must not wipe it (and can't set it either).
  it('a non-admin save neither wipes nor sets the API key', async () => {
    await harness.db.settings.setSetting('adsb_api_token', 'secret-key');
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post('/api/settings').send({ adsbMatchEnabled: 'true', adsb_api_token: '' });
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('adsb_api_token')).toBe('secret-key');
    expect(await harness.db.settings.getSetting('adsbMatchEnabled')).toBe('true');

    await agent.post('/api/settings').send({ adsb_api_token: 'attacker' });
    expect(await harness.db.settings.getSetting('adsb_api_token')).toBe('secret-key');
  });

  it('an admin can clear the API key', async () => {
    await harness.db.settings.setSetting('adsb_api_token', 'secret-key');
    const admin = await harness.loginAs(harness.admin);
    await admin.post('/api/settings').send({ adsb_api_token: '' });
    expect(await harness.db.settings.getSetting('adsb_api_token')).toBe('');
  });

  it('never sends the API key to a non-admin, but does send the enable flag', async () => {
    await harness.db.settings.setSetting('adsbMatchEnabled', 'true');
    await harness.db.settings.setSetting('adsb_api_token', 'secret-key');

    const anon = await harness.loginAs(null);
    const anonRes = await anon.get('/api/settings');
    expect(anonRes.status).toBe(200);
    expect(anonRes.body.adsbMatchEnabled).toBe('true');
    expect(anonRes.body).not.toHaveProperty('adsb_api_token');

    const admin = await harness.loginAs(harness.admin);
    const adminRes = await admin.get('/api/settings');
    expect(adminRes.body.adsb_api_token).toBe('secret-key');
  });
});

describe('/api/settings — OpenSky Network feed (#5877)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/settings', settingsRoutes),
    });
  });

  afterEach(async () => {
    for (const k of KEYS) await harness.db.settings.deleteSetting(k).catch(() => {});
    await harness.cleanup();
  });

  it.each([
    [{ adsbFeed: 'opensky' }],
    [{ adsbFeed: 'opensky', adsb_opensky_client_id: 'id' }],
    [{ adsbFeed: 'opensky', adsb_opensky_client_secret: 'secret' }],
    [{ adsbFeed: 'opensky', adsb_opensky_client_id: ' ', adsb_opensky_client_secret: 'secret' }],
  ])('rejects OpenSky without both credentials: %j', async (body) => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ADSB_OPENSKY_CREDENTIALS_REQUIRED');
    expect(await harness.db.settings.getSetting('adsbFeed')).toBeNull();
  });

  it('accepts OpenSky with both credentials in the same save', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({
      adsbFeed: 'opensky', adsb_opensky_client_id: 'id', adsb_opensky_client_secret: 'secret',
    });
    expect(res.status).toBe(200);
    expect(await harness.db.settings.getSetting('adsbFeed')).toBe('opensky');
    expect(await harness.db.settings.getSetting('adsb_opensky_client_id')).toBe('id');
    expect(await harness.db.settings.getSetting('adsb_opensky_client_secret')).toBe('secret');
  });

  it('accepts OpenSky when the credentials are already stored', async () => {
    await harness.db.settings.setSetting('adsb_opensky_client_id', 'id');
    await harness.db.settings.setSetting('adsb_opensky_client_secret', 'secret');
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({ adsbFeed: 'opensky' });
    expect(res.status).toBe(200);
  });

  it('refuses to clear a credential while OpenSky stays selected', async () => {
    await harness.db.settings.setSetting('adsbFeed', 'opensky');
    await harness.db.settings.setSetting('adsb_opensky_client_id', 'id');
    await harness.db.settings.setSetting('adsb_opensky_client_secret', 'secret');
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/api/settings').send({ adsb_opensky_client_secret: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ADSB_OPENSKY_CREDENTIALS_REQUIRED');
    expect(await harness.db.settings.getSetting('adsb_opensky_client_secret')).toBe('secret');
  });

  it('never sends either credential to a non-admin', async () => {
    await harness.db.settings.setSetting('adsb_opensky_client_id', 'id-123');
    await harness.db.settings.setSetting('adsb_opensky_client_secret', 'secret-456');

    const anon = await harness.loginAs(null);
    const anonRes = await anon.get('/api/settings');
    expect(anonRes.status).toBe(200);
    expect(anonRes.body).not.toHaveProperty('adsb_opensky_client_id');
    expect(anonRes.body).not.toHaveProperty('adsb_opensky_client_secret');

    await harness.grant(harness.limited.id, 'settings', 'read', harness.sourceA);
    const limited = await harness.loginAs(harness.limited);
    const limitedRes = await limited.get('/api/settings');
    expect(limitedRes.body).not.toHaveProperty('adsb_opensky_client_id');
    expect(limitedRes.body).not.toHaveProperty('adsb_opensky_client_secret');

    const admin = await harness.loginAs(harness.admin);
    const adminRes = await admin.get('/api/settings');
    expect(adminRes.body.adsb_opensky_client_id).toBe('id-123');
    expect(adminRes.body.adsb_opensky_client_secret).toBe('secret-456');
  });
});
