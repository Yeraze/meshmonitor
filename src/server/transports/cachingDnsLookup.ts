/**
 * A small in-process caching wrapper around `dns.lookup`, shaped so it can be
 * passed straight to `net.connect` / `tls.connect` (and therefore to mqtt.js as
 * its `lookup` option).
 *
 * Why this exists (MQTT DNS thrashing): the MQTT bridge's `per_gateway`
 * forwarding mode opens one upstream connection per relayed gateway, and Node.js
 * performs NO in-process DNS caching — every TCP (re)connect calls the system
 * resolver. With dozens of pooled connections re-resolving the same broker
 * hostname on every connect/reconnect, the resolver gets hammered ("dozens of
 * requests per minute"). Caching the resolution for a short TTL collapses that
 * to ~one lookup per host per TTL window, regardless of how much the
 * connections churn.
 *
 * Using a custom `lookup` (rather than pre-resolving to an IP) keeps the
 * hostname on the socket, so TLS SNI / certificate validation still works
 * against the broker's name.
 */

import dns from 'dns';

/** Default cache lifetime. Brokers rarely change IPs; 30s is a safe default. */
const DEFAULT_TTL_MS = 30_000;

type LookupOneCb = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;
type LookupAllCb = (
  err: NodeJS.ErrnoException | null,
  addresses: dns.LookupAddress[],
) => void;

type CacheValue =
  | { all: false; address: string; family: number }
  | { all: true; addresses: dns.LookupAddress[] };

interface CacheEntry {
  value: CacheValue;
  expires: number;
}

export interface CachingLookupOptions {
  ttlMs?: number;
  /** Injectable resolver + clock for tests. */
  resolver?: typeof dns.lookup;
  now?: () => number;
}

/**
 * Build a `lookup`-compatible function with its own private cache. Each call
 * site (e.g. the MQTT transport) gets one instance shared across all its
 * connections, so they collectively resolve a host at most once per TTL window.
 */
export function createCachingLookup(options: CachingLookupOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const resolver = options.resolver ?? dns.lookup;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  // Signature mirrors dns.lookup: (hostname, options?, callback). net.connect
  // may also call it as (hostname, callback) with options omitted.
  function cachingLookup(hostname: string, opts: unknown, callback?: unknown): void {
    let lookupOpts: dns.LookupOptions;
    let cb: LookupOneCb | LookupAllCb;
    if (typeof opts === 'function') {
      cb = opts as LookupOneCb;
      lookupOpts = {};
    } else if (typeof opts === 'number') {
      cb = callback as LookupOneCb;
      lookupOpts = { family: opts };
    } else {
      cb = callback as LookupOneCb | LookupAllCb;
      lookupOpts = (opts as dns.LookupOptions) ?? {};
    }

    const all = lookupOpts.all === true;
    const family = lookupOpts.family ?? 0;
    const key = `${hostname}|${family}|${all ? 'all' : 'one'}`;

    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      if (hit.value.all) (cb as LookupAllCb)(null, hit.value.addresses);
      else (cb as LookupOneCb)(null, hit.value.address, hit.value.family);
      return;
    }

    // Cache miss — resolve for real and cache only successful results so a
    // transient DNS failure isn't pinned for the whole TTL.
    resolver(hostname, lookupOpts, (err: NodeJS.ErrnoException | null, address: unknown, fam?: number) => {
      if (err) {
        (cb as LookupOneCb)(err, '', 0);
        return;
      }
      if (all) {
        const addresses = address as dns.LookupAddress[];
        cache.set(key, { value: { all: true, addresses }, expires: now() + ttlMs });
        (cb as LookupAllCb)(null, addresses);
      } else {
        const addr = address as string;
        cache.set(key, { value: { all: false, address: addr, family: fam ?? 0 }, expires: now() + ttlMs });
        (cb as LookupOneCb)(null, addr, fam ?? 0);
      }
    });
  }

  return cachingLookup;
}
