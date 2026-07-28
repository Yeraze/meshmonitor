/**
 * User Preferences Routes Integration Tests
 *
 * GET /user/map-preferences (optionalAuth) and POST /user/map-preferences
 * (requireAuth) moved out of server.ts as part of #3502 PR1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import userPreferencesRoutes from './userPreferencesRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('userPreferencesRoutes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', userPreferencesRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('GET /map-preferences (optionalAuth)', () => {
    it('returns null preferences for an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.get('/map-preferences');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ preferences: null });
    });

    it('returns 200 with a preferences key for an authenticated user', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/map-preferences');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('preferences');
    });
  });

  describe('POST /map-preferences (requireAuth)', () => {
    it('401s an anonymous (unauthenticated) caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.post('/map-preferences').send({ showPaths: true });

      expect(res.status).toBe(401);
    });

    it('saves preferences for an authenticated user', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/map-preferences').send({
        showPaths: true,
        showRoute: false,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, message: 'Map preferences saved successfully' });

      const getRes = await agent.get('/map-preferences');
      expect(getRes.status).toBe(200);
      expect(getRes.body.preferences).toMatchObject({ showPaths: true, showRoute: false });
    });

    it('400s on an invalid boolean field', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/map-preferences').send({ showPaths: 'not-a-boolean' });

      expect(res.status).toBe(400);
    });
  });

  /**
   * #4378: the route destructures an explicit field list, so a preference the
   * client sends but the list omits is dropped with a `{ success: true }` reply
   * — no error surfaces, and the next GET returns the old value. That is
   * exactly how "Show ATAK Contacts" behaved from #3691 until this fix, so the
   * regression has to assert the round-trip, not just the 200.
   */
  describe('showAtakContacts round-trip (#4378)', () => {
    it('persists showAtakContacts=true across a save/load cycle', async () => {
      const agent = await harness.loginAs(harness.limited);

      const post = await agent.post('/map-preferences').send({ showAtakContacts: true });
      expect(post.status).toBe(200);

      const get = await agent.get('/map-preferences');
      expect(get.status).toBe(200);
      expect(get.body.preferences).toMatchObject({ showAtakContacts: true });
    });

    it('persists showAtakContacts=false without falling back to the default', async () => {
      const agent = await harness.loginAs(harness.limited);

      await agent.post('/map-preferences').send({ showAtakContacts: true });
      await agent.post('/map-preferences').send({ showAtakContacts: false });

      const get = await agent.get('/map-preferences');
      expect(get.body.preferences).toMatchObject({ showAtakContacts: false });
    });

    it('leaves showAtakContacts untouched when a save omits it', async () => {
      const agent = await harness.loginAs(harness.limited);

      await agent.post('/map-preferences').send({ showAtakContacts: true });
      await agent.post('/map-preferences').send({ showPaths: true });

      const get = await agent.get('/map-preferences');
      expect(get.body.preferences).toMatchObject({ showAtakContacts: true, showPaths: true });
    });

    it('400s on a non-boolean showAtakContacts', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/map-preferences').send({ showAtakContacts: 'yes' });

      expect(res.status).toBe(400);
    });

    it('defaults to false for a user who never saved it', async () => {
      const agent = await harness.loginAs(harness.limited);
      await agent.post('/map-preferences').send({ showPaths: true });

      const get = await agent.get('/map-preferences');
      expect(get.body.preferences.showAtakContacts).toBe(false);
    });
  });
});
