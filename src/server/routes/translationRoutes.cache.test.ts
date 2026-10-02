/**
 * Translation cache routes (#5520), on the real harness: real session, real
 * `optionalAuth`, real permission rows, real SQLite repositories, real
 * `DbTranslationCache`. Only the provider network call is faked.
 *
 * Write path: `POST /api/translate` with `{ sourceId, messageId }`.
 * Read path:  `GET /api/translate/stored`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import translationRoutes from './translationRoutes.js';
import { PortNum } from '../constants/meshtastic.js';
import { setTranslationCache, NoOpTranslationCache } from '../services/translation/translationCache.js';
import { DbTranslationCache } from '../services/translation/dbTranslationCache.js';
import { computeTranslationCacheKey } from '../services/translation/cacheKey.js';

const providerTranslate = vi.fn();

vi.mock('../services/translation/providers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/translation/providers/index.js')>();
  return {
    ...actual,
    getTranslationProvider: () => ({ id: 'deepl', translate: providerTranslate }),
  };
});

vi.mock('../middleware/rateLimiters.js', () => ({
  translateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const LOCAL = { nodeNum: 0x0a000001, nodeId: '!0a000001' };
const PEER = { nodeNum: 0x0a000002, nodeId: '!0a000002' };
const VIRTUAL_CHANNEL = 105; // CHANNEL_DB_OFFSET (100) + channel_database id 5

describe('translation cache routes (#5520)', () => {
  let harness: RouteTestHarness;
  const inserted: string[] = [];

  const seedMessage = async (sourceId: string, id: string, text: string, channel: number) => {
    await harness.db.messages.insertMessage(
      {
        id,
        fromNodeNum: PEER.nodeNum,
        toNodeNum: channel === -1 ? LOCAL.nodeNum : 0xffffffff,
        fromNodeId: PEER.nodeId,
        toNodeId: channel === -1 ? LOCAL.nodeId : '!ffffffff',
        text,
        channel,
        portnum: PortNum.TEXT_MESSAGE_APP,
        timestamp: Date.now(),
        createdAt: Date.now(),
      } as never,
      sourceId,
    );
    inserted.push(id);
  };

  const translate = (agent: ReturnType<typeof request.agent>, body: Record<string, unknown>) =>
    agent.post('/api/translate').send({ targetLang: 'en', ...body });

  const stored = (agent: ReturnType<typeof request.agent> | ReturnType<typeof request>, sourceId: string, ids: string[]) =>
    agent.get(`/api/translate/stored?sourceId=${sourceId}&lang=en&messageIds=${ids.join(',')}`);

  beforeEach(async () => {
    providerTranslate.mockReset();
    providerTranslate.mockImplementation(async (text: string) => ({
      translatedText: `EN(${text})`,
      detectedSourceLanguage: 'de',
    }));
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/translate', translationRoutes),
    });
    harness.db.setSetting('translationEnabled', 'true');
    harness.db.setSetting('translationProvider', 'deepl');
    setTranslationCache(new DbTranslationCache());

    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      for (const node of [LOCAL, PEER, { nodeNum: 0xffffffff, nodeId: '!ffffffff' }]) {
        await harness.db.nodes.upsertNode(
          { nodeNum: node.nodeNum, nodeId: node.nodeId, channel: 0, lastHeard: Date.now() } as never,
          sourceId,
        );
      }
    }
    await seedMessage(harness.sourceA, 'a-ch0', 'Guten Morgen', 0);
    await seedMessage(harness.sourceA, 'a-ch0-dup', 'Guten   Morgen', 0);
    await seedMessage(harness.sourceA, 'a-dm', 'Geheimer Plan', -1);
    await seedMessage(harness.sourceA, 'a-virtual', 'Virtuell', VIRTUAL_CHANNEL);
    await seedMessage(harness.sourceB, 'b-ch0', 'Hallo Welt', 0);
  });

  afterEach(async () => {
    for (const id of inserted) await harness.db.messages.deleteMessage(id).catch(() => {});
    inserted.length = 0;
    // Drop every cache row (pinned ones survive any prune by design) so tests
    // stay independent.
    (harness.db as unknown as { db: { prepare(q: string): { run(): void } } }).db
      .prepare('DELETE FROM translation_cache').run();
    harness.db.setSetting('translationEnabled', 'false');
    setTranslationCache(new NoOpTranslationCache());
    // harness.cleanup() only revokes admin/limited grants; drop the
    // source-scoped anonymous grants a test added (defaults are global).
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      await harness.db.auth.deletePermissionsForUserByScope(harness.anonymous.id, sourceId);
    }
    await harness.cleanup();
  });

  describe('POST /api/translate with { sourceId, messageId }', () => {
    it('translates the STORED text, ignores the client text, and links the message', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await translate(agent, { sourceId: harness.sourceA, messageId: 'a-ch0', text: 'EVIL TEXT' });

      expect(res.status).toBe(200);
      expect(res.body.data.translatedText).toBe('EN(Guten Morgen)');
      expect(providerTranslate).toHaveBeenCalledTimes(1);
      expect(providerTranslate.mock.calls[0][0]).toBe('Guten Morgen');

      const key = computeTranslationCacheKey('Guten Morgen', 'en');
      expect(await harness.db.translations.getLinksForMessage(harness.sourceA, 'a-ch0')).toEqual([{ targetLang: 'en', cacheKey: key }]);
      // The poisoned text never reached the cache.
      expect(await harness.db.translations.getCacheEntry(computeTranslationCacheKey('EVIL TEXT', 'en'))).toBeNull();
    });

    it('is a 404 with no provider call when the caller cannot read the message', async () => {
      // messages:read (DMs) but no channel grant on source A.
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const hidden = await translate(agent, { sourceId: harness.sourceA, messageId: 'a-ch0' });
      expect(hidden.status).toBe(404);
      // Message exists, but on another source.
      const wrongSource = await translate(agent, { sourceId: harness.sourceA, messageId: 'b-ch0' });
      expect(wrongSource.status).toBe(404);
      const missing = await translate(agent, { sourceId: harness.sourceA, messageId: 'nope' });
      expect(missing.status).toBe(404);
      expect(hidden.body.code).toBe(missing.body.code);
      expect(providerTranslate).not.toHaveBeenCalled();

      // The DM it CAN read goes through.
      const dm = await translate(agent, { sourceId: harness.sourceA, messageId: 'a-dm' });
      expect(dm.status).toBe(200);
      expect(providerTranslate).toHaveBeenCalledTimes(1);
    });

    it('a cache hit (same normalized text) skips the provider, bumps hitCount + lastUsedAt, and pins the entry', async () => {
      const agent = await harness.loginAs(harness.admin);
      await translate(agent, { sourceId: harness.sourceA, messageId: 'a-ch0' });
      const key = computeTranslationCacheKey('Guten Morgen', 'en');
      const before = await harness.db.translations.getCacheEntry(key);
      expect(before?.hitCount).toBe(0);

      await new Promise((r) => setTimeout(r, 5));
      const res = await translate(agent, { sourceId: harness.sourceA, messageId: 'a-ch0-dup' });
      expect(res.body.data.cached).toBe(true);
      expect(providerTranslate).toHaveBeenCalledTimes(1);

      const after = await harness.db.translations.getCacheEntry(key);
      expect(after?.hitCount).toBe(1);
      expect(after!.lastUsedAt).toBeGreaterThan(before!.lastUsedAt);
      expect(after?.messageRefCount).toBe(2);
      expect(after?.pinnedAt).not.toBeNull();
    });

    it('composer / free-text translations never touch the cache or create links', async () => {
      const agent = await harness.loginAs(harness.admin);
      const first = await translate(agent, { text: 'Guten Morgen' });
      const second = await translate(agent, { text: 'Guten Morgen' });
      expect(first.status).toBe(200);
      expect(second.body.data.cached).toBe(false);
      expect(providerTranslate).toHaveBeenCalledTimes(2);
      expect(await harness.db.translations.getCacheEntry(computeTranslationCacheKey('Guten Morgen', 'en'))).toBeNull();
      expect(await harness.db.translations.getLinksForMessage(harness.sourceA, 'a-ch0')).toEqual([]);
    });

    it('rejects half-specified or malformed message references', async () => {
      const agent = await harness.loginAs(harness.admin);
      expect((await translate(agent, { sourceId: harness.sourceA })).status).toBe(400);
      expect((await translate(agent, { messageId: 'a-ch0' })).status).toBe(400);
      expect((await translate(agent, { sourceId: harness.sourceA, messageId: 'a-ch0', targetLang: 'x; drop' })).status).toBe(400);
      expect(providerTranslate).not.toHaveBeenCalled();
    });

    it('drops the link when the message is deleted', async () => {
      const agent = await harness.loginAs(harness.admin);
      await translate(agent, { sourceId: harness.sourceA, messageId: 'a-ch0' });
      await harness.db.messages.deleteMessage('a-ch0');
      expect(await harness.db.translations.getLinksForMessage(harness.sourceA, 'a-ch0')).toEqual([]);
      expect((await harness.db.translations.getCacheEntry(computeTranslationCacheKey('Guten Morgen', 'en')))?.messageRefCount).toBe(0);
    });
  });

  describe('GET /api/translate/stored', () => {
    beforeEach(async () => {
      const admin = await harness.loginAs(harness.admin);
      for (const messageId of ['a-ch0', 'a-dm', 'a-virtual']) {
        await translate(admin, { sourceId: harness.sourceA, messageId });
      }
      await translate(admin, { sourceId: harness.sourceB, messageId: 'b-ch0' });
      providerTranslate.mockClear();
    });

    it('anonymous viewers with channel read access get stored translations, never DMs or hidden channels', async () => {
      await harness.grant(harness.anonymous.id, 'channel_0', 'read', harness.sourceA);
      const res = await stored(request(harness.app), harness.sourceA, ['a-ch0', 'a-dm', 'a-virtual', 'b-ch0', 'nope']);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
        'a-ch0': { translatedText: 'EN(Guten Morgen)', detectedSourceLanguage: 'de', provider: 'deepl' },
      });
      expect(providerTranslate).not.toHaveBeenCalled();
    });

    it('omits translated messages the viewer cannot read (per message, per source)', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await stored(agent, harness.sourceA, ['a-ch0', 'a-dm']);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data)).toEqual(['a-dm']);

      // Same caller, other source: no grants there at all.
      const other = await stored(agent, harness.sourceB, ['b-ch0']);
      expect(other.status).toBe(403);
    });

    it('admins see every stored translation; nothing comes back in another language', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await stored(agent, harness.sourceA, ['a-ch0', 'a-dm', 'a-virtual']);
      expect(Object.keys(res.body.data).sort()).toEqual(['a-ch0', 'a-dm', 'a-virtual']);
      const es = await agent.get(`/api/translate/stored?sourceId=${harness.sourceA}&lang=es&messageIds=a-ch0`);
      expect(es.body.data).toEqual({});
      expect(providerTranslate).not.toHaveBeenCalled();
    });

    it('anonymous without a channel grant sees nothing; disabled translation is refused', async () => {
      // Whether the default anonymous role reads any channel kind (403) or
      // not this one (200 + {}), the translation is never served.
      const anon = await stored(request(harness.app), harness.sourceA, ['a-ch0']);
      expect([200, 403]).toContain(anon.status);
      expect(anon.body.data ?? {}).toEqual({});

      // A caller with no grant of any kind on the source is refused outright.
      const limited = await harness.loginAs(harness.limited);
      expect((await stored(limited, harness.sourceA, ['a-ch0'])).status).toBe(403);

      harness.db.setSetting('translationEnabled', 'false');
      const agent = await harness.loginAs(harness.admin);
      const disabled = await stored(agent, harness.sourceA, ['a-ch0']);
      expect(disabled.status).toBe(403);
      expect(disabled.body.code).toBe('TRANSLATION_DISABLED');
    });

    it('validates input and caps the id count', async () => {
      const agent = await harness.loginAs(harness.admin);
      expect((await agent.get(`/api/translate/stored?lang=en&messageIds=a`)).status).toBe(400);
      expect((await agent.get(`/api/translate/stored?sourceId=${harness.sourceA}&lang=xx-yy-zz&messageIds=a`)).status).toBe(400);
      const ids = Array.from({ length: 201 }, (_, i) => `m${i}`);
      expect((await stored(agent, harness.sourceA, ids)).status).toBe(400);
    });

    it('a deleted message is no longer served even before any sweep', async () => {
      const agent = await harness.loginAs(harness.admin);
      await harness.db.messages.deleteMessage('a-ch0');
      const res = await stored(agent, harness.sourceA, ['a-ch0']);
      expect(res.body.data).toEqual({});
    });
  });
});
