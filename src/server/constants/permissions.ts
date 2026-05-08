/**
 * Resource classification for per-source permissions.
 *
 * Sourcey resources require a sourceId for every permission check.
 * Global resources ignore sourceId entirely.
 */
export const SOURCEY_RESOURCES = new Set<string>([
  'channel_0', 'channel_1', 'channel_2', 'channel_3',
  'channel_4', 'channel_5', 'channel_6', 'channel_7',
  'messages', 'nodes', 'nodes_private', 'traceroute',
  'packetmonitor', 'configuration', 'connection', 'automation',
  'dashboard', 'settings', 'info', 'audit', 'security',
  'waypoints',
]);

export const isResourceSourcey = (resource: string): boolean =>
  SOURCEY_RESOURCES.has(resource);
