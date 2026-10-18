/**
 * Fill a saved MQTT broker preset's login into a config on save (#5794).
 *
 * Only admins are shown a preset's `username`/`password`. When anyone else
 * applies a preset that has them, the form leaves those fields blank and
 * sends `brokerPresetId`; the server copies the login in here, on save.
 *
 * Rules, the same for every form:
 *   - the config must still reach the preset's endpoint (host, port, TLS), or
 *     the save is refused. Otherwise an editor could aim the preset's login at
 *     a broker they run and read it there.
 *   - a field is filled only when the submitted value is blank. A value the
 *     user typed always wins.
 *   - `brokerPresetId` is removed before the config is stored or sent. The
 *     config holds a copy of the login, so editing or deleting the preset
 *     later changes nothing that is already saved.
 *
 * A password written to a radio is readable in that device's MQTT config
 * afterwards, by anyone who may read it. That is true of every device MQTT
 * password, not only preset ones.
 */
import databaseService from '../../services/database.js';
import {
  bridgeUrlReachesEndpoint,
  deviceFieldsReachEndpoint,
} from '../../utils/mqttBrokerEndpoint.js';
import type { MqttBrokerPreset } from '../../db/repositories/mqttBrokerPresets.js';

export type PresetFillErrorCode = 'BROKER_PRESET_INVALID' | 'BROKER_PRESET_NOT_FOUND' | 'BROKER_PRESET_ENDPOINT_MISMATCH';

export interface PresetFillError {
  status: 400 | 404;
  code: PresetFillErrorCode;
  message: string;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value === '');
}

/**
 * Remove `brokerPresetId` from `holder` and resolve it.
 * Returns `{ preset: null }` when no id was sent.
 */
async function takePreset(
  holder: Record<string, unknown>,
): Promise<{ preset: MqttBrokerPreset | null; error?: PresetFillError }> {
  if (!Object.prototype.hasOwnProperty.call(holder, 'brokerPresetId')) return { preset: null };
  const raw = holder.brokerPresetId;
  delete holder.brokerPresetId;
  if (raw === null || raw === undefined || raw === '') return { preset: null };
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return { preset: null, error: { status: 400, code: 'BROKER_PRESET_INVALID', message: 'brokerPresetId must be a positive integer' } };
  }
  const preset = await databaseService.mqttBrokerPresets.getAsync(id);
  if (!preset) {
    return { preset: null, error: { status: 404, code: 'BROKER_PRESET_NOT_FOUND', message: 'That saved broker preset no longer exists. Pick it again, or type the login.' } };
  }
  return { preset };
}

const MISMATCH: PresetFillError = {
  status: 400,
  code: 'BROKER_PRESET_ENDPOINT_MISMATCH',
  message: 'The broker address no longer matches the saved preset, so its login was not filled in. Pick the preset again, or type the login.',
};

function fillLogin(target: Record<string, unknown>, preset: MqttBrokerPreset): void {
  if (isBlank(target.username) && preset.username) target.username = preset.username;
  if (isBlank(target.password) && preset.password) target.password = preset.password;
}

/**
 * Device MQTT config (local `POST /config/mqtt` and remote-admin
 * `setMQTTConfig`): `{ address, tlsEnabled, username, password, … }`.
 * Mutates `config`. Returns an error to send, or null.
 */
export async function fillDeviceMqttFromPreset(config: Record<string, unknown>): Promise<PresetFillError | null> {
  const { preset, error } = await takePreset(config);
  if (error) return error;
  if (!preset) return null;
  const address = typeof config.address === 'string' ? config.address : '';
  if (!deviceFieldsReachEndpoint({ address, tlsEnabled: config.tlsEnabled === true }, preset)) return MISMATCH;
  fillLogin(config, preset);
  return null;
}

/**
 * mqtt_bridge source config: the id rides on `upstream.brokerPresetId`.
 * Mutates `config`. Returns an error to send, or null.
 */
export async function fillBridgeConfigFromPreset(config: Record<string, unknown>): Promise<PresetFillError | null> {
  const upstream = config.upstream;
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) return null;
  const up = upstream as Record<string, unknown>;
  const { preset, error } = await takePreset(up);
  if (error) return error;
  if (!preset) return null;
  if (!bridgeUrlReachesEndpoint(typeof up.url === 'string' ? up.url : '', preset)) return MISMATCH;
  fillLogin(up, preset);
  return null;
}

/**
 * Take `upstream.brokerPresetId` off an incoming bridge config without
 * resolving it, so the credential merge never sees it. Returns the raw id.
 */
export function detachBridgePresetId(config: Record<string, unknown>): unknown {
  const upstream = config.upstream;
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) return undefined;
  const up = upstream as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(up, 'brokerPresetId')) return undefined;
  const id = up.brokerPresetId;
  const rest = { ...up };
  delete rest.brokerPresetId;
  config.upstream = rest;
  return id;
}
