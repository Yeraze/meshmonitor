/**
 * SSRF guard utilities.
 *
 * Defense-in-depth wrapper around `fetch` that resolves the target host and rejects
 * requests pointed at ranges that should never be reachable from outbound HTTP
 * (cloud metadata services, loopback, link-local, multicast, broadcast, IPv6-mapped
 * loopback / link-local) — and optionally rejects RFC1918 private ranges.
 *
 * Two modes:
 *   - `strict: true`  — also blocks RFC1918 private networks (10/8, 172.16/12, 192.168/16)
 *                       and IPv6 ULA (fc00::/7). Use for endpoints that must only hit
 *                       public internet URLs (e.g. link previews).
 *   - `strict: false` — allows RFC1918 / ULA so admin-configured LAN targets
 *                       (self-hosted tile servers, internal webhooks) still work.
 *                       Still blocks metadata/loopback/link-local.
 *
 * Note: this does a pre-fetch DNS resolution and then passes the resolved IP
 * through fetch's connect phase by re-using the URL. Because the Node http agent
 * re-resolves on connect, a determined attacker could still DNS-rebind; this guard
 * is a meaningful barrier but not a complete mitigation. For the threat model here
 * (admin-configured URLs plus user-supplied link previews), it is sufficient.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BLOCKED_HOSTS = new Set([
  '169.254.169.254', // AWS / GCP / Azure / DO instance metadata
  'metadata.google.internal',
  'metadata.goog',
]);

// IPs that are always blocked regardless of allow* flags. Cloud metadata services
// live on link-local IPs but must never be reachable from outbound HTTP, even
// when link-local as a range is otherwise permitted.
const ALWAYS_BLOCKED_IPS = new Set([
  '169.254.169.254',
  'fd00:ec2::254', // AWS IPv6 metadata
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) + x;
  }
  return n >>> 0;
}

function inCidrV4(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const rangeInt = ipv4ToInt(range);
  const ipInt = ipv4ToInt(ip);
  if (rangeInt === null || ipInt === null) return false;
  const bits = Number(bitsStr);
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function classifyIPv4(ip: string): {
  loopback: boolean;
  linkLocal: boolean;
  private: boolean;
  multicast: boolean;
  broadcast: boolean;
  reserved: boolean;
} {
  return {
    loopback: inCidrV4(ip, '127.0.0.0/8'),
    linkLocal: inCidrV4(ip, '169.254.0.0/16'),
    private:
      inCidrV4(ip, '10.0.0.0/8') ||
      inCidrV4(ip, '172.16.0.0/12') ||
      inCidrV4(ip, '192.168.0.0/16'),
    multicast: inCidrV4(ip, '224.0.0.0/4'),
    broadcast: ip === '255.255.255.255',
    reserved:
      inCidrV4(ip, '0.0.0.0/8') ||
      inCidrV4(ip, '100.64.0.0/10') || // CGNAT
      inCidrV4(ip, '240.0.0.0/4'),
  };
}

function classifyIPv6(ip: string): {
  loopback: boolean;
  linkLocal: boolean;
  private: boolean;
  multicast: boolean;
  reserved: boolean;
} {
  const lower = ip.toLowerCase();
  // Normalize IPv4-mapped like ::ffff:127.0.0.1 by extracting the v4 portion.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const v4 = classifyIPv4(mapped[1]);
    return {
      loopback: v4.loopback,
      linkLocal: v4.linkLocal,
      private: v4.private,
      multicast: v4.multicast,
      reserved: v4.reserved || v4.broadcast,
    };
  }
  return {
    loopback: lower === '::1',
    linkLocal: lower.startsWith('fe80:') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'),
    private: lower.startsWith('fc') || lower.startsWith('fd'), // fc00::/7 ULA
    multicast: lower.startsWith('ff'),
    reserved: lower === '::' || lower.startsWith('2001:db8:'),
  };
}

export interface SsrfCheckOptions {
  /** Allowed URL protocols. Defaults to ['http:', 'https:']. */
  protocols?: string[];
  /** When true, also rejects RFC1918 private ranges and IPv6 ULA. */
  strict?: boolean;
}

export class SsrfBlockedError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Parse and validate a URL for SSRF safety.
 * Resolves the hostname and classifies the resulting IP. Throws SsrfBlockedError
 * if the destination is disallowed.
 *
 * Returns the parsed URL on success.
 */
export async function assertSafeUrl(
  rawUrl: string,
  opts: SsrfCheckOptions = {}
): Promise<URL> {
  const protocols = opts.protocols ?? ['http:', 'https:'];
  const strict = opts.strict ?? false;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('Invalid URL', 'invalid_url');
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new SsrfBlockedError(
      `Protocol ${parsed.protocol} not allowed`,
      'bad_protocol'
    );
  }

  const host = parsed.hostname;
  if (!host) {
    throw new SsrfBlockedError('URL has no host', 'no_host');
  }

  if (BLOCKED_HOSTS.has(host.toLowerCase())) {
    throw new SsrfBlockedError('Target host is blocked', 'blocked_host');
  }

  // URL.hostname keeps brackets for IPv6 literals (e.g. "[::1]"). Strip them
  // before passing to isIP() and for downstream comparisons.
  const bareHost = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;

  // If host is already an IP literal, classify directly; otherwise resolve DNS.
  const literalIpFamily = isIP(bareHost);
  let resolved: Array<{ address: string; family: number }>;
  if (literalIpFamily) {
    resolved = [{ address: bareHost, family: literalIpFamily }];
  } else {
    try {
      resolved = await lookup(host, { all: true });
    } catch (err) {
      throw new SsrfBlockedError(
        `DNS lookup failed for ${host}`,
        'dns_failed'
      );
    }
  }

  for (const { address, family } of resolved) {
    if (ALWAYS_BLOCKED_IPS.has(address.toLowerCase())) {
      throw new SsrfBlockedError('Cloud metadata target blocked', 'metadata');
    }
    if (family === 4) {
      const c = classifyIPv4(address);
      if (c.loopback) throw new SsrfBlockedError('Loopback target blocked', 'loopback');
      if (c.linkLocal) throw new SsrfBlockedError('Link-local target blocked', 'link_local');
      if (c.multicast) throw new SsrfBlockedError('Multicast target blocked', 'multicast');
      if (c.broadcast) throw new SsrfBlockedError('Broadcast target blocked', 'broadcast');
      if (c.reserved) throw new SsrfBlockedError('Reserved-range target blocked', 'reserved');
      if (strict && c.private) {
        throw new SsrfBlockedError('Private-network target blocked', 'private');
      }
    } else if (family === 6) {
      const c = classifyIPv6(address);
      if (c.loopback) throw new SsrfBlockedError('Loopback target blocked', 'loopback');
      if (c.linkLocal) throw new SsrfBlockedError('Link-local target blocked', 'link_local');
      if (c.multicast) throw new SsrfBlockedError('Multicast target blocked', 'multicast');
      if (c.reserved) throw new SsrfBlockedError('Reserved-range target blocked', 'reserved');
      if (strict && c.private) {
        throw new SsrfBlockedError('Private-network target blocked', 'private');
      }
    }
  }

  return parsed;
}

/**
 * Thin wrapper around global fetch that first validates the URL with assertSafeUrl.
 * Uses the parsed URL (so the tainted raw string never reaches fetch directly),
 * which also silences the CodeQL js/request-forgery flow-based tracker.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SsrfCheckOptions = {}
): Promise<Response> {
  const safeUrl = await assertSafeUrl(rawUrl, opts);
  return fetch(safeUrl, init);
}
