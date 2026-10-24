/**
 * Auto Ping settings: one parser and one reader for both the Meshtastic
 * route (`/api/settings/auto-ping`) and the MeshCore route
 * (`/api/sources/:id/meshcore/automation/auto-ping`, #5953), so the two can
 * never drift apart on ranges or defaults.
 *
 * Both protocols use the same per-source keys. A MeshCore source reads them
 * with `getSettingForSource`, exactly as Meshtastic does.
 */
import {
  AUTO_PING_DEFAULTS,
  AUTO_PING_MAX_PINGS_LIMIT,
  AUTO_PING_MIN_INTERVAL_SECONDS,
  AUTO_PING_MIN_TIMEOUT_SECONDS,
} from '../meshcoreAutoPing.js';

export type AutoPingSettingKey =
  | 'autoPingEnabled'
  | 'autoPingIntervalSeconds'
  | 'autoPingMaxPings'
  | 'autoPingTimeoutSeconds';

export interface AutoPingSettings {
  autoPingEnabled: boolean;
  autoPingIntervalSeconds: number;
  autoPingMaxPings: number;
  autoPingTimeoutSeconds: number;
}

export type AutoPingUpdateResult =
  | { ok: true; updates: Array<[AutoPingSettingKey, string]> }
  | { ok: false; code: string; message: string };

/**
 * Validate a save. Only the fields present are written. Ranges: interval
 * >= 10 s, max pings 1-100, timeout >= 10 s (the Meshtastic ranges).
 */
export function parseAutoPingSettingsUpdate(body: Record<string, unknown> | undefined): AutoPingUpdateResult {
  const b = body ?? {};
  const updates: Array<[AutoPingSettingKey, string]> = [];
  if (b.autoPingEnabled !== undefined) {
    updates.push(['autoPingEnabled', String(b.autoPingEnabled)]);
  }
  if (b.autoPingIntervalSeconds !== undefined) {
    const val = parseInt(String(b.autoPingIntervalSeconds), 10);
    if (isNaN(val) || val < AUTO_PING_MIN_INTERVAL_SECONDS) {
      return { ok: false, code: 'INVALID_INTERVAL', message: `Interval must be at least ${AUTO_PING_MIN_INTERVAL_SECONDS} seconds.` };
    }
    updates.push(['autoPingIntervalSeconds', String(val)]);
  }
  if (b.autoPingMaxPings !== undefined) {
    const val = parseInt(String(b.autoPingMaxPings), 10);
    if (isNaN(val) || val < 1 || val > AUTO_PING_MAX_PINGS_LIMIT) {
      return { ok: false, code: 'INVALID_MAX_PINGS', message: `Max pings must be between 1 and ${AUTO_PING_MAX_PINGS_LIMIT}.` };
    }
    updates.push(['autoPingMaxPings', String(val)]);
  }
  if (b.autoPingTimeoutSeconds !== undefined) {
    const val = parseInt(String(b.autoPingTimeoutSeconds), 10);
    if (isNaN(val) || val < AUTO_PING_MIN_TIMEOUT_SECONDS) {
      return { ok: false, code: 'INVALID_TIMEOUT', message: `Timeout must be at least ${AUTO_PING_MIN_TIMEOUT_SECONDS} seconds.` };
    }
    updates.push(['autoPingTimeoutSeconds', String(val)]);
  }
  return { ok: true, updates };
}

/** Read the four settings through `read`, with the shared defaults. */
export async function readAutoPingSettings(read: (key: AutoPingSettingKey) => Promise<string | null>): Promise<AutoPingSettings> {
  return {
    autoPingEnabled: (await read('autoPingEnabled')) === 'true',
    autoPingIntervalSeconds: parseInt((await read('autoPingIntervalSeconds')) || String(AUTO_PING_DEFAULTS.intervalSeconds), 10),
    autoPingMaxPings: parseInt((await read('autoPingMaxPings')) || String(AUTO_PING_DEFAULTS.maxPings), 10),
    autoPingTimeoutSeconds: parseInt((await read('autoPingTimeoutSeconds')) || String(AUTO_PING_DEFAULTS.timeoutSeconds), 10),
  };
}
