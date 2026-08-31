/**
 * Classifies an MQTT broker address string as `private` / `public` / `unknown`,
 * mirroring firmware's `isMqttServerAddressPrivate()` (#4982).
 *
 * Background (verified against firmware `master`): firmware gates the
 * `ok_to_mqtt` drop in `MQTT::onSend` on whether the configured broker is a
 * private IPv4. When it is, uplinking a packet whose originator's
 * `ok_to_mqtt` bit is clear is EXPECTED BY DESIGN — the drop only applies to
 * public brokers. MeshMonitor's violation detector (`okToMqtt.ts`) has no
 * way to know the gateway's broker, so it flags every relayed
 * `ok_to_mqtt = 0` packet the same way; this module lets callers annotate
 * those flags with what can actually be known about the observing source's
 * configured broker, so the report can separate "expected" noise from real
 * violations.
 *
 * Firmware's private set (Firmware `isMqttServerAddressPrivate`, IPv4 only):
 *   - 10.0.0.0/8
 *   - 172.16.0.0/12
 *   - 192.168.0.0/16
 *   - 169.254.0.0/16 (link-local)
 *   - 100.64.0.0/10 (carrier-grade NAT)
 *   - 127.0.0.1/32 EXACTLY — NOT the whole 127.0.0.0/8 loopback block.
 *     `127.0.0.2` is a normal (non-private, per this check) address.
 *
 * Firmware parses the configured address with `IPAddress::fromString`,
 * which only understands dotted-quad IPv4 literals — never hostnames, never
 * IPv6. Consequences mirrored here:
 *   - A literal private IPv4 is DEFINITELY exempt from the drop → `'private'`.
 *   - A literal non-private IPv4 is DEFINITELY not exempt → `'public'`.
 *     (It's still a literal IP, so there's no DNS ambiguity — every gateway
 *     type evaluates it identically.)
 *   - A hostname (e.g. a self-hosted broker behind a DNS name) makes
 *     `fromString` fail, so firmware evaluates it as NOT-private at config
 *     time. Direct-TCP gateways later re-check against the resolved peer
 *     IP (which could turn out private), but MQTT-client-proxy gateways
 *     never re-check. Since MeshMonitor can't tell which gateway type
 *     produced a given reception, a hostname is reported as `'unknown'`
 *     rather than guessed either way.
 *   - IPv6 literals aren't handled by firmware's parser either → `'unknown'`.
 *   - The empty string, or the literal default server `mqtt.meshtastic.org`,
 *     is firmware's public default → `'public'`.
 *
 * Firmware splits the configured address on the FIRST `:` before parsing
 * (to drop an optional port suffix) — mirrored here exactly, including the
 * consequence that this is unsafe for unbracketed IPv6 literals. A
 * bracketed IPv6 literal (`[::1]:1883`) would defeat that naive split, so
 * it's treated defensively as `'unknown'` rather than mis-parsed.
 */

export type BrokerAddressClass = 'private' | 'public' | 'unknown';

/** Firmware's default public broker when the configured address is empty. */
const DEFAULT_MESHTASTIC_MQTT_HOST = 'mqtt.meshtastic.org';

/** Bind-all wildcard hosts — not a real address a client could have been configured with. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);

/**
 * Classify a raw broker address string (host, or host:port — no URL scheme)
 * the way firmware's `isMqttServerAddressPrivate` would. See module doc
 * comment for the exact rules and their provenance.
 */
export function classifyBrokerAddress(
  address: string | null | undefined,
): BrokerAddressClass {
  if (address == null) return 'unknown';
  const trimmed = address.trim();
  if (trimmed === '') return 'public'; // firmware default: empty address == mqtt.meshtastic.org

  // Bracketed IPv6 literal (e.g. "[::1]:1883") — firmware's naive first-':'
  // split would mangle this. Treat defensively as unrecognized.
  if (trimmed.startsWith('[')) return 'unknown';

  // Mirror firmware: split on the FIRST ':' to drop an optional port suffix.
  const colonIdx = trimmed.indexOf(':');
  const host = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
  if (host === '') return 'unknown';

  if (host.toLowerCase() === DEFAULT_MESHTASTIC_MQTT_HOST) return 'public';

  if (isLiteralIPv4(host)) {
    return isPrivateIPv4(host) ? 'private' : 'public';
  }

  // Hostname (that isn't the default server) or an unbracketed IPv6 literal
  // (which will simply fail the IPv4 literal test above) — can't be
  // resolved deterministically from the string alone.
  return 'unknown';
}

function isLiteralIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  return m.slice(1, 5).every((part) => {
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

/** Exact port of firmware's `isMqttServerAddressPrivate` IPv4 CIDR table. */
function isPrivateIPv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  const [a, b, c, d] = octets;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127 && b === 0 && c === 0 && d === 1) return true; // 127.0.0.1/32 ONLY
  return false;
}

/**
 * Extract the "broker address" (host, or host:port) a MeshMonitor MQTT
 * source is configured with, from its `sources.config` JSON. Returns `null`
 * when the type isn't an MQTT source, or no usable address is on record —
 * `classifyBrokerAddress(null)` maps that to `'unknown'`, distinct from an
 * on-record empty string (which firmware treats as the public default).
 *
 * - `mqtt_bridge`: the configured `upstream.url` (a full MQTT URL, e.g.
 *   `mqtt://192.168.1.5:1883`) is what firmware's `config_mqtt.address`
 *   maps to for THIS bridge's upstream connection — this is the broker the
 *   bridge (and, in the common case, the same physical gateway node) both
 *   publish into. The scheme is stripped; `URL.hostname` already strips
 *   brackets from an IPv6 host, and firmware never handles those anyway
 *   (see module doc), so no scheme leaks into the returned value.
 * - `mqtt_broker`: MeshMonitor itself hosts the broker, so there's no
 *   upstream URL — devices connect directly. The only address on record is
 *   the listener's OWN bind host, which is not what a device was configured
 *   with, but if an operator has explicitly bound it to a specific literal
 *   address that's the closest signal available. A wildcard bind
 *   (`0.0.0.0`, `::`, unset) carries no information → `null`.
 * - Any other source type (`meshtastic_tcp`, `meshcore`, `reticulum`) has no
 *   broker of its own.
 */
export function resolveSourceBrokerAddress(
  type: string | null | undefined,
  config: Record<string, unknown> | null | undefined,
): string | null {
  if (!config) return null;

  if (type === 'mqtt_bridge') {
    const upstream = config.upstream as { url?: unknown } | undefined;
    const url = typeof upstream?.url === 'string' ? upstream.url.trim() : '';
    if (url === '') return null;
    try {
      const parsed = new URL(url);
      return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch {
      return null;
    }
  }

  if (type === 'mqtt_broker') {
    const listener = config.listener as { host?: unknown } | undefined;
    const host = typeof listener?.host === 'string' ? listener.host.trim() : '';
    return WILDCARD_HOSTS.has(host) ? null : host;
  }

  return null;
}

/**
 * Classify the broker a MeshMonitor MQTT source is configured against.
 * Convenience wrapper composing {@link resolveSourceBrokerAddress} and
 * {@link classifyBrokerAddress} — see both for the rules.
 */
export function classifySourceBrokerAddress(
  type: string | null | undefined,
  config: Record<string, unknown> | null | undefined,
): BrokerAddressClass {
  return classifyBrokerAddress(resolveSourceBrokerAddress(type, config));
}

/**
 * Combine the broker classes of every source that observed one violation
 * (or one gateway's set of violations) into a single class:
 *
 *  - Any `'public'` source in the mix → `'public'`. At least one path is
 *    known-not-exempt, so the violation is confirmed regardless of what the
 *    other sources are.
 *  - No `'public'`, and every source is `'private'` → `'private'`. Every
 *    known path is exempt by design.
 *  - Otherwise (any `'unknown'`, with no `'public'`) → `'unknown'`. Can't
 *    rule out a real violation, so it must not be reported as expected.
 *  - No sources at all → `'unknown'`.
 */
export function combineBrokerClasses(
  classes: readonly BrokerAddressClass[],
): BrokerAddressClass {
  if (classes.length === 0) return 'unknown';
  if (classes.includes('public')) return 'public';
  if (classes.every((c) => c === 'private')) return 'private';
  return 'unknown';
}
