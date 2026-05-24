/**
 * MeshCoreCredentialStore
 *
 * Encrypts and persists MeshCore remote-admin passwords (one per
 * (sourceId, publicKey) pair) using AES-256-GCM with an HKDF-derived key
 * from `SESSION_SECRET`. The on-disk envelope carries a short
 * "key fingerprint" (kid) so that a rotated SESSION_SECRET can be detected
 * and surfaced to the user as `key_rotated` rather than silently failing
 * with an auth-tag error.
 *
 * Threat model:
 *   - Defends against a DB-file-only exfil (someone grabs `meshmonitor.db`
 *     without the host environment).
 *   - Does NOT defend against a server compromise. Anyone running code on
 *     the host can read SESSION_SECRET and the DB.
 *
 * Capability gating:
 *   - When SESSION_SECRET was NOT explicitly configured (i.e. the
 *     environment loader auto-generated one), `canRemember` is false.
 *     The UI hides the "Remember password" checkbox and routes reject
 *     persistence attempts: encrypting against an ephemeral key would
 *     lose every saved password on every restart, which is worse than
 *     just re-prompting.
 *
 * On-disk envelope shape (JSON in `meshcore_nodes.adminCredential`):
 *   { v: 1, kid: "<8 hex>", iv: "<24 hex>", ct: "<hex>", tag: "<32 hex>" }
 */

import crypto from 'node:crypto';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';

/** KDF version stamped into each envelope. Bump if the HKDF info-strings
 *  or AEAD parameters ever change so old rows route through key_rotated. */
const KDF_VERSION = 1;
const KDF_INFO_AEAD = 'meshcore-admin-creds-aead-v1';
const KDF_INFO_FINGERPRINT = 'meshcore-admin-creds-fingerprint-v1';

interface StoredEnvelope {
  v: number;
  kid: string;
  iv: string;
  ct: string;
  tag: string;
}

export interface CredentialCapability {
  canRemember: boolean;
  /** Human-readable explanation when canRemember=false, surfaced to the UI. */
  reason?: string;
}

export type CredentialLoadResult =
  | { kind: 'none' }
  | { kind: 'ok'; password: string }
  | { kind: 'key_rotated'; storedKid: string };

export interface RotatedCredentialEntry {
  sourceId: string;
  publicKey: string;
  name: string | null;
  storedKid: string;
}

export interface StoredCredentialEntry {
  sourceId: string;
  publicKey: string;
  name: string | null;
}

export class MeshCoreCredentialStore {
  private readonly aeadKey: Buffer;
  private readonly currentKid: string;
  private readonly _capability: CredentialCapability;

  constructor(sessionSecret: string, sessionSecretProvided: boolean) {
    this._capability = sessionSecretProvided
      ? { canRemember: true }
      : {
          canRemember: false,
          reason:
            'SESSION_SECRET was not configured; an auto-generated value is in use. ' +
            'Saved credentials would be unrecoverable on every restart. ' +
            'Set SESSION_SECRET=$(openssl rand -hex 32) in your environment to enable saved passwords.',
        };
    const ikm = Buffer.from(sessionSecret, 'utf8');
    this.aeadKey = hkdfBytes(ikm, KDF_INFO_AEAD, 32);
    this.currentKid = hkdfBytes(ikm, KDF_INFO_FINGERPRINT, 4).toString('hex');
  }

  get capability(): CredentialCapability {
    return this._capability;
  }

  /** First 8 hex chars of the HKDF fingerprint of the current SESSION_SECRET.
   *  Exposed mostly for tests; consumers should use `load()` and react to
   *  the `key_rotated` result rather than comparing fingerprints themselves. */
  get currentFingerprint(): string {
    return this.currentKid;
  }

  /**
   * Encrypt and persist `password` for the given target. Throws when
   * SESSION_SECRET is auto-generated — callers must check `capability`
   * first, or expect the throw and translate to a 400 at the route layer.
   */
  async store(sourceId: string, publicKey: string, password: string): Promise<void> {
    if (!this._capability.canRemember) {
      throw new Error(
        'Cannot persist MeshCore admin credential: SESSION_SECRET is auto-generated',
      );
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.aeadKey, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(password, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: StoredEnvelope = {
      v: KDF_VERSION,
      kid: this.currentKid,
      iv: iv.toString('hex'),
      ct: ct.toString('hex'),
      tag: tag.toString('hex'),
    };
    await databaseService.meshcore.setAdminCredential(
      sourceId,
      publicKey,
      JSON.stringify(envelope),
    );
  }

  /**
   * Load and decrypt the stored credential. Returns one of:
   *   - `{ kind: 'none' }` when nothing is saved.
   *   - `{ kind: 'ok', password }` on success.
   *   - `{ kind: 'key_rotated', storedKid }` when the envelope was
   *     encrypted with a different SESSION_SECRET (most common cause:
   *     operator rotated the env var). The caller surfaces this in the UI
   *     so the user can re-enter the password.
   */
  async load(sourceId: string, publicKey: string): Promise<CredentialLoadResult> {
    const raw = await databaseService.meshcore.getAdminCredential(sourceId, publicKey);
    if (!raw) return { kind: 'none' };

    let env: StoredEnvelope;
    try {
      env = JSON.parse(raw) as StoredEnvelope;
    } catch {
      logger.warn(
        `[MeshCoreCredentialStore] Malformed adminCredential for ${sourceId}/${publicKey.substring(0, 8)}; treating as rotated`,
      );
      return { kind: 'key_rotated', storedKid: '?' };
    }

    if (env.v !== KDF_VERSION || env.kid !== this.currentKid) {
      return { kind: 'key_rotated', storedKid: env.kid ?? '?' };
    }

    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.aeadKey,
        Buffer.from(env.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
      const pt = Buffer.concat([
        decipher.update(Buffer.from(env.ct, 'hex')),
        decipher.final(),
      ]);
      return { kind: 'ok', password: pt.toString('utf8') };
    } catch (err) {
      // kid matched but decrypt failed. Either an upgrade hazard or row
      // corruption — treat as rotated so the user re-enters rather than
      // silently proceeding with a broken credential.
      logger.warn(
        `[MeshCoreCredentialStore] Decrypt failed for ${sourceId}/${publicKey.substring(0, 8)} despite matching kid: ${(err as Error).message}`,
      );
      return { kind: 'key_rotated', storedKid: env.kid };
    }
  }

  /** Clear any saved credential for the target. No-op if none exists. */
  async clear(sourceId: string, publicKey: string): Promise<void> {
    await databaseService.meshcore.setAdminCredential(sourceId, publicKey, null);
  }

  /**
   * Enumerate every stored credential whose envelope cannot be decrypted
   * by the current SESSION_SECRET. Cheap because we only inspect the
   * envelope's `kid` and `v` — we never attempt the AEAD until the user
   * actually asks to use the credential.
   *
   * Used by the startup banner: if this returns N>0 entries, the UI shows
   * "N saved MeshCore admin passwords need to be re-entered after a key
   * change." Aggregating once at boot avoids surprising the user with N
   * separate banners during their first session.
   */
  async listRotated(): Promise<RotatedCredentialEntry[]> {
    const rows = await databaseService.meshcore.listAdminCredentials();
    const out: RotatedCredentialEntry[] = [];
    for (const row of rows) {
      let env: StoredEnvelope;
      try {
        env = JSON.parse(row.adminCredential) as StoredEnvelope;
      } catch {
        out.push({
          sourceId: row.sourceId,
          publicKey: row.publicKey,
          name: row.name,
          storedKid: '?',
        });
        continue;
      }
      if (env.v !== KDF_VERSION || env.kid !== this.currentKid) {
        out.push({
          sourceId: row.sourceId,
          publicKey: row.publicKey,
          name: row.name,
          storedKid: env.kid ?? '?',
        });
      }
    }
    return out;
  }

  /**
   * Enumerate every stored credential whose envelope CAN be decrypted by
   * the current SESSION_SECRET (i.e. kid matches + KDF version current).
   * The UI uses this on console mount to decide whether to silently
   * attempt an auto-login or prompt for a password.
   *
   * Returns only metadata — never the password or the envelope itself.
   */
  async listStored(): Promise<StoredCredentialEntry[]> {
    const rows = await databaseService.meshcore.listAdminCredentials();
    const out: StoredCredentialEntry[] = [];
    for (const row of rows) {
      let env: StoredEnvelope;
      try {
        env = JSON.parse(row.adminCredential) as StoredEnvelope;
      } catch {
        continue;
      }
      if (env.v === KDF_VERSION && env.kid === this.currentKid) {
        out.push({
          sourceId: row.sourceId,
          publicKey: row.publicKey,
          name: row.name,
        });
      }
    }
    return out;
  }
}

/**
 * HKDF-SHA256 wrapper returning a Buffer. We use a stable zero salt because
 * the IKM (SESSION_SECRET) is itself high-entropy and we need the derivation
 * to be deterministic — persisting a random salt in the DB would re-introduce
 * the key-rotation problem we're trying to detect.
 */
function hkdfBytes(ikm: Buffer, info: string, length: number): Buffer {
  const salt = Buffer.alloc(32);
  const derived = crypto.hkdfSync('sha256', ikm, salt, info, length);
  return Buffer.from(derived);
}

// ---------------------------------------------------------------------------
// Module-level singleton — lazily constructed so tests can inject their own
// secret via `setMeshCoreCredentialStoreForTesting`. The runtime path
// initializes from the environment config on first access.
// ---------------------------------------------------------------------------

let singleton: MeshCoreCredentialStore | null = null;

export function getMeshCoreCredentialStore(): MeshCoreCredentialStore {
  if (!singleton) {
    const { sessionSecret, sessionSecretProvided } = getEnvironmentConfig();
    singleton = new MeshCoreCredentialStore(sessionSecret, sessionSecretProvided);
  }
  return singleton;
}

/** Test hook: replace the singleton with a custom instance, or pass null
 *  to force re-initialization on the next access. */
export function setMeshCoreCredentialStoreForTesting(
  store: MeshCoreCredentialStore | null,
): void {
  singleton = store;
}
