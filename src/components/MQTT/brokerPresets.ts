/**
 * MQTT broker presets for the three Meshtastic-side MQTT forms (#5689):
 *
 *   - device MQTT config      (configuration/MQTTConfigSection.tsx)
 *   - remote-admin MQTT config (admin-commands/ModuleConfigurationSection.tsx)
 *   - MQTT bridge source       (MQTT/MqttBridgeConfigurationView.tsx)
 *
 * This file is the ONLY place a preset is defined. Each form maps a preset
 * onto its own fields through the functions below, so the forms cannot drift:
 *
 *   device / remote admin  `address` is a bare host (firmware also accepts
 *                          host:port), TLS is the `tlsEnabled` flag, and an
 *                          EMPTY address means "the default public server".
 *   bridge                 one URL with scheme and port: `mqtt://host:1883`
 *                          or `mqtts://host:8883`.
 *
 * A preset owns the broker endpoint and its login, nothing else. Root topic,
 * payload encryption, JSON, client proxy, map reporting, channel uplink and
 * downlink, and every bridge filter stay as they are.
 *
 * Choosing a preset only edits the form. Nothing is saved or sent to a radio
 * until the user saves, exactly as if they had typed the values.
 *
 * Sources (read 2026-10-09):
 * - https://meshtastic.org/docs/configuration/module/mqtt/ — the CLI table
 *   lists the defaults: `mqtt.address` `mqtt.meshtastic.org`, `mqtt.username`
 *   `meshdev`, `mqtt.password` `large4cats`, `mqtt.tls_enabled` `false`; and
 *   "Server Address … If not set, the default public server will be used."
 * - https://meshtastic.org/docs/software/integrations/mqtt/ — "If no specific
 *   root topic is configured, the default root topic will be `msh/REGION`."
 * - meshtastic/firmware src/mqtt/MQTT.cpp: `defaultPort = 1883`,
 *   `defaultPortTls = 8883`, and `tls_enabled` switches the port to 8883; the
 *   default server is accepted on either port. src/mesh/Default.h holds the
 *   same address and login. The docs do not name the ports or say the public
 *   broker serves TLS; a live MQTT CONNECT with meshdev/large4cats got CONNACK
 *   0 on both 1883 and 8883 (8883: valid Let's Encrypt certificate), and no
 *   WebSocket listener answered on 443, so there is no WebSocket preset.
 *
 * Adding a broker (Phase 2 of #5689) needs its operator's consent: one entry
 * here, its `labelKey` in public/locales/en.json, a source line above, and a
 * row in docs/features/mqtt-broker.md.
 *
 * Saved presets (#5794) are the brokers an admin saved; `savedPresetToBroker`
 * turns one into a `BrokerPreset` so the same apply/match functions serve
 * both. A saved preset may also carry a root topic, and for a non-admin its
 * login is HIDDEN: the form leaves those fields blank and the server copies
 * the login in on save (see `serverFill`).
 */
import type { SavedBrokerPreset } from '../../hooks/useMqttBrokerPresets';
import {
  defaultMqttPort,
  deviceFieldsReachEndpoint,
  MESHTASTIC_DEFAULT_SERVER,
  splitDeviceAddress,
} from '../../utils/mqttBrokerEndpoint';

export interface BrokerPreset {
  /** Stable handle: the <option> value and test id. Never `'custom'`. */
  id: string;
  labelKey: string;
  labelFallback: string;
  host: string;
  port: number;
  tls: boolean;
  /** The broker's published login. Public by design, so safe to show. */
  username: string;
  password: string;
  /** Saved presets only (#5794): the row id. */
  savedId?: number;
  /** Saved presets only: the name, shown as typed (no translation). */
  label?: string;
  /** Saved presets only: fills the root topic (device) or subscription (bridge). */
  rootTopic?: string | null;
  /** Saved presets only: the preset has a username this user is not shown. */
  usernameHidden?: boolean;
  /** Saved presets only: the preset has a password this user is not shown. */
  passwordHidden?: boolean;
}

/** The chip id of a saved preset. Never collides with a built-in id or `'custom'`. */
export function savedPresetChipId(savedId: number): string {
  return `saved:${savedId}`;
}

export function savedPresetToBroker(p: SavedBrokerPreset): BrokerPreset {
  const usernameHidden = p.username === undefined && p.hasUsername;
  const passwordHidden = p.password === undefined && p.hasPassword;
  return {
    id: savedPresetChipId(p.id),
    labelKey: '',
    labelFallback: p.name,
    label: p.name,
    host: p.host,
    port: p.port,
    tls: p.tls,
    username: p.username ?? '',
    password: p.password ?? '',
    savedId: p.id,
    rootTopic: p.rootTopic,
    usernameHidden,
    passwordHidden,
  };
}

/** The selector's escape hatch: today's free-text fields, untouched. */
export const CUSTOM_PRESET_ID = 'custom';

export const MESHTASTIC_PUBLIC_HOST = MESHTASTIC_DEFAULT_SERVER;

export const BROKER_PRESETS: readonly BrokerPreset[] = [
  {
    id: 'meshtastic_public',
    labelKey: 'mqtt_presets.meshtastic_public',
    labelFallback: 'Meshtastic Official',
    host: MESHTASTIC_PUBLIC_HOST,
    port: 1883,
    tls: false,
    username: 'meshdev',
    password: 'large4cats',
  },
  {
    id: 'meshtastic_public_tls',
    labelKey: 'mqtt_presets.meshtastic_public_tls',
    labelFallback: 'Meshtastic Official (TLS)',
    host: MESHTASTIC_PUBLIC_HOST,
    port: 8883,
    tls: true,
    username: 'meshdev',
    password: 'large4cats',
  },
];

/**
 * Where to look for a regional broker. Neither page lists brokers: they list
 * groups, and a group publishes its own broker. MeshMonitor links to them and
 * never reads, copies or caches either list.
 */
export const BROKER_DISCOVERY_LINKS = {
  localGroups: 'https://meshtastic.org/docs/community/local-groups/',
  siteGallery: 'https://meshmonitor.org/site-gallery.html',
} as const;

export function findBrokerPreset(id: string): BrokerPreset | undefined {
  return BROKER_PRESETS.find((p) => p.id === id);
}

/**
 * Credentials a preset left alone because the form already held something
 * else. The selector names them, so the change is never silent.
 */
export interface KeptCredentials {
  username: boolean;
  password: boolean;
  /** The kept password is a stored one the form does not show (bridge only). */
  storedPassword: boolean;
  /**
   * A saved preset's hidden login goes in on save (#5794): the form left the
   * field blank and must send the preset's id with the save.
   */
  serverFill?: boolean;
}

/**
 * The credential rule, shared by every form: a preset fills a credential only
 * when the field is empty (and, for the bridge, no hidden password is stored).
 * A value the user typed or saved is kept, and `kept` says so.
 */
function fillCredential(current: string, presetValue: string): { value: string; kept: boolean } {
  if (current === '' || current === presetValue) return { value: presetValue, kept: false };
  return { value: current, kept: true };
}

/**
 * The same rule for a credential this user is not shown: an empty field stays
 * empty and the server fills it on save; anything typed is kept.
 */
function fillHiddenCredential(current: string): { value: string; kept: boolean; serverFill: boolean } {
  if (current === '') return { value: '', kept: false, serverFill: true };
  return { value: current, kept: true, serverFill: false };
}

function fillAnyCredential(
  current: string,
  presetValue: string,
  hidden: boolean | undefined,
): { value: string; kept: boolean; serverFill: boolean } {
  return hidden ? fillHiddenCredential(current) : { ...fillCredential(current, presetValue), serverFill: false };
}

// ---------------------------------------------------------------------------
// Device MQTT config (local and remote admin): host + tlsEnabled flag
// ---------------------------------------------------------------------------

export interface DeviceMqttFields {
  address: string;
  username: string;
  password: string;
  tlsEnabled: boolean;
  /** Root topic. Changed only by a saved preset that has one. */
  root?: string;
}

/** Does this firmware address, under the preset's TLS mode, reach the preset's host and port? */
function deviceAddressReaches(address: string, preset: BrokerPreset): boolean {
  // Shared with the server's preset fill (#5794), so both agree on a match.
  return deviceFieldsReachEndpoint({ address, tlsEnabled: preset.tls }, preset);
}

/** The preset a device's stored MQTT settings already describe, if any. */
export function matchDevicePreset(
  fields: Pick<DeviceMqttFields, 'address' | 'tlsEnabled'>,
  presets: readonly BrokerPreset[] = BROKER_PRESETS,
): BrokerPreset | null {
  return presets.find((p) => p.tls === fields.tlsEnabled && deviceAddressReaches(fields.address, p)) ?? null;
}

/**
 * The device fields after choosing `preset`. An address that already reaches
 * the preset (including firmware's empty "default server") is left as typed.
 */
export function applyPresetToDevice(
  preset: BrokerPreset,
  current: DeviceMqttFields,
): { fields: DeviceMqttFields; kept: KeptCredentials } {
  const username = fillAnyCredential(current.username, preset.username, preset.usernameHidden);
  const password = fillAnyCredential(current.password, preset.password, preset.passwordHidden);
  // An address with a port that is right for the other mode (":1883" under
  // TLS) must go; a bare host or the empty default can stay. A saved preset
  // on a non-default port writes `host:port`, since firmware has no port field.
  const keepAddress = deviceAddressReaches(current.address, preset);
  const presetAddress =
    preset.savedId !== undefined && preset.port !== (preset.tls ? 8883 : 1883)
      ? `${preset.host}:${preset.port}`
      : preset.host;
  const fields: DeviceMqttFields = {
    address: keepAddress ? current.address : presetAddress,
    username: username.value,
    password: password.value,
    tlsEnabled: preset.tls,
  };
  if (preset.rootTopic) fields.root = preset.rootTopic;
  return {
    fields,
    kept: {
      username: username.kept,
      password: password.kept,
      storedPassword: false,
      ...(username.serverFill || password.serverFill ? { serverFill: true } : {}),
    },
  };
}

/**
 * A device form's values for "Save as preset" (#5794), or null when the
 * address names no broker. No port means firmware's default for the mode.
 */
export function devicePresetDraft(fields: DeviceMqttFields): {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  rootTopic: string;
} | null {
  const { host, port } = splitDeviceAddress(fields.address);
  if (!host || Number.isNaN(port)) return null;
  return {
    host,
    port: port ?? defaultMqttPort(fields.tlsEnabled),
    tls: fields.tlsEnabled,
    username: fields.username,
    password: fields.password,
    rootTopic: fields.root ?? '',
  };
}

// ---------------------------------------------------------------------------
// MQTT bridge source: one URL with scheme and port
// ---------------------------------------------------------------------------

export interface BridgeMqttFields {
  url: string;
  username: string;
  /** '' on edit means "keep the stored password" (server-side merge). */
  password: string;
  /** Upstream topics, one per line. Changed only by a saved preset with a root topic. */
  subscriptions?: string;
}

export function bridgeUrlForPreset(preset: BrokerPreset): string {
  return `${preset.tls ? 'mqtts' : 'mqtt'}://${preset.host}:${preset.port}`;
}

const BRIDGE_URL_RE = /^(mqtts?):\/\/(?:[^@/]*@)?([^:/?#]+)(?::(\d+))?\/?$/i;

/** The preset a bridge URL already points at, if any. */
export function matchBridgePreset(url: string, presets: readonly BrokerPreset[] = BROKER_PRESETS): BrokerPreset | null {
  const m = BRIDGE_URL_RE.exec(url.trim());
  if (!m) return null;
  const tls = m[1].toLowerCase() === 'mqtts';
  const host = m[2].toLowerCase();
  const port = m[3] ? Number(m[3]) : tls ? 8883 : 1883;
  return presets.find((p) => p.tls === tls && p.host === host && p.port === port) ?? null;
}

/**
 * The bridge fields after choosing `preset`.
 *
 * `passwordStored`: a password is saved for this bridge that the form does
 * not show (the bridge form never round-trips it; a non-admin editor gets it
 * in `maskedConfigFields`). The preset then leaves the password field blank,
 * which is the server's "keep the stored password" signal, and reports it as
 * kept. It never types over or clears a hidden secret. `usernameStored` does
 * the same for a username the server masked.
 */
export function applyPresetToBridge(
  preset: BrokerPreset,
  current: BridgeMqttFields,
  opts: { passwordStored: boolean; usernameStored?: boolean },
): { fields: BridgeMqttFields; kept: KeptCredentials } {
  const username =
    opts.usernameStored && current.username === ''
      ? { value: '', kept: true, serverFill: false }
      : fillAnyCredential(current.username, preset.username, preset.usernameHidden);
  const storedPassword = opts.passwordStored && current.password === '';
  const password = storedPassword
    ? { value: '', kept: true, serverFill: false }
    : fillAnyCredential(current.password, preset.password, preset.passwordHidden);
  const fields: BridgeMqttFields = {
    url: matchBridgePreset(current.url, [preset])?.id === preset.id ? current.url : bridgeUrlForPreset(preset),
    username: username.value,
    password: password.value,
  };
  if (preset.rootTopic) fields.subscriptions = `${preset.rootTopic}/#`;
  return {
    fields,
    kept: {
      username: username.kept,
      password: password.kept,
      storedPassword,
      ...(username.serverFill || password.serverFill ? { serverFill: true } : {}),
    },
  };
}
