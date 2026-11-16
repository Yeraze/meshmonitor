/**
 * Public-instance mode (#5156): cached config reader.
 *
 * The redaction middleware runs on every API response, so it reads this
 * module-level cache and never the database. `reloadPublicInstanceConfig()`
 * refreshes it at startup (before `app.listen`), after a settings save and
 * after a settings reset.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import {
  PUBLIC_INSTANCE_SETTING_KEYS,
  parsePublicInstanceConfig,
  type RedactionConfig,
} from '../../utils/publicInstanceMode.js';

let cached: Readonly<RedactionConfig> | null = null;

const KEYS = Object.values(PUBLIC_INSTANCE_SETTING_KEYS);

function freeze(config: RedactionConfig): Readonly<RedactionConfig> {
  return Object.freeze({ ...config });
}

/**
 * Current config. If nothing has loaded yet, does one synchronous load from
 * the settings cache so an early request is never served unredacted.
 */
export function getPublicInstanceConfig(): Readonly<RedactionConfig> {
  if (cached) return cached;
  const raw: Record<string, string | null> = {};
  for (const key of KEYS) raw[key] = databaseService.getSetting(key);
  cached = freeze(parsePublicInstanceConfig(raw));
  return cached;
}

/** Re-read the settings and replace the cache. */
export async function reloadPublicInstanceConfig(): Promise<void> {
  const raw: Record<string, string | null> = {};
  for (const key of KEYS) raw[key] = await databaseService.settings.getSetting(key);
  cached = freeze(parsePublicInstanceConfig(raw));
  logger.debug(`[PublicInstance] mode ${cached.enabled ? 'on' : 'off'}`);
}

/** Test hook: install a config directly. */
export function __setPublicInstanceConfigForTest(config: Partial<RedactionConfig>): void {
  cached = freeze({
    ...parsePublicInstanceConfig({}),
    ...config,
  });
}

/** Test hook: clear the cache so the next read loads afresh. */
export function __resetPublicInstanceConfigForTest(): void {
  cached = null;
}
