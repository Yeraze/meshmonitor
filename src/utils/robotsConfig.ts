/**
 * Global "discourage search-engine / LLM indexing" gate (issue #4202).
 *
 * Backs the `noIndexEnabled` setting. When enabled (opt-in, default OFF), the
 * server:
 *   1. Emits an `X-Robots-Tag: noindex, nofollow` response header on every
 *      request via {@link robotsTagMiddleware}, and
 *   2. Serves a disallow-all `/robots.txt` body.
 *
 * The header path is the primary mechanism, but some reverse-proxy setups
 * (notably Cloudflare tunnels) strip custom response headers at the edge — the
 * dynamic `/robots.txt` body survives that because proxies don't rewrite
 * response bodies, so both are offered together.
 *
 * The value is cached in this module rather than read from the DB per request:
 * the setting is GLOBAL (not per-source) and changes rarely, but the gate runs
 * on the HTTP hot path. A single module-level flag, seeded at startup and
 * refreshed by the settings-save callback, gives the middleware a zero-DB read.
 */

// Default OFF = do not add noindex directives = the behavior before this setting existed.
let noIndexEnabled = false;

/** Current value of the global no-index gate. */
export function getNoIndexEnabled(): boolean {
  return noIndexEnabled;
}

/** Update the cached gate (called at startup and from the settings-save callback). */
export function setNoIndexEnabled(enabled: boolean): void {
  noIndexEnabled = enabled;
}

/**
 * Parse the stored setting value into a boolean with a default-OFF policy:
 * only an explicit `'1'` / `'true'` → `true`; an absent value or anything else
 * → `false`. Mirrors the frontend parse in SettingsContext.
 */
export function parseNoIndexEnabled(raw: string | null | undefined): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * Reset the cached flag to its factory default (`false`). Exported for test
 * isolation only — a suite that flips the flag must restore it in teardown so it
 * cannot bleed into other tests (the flag is a process-global module singleton).
 */
export function __resetNoIndexEnabledForTest(): void {
  noIndexEnabled = false;
}
