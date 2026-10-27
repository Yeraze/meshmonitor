/**
 * Find enabled Meshtastic TCP sources that point at the same node (#5974).
 *
 * Meshtastic firmware serves one TCP API client at a time and force-closes the
 * old link when a new one connects, so two sources on one host:port knock each
 * other off forever. The source routes already refuse an exact duplicate, but
 * rows that differ only in case, whitespace, or port type (`"4403"` vs `4403`),
 * or that predate that check, still get through. This compares them the way
 * the socket does.
 *
 * Two different host names for one address (a DNS name and its IP) are not
 * detected; that would need a lookup.
 */
export interface TcpSourceLike {
  id: string;
  name: string;
  type: string;
  enabled?: boolean | number | null;
  config: unknown;
}

const DEFAULT_TCP_PORT = 4403;

/** Normalised `host:port` key, or null when the config has no host. */
export function tcpEndpointKey(config: unknown): string | null {
  if (!config || typeof config !== 'object') return null;
  const cfg = config as { host?: unknown; port?: unknown };
  if (typeof cfg.host !== 'string') return null;
  const host = cfg.host.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  const portNum = Number(cfg.port);
  const port = Number.isFinite(portNum) && portNum > 0 ? portNum : DEFAULT_TCP_PORT;
  return `${host}:${port}`;
}

/**
 * Group enabled meshtastic_tcp sources by endpoint and return only the groups
 * with more than one source.
 */
export function findDuplicateTcpEndpoints<T extends TcpSourceLike>(
  sources: readonly T[],
): Array<{ endpoint: string; sources: T[] }> {
  const groups = new Map<string, T[]>();
  for (const s of sources) {
    if (s.type !== 'meshtastic_tcp' || !s.enabled) continue;
    const key = tcpEndpointKey(s.config);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([endpoint, list]) => ({ endpoint, sources: list }));
}

/** The log line for one duplicate group. */
export function describeDuplicateTcpEndpoint(group: { endpoint: string; sources: TcpSourceLike[] }): string {
  const names = group.sources.map((s) => `"${s.name}"`).join(', ');
  return (
    `⚠️ ${group.sources.length} enabled Meshtastic TCP sources point at ${group.endpoint} (${names}). ` +
    'The node allows one TCP client at a time, so they will keep disconnecting each other. ' +
    'Disable or delete all but one.'
  );
}

/** Log every duplicate group through `warn`. Returns the number of groups. */
export function warnOnDuplicateTcpEndpoints(
  sources: readonly TcpSourceLike[],
  warn: (msg: string) => void,
): number {
  const groups = findDuplicateTcpEndpoints(sources);
  for (const g of groups) warn(describeDuplicateTcpEndpoint(g));
  return groups.length;
}
