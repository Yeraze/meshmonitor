/**
 * Translation provider settings through the real routes (#5518).
 *
 * Route harness: real session + auth middleware + the `:memory:` SQLite
 * database. Only the network (`fetch`) and the rate limiter are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import settingsRoutes from './settingsRoutes.js';
import translationRoutes from './translationRoutes.js';
import { isSecretSettingKey } from '../constants/settings.js';
import {
  TRANSLATION_PROVIDER_DESCRIPTORS,
  TRANSLATION_PROVIDER_IDS,
  TRANSLATION_PROVIDER_SECRET_SETTING_KEYS,
  TRANSLATION_PROVIDER_SETTING_KEYS,
  TRANSLATION_PROVIDER_URL_SETTING_KEYS,
} from '../../types/translationProviders.js';

vi.mock('../middleware/rateLimiters.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/rateLimiters.js')>()),
  translateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const SECRET_VALUE = (key: string) => `SECRET-${key}`;

describe('translation provider settings routes (#5518)', () => {
  let harness: RouteTestHarness;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/settings', settingsRoutes);
        app.use('/api/translate', translationRoutes);
      },
    });
    for (const key of [...TRANSLATION_PROVIDER_SETTING_KEYS, 'translationProvider', 'translationApiKey']) {
      await harness.db.settings.deleteSetting(key).catch(() => {});
    }
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    for (const key of [...TRANSLATION_PROVIDER_SETTING_KEYS, 'translationProvider', 'translationApiKey']) {
      await harness.db.settings.deleteSetting(key).catch(() => {});
    }
    await harness.cleanup();
  });

  const storeAllSecrets = async () => {
    for (const key of TRANSLATION_PROVIDER_SECRET_SETTING_KEYS) {
      await harness.db.settings.setSetting(key, SECRET_VALUE(key));
    }
  };

  describe('GET /api/settings', () => {
    it('has a secret field for every provider that declares one', () => {
      expect(TRANSLATION_PROVIDER_SECRET_SETTING_KEYS.length).toBe(TRANSLATION_PROVIDER_IDS.length);
      for (const key of TRANSLATION_PROVIDER_SECRET_SETTING_KEYS) expect(isSecretSettingKey(key)).toBe(true);
    });

    it('omits every provider secret for a non-admin and for an anonymous caller', async () => {
      await storeAllSecrets();
      await harness.db.settings.setSetting('translationUrl', 'http://libre.internal:5000');

      const limited = await harness.loginAs(harness.limited);
      for (const res of [await limited.get('/api/settings'), await request(harness.app).get('/api/settings')]) {
        expect(res.status).toBe(200);
        for (const key of TRANSLATION_PROVIDER_SECRET_SETTING_KEYS) {
          expect(res.body).not.toHaveProperty(key);
          expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE(key));
        }
        // Non-secret provider fields still reach the client.
        expect(res.body.translationUrl).toBe('http://libre.internal:5000');
      }
    });

    it('returns every provider secret to an admin, so an untouched field saves back unchanged', async () => {
      await storeAllSecrets();
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.get('/api/settings');
      for (const key of TRANSLATION_PROVIDER_SECRET_SETTING_KEYS) {
        expect(res.body[key]).toBe(SECRET_VALUE(key));
      }
    });
  });

  describe('POST /api/settings', () => {
    it('stores each provider key under its own setting', async () => {
      const admin = await harness.loginAs(harness.admin);
      const body = Object.fromEntries(TRANSLATION_PROVIDER_SECRET_SETTING_KEYS.map((k) => [k, SECRET_VALUE(k)]));
      await admin.post('/api/settings').send(body).expect(200);
      for (const key of TRANSLATION_PROVIDER_SECRET_SETTING_KEYS) {
        expect(await harness.db.settings.getSetting(key)).toBe(SECRET_VALUE(key));
      }
    });

    it('no longer accepts the retired shared translationApiKey', async () => {
      const admin = await harness.loginAs(harness.admin);
      await admin.post('/api/settings').send({ translationApiKey: 'shared' }).expect(200);
      expect(await harness.db.settings.getSetting('translationApiKey')).toBeNull();
    });

    it('a non-admin save with blank secrets does not wipe the stored keys', async () => {
      await storeAllSecrets();
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      const limited = await harness.loginAs(harness.limited);
      const body = Object.fromEntries(TRANSLATION_PROVIDER_SECRET_SETTING_KEYS.map((k) => [k, '']));
      await limited.post('/api/settings').send(body).expect(200);
      for (const key of TRANSLATION_PROVIDER_SECRET_SETTING_KEYS) {
        expect(await harness.db.settings.getSetting(key)).toBe(SECRET_VALUE(key));
      }
    });

    describe.each(TRANSLATION_PROVIDER_URL_SETTING_KEYS.map((key) => [key] as const))('URL field %s', (key) => {
      it.each([
        ['prose', 'this isnt a valid url yo!'],
        ['ftp scheme', 'ftp://invalid-protocol.com'],
        ['file scheme', 'file:///etc/passwd'],
        ['javascript scheme', 'javascript://alert(1)'],
      ])('rejects %s with 400 INVALID_TRANSLATION_URL', async (_name, value) => {
        const admin = await harness.loginAs(harness.admin);
        const res = await admin.post('/api/settings').send({ [key]: value });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({
          success: false,
          code: 'INVALID_TRANSLATION_URL',
          error: `${key} must be a valid http(s) URL`,
        });
        expect(await harness.db.settings.getSetting(key)).toBeNull();
      });

      it.each([
        ['http', 'http://custom-host:5000'],
        ['https with a path', 'https://gateway.example.com/v1'],
        ['no scheme', 'localhost:5000'],
        ['blank', ''],
      ])('accepts %s and stores it unchanged', async (_name, value) => {
        const admin = await harness.loginAs(harness.admin);
        await admin.post('/api/settings').send({ [key]: value }).expect(200);
        expect(await harness.db.settings.getSetting(key)).toBe(value);
      });
    });

    it('every kind:url descriptor field is in the validated list', () => {
      const urlFields = TRANSLATION_PROVIDER_IDS.flatMap((id) =>
        TRANSLATION_PROVIDER_DESCRIPTORS[id].fields.filter((f) => f.kind === 'url').map((f) => f.settingKey));
      expect([...TRANSLATION_PROVIDER_URL_SETTING_KEYS].sort()).toEqual([...urlFields].sort());
      expect(urlFields.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/translate/test', () => {
    const okFetch = () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'ok',
          choices: [{ message: { content: 'ok' } }],
          translations: [{ text: 'ok' }],
          data: { translations: [{ translatedText: 'ok' }] },
        }),
      } as unknown as Response);
    };
    const wire = () => JSON.stringify(vi.mocked(global.fetch).mock.calls);

    it('uses the stored key of the provider under test, and never echoes it back', async () => {
      await storeAllSecrets();
      // The ACTIVE provider is openai; the test is of deepl.
      await harness.db.settings.setSetting('translationProvider', 'openai');
      okFetch();
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.post('/api/translate/test').send({ provider: 'deepl' });

      expect(res.status).toBe(200);
      expect(wire()).toContain(`DeepL-Auth-Key ${SECRET_VALUE('translationDeeplApiKey')}`);
      for (const key of TRANSLATION_PROVIDER_SECRET_SETTING_KEYS) {
        if (key !== 'translationDeeplApiKey') expect(wire()).not.toContain(SECRET_VALUE(key));
        expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE(key));
      }
      expect(res.body.data).not.toHaveProperty('apiKey');
    });

    it('uses a key sent in the request over the stored one, and does not echo it', async () => {
      await storeAllSecrets();
      okFetch();
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.post('/api/translate/test').send({ provider: 'openai', apiKey: 'TYPED-KEY' });

      expect(res.status).toBe(200);
      expect(wire()).toContain('Bearer TYPED-KEY');
      expect(wire()).not.toContain('SECRET-');
      expect(JSON.stringify(res.body)).not.toContain('TYPED-KEY');
    });

    it.each(['deepl', 'google'] as const)('rejects %s with no key before any fetch', async (provider) => {
      okFetch();
      const admin = await harness.loginAs(harness.admin);

      const res = await admin.post('/api/translate/test').send({ provider, apiKey: '' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TRANSLATION_CONFIG_INCOMPLETE');
      expect(res.body.missingFields).toHaveLength(1);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects an unknown provider and a non-string field', async () => {
      okFetch();
      const admin = await harness.loginAs(harness.admin);
      expect((await admin.post('/api/translate/test').send({ provider: 'nope' })).status).toBe(400);
      const res = await admin.post('/api/translate/test').send({ provider: 'openai', apiKey: { a: 1 } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_INPUT');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
