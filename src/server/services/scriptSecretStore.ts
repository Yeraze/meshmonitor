/**
 * ScriptSecretStore
 *
 * Named values (API keys and the like) that every user script receives as
 * environment variables. Admins write them in Settings › Scripts; nothing
 * ever reads a value back out through the API.
 *
 * Encryption mirrors `meshcoreCredentialStore.ts`: AES-256-GCM with a key
 * HKDF-derived from SESSION_SECRET (zero salt), stored as
 * `{ v, kid, iv, ct, tag }` JSON. `kid` is a short fingerprint of the key, so
 * a row sealed under another SESSION_SECRET shows as `unreadable` instead of
 * failing on an auth tag.
 *
 * GLOBAL scope (a user decision): every script run on every source gets every
 * secret. Any uploaded script can read them, print them, or send them over
 * the mesh or the network. The UI and docs say so.
 *
 * Threat model: defends a DB-file-only or backup-file-only leak. Does NOT
 * defend against code running on the host, which can read SESSION_SECRET —
 * or simply run a script.
 *
 * Decrypted values live in `scriptSecretsSnapshot` so the spawn path stays
 * synchronous. `reloadCache()` refreshes it after every write, at boot, and
 * after a restore. Nothing in this file logs a value.
 */
import crypto from 'node:crypto';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { isReservedScriptSecretName, SCRIPT_SECRET_NAME_PATTERN } from '../utils/scriptRunner.js';
import { setScriptSecretsSnapshot } from '../utils/scriptSecretsSnapshot.js';

const KDF_VERSION = 1;
const KDF_INFO_AEAD = 'script-secrets-aead-v1';
const KDF_INFO_FINGERPRINT = 'script-secrets-fingerprint-v1';

export const MAX_SCRIPT_SECRETS = 50;
export const MAX_SCRIPT_SECRET_VALUE_LENGTH = 4096;

interface StoredEnvelope {
  v: number;
  kid: string;
  iv: string;
  ct: string;
  tag: string;
}

export interface ScriptSecretCapability {
  canStore: boolean;
  /** Why storing is off, for the UI. Present only when canStore=false. */
  reason?: string;
}

export interface ScriptSecretMetadata {
  name: string;
  updatedAt: number;
  /** `unreadable`: sealed under a different SESSION_SECRET (or corrupt). Re-enter it. */
  status: 'ok' | 'unreadable';
}

export type ScriptSecretErrorCode =
  | 'SESSION_SECRET_REQUIRED'
  | 'INVALID_SECRET_NAME'
  | 'RESERVED_SECRET_NAME'
  | 'INVALID_SECRET_VALUE'
  | 'TOO_MANY_SECRETS';

/** A refused write. `message` never contains the value. */
export class ScriptSecretError extends Error {
  constructor(
    readonly code: ScriptSecretErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ScriptSecretError';
  }
}

/** Error code for a bad name, or null when the name is usable. */
export function checkScriptSecretName(name: unknown): 'INVALID_SECRET_NAME' | 'RESERVED_SECRET_NAME' | null {
  if (typeof name !== 'string' || !SCRIPT_SECRET_NAME_PATTERN.test(name)) return 'INVALID_SECRET_NAME';
  if (isReservedScriptSecretName(name)) return 'RESERVED_SECRET_NAME';
  return null;
}

/** True when `value` may be stored: a 1–4096 character string with no NUL. */
export function isValidScriptSecretValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_SCRIPT_SECRET_VALUE_LENGTH &&
    !value.includes('\0')
  );
}

export class ScriptSecretStore {
  private readonly aeadKey: Buffer;
  private readonly currentKid: string;
  private readonly _capability: ScriptSecretCapability;

  constructor(sessionSecret: string, sessionSecretProvided: boolean) {
    this._capability = sessionSecretProvided
      ? { canStore: true }
      : {
          canStore: false,
          reason:
            'SESSION_SECRET is not set, so MeshMonitor generated one for this run. Secrets sealed with it ' +
            'could not be read after a restart. Set SESSION_SECRET=$(openssl rand -hex 32) in your ' +
            'environment to store script secrets.',
        };
    const ikm = Buffer.from(sessionSecret, 'utf8');
    this.aeadKey = hkdfBytes(ikm, KDF_INFO_AEAD, 32);
    this.currentKid = hkdfBytes(ikm, KDF_INFO_FINGERPRINT, 4).toString('hex');
  }

  get capability(): ScriptSecretCapability {
    return this._capability;
  }

  /** Validate, seal and save one secret, then refresh the snapshot. Throws ScriptSecretError. */
  async set(name: string, value: unknown): Promise<{ name: string; updatedAt: number; created: boolean }> {
    if (!this._capability.canStore) {
      throw new ScriptSecretError('SESSION_SECRET_REQUIRED', this._capability.reason ?? 'SESSION_SECRET is not set', 409);
    }
    const nameError = checkScriptSecretName(name);
    if (nameError === 'INVALID_SECRET_NAME') {
      throw new ScriptSecretError(
        nameError,
        'Name must be 1–64 characters: upper-case letters, digits and underscores, not starting with a digit',
        400,
      );
    }
    if (nameError === 'RESERVED_SECRET_NAME') {
      throw new ScriptSecretError(
        nameError,
        `${name} is reserved: scripts already get a variable by that name, or it controls the interpreter`,
        400,
      );
    }
    if (!isValidScriptSecretValue(value)) {
      throw new ScriptSecretError(
        'INVALID_SECRET_VALUE',
        `Value must be 1–${MAX_SCRIPT_SECRET_VALUE_LENGTH} characters with no NUL characters`,
        400,
      );
    }
    const repo = databaseService.scriptSecrets;
    if (!(await repo.exists(name)) && (await repo.count()) >= MAX_SCRIPT_SECRETS) {
      throw new ScriptSecretError('TOO_MANY_SECRETS', `At most ${MAX_SCRIPT_SECRETS} script secrets can be stored`, 400);
    }
    const result = await repo.upsert(name, JSON.stringify(this.seal(value)));
    await this.reloadCache();
    return { name, ...result };
  }

  /** Delete one secret. Returns false when none had that name. Works without SESSION_SECRET. */
  async delete(name: string): Promise<boolean> {
    const removed = await databaseService.scriptSecrets.delete(name);
    if (removed) await this.reloadCache();
    return removed;
  }

  /** Names, timestamps and readability. Never a value or an envelope. */
  async listMetadata(): Promise<ScriptSecretMetadata[]> {
    const rows = await databaseService.scriptSecrets.getAll();
    return rows.map((row) => ({
      name: row.name,
      updatedAt: row.updatedAt,
      status: this.isEnvelopeCurrent(row.encryptedValue) ? 'ok' : 'unreadable',
    }));
  }

  /**
   * Names whose envelope the current SESSION_SECRET cannot open, judged from
   * the envelope's version and key fingerprint only (no decrypt). Used after
   * a restore.
   */
  async findUnreadable(): Promise<string[]> {
    const rows = await databaseService.scriptSecrets.getAll();
    return rows.filter((row) => !this.isEnvelopeCurrent(row.encryptedValue)).map((row) => row.name);
  }

  /**
   * Decrypt every row into the in-memory snapshot. Never throws. Rows that
   * cannot be opened are skipped with one warning (count and names, never
   * values). On a database error the previous snapshot stays in place.
   */
  async reloadCache(): Promise<void> {
    let rows;
    try {
      rows = await databaseService.scriptSecrets.getAll();
    } catch (error) {
      logger.warn(`[ScriptSecrets] Could not load script secrets; keeping the previous set: ${(error as Error).message}`);
      return;
    }
    const next = new Map<string, string>();
    const skipped: string[] = [];
    for (const row of rows) {
      const value = this.open(row.encryptedValue);
      if (value === null) skipped.push(row.name);
      else next.set(row.name, value);
    }
    setScriptSecretsSnapshot(next);
    if (skipped.length > 0) {
      logger.warn(
        `[ScriptSecrets] ${skipped.length} script secret(s) cannot be decrypted with the current SESSION_SECRET ` +
          `and are not passed to scripts (${skipped.join(', ')}). Re-enter them in Settings › Scripts.`,
      );
    }
  }

  private seal(value: string): StoredEnvelope {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.aeadKey, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
    return {
      v: KDF_VERSION,
      kid: this.currentKid,
      iv: iv.toString('hex'),
      ct: ct.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
    };
  }

  private parse(raw: string): StoredEnvelope | null {
    try {
      const env = JSON.parse(raw) as StoredEnvelope;
      return env && typeof env === 'object' ? env : null;
    } catch {
      return null;
    }
  }

  private isEnvelopeCurrent(raw: string): boolean {
    const env = this.parse(raw);
    return env !== null && env.v === KDF_VERSION && env.kid === this.currentKid;
  }

  /** Plain value, or null when the envelope is foreign, stale or corrupt. */
  private open(raw: string): string | null {
    const env = this.parse(raw);
    if (!env || env.v !== KDF_VERSION || env.kid !== this.currentKid) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.aeadKey, Buffer.from(env.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(env.ct, 'hex')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}

/** HKDF-SHA256 with a fixed zero salt, so the key is a pure function of SESSION_SECRET. */
function hkdfBytes(ikm: Buffer, info: string, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(32), info, length));
}

let singleton: ScriptSecretStore | null = null;

export function getScriptSecretStore(): ScriptSecretStore {
  if (!singleton) {
    const { sessionSecret, sessionSecretProvided } = getEnvironmentConfig();
    singleton = new ScriptSecretStore(sessionSecret, sessionSecretProvided);
  }
  return singleton;
}

/** Test hook: replace the singleton, or pass null to rebuild it from the environment. */
export function setScriptSecretStoreForTesting(store: ScriptSecretStore | null): void {
  singleton = store;
}
