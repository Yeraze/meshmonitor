/**
 * Translation routes for a MeshCore source (#6261), on the real harness: real
 * session, real permission rows, real SQLite repositories. A MeshCore row must
 * be as visible to translation as it is to the MeshCore message-list routes.
 * Only the provider network call is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import translationRoutes from './translationRoutes.js';
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

const MC = 'mc-src-6261';
const MC_OTHER = 'mc-src-6261-b';
const PEER = 'aa'.repeat(32);
const SELF = 'bb'.repeat(32);
const KEYED_FP = 'feedfacecafebeef';

describe('translation routes: MeshCore source (#6261)', () => {
  let harness: RouteTestHarness;

  const seed = async (
    sourceId: string,
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) => {
    await harness.db.meshcore.insertMessage(
      {
        id,
        fromPublicKey: PEER,
        toPublicKey: 'channel-0',
        text,
        timestamp: Date.now(),
        createdAt: Date.now(),
        messageType: 'channel',
        ...extra,
      } as never,
      sourceId,
    );
  };

  const translate = (agent: ReturnType<typeof request.agent>, messageId: string, extra: Record<string, unknown> = {}) =>
    agent.post('/api/translate').send({ targetLang: 'en', sourceId: MC, messageId, ...extra });

  const stored = (agent: ReturnType<typeof request.agent> | ReturnType<typeof request>, ids: string[], sourceId = MC) =>
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
    for (const id of [MC, MC_OTHER]) {
      await harness.db.sources.deleteSource(id).catch(() => {});
      await harness.db.sources.createSource({ id, name: id, type: 'meshcore', config: {}, enabled: true });
    }
    harness.db.setSetting('translationEnabled', 'true');
    harness.db.setSetting('translationProvider', 'deepl');
    harness.db.setSetting('translationDeeplApiKey', 'test-deepl-key');
    setTranslationCache(new DbTranslationCache());

    await seed(MC, 'mc-ch0', 'Guten Morgen');
    await seed(MC, 'mc-ch2', 'Kanal zwei', { toPublicKey: 'channel-2' });
    await seed(MC, 'mc-ch9', 'Kanal neun', { toPublicKey: 'channel-9' });
    await seed(MC, 'mc-keyed', 'Geheim', { keyFingerprint: KEYED_FP });
    await seed(MC, 'mc-dm', 'Privat', { toPublicKey: SELF, messageType: 'direct' });
    await seed(MC, 'mc-legacy', 'Alt', { toPublicKey: null });
    await seed(MC, 'mc-react', '👍', { reactionEmoji: '👍', reactionTargetId: 'mc-ch0' });
    await seed(MC_OTHER, 'mc-other', 'Anderswo');
  });

  afterEach(async () => {
    (harness.db as unknown as { db: { prepare(q: string): { run(): void } } }).db
      .prepare('DELETE FROM translation_cache').run();
    (harness.db as unknown as { db: { prepare(q: string): { run(): void } } }).db
      .prepare('DELETE FROM meshcore_messages WHERE sourceId IN (?, ?)').run(MC, MC_OTHER);
    harness.db.setSetting('translationEnabled', 'false');
    setTranslationCache(new NoOpTranslationCache());
    for (const id of [MC, MC_OTHER]) {
      await harness.db.auth.deletePermissionsForUserByScope(harness.anonymous.id, id);
    }
    await harness.cleanup();
    for (const id of [MC, MC_OTHER]) await harness.db.sources.deleteSource(id).catch(() => {});
  });

  it('translates the STORED text, ignores client text, and links the row', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await translate(agent, 'mc-ch0', { text: 'EVIL TEXT' });

    expect(res.status).toBe(200);
    expect(res.body.data.translatedText).toBe('EN(Guten Morgen)');
    expect(providerTranslate).toHaveBeenCalledTimes(1);
    expect(providerTranslate.mock.calls[0][0]).toBe('Guten Morgen');
    const key = computeTranslationCacheKey('Guten Morgen', 'en');
    expect(await harness.db.translations.getLinksForMessage(MC, 'mc-ch0')).toEqual([{ targetLang: 'en', cacheKey: key }]);
  });

  it('404s with no provider call for hidden, reaction, wrong-source and unknown rows', async () => {
    // messages:read on the MeshCore source covers channels and DMs, so use a
    // reader with ONLY channel_1 to hide the rest.
    // The route middleware checks messages:read on ANY source (unscoped), so
    // the reader holds it on another source; the per-source scope then decides.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_1', 'read', MC);
    const agent = await harness.loginAs(harness.limited);

    for (const id of ['mc-ch0', 'mc-ch2', 'mc-ch9', 'mc-dm', 'mc-legacy', 'mc-react', 'mc-other', 'nope']) {
      const res = await translate(agent, id);
      expect(res.status, id).toBe(404);
    }
    expect(providerTranslate).not.toHaveBeenCalled();
  });

  it('a channel-only reader translates that channel but not a DM', async () => {
    // The route middleware checks messages:read on ANY source (unscoped), so
    // the reader holds it on another source; the per-source scope then decides.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_2', 'read', MC);
    const agent = await harness.loginAs(harness.limited);

    expect((await translate(agent, 'mc-ch2')).status).toBe(200);
    expect((await translate(agent, 'mc-dm')).status).toBe(404);
    expect((await translate(agent, 'mc-ch0')).status).toBe(404);
  });

  it('a keyed row needs key access, and a reaction is never translatable', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', MC);
    const limited = await harness.loginAs(harness.limited);
    expect((await translate(limited, 'mc-ch0')).status).toBe(200);
    expect((await translate(limited, 'mc-keyed')).status).toBe(404);
    expect((await translate(limited, 'mc-react')).status).toBe(404);

    const admin = await harness.loginAs(harness.admin);
    expect((await translate(admin, 'mc-keyed')).status).toBe(200);
    expect((await translate(admin, 'mc-react')).status).toBe(404);
  });

  it('messages:read reads channels, DMs and legacy null-recipient rows', async () => {
    await harness.grant(harness.limited.id, 'messages', 'read', MC);
    const agent = await harness.loginAs(harness.limited);
    for (const id of ['mc-ch0', 'mc-ch9', 'mc-dm', 'mc-legacy']) {
      expect((await translate(agent, id)).status, id).toBe(200);
    }
  });

  describe('GET /stored', () => {
    const prime = async () => {
      const admin = await harness.loginAs(harness.admin);
      for (const id of ['mc-ch0', 'mc-ch2', 'mc-dm', 'mc-keyed']) {
        expect((await translate(admin, id)).status).toBe(200);
      }
      providerTranslate.mockClear();
    };

    it('omits invisible ids and never calls the provider', async () => {
      await prime();
      await harness.grant(harness.limited.id, 'channel_2', 'read', MC);
      const agent = await harness.loginAs(harness.limited);
      const res = await stored(agent, ['mc-ch0', 'mc-ch2', 'mc-dm', 'mc-keyed']);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data)).toEqual(['mc-ch2']);
      expect(res.body.data['mc-ch2'].translatedText).toBe('EN(Kanal zwei)');
      expect(providerTranslate).not.toHaveBeenCalled();
    });

    it('403s a caller with no read grant on the source', async () => {
      await prime();
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await stored(agent, ['mc-ch0'])).status).toBe(403);
    });

    it('403s an unknown source', async () => {
      const agent = await harness.loginAs(harness.admin);
      expect((await stored(agent, ['x'], 'no-such-source')).status).toBe(403);
    });

    it('serves an anonymous user that has read access', async () => {
      await prime();
      await harness.grant(harness.anonymous.id, 'messages', 'read', MC);
      const res = await stored(request(harness.app), ['mc-ch0', 'mc-keyed']);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data)).toEqual(['mc-ch0']);
      expect(providerTranslate).not.toHaveBeenCalled();
    });
  });

  it('a link follows its row: deleting the row hides it and the sweep removes the link', async () => {
    const admin = await harness.loginAs(harness.admin);
    expect((await translate(admin, 'mc-ch0')).status).toBe(200);
    expect((await translate(admin, 'mc-dm')).status).toBe(200);

    await harness.db.meshcore.deleteMessagesByIds(['mc-ch0'], MC);
    expect(await harness.db.translations.getLinksForMessage(MC, 'mc-ch0')).toEqual([]);
    expect(await harness.db.translations.getLinksForMessage(MC, 'mc-dm')).toHaveLength(1);

    await harness.db.meshcore.deleteAllMessagesForSource(MC);
    expect(await harness.db.translations.getLinksForMessage(MC, 'mc-dm')).toEqual([]);
  });
});
