/**
 * Owner claims for the MeshCore Analyzer Observer auth token (#6454).
 *
 * LetsMesh and MeshMapper link an observer to an account through two optional
 * claims in the signed token: `owner` (the owner's MeshCore public key) and
 * `email`. The rules match `agessaman/meshcore-packet-capture`, so a broker
 * that accepts that client accepts ours.
 *
 * Shared by the server (config normalization) and the UI (inline validation),
 * so both apply the same rules. Pure: no logging, no I/O.
 */

/** Exactly 64 hex chars: a 32-byte MeshCore public key. */
const OWNER_PUBLIC_KEY_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Deliberately loose: one `@`, no spaces, a dot in the domain. The domain is
 * dot-separated labels with no dot inside a label, so the match is linear-time
 * (the earlier `[^\s@]+\.[^\s@]+` could backtrack polynomially, CodeQL #270).
 */
const OWNER_EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** RFC 5321 path limit; also bounds the work on hostile input. */
const OWNER_EMAIL_MAX_LENGTH = 254;

/** The claims as they go into the token payload. */
export interface ObserverOwnerClaims {
  owner?: string;
  email?: string;
}

/**
 * Trim, check and uppercase an owner public key. Returns `undefined` for an
 * empty value and `null` for an invalid one, so a caller can tell "not set"
 * from "set but wrong".
 */
export function normalizeOwnerPublicKey(value: unknown): string | undefined | null {
  if (typeof value !== 'string') return value === undefined || value === null ? undefined : null;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return OWNER_PUBLIC_KEY_RE.test(trimmed) ? trimmed.toUpperCase() : null;
}

/**
 * Trim, check and lowercase an owner email. Returns `undefined` for an empty
 * value and `null` for an invalid one.
 */
export function normalizeOwnerEmail(value: unknown): string | undefined | null {
  if (typeof value !== 'string') return value === undefined || value === null ? undefined : null;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > OWNER_EMAIL_MAX_LENGTH) return null;
  return OWNER_EMAIL_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** True when the value is empty or a valid owner public key. For form validation. */
export function isValidOwnerPublicKeyInput(value: string | undefined | null): boolean {
  return normalizeOwnerPublicKey(value ?? '') !== null;
}

/** True when the value is empty or a valid owner email. For form validation. */
export function isValidOwnerEmailInput(value: string | undefined | null): boolean {
  return normalizeOwnerEmail(value ?? '') !== null;
}
