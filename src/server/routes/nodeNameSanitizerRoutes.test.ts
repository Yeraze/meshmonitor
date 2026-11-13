/**
 * #6382 — node-name anti-spam routes, through the real-middleware harness:
 *   - POST /api/settings validates the four keys (bad regex → 400) and is
 *     admin-only, and a save reloads the cached rules;
 *   - /api/node-name-sanitizer/status and /rescan are admin-only, and the
 *     re-scan reports how many rows changed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import settingsRoutes from './settingsRoutes.js';
import nodeNameSanitizerRoutes from './nodeNameSanitizerRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { __resetNodeNameSanitizerForTest, isNodeNameSanitizerActive } from '../../utils/nodeNameSanitizerRuntime.js';
import { NODE_NAME_SANITIZE_KEYS } from '../../utils/nodeNameSanitizerConstants.js';

const SPAM_NUM = 0x6382_0a01;
const SPAM_KEY = 'e5'.repeat(32);

describe('node-name anti-spam routes (#6382)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    __resetNodeNameSanitizerForTest();
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/settings', settingsRoutes);
        app.use('/api/node-name-sanitizer', nodeNameSanitizerRoutes);
      },
    });
  });

  afterEach(async () => {
    for (const key of NODE_NAME_SANITIZE_KEYS) await harness.db.settings.deleteSetting(key).catch(() => {});
    __resetNodeNameSanitizerForTest();
    await harness.cleanup();
  });

  describe('POST /api/settings', () => {
    it('saves valid settings and reloads the cached rules', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/api/settings').send({
        nodeNameSanitizeEnabled: 'true',
        nodeNameSanitizeBuiltins: 'true',
        nodeNameSanitizeCustomPatterns: JSON.stringify(['spam.example', 'buy\\s+now']),
        nodeNameSanitizePlaceholder: '[spam]',
      });
      expect(res.status).toBe(200);
      expect(await harness.db.settings.getSetting('nodeNameSanitizeEnabled')).toBe('true');
      expect(isNodeNameSanitizerActive()).toBe(true);

      await admin.post('/api/settings').send({ nodeNameSanitizeEnabled: 'false' });
      expect(isNodeNameSanitizerActive()).toBe(false);
    });

    it('rejects an invalid regex with 400 and writes nothing', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/api/settings').send({
        nodeNameSanitizeEnabled: 'true',
        nodeNameSanitizeCustomPatterns: JSON.stringify(['ok\\.example', '(a)\\1']),
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_NODE_NAME_SANITIZER_SETTING');
      expect(res.body.error).toMatch(/pattern 2/i);
      expect(await harness.db.settings.getSetting('nodeNameSanitizeEnabled')).toBeNull();
    });

    it('rejects an over-long pattern, a non-boolean and an over-long placeholder', async () => {
      const admin = await harness.loginAs(harness.admin);
      for (const body of [
        { nodeNameSanitizeCustomPatterns: JSON.stringify(['x'.repeat(257)]) },
        { nodeNameSanitizeEnabled: 'yes' },
        { nodeNameSanitizePlaceholder: 'p'.repeat(30) },
      ]) {
        const res = await admin.post('/api/settings').send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_NODE_NAME_SANITIZER_SETTING');
      }
    });

    it('drops the keys from a non-admin settings writer', async () => {
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      const user = await harness.loginAs(harness.limited);
      const res = await user.post('/api/settings').send({ nodeNameSanitizeEnabled: 'true' });
      expect(res.status).toBe(200);
      expect(await harness.db.settings.getSetting('nodeNameSanitizeEnabled')).toBeNull();
      expect(isNodeNameSanitizerActive()).toBe(false);
    });

    it('drops the keys from a per-source save', async () => {
      const admin = await harness.loginAs(harness.admin);
      await admin.post(`/api/settings?sourceId=${harness.sourceA}`).send({ nodeNameSanitizeEnabled: 'true' });
      expect(await harness.db.settings.getSetting('nodeNameSanitizeEnabled')).toBeNull();
    });
  });

  describe('/api/node-name-sanitizer', () => {
    it('status and re-scan are admin-only', async () => {
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      const user = await harness.loginAs(harness.limited);
      expect((await user.get('/api/node-name-sanitizer/status')).status).toBe(403);
      expect((await user.post('/api/node-name-sanitizer/rescan')).status).toBe(403);
      const anon = await harness.loginAs(null);
      expect([401, 403]).toContain((await anon.post('/api/node-name-sanitizer/rescan')).status);
    });

    it('re-scan refuses while the feature is off', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.post('/api/node-name-sanitizer/rescan');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NODE_NAME_SANITIZER_DISABLED');
    });

    it('re-scan rewrites stored names and reports the counts; status shows the hits', async () => {
      // Stored while the filter is off.
      await harness.db.nodes.upsertNode({ nodeNum: SPAM_NUM, nodeId: '!63820a01', longName: 'Bad t.me/x', shortName: 'BAD' }, harness.sourceB);
      await harness.db.meshcore.upsertNode({ publicKey: SPAM_KEY, name: 'Bad wa.me/1' }, harness.sourceA);

      const admin = await harness.loginAs(harness.admin);
      await admin.post('/api/settings').send({ nodeNameSanitizeEnabled: 'true' });

      const res = await admin.post('/api/node-name-sanitizer/rescan');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.nodesChanged).toBeGreaterThanOrEqual(1);
      expect(res.body.data.meshcoreNodesChanged).toBeGreaterThanOrEqual(1);
      expect(res.body.data.scanned).toBeGreaterThanOrEqual(2);

      expect((await harness.db.nodes.getNode(SPAM_NUM, harness.sourceB))?.longName).toBe('Bad [spammer]');
      expect((await harness.db.meshcore.getNodeByPublicKeyAndSource(SPAM_KEY, harness.sourceA))?.name).toBe('Bad [spammer]');

      const status = await admin.get('/api/node-name-sanitizer/status');
      expect(status.status).toBe(200);
      expect(status.body.data.active).toBe(true);
      expect(status.body.data.hits.total).toBeGreaterThanOrEqual(2);

      const again = await admin.post('/api/node-name-sanitizer/rescan');
      expect(again.body.data.nodesChanged).toBe(0);
      expect(again.body.data.meshcoreNodesChanged).toBe(0);
    });
  });
});
