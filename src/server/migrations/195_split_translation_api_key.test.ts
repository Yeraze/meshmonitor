/**
 * Migration 195 — one translation API key per provider (#5518).
 * Pure planner + real SQLite `up()` against in-memory better-sqlite3.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  migration,
  planTranslationApiKeySplit,
  PROVIDER_API_KEYS,
} from './195_split_translation_api_key.js';
import { TRANSLATION_PROVIDER_DESCRIPTORS, TRANSLATION_PROVIDER_IDS } from '../../types/translationProviders.js';

function seed(db: Database.Database, settings: Record<string, string>) {
  const stmt = db.prepare(`INSERT INTO settings (key, value, createdAt, updatedAt) VALUES (?, ?, 1, 1)`);
  for (const [k, v] of Object.entries(settings)) stmt.run(k, v);
}

function settingsMap(db: Database.Database): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const rows = (m: Record<string, string>) => Object.entries(m).map(([key, value]) => ({ key, value }));

describe('migration 195 frozen provider → key map', () => {
  it('matches the secret field each provider descriptor declares today', () => {
    // The map is frozen in the migration; this pins it to the descriptors as
    // of #5518. A provider added later needs no entry here (it never had a
    // shared key to move).
    for (const id of ['libretranslate', 'openai', 'deepl', 'google'] as const) {
      expect(TRANSLATION_PROVIDER_IDS).toContain(id);
      const secret = TRANSLATION_PROVIDER_DESCRIPTORS[id].fields.find((f) => f.kind === 'secret');
      expect(PROVIDER_API_KEYS[id]).toBe(secret?.settingKey);
    }
  });
});

describe('planTranslationApiKeySplit (pure)', () => {
  it('does nothing when there is no stored key', () => {
    expect(planTranslationApiKeySplit(rows({ translationProvider: 'deepl' }))).toEqual({ write: null, deleteKeys: [] });
  });

  it.each(Object.entries(PROVIDER_API_KEYS))('moves the key to the active provider (%s)', (provider, target) => {
    const plan = planTranslationApiKeySplit(rows({ translationProvider: provider, translationApiKey: ' k ' }));
    expect(plan).toEqual({ write: { key: target, value: 'k' }, deleteKeys: ['translationApiKey'] });
  });

  it('treats an unset or unknown provider as libretranslate', () => {
    expect(planTranslationApiKeySplit(rows({ translationApiKey: 'k' })).write)
      .toEqual({ key: 'translationLibreTranslateApiKey', value: 'k' });
    expect(planTranslationApiKeySplit(rows({ translationProvider: '__proto__', translationApiKey: 'k' })).write)
      .toEqual({ key: 'translationLibreTranslateApiKey', value: 'k' });
  });

  it('never overwrites a new key that already has a value, but still drops the old row', () => {
    const plan = planTranslationApiKeySplit(rows({
      translationProvider: 'deepl', translationApiKey: 'old', translationDeeplApiKey: 'new',
    }));
    expect(plan).toEqual({ write: null, deleteKeys: ['translationApiKey'] });
  });

  it('fills a new key that exists but is blank', () => {
    const plan = planTranslationApiKeySplit(rows({
      translationProvider: 'deepl', translationApiKey: 'old', translationDeeplApiKey: '',
    }));
    expect(plan.write).toEqual({ key: 'translationDeeplApiKey', value: 'old' });
  });

  it('drops a blank old key without writing anything', () => {
    expect(planTranslationApiKeySplit(rows({ translationProvider: 'google', translationApiKey: '' })))
      .toEqual({ write: null, deleteKeys: ['translationApiKey'] });
  });

  it('deletes per-source copies of the old key and nothing else', () => {
    const plan = planTranslationApiKeySplit(rows({
      'source:a:translationApiKey': 'stale', translationProvider: 'openai',
    }));
    expect(plan).toEqual({ write: null, deleteKeys: ['source:a:translationApiKey'] });
  });
});

describe('migration 195 — SQLite', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );`);
  });

  it('gives the key to the active provider only, removes the old row, and is a no-op on re-run', () => {
    seed(db, {
      translationProvider: 'deepl',
      translationApiKey: 'deepl-key:fx',
      translationUrl: 'http://libre:5000',
      translationModel: 'llama3',
      'source:a:translationApiKey': 'stale',
      maxNodeAgeHours: '24',
    });
    migration.up(db);
    const after = settingsMap(db);
    expect(after).toEqual({
      translationProvider: 'deepl',
      translationDeeplApiKey: 'deepl-key:fx',
      translationUrl: 'http://libre:5000',
      translationModel: 'llama3',
      maxNodeAgeHours: '24',
    });
    // Other providers start blank: no row at all.
    for (const key of ['translationLibreTranslateApiKey', 'translationOpenAiApiKey', 'translationGoogleApiKey']) {
      expect(after).not.toHaveProperty(key);
    }

    migration.up(db);
    expect(settingsMap(db)).toEqual(after);
  });

  it('defaults to libretranslate when no provider is stored', () => {
    seed(db, { translationApiKey: 'libre-key' });
    migration.up(db);
    expect(settingsMap(db)).toEqual({ translationLibreTranslateApiKey: 'libre-key' });
  });

  it('does not overwrite an existing new key', () => {
    seed(db, { translationProvider: 'openai', translationApiKey: 'old', translationOpenAiApiKey: 'sk-new' });
    migration.up(db);
    expect(settingsMap(db)).toEqual({ translationProvider: 'openai', translationOpenAiApiKey: 'sk-new' });
  });

  it('does nothing when no key was ever stored', () => {
    seed(db, { translationProvider: 'google', translationEnabled: 'true' });
    migration.up(db);
    expect(settingsMap(db)).toEqual({ translationProvider: 'google', translationEnabled: 'true' });
  });

  it('runs on an empty settings table (fresh install replay)', () => {
    migration.up(db);
    expect(settingsMap(db)).toEqual({});
  });
});
