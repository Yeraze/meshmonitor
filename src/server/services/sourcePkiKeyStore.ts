/**
 * SourcePkiKeyStore
 *
 * Encrypts and persists a Meshtastic source's local-node X25519 PRIVATE key
 * (one per source) so MeshMonitor can decrypt PKI direct messages server-side
 * and surface them in the unified view (issue #3441). Mirrors the
 * MeshCoreCredentialStore design: AES-256-GCM with an HKDF-derived key from
 * `SESSION_SECRET`, with an envelope `kid` so a rotated secret is detected
 * (and the stale key cleared) rather than silently failing.
 *
 * Threat model (same as MeshCoreCredentialStore):
 *   - Defends against a DB-file-only exfil.
 *   - Does NOT defend against host compromise (the host can read SESSION_SECRET
 *     and the DB). Storing private keys here lets an attacker who already owns
 *     the host impersonate those nodes — the operator opts in per source.
 *
 * Capability gating: when SESSION_SECRET was auto-generated, `canStore` is
 * false (an ephemeral key would lose every stored private key on restart).
 */
import crypto from 'node:crypto';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';

const KDF_VERSION = 1;
const KDF_INFO_AEAD = 'source-pki-key-aead-v1';
const KDF_INFO_FINGERPRINT = 'source-pki-key-fingerprint-v1';

interface StoredEnvelope {
  v: number;
  kid: string;
  iv: string;
  ct: string;
  tag: string;
}

export interface PkiKeyStoreCapability {
  canStore: boolean;
  reason?: string;
}

export type PkiKeyLoadResult =
  | { kind: 'none' }
  | { kind: 'ok'; privateKey: Buffer }
  | { kind: 'key_rotated'; storedKid: string };

export class SourcePkiKeyStore {
  private readonly aeadKey: Buffer;
  private readonly currentKid: string;
  private readonly _capability: PkiKeyStoreCapability;

  constructor(sessionSecret: string, sessionSecretProvided: boolean) {
    this._capability = sessionSecretProvided
      ? { canStore: true }
      : {
          canStore: false,
          reason:
            'SESSION_SECRET was not configured; an auto-generated value is in use. ' +
            'Stored PKI private keys would be unrecoverable on every restart. ' +
            'Set SESSION_SECRET=$(openssl rand -hex 32) to enable PKI DM decryption persistence.',
        };
    const ikm = Buffer.from(sessionSecret, 'utf8');
    this.aeadKey = hkdfBytes(ikm, KDF_INFO_AEAD, 32);
    this.currentKid = hkdfBytes(ikm, KDF_INFO_FINGERPRINT, 4).toString('hex');
  }

  get capability(): PkiKeyStoreCapability {
    return this._capability;
  }

  /**
   * Encrypt and persist `privateKey` (raw 32 bytes) for a source, alongside the
   * clear `publicKey` (base64, for display). Throws when SESSION_SECRET is
   * auto-generated — callers should check `capability` first.
   */
  async store(sourceId: string, nodeNum: number | null, privateKey: Buffer, publicKeyB64: string | null): Promise<void> {
    if (!this._capability.canStore) {
      throw new Error('Cannot persist source PKI key: SESSION_SECRET is auto-generated');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.aeadKey, iv);
    const ct = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope: StoredEnvelope = {
      v: KDF_VERSION,
      kid: this.currentKid,
      iv: iv.toString('hex'),
      ct: ct.toString('hex'),
      tag: tag.toString('hex'),
    };
    await databaseService.sourcePkiKeys.upsert(sourceId, nodeNum, JSON.stringify(envelope), publicKeyB64);
  }

  /** Load + decrypt the stored private key for a source. */
  async load(sourceId: string): Promise<PkiKeyLoadResult> {
    const row = await databaseService.sourcePkiKeys.getBySourceId(sourceId);
    return this.decodeRow(row);
  }

  /**
   * Load + decrypt the stored private key for whichever source owns the given
   * local node identity — used by the decrypt hook to find the DESTINATION
   * node's key regardless of which source received the DM.
   */
  async loadByNodeNum(nodeNum: number): Promise<PkiKeyLoadResult> {
    const row = await databaseService.sourcePkiKeys.getByNodeNum(nodeNum);
    return this.decodeRow(row);
  }

  private decodeRow(row: { encryptedPrivateKey: string } | null): PkiKeyLoadResult {
    if (!row) return { kind: 'none' };

    let env: StoredEnvelope;
    try {
      env = JSON.parse(row.encryptedPrivateKey) as StoredEnvelope;
    } catch {
      logger.warn('[SourcePkiKeyStore] Malformed key envelope; treating as rotated');
      return { kind: 'key_rotated', storedKid: '?' };
    }
    if (env.v !== KDF_VERSION || env.kid !== this.currentKid) {
      return { kind: 'key_rotated', storedKid: env.kid ?? '?' };
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.aeadKey, Buffer.from(env.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(env.tag, 'hex'));
      const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, 'hex')), decipher.final()]);
      return { kind: 'ok', privateKey: pt };
    } catch (err) {
      logger.warn(`[SourcePkiKeyStore] Key decrypt failed despite matching kid: ${(err as Error).message}`);
      return { kind: 'key_rotated', storedKid: env.kid };
    }
  }

  /** Clear any stored key for a source. */
  async clear(sourceId: string): Promise<void> {
    await databaseService.sourcePkiKeys.deleteBySourceId(sourceId);
  }

  /** Whether a key row exists for a source (no decryption attempted). */
  async hasStored(sourceId: string): Promise<boolean> {
    return databaseService.sourcePkiKeys.hasKey(sourceId);
  }
}

function hkdfBytes(ikm: Buffer, info: string, length: number): Buffer {
  const salt = Buffer.alloc(32);
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

let singleton: SourcePkiKeyStore | null = null;

export function getSourcePkiKeyStore(): SourcePkiKeyStore {
  if (!singleton) {
    const { sessionSecret, sessionSecretProvided } = getEnvironmentConfig();
    singleton = new SourcePkiKeyStore(sessionSecret, sessionSecretProvided);
  }
  return singleton;
}

/** Test hook: replace or reset the singleton. */
export function setSourcePkiKeyStoreForTesting(store: SourcePkiKeyStore | null): void {
  singleton = store;
}
