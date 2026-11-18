/**
 * ScriptSecretStore — sealing round-trip, nothing stored in the clear,
 * key-change detection, capability gating, validation, the 50-secret cap,
 * and the in-memory snapshot the script spawn path reads.
 *
 * Runs against the real `:memory:` DatabaseService singleton (all migrations,
 * so this also exercises migration 240 through the registry).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import databaseService from '../../services/database.js';
import {
  ScriptSecretStore,
  ScriptSecretError,
  MAX_SCRIPT_SECRETS,
  checkScriptSecretName,
  isValidScriptSecretValue,
} from './scriptSecretStore.js';
import {
  getScriptSecretsSnapshot,
  setScriptSecretsSnapshot,
  scrubScriptSecrets,
} from '../utils/scriptSecretsSnapshot.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const VALUE = 'sk-live-THIS-IS-THE-SENTINEL-VALUE-9f3c';

async function clearAll(): Promise<void> {
  for (const row of await databaseService.scriptSecrets.listMetadata()) {
    await databaseService.scriptSecrets.delete(row.name);
  }
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(ScriptSecretError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('ScriptSecretStore', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
  });
  beforeEach(async () => {
    await clearAll();
    setScriptSecretsSnapshot(new Map());
  });
  afterAll(async () => {
    await clearAll();
    setScriptSecretsSnapshot(new Map());
  });

  it('seals the value: the stored row never holds it in the clear', async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    const result = await store.set('OPENAI_API_KEY', VALUE);
    expect(result).toMatchObject({ name: 'OPENAI_API_KEY', created: true });
    const rows = await databaseService.scriptSecrets.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].encryptedValue).not.toContain(VALUE);
    expect(JSON.parse(rows[0].encryptedValue)).toMatchObject({ v: 1 });
  });

  it('decrypts into the snapshot after a write, and replaces on update', async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    await store.set('WEATHER_KEY', VALUE);
    expect(getScriptSecretsSnapshot().get('WEATHER_KEY')).toBe(VALUE);
    const second = await store.set('WEATHER_KEY', 'other-value');
    expect(second.created).toBe(false);
    expect(getScriptSecretsSnapshot().get('WEATHER_KEY')).toBe('other-value');
  });

  it('listMetadata returns names, times and status only', async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    await store.set('WEATHER_KEY', VALUE);
    const meta = await store.listMetadata();
    expect(meta).toEqual([{ name: 'WEATHER_KEY', updatedAt: expect.any(Number), status: 'ok' }]);
    expect(JSON.stringify(meta)).not.toContain(VALUE);
  });

  it('marks rows sealed under another SESSION_SECRET unreadable and keeps them out of the snapshot', async () => {
    await new ScriptSecretStore(KEY_A, true).set('WEATHER_KEY', VALUE);
    const other = new ScriptSecretStore(KEY_B, true);
    expect(await other.listMetadata()).toEqual([
      { name: 'WEATHER_KEY', updatedAt: expect.any(Number), status: 'unreadable' },
    ]);
    expect(await other.findUnreadable()).toEqual(['WEATHER_KEY']);
    await other.reloadCache();
    expect(getScriptSecretsSnapshot().has('WEATHER_KEY')).toBe(false);
  });

  it('treats a corrupt envelope as unreadable without throwing', async () => {
    await databaseService.scriptSecrets.upsert('BROKEN', 'not json');
    const store = new ScriptSecretStore(KEY_A, true);
    await expect(store.reloadCache()).resolves.toBeUndefined();
    expect(await store.findUnreadable()).toEqual(['BROKEN']);
  });

  it('refuses to store when SESSION_SECRET was not provided, but still deletes', async () => {
    const store = new ScriptSecretStore(KEY_A, false);
    expect(store.capability.canStore).toBe(false);
    expect(store.capability.reason).toMatch(/SESSION_SECRET/);
    await expectCode(store.set('WEATHER_KEY', VALUE), 'SESSION_SECRET_REQUIRED');
    await new ScriptSecretStore(KEY_A, true).set('WEATHER_KEY', VALUE);
    expect(await store.delete('WEATHER_KEY')).toBe(true);
    expect(await store.delete('WEATHER_KEY')).toBe(false);
  });

  it('validates names and values', async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    await expectCode(store.set('lower_case', VALUE), 'INVALID_SECRET_NAME');
    await expectCode(store.set('1STARTS_WITH_DIGIT', VALUE), 'INVALID_SECRET_NAME');
    await expectCode(store.set('A'.repeat(65), VALUE), 'INVALID_SECRET_NAME');
    await expectCode(store.set('HAS-DASH', VALUE), 'INVALID_SECRET_NAME');
    await expectCode(store.set('PATH', VALUE), 'RESERVED_SECRET_NAME');
    await expectCode(store.set('SESSION_SECRET', VALUE), 'RESERVED_SECRET_NAME');
    await expectCode(store.set('DATABASE_URL', VALUE), 'RESERVED_SECRET_NAME');
    await expectCode(store.set('PARAM_CITY', VALUE), 'RESERVED_SECRET_NAME');
    await expectCode(store.set('MESSAGE', VALUE), 'RESERVED_SECRET_NAME');
    await expectCode(store.set('OK_NAME', ''), 'INVALID_SECRET_VALUE');
    await expectCode(store.set('OK_NAME', 'a\0b'), 'INVALID_SECRET_VALUE');
    await expectCode(store.set('OK_NAME', 'x'.repeat(4097)), 'INVALID_SECRET_VALUE');
    await expectCode(store.set('OK_NAME', 42), 'INVALID_SECRET_VALUE');
    expect(await databaseService.scriptSecrets.count()).toBe(0);
  });

  it('allows names that only look secret (the filter pattern), e.g. *_API_KEY / *_TOKEN', () => {
    expect(checkScriptSecretName('OPENAI_API_KEY')).toBeNull();
    expect(checkScriptSecretName('GITHUB_TOKEN')).toBeNull();
    expect(checkScriptSecretName('LD_PRELOAD')).toBe('RESERVED_SECRET_NAME');
    expect(checkScriptSecretName('NODE_OPTIONS')).toBe('RESERVED_SECRET_NAME');
    expect(checkScriptSecretName('PYTHONPATH')).toBe('RESERVED_SECRET_NAME');
    expect(isValidScriptSecretValue('x'.repeat(4096))).toBe(true);
  });

  it(`caps the store at ${MAX_SCRIPT_SECRETS} names, but still lets an existing one be replaced`, async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    for (let i = 0; i < MAX_SCRIPT_SECRETS; i++) {
      await databaseService.scriptSecrets.upsert(`KEY_${i}`, '{}');
    }
    await expectCode(store.set('ONE_MORE', VALUE), 'TOO_MANY_SECRETS');
    await expect(store.set('KEY_0', VALUE)).resolves.toMatchObject({ created: false });
  });

  it('error messages never contain the value', async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    for (const name of ['bad', 'PATH']) {
      try {
        await store.set(name, VALUE);
      } catch (error) {
        expect((error as Error).message).not.toContain(VALUE);
      }
    }
  });
});

describe('scrubScriptSecrets', () => {
  afterAll(() => setScriptSecretsSnapshot(new Map()));

  it('masks every stored value, longest first', () => {
    setScriptSecretsSnapshot(new Map([['A', 'abcdefgh'], ['B', 'abcdefghijkl']]));
    expect(scrubScriptSecrets('x abcdefghijkl y abcdefgh z')).toBe('x *** y *** z');
  });

  it('leaves values shorter than 8 characters alone', () => {
    setScriptSecretsSnapshot(new Map([['A', 'abc1234']]));
    expect(scrubScriptSecrets('abc1234')).toBe('abc1234');
  });

  it('passes text through when nothing is stored', () => {
    setScriptSecretsSnapshot(new Map());
    expect(scrubScriptSecrets('abc')).toBe('abc');
    expect(scrubScriptSecrets('')).toBe('');
  });
});

describe('ScriptSecretStore hardening', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
  });
  beforeEach(async () => {
    await clearAll();
    setScriptSecretsSnapshot(new Map());
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await clearAll();
    setScriptSecretsSnapshot(new Map());
  });

  it('binds the envelope to its name: a row copied to another name does not open', async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    await store.set('SOURCE_KEY', VALUE);
    const [row] = await databaseService.scriptSecrets.getAll();
    await databaseService.scriptSecrets.upsert('OTHER_KEY', row.encryptedValue);
    await store.reloadCache();
    expect(getScriptSecretsSnapshot().get('SOURCE_KEY')).toBe(VALUE);
    expect(getScriptSecretsSnapshot().has('OTHER_KEY')).toBe(false);
    const meta = await store.listMetadata();
    expect(meta.find((m) => m.name === 'OTHER_KEY')?.status).toBe('unreadable');
    expect(meta.find((m) => m.name === 'SOURCE_KEY')?.status).toBe('ok');
  });

  it('revokes a deleted secret even when the reload after the delete fails', async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    await store.set('GONE_KEY', VALUE);
    const spy = vi.spyOn(databaseService.scriptSecrets, 'getAll').mockRejectedValueOnce(new Error('db down'));
    expect(await store.delete('GONE_KEY')).toBe(true);
    expect(getScriptSecretsSnapshot().has('GONE_KEY')).toBe(false);
    spy.mockRestore();
  });

  it('an older reload that finishes last does not overwrite a newer snapshot', async () => {
    const store = new ScriptSecretStore(KEY_A, true);
    await store.set('RACE_KEY', VALUE);
    const stale = await databaseService.scriptSecrets.getAll(); // still holds RACE_KEY
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const spy = vi
      .spyOn(databaseService.scriptSecrets, 'getAll')
      .mockImplementationOnce(async () => { await gate; return stale; });
    const older = store.reloadCache(); // reads the stale rows, slowly
    spy.mockRestore();
    expect(await store.delete('RACE_KEY')).toBe(true); // newer reload, no RACE_KEY
    release();
    await older;
    expect(getScriptSecretsSnapshot().has('RACE_KEY')).toBe(false);
  });
});
