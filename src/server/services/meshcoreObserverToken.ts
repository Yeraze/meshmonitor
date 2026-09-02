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
 * Discriminated result for {@link mintObserverTokenForSourceDetailed}. Lets
 * the Phase 2 publisher distinguish *why* minting didn't produce a token —
 * `mintObserverTokenForSource`'s flat `null` collapses all of these into one
 * case, which is fine for Phase 1 but not enough for the publisher's
 * `lastError` surface (spec §3.3/§6).
 */
export type ObserverTokenResult =
  | { kind: 'ok'; token: ObserverToken }
  /** Source missing, not `meshcore`, or the `observer` config block absent/incomplete. */
  | { kind: 'not_configured' }
  /** No row in `meshcore_observer_keys` for this source. */
  | { kind: 'no_key' }
  /** Stored envelope was encrypted under a different `SESSION_SECRET`. */
  | { kind: 'key_rotated' }
  /** `mintObserverToken` threw (WASM/derive/sign failure). `message` is the
   *  sanitized library text — callers must log it at `debug` only and never
   *  surface it directly to a user (module header logging discipline). */
  | { kind: 'mint_failed'; message: string };

/**
 * Mint a token for a configured source: loads the stored signing key, derives
 * the public key, and signs. Unlike {@link mintObserverTokenForSource}, the
 * failure reason is distinguishable — see {@link ObserverTokenResult}.
 *
 * `audienceOverride` (#5014 Phase 1 WP3): when supplied, THIS audience is
 * used instead of `observer.tokenAudience` from the source's saved config,
 * and the "no tokenAudience -> not_configured" gate is skipped — the source
 * still needs to exist, be `meshcore`, and have an ENABLED observer block,
 * but need not carry a top-level `tokenAudience` at all. This is what lets
 * the multi-broker publisher mint one token per broker's own audience
 * (`brokers[i].tokenAudience`), which is not necessarily the block-level
 * mirror value. With no override, behaviour is byte-identical to before
 * `audienceOverride` existed.
 *
 * Not exposed via any route — this is the publisher's (Phase 2) seam.
 */
export async function mintObserverTokenForSourceDetailed(
  sourceId: string,
  audienceOverride?: string,
): Promise<ObserverTokenResult> {
  const source = await databaseService.sources.getSource(sourceId);
  if (!source || source.type !== 'meshcore') return { kind: 'not_configured' };

  const cfg = (source.config ?? {}) as MeshCoreSourceConfig;
  const observer = observerConfigFromSource(cfg);
  if (!observer) return { kind: 'not_configured' };
  // `observerConfigFromSource` only ever returns non-undefined once brokerUrl/
  // iataCode/tokenAudience are all present for `brokers[0]` (see its own
  // definition of "incomplete"), but its declared type still marks
  // `tokenAudience` optional — narrow explicitly so this stays type-safe if
  // that contract ever loosens. An explicit override bypasses this gate
  // entirely, since it supplies its own audience.
  const audience = audienceOverride ?? observer.tokenAudience;
  if (!audience) return { kind: 'not_configured' };

  const keyResult = await getMeshCoreObserverKeyStore().load(sourceId);
  if (keyResult.kind === 'none') return { kind: 'no_key' };
  if (keyResult.kind === 'key_rotated') return { kind: 'key_rotated' };

  try {
    const token = await mintObserverToken(keyResult.privateKeyHex, audience);
    return { kind: 'ok', token };
  } catch (err) {
    // Never let a thrown error carry key material into the log at anything
    // above debug — the message itself is the sanitized text from
    // `mintObserverToken`'s own catch, but treat it as sensitive regardless.
    const message = (err as Error).message;
    logger.debug(`[ObserverToken:${sourceId}] failed to mint token: ${message}`);
    return { kind: 'mint_failed', message };
  }
}

/**
 * Mint a token for a configured source, collapsed to Phase 1's flat
 * `ObserverToken | null` contract. Thin wrapper over
 * {@link mintObserverTokenForSourceDetailed} — kept so Phase 1 callers and
 * tests are unaffected by the WP3 refinement.
 *
 * Not exposed via any route in Phase 1 — this exists so Phase 2's publisher
 * has a tested seam.
 */
export async function mintObserverTokenForSource(sourceId: string): Promise<ObserverToken | null> {
  const r = await mintObserverTokenForSourceDetailed(sourceId);
  return r.kind === 'ok' ? r.token : null;
}
