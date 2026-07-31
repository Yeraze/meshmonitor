/**
 * meshcoreObserverToken
 *
 * Mints MeshCore Analyzer Observer auth tokens (JWT-style
 * `header.payload.signature`, Ed25519/orlp signature) using
 * `@michaelhart/meshcore-decoder` (#4457). The broker verifies tokens with
 * this same library.
 *
 * IMPORTANT — public key derivation (spec §2.2): the public key is NEVER the
 * second 32 bytes of the private key. orlp/ed25519 clamps
 * `private_key = clamp(SHA-512(seed))` (`[scalar‖nonce-prefix]`); the public
 * key is `scalarmult_base(scalar)`, which must be *derived* via
 * `Utils.derivePublicKey`. Slicing bytes 32..64 produces a public key the
 * broker will reject.
 *
 * WASM notes: `Utils.derivePublicKey`/`sign`/`verify` re-instantiate a fresh
 * WASM module on every call (deliberate library behavior). Fine for minting
 * a token once per TTL; never call this per packet — Phase 2's publisher
 * must cache the minted token, not re-mint on every observation.
 *
 * Logging discipline: never log the private key or a minted token, at any
 * level. WASM error messages (which can otherwise be verbose) are caught and
 * replaced with fixed, sanitized text so no key material escapes into a log
 * line or a thrown error's message.
 */
import { createAuthToken, Utils } from '@michaelhart/meshcore-decoder';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { observerConfigFromSource, type MeshCoreSourceConfig } from '../meshcoreConfig.js';
import { getMeshCoreObserverKeyStore } from './meshcoreObserverKeyStore.js';

/** Default token lifetime. Matches the broker README's 24h example. */
export const OBSERVER_TOKEN_TTL_SECONDS = 86_400;

export interface ObserverToken {
  /** JWT-style `header.payload.signature` (signature = 128 UPPER hex). SECRET — never log or return. */
  token: string;
  /** 32-byte hex UPPERCASE. Also the `{PUBLIC_KEY}` in username `v1_{PUBLIC_KEY}` and in topics. */
  publicKey: string;
  /** Unix seconds. */
  issuedAt: number;
  expiresAt: number;
}

/**
 * Derive the 32-byte public key from a 64-byte orlp private key. MUST go
 * through the library's WASM — the second 32 bytes of the private key are
 * the SHA-512 nonce prefix, NOT the public key (see module header / spec
 * §2.2). Throws a sanitized error on a structurally invalid / unclamped key
 * — never lets the underlying WASM message (which can embed input) escape.
 */
export async function deriveObserverPublicKey(privateKeyHex: string): Promise<string> {
  try {
    const pub = await Utils.derivePublicKey(privateKeyHex);
    return pub.toUpperCase();
  } catch {
    throw new Error('Invalid Analyzer Observer signing key: key derivation failed');
  }
}

/**
 * True iff `privateKeyHex` is 128 hex chars AND a valid orlp scalar (passes
 * the WASM's clamping check). Never throws — this is meant to be used as a
 * plain boolean gate in validation code.
 */
export async function isValidObserverPrivateKey(privateKeyHex: string): Promise<boolean> {
  if (typeof privateKeyHex !== 'string' || !/^[0-9a-fA-F]{128}$/.test(privateKeyHex)) {
    return false;
  }
  try {
    await Utils.derivePublicKey(privateKeyHex);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mint a token from raw material. Pure w.r.t. the DB — used directly by unit
 * tests and by `mintObserverTokenForSource` below.
 */
export async function mintObserverToken(
  privateKeyHex: string,
  audience: string,
  opts?: { ttlSeconds?: number; nowSeconds?: number },
): Promise<ObserverToken> {
  const iat = opts?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + (opts?.ttlSeconds ?? OBSERVER_TOKEN_TTL_SECONDS);
  const publicKey = await deriveObserverPublicKey(privateKeyHex);

  // `createAuthToken` mutates the payload object passed to it (uppercases
  // `publicKey`, defaults `iat`) — always construct a fresh object literal
  // per call so no caller-visible state is mutated.
  let token: string;
  try {
    token = await createAuthToken({ publicKey, aud: audience, iat, exp }, privateKeyHex, publicKey);
  } catch {
    throw new Error('Failed to mint Analyzer Observer auth token');
  }

  return { token, publicKey, issuedAt: iat, expiresAt: exp };
}

/**
 * Mint a token for a configured source: loads the stored signing key, reads
 * `observer.tokenAudience` from the source's saved config, derives the
 * public key, and signs.
 *
 * Returns null when: no key is stored, the stored envelope is rotated
 * (SESSION_SECRET changed), the source is not `meshcore`, or the `observer`
 * config block is absent/incomplete (mirrors `observerConfigFromSource`'s
 * own definition of "incomplete" — missing `brokerUrl`/`iataCode`/
 * `tokenAudience`, or not enabled).
 *
 * Not exposed via any route in Phase 1 — this exists so Phase 2's publisher
 * has a tested seam.
 */
export async function mintObserverTokenForSource(sourceId: string): Promise<ObserverToken | null> {
  const source = await databaseService.sources.getSource(sourceId);
  if (!source || source.type !== 'meshcore') return null;

  const cfg = (source.config ?? {}) as MeshCoreSourceConfig;
  const observer = observerConfigFromSource(cfg);
  // `observerConfigFromSource` only ever returns non-undefined once brokerUrl/
  // iataCode/tokenAudience are all present (see its own definition of
  // "incomplete"), but its declared type still marks tokenAudience optional —
  // narrow explicitly so this stays type-safe if that contract ever loosens.
  if (!observer || !observer.tokenAudience) return null;

  const keyResult = await getMeshCoreObserverKeyStore().load(sourceId);
  if (keyResult.kind !== 'ok') return null;

  try {
    return await mintObserverToken(keyResult.privateKeyHex, observer.tokenAudience);
  } catch (err) {
    // Never let a thrown error carry key material into the log.
    logger.warn(`[ObserverToken:${sourceId}] failed to mint token: ${(err as Error).message}`);
    return null;
  }
}
