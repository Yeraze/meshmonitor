/**
 * MQTT broker endpoints: the (host, port, TLS) a form's fields reach.
 *
 * Shared by the browser (which preset do these fields match?) and the server
 * (may a saved preset's password be filled into this config?, #5794). The two
 * must agree, or the server would refuse a save the form thought was fine.
 *
 *   device  firmware's `address` is a bare host or `host:port`, split on the
 *           first `:`, and TLS is the separate `tlsEnabled` flag. No port
 *           means firmware's default for the mode (1883, or 8883 with TLS).
 *   bridge  one URL: `mqtt://host:1883` or `mqtts://host:8883`. Any
 *           `user:pass@` in it is ignored.
 */

export interface BrokerEndpoint {
  host: string;
  port: number;
  tls: boolean;
}

/** Firmware reads an empty device `address` as this server. */
export const MESHTASTIC_DEFAULT_SERVER = 'mqtt.meshtastic.org';

export const MQTT_DEFAULT_PORT = 1883;
export const MQTT_DEFAULT_TLS_PORT = 8883;

export function defaultMqttPort(tls: boolean): number {
  return tls ? MQTT_DEFAULT_TLS_PORT : MQTT_DEFAULT_PORT;
}

/**
 * Split firmware's `address` the way firmware does: on the first `:`.
 * `port` is null when none is given and NaN when it is not a number.
 */
export function splitDeviceAddress(address: string): { host: string; port: number | null } {
  const trimmed = address.trim();
  const i = trimmed.indexOf(':');
  if (i < 0) return { host: trimmed.toLowerCase(), port: null };
  const port = Number(trimmed.slice(i + 1));
  return { host: trimmed.slice(0, i).toLowerCase(), port: Number.isInteger(port) ? port : NaN };
}

/**
 * Does a device's `address` + `tlsEnabled` reach `endpoint`? With no port,
 * firmware uses the mode's default (1883, or 8883 with TLS); an empty address
 * is firmware's default server.
 */
export function deviceFieldsReachEndpoint(
  fields: { address: string; tlsEnabled: boolean },
  endpoint: BrokerEndpoint,
): boolean {
  const { host, port } = splitDeviceAddress(fields.address);
  const target = endpoint.host.toLowerCase();
  const hostOk = host === target || (host === '' && target === MESHTASTIC_DEFAULT_SERVER);
  return fields.tlsEnabled === endpoint.tls && hostOk && (port ?? defaultMqttPort(fields.tlsEnabled)) === endpoint.port;
}

/**
 * How the MQTT client reads a broker URL: a bare host becomes `mqtt://host`,
 * and a bare `host:8883` / `host:8884` becomes `mqtts://`. The bridge connects
 * with exactly this (transports/mqttBrokerClient.ts).
 */
export function normalizeBrokerUrl(input: string): string {
  const trimmed = input.trim();
  if (/^(mqtt|mqtts|ws|wss|tcp|tls):\/\//i.test(trimmed)) {
    return trimmed;
  }
  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx > 0) {
    const port = Number(trimmed.slice(colonIdx + 1));
    if (port === 8883 || port === 8884) return 'mqtts://' + trimmed;
  }
  return 'mqtt://' + trimmed;
}

const BRIDGE_URL_RE = /^(mqtts?):\/\/(?:[^@/]*@)?([^:/?#]+)(?::(\d+))?\/?$/i;

/**
 * The endpoint a bridge URL names, or null when it is not an mqtt(s) URL. A
 * bare host is read as the bridge reads it (`normalizeBrokerUrl`).
 */
export function parseBridgeUrl(url: string): BrokerEndpoint | null {
  if (url.trim() === '') return null;
  const m = BRIDGE_URL_RE.exec(normalizeBrokerUrl(url));
  if (!m) return null;
  const tls = m[1].toLowerCase() === 'mqtts';
  return {
    host: m[2].toLowerCase(),
    port: m[3] ? Number(m[3]) : defaultMqttPort(tls),
    tls,
  };
}

export function bridgeUrlReachesEndpoint(url: string, endpoint: BrokerEndpoint): boolean {
  const parsed = parseBridgeUrl(url);
  return (
    parsed !== null &&
    parsed.tls === endpoint.tls &&
    parsed.host === endpoint.host.toLowerCase() &&
    parsed.port === endpoint.port
  );
}

export function bridgeUrlForEndpoint(endpoint: BrokerEndpoint): string {
  return `${endpoint.tls ? 'mqtts' : 'mqtt'}://${endpoint.host}:${endpoint.port}`;
}
