/**
 * v1 `default` source alias honours the default Meshtastic source setting
 * (#5245), and keeps its old rule when the chosen source is disabled or the
 * caller cannot read it.
 *
 * Real-middleware harness (createRouteTestApp) and real permission rows.
 * req.user is set by a mount middleware, standing in for requireAPIToken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../../test-helpers/routeTestApp.js';
import { attachSource } from './sourceParam.js';

describe('v1 `default` alias — default Meshtastic source setting (#5245)', () => {
  let harness: RouteTestHarness;
  let actor: SeededUser;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use((req: any, _res: any, next: any) => {
          req.user = actor;
          next();
        });
        app.get('/v1/sources/:sourceId/probe', attachSource('nodes', 'read'), (req: any, res: any) => {
          res.json({ id: req.source.id });
        });
      },
    });
    actor = harness.admin;
  });

  afterEach(async () => {
    await harness.db.settings.deleteSetting('defaultMeshtasticSourceId').catch(() => {});
    await harness.cleanup();
  });

  const resolve = async () => {
    const res = await request(harness.app).get('/v1/sources/default/probe');
    expect(res.status).toBe(200);
    return res.body.id as string;
  };

  it('an admin gets the configured source', async () => {
    const automatic = await resolve();
    const other = automatic === harness.sourceB ? harness.sourceA : harness.sourceB;
    await harness.db.settings.setSetting('defaultMeshtasticSourceId', other);
    expect(await resolve()).toBe(other);
  });

  it('a user who can read the configured source gets it', async () => {
    actor = harness.limited;
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    expect(await resolve()).toBe(harness.sourceA);
    await harness.db.settings.setSetting('defaultMeshtasticSourceId', harness.sourceB);
    expect(await resolve()).toBe(harness.sourceB);
  });

  it('a user who cannot read the configured source keeps the old rule', async () => {
    actor = harness.limited;
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.db.settings.setSetting('defaultMeshtasticSourceId', harness.sourceB);
    expect(await resolve()).toBe(harness.sourceA);
  });

  it('a disabled configured source falls back to the old rule', async () => {
    actor = harness.limited;
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.db.sources.updateSource(harness.sourceB, { enabled: false });
    await harness.db.settings.setSetting('defaultMeshtasticSourceId', harness.sourceB);
    expect(await resolve()).toBe(harness.sourceA);
  });

  it('a missing configured source falls back to the old rule', async () => {
    actor = harness.limited;
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.db.settings.setSetting('defaultMeshtasticSourceId', 'no-such-source');
    expect(await resolve()).toBe(harness.sourceA);
  });
});
