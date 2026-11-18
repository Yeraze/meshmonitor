/**
 * In-memory copy of the decrypted script secrets (name -> value).
 *
 * `scriptRunner` reads it on every spawn, so it must stay synchronous and
 * free of database imports. `scriptSecretStore.reloadCache()` is the only
 * writer. Never log the map or any value in it.
 */

let snapshot: ReadonlyMap<string, string> = new Map();

/** Replace the snapshot. The store calls this after every load or change. */
export function setScriptSecretsSnapshot(next: ReadonlyMap<string, string>): void {
  snapshot = new Map(next);
}

/** Drop one name now, so a deleted secret stops reaching scripts even if the reload that follows fails. */
export function removeFromScriptSecretsSnapshot(name: string): void {
  if (!snapshot.has(name)) return;
  const next = new Map(snapshot);
  next.delete(name);
  snapshot = next;
}

export function getScriptSecretsSnapshot(): ReadonlyMap<string, string> {
  return snapshot;
}

/** Mask that replaces a secret value in log text. */
export const SCRIPT_SECRET_MASK = '***';

/**
 * Shorter values are not masked: masking a 3-character value garbles every
 * log line and, by where the `***` lands, still shows what it was.
 */
export const MIN_MASKED_SECRET_LENGTH = 8;

/**
 * Replace every stored secret value in `text` with `***`. Used on script
 * stdout/stderr (and error text that embeds them) before the server logs it.
 * Longest values first, so a value that contains another is masked whole.
 *
 * Best effort: it matches the value as stored, not an encoded form (base64,
 * URL-encoded, split across lines), and skips values shorter than
 * MIN_MASKED_SECRET_LENGTH.
 */
export function scrubScriptSecrets(text: string): string {
  if (!text || snapshot.size === 0) return text;
  const values = [...snapshot.values()]
    .filter((v) => v.length >= MIN_MASKED_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(SCRIPT_SECRET_MASK);
  }
  return out;
}
