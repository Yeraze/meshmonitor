/**
 * OTA gateway address helpers, shared by the firmware-update frontend and
 * backend (issue #5424).
 *
 * The OTA flow drives the meshtastic Python CLI with `--host <gateway>`. The
 * CLI splits that value on `:` and passes the second part to
 * `TCPInterface(portNumber=...)`, so `--host 10.0.0.5:5000` reaches a node on
 * a custom TCP API port. It also means the CLI cannot take an IPv6 literal at
 * all: `"fe80::1".split(':')` has more than two parts and the CLI exits with a
 * connect error.
 */

export const DEFAULT_MESHTASTIC_TCP_PORT = 4403;

/** True when `host` is an IPv6 literal (bare or bracketed). */
export function isIpv6Literal(host: string): boolean {
  return host.includes(':');
}

/**
 * Build the gateway string for a source's host and TCP port. The port is
 * appended only when it is set and differs from the default, so default-port
 * sources keep sending the bare host. IPv6 literals never get a port: the
 * CLI cannot parse them either way, and a bare `fe80::1:5000` is ambiguous.
 */
export function buildOtaGateway(host: string | null | undefined, port: number | null | undefined): string {
  const h = (host ?? '').trim();
  if (!h) return '';
  if (isIpv6Literal(h)) return h;
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535 || p === DEFAULT_MESHTASTIC_TCP_PORT) return h;
  return `${h}:${p}`;
}

/**
 * Split an OTA gateway string into host and TCP API port. Forms:
 *   - `10.0.0.5` / `node.lan`        → default port 4403
 *   - `10.0.0.5:5000`                → port 5000
 *   - `[fe80::1]:5000` / `[fe80::1]` → IPv6 literal, brackets stripped
 *   - `fe80::1` (bare IPv6)          → whole string is the host, default port
 * A bare IPv6 literal has several colons, so its last group must not be read
 * as a port (`fe80::1` is not host `fe80:` on port 1).
 */
export function parseOtaGateway(gateway: string): { host: string; port: number } {
  const trimmed = gateway.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    const port = bracketed[2] ? Number(bracketed[2]) : DEFAULT_MESHTASTIC_TCP_PORT;
    return { host: bracketed[1], port: port > 0 && port <= 65535 ? port : DEFAULT_MESHTASTIC_TCP_PORT };
  }
  const colonCount = (trimmed.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const lastColon = trimmed.lastIndexOf(':');
    const portStr = trimmed.slice(lastColon + 1);
    const port = Number(portStr);
    if (lastColon > 0 && /^\d+$/.test(portStr) && port > 0 && port <= 65535) {
      return { host: trimmed.slice(0, lastColon), port };
    }
  }
  return { host: trimmed, port: DEFAULT_MESHTASTIC_TCP_PORT };
}
