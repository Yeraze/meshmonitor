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

export function getScriptSecretsSnapshot(): ReadonlyMap<string, string> {
  return snapshot;
}

/** Mask that replaces a secret value in log text. */
export const SCRIPT_SECRET_MASK = '***';

/**
 * Replace every stored secret value in `text` with `***`. Used on script
 * stdout/stderr (and error text that embeds them) before the server logs it.
 * Longest values first, so a value that contains another is masked whole.
 */
export function scrubScriptSecrets(text: string): string;
export function scrubScriptSecrets(text: string | undefined | null): string | undefined | null;
export function scrubScriptSecrets(text: string | undefined | null): string | undefined | null {
  if (!text || snapshot.size === 0) return text;
  const values = [...snapshot.values()].filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(SCRIPT_SECRET_MASK);
  }
  return out;
}
