/**
 * Exceptions for the public-instance sentinel audit (#5156, Phase 2).
 *
 * Every walked GET route is called and scanned by default. Only exceptions
 * live here. A key that matches no walked route fails the audit (stale), so
 * deleting a route forces its entry out. Keys are `METHOD /full/path`.
 */

/**
 * Routes the audit does not call, with the reason. Intentionally empty today:
 * every walked GET runs under the fakes (filesystem params use harmless missing
 * names via ROUTE_OVERRIDES). Add an entry only for a route that cannot run at
 * all, such as one that streams without end.
 */
export const SKIP: Record<string, string> = {};

/** Routes that answer 5xx under the fakes by design, with the reason. */
export const EXPECT_ERROR: Record<string, string> = {
  'GET /api/device/backup': 'the ?sourceId= variant for a MeshCore fake has no device to export',
  'GET /api/elevation/tiles/:z/:x/:y': 'fetches terrain tiles from an upstream server; outbound fetch is blocked',
  'GET /api/nodes/:nodeNum/contact-url': 'needs the Meshtastic protobuf definitions, which are not loaded in tests',
};

/** Concrete URLs (path and query) for routes whose params the defaults cannot fill. */
export const ROUTE_OVERRIDES: Record<string, string | string[]> = {
  'GET /api/audit/:id': '/api/audit/1',
  'GET /api/channel-database/:id': '/api/channel-database/1',
  'GET /api/channel-database/:id/permissions': '/api/channel-database/1/permissions',
  'GET /api/packets/:id': '/api/packets/1',
  'GET /api/sources/:id/reticulum/interfaces/:name/history': '/api/sources/audit-rns/reticulum/interfaces/audit0/history',
  'GET /api/admin/operations/:id': '/api/admin/operations/audit-op',
  'GET /api/elevation/tiles/:z/:x/:y': '/api/elevation/tiles/10/300/400',
  'GET /api/geojson/layers/:id/data': '/api/geojson/layers/audit-layer/data',
  'GET /api/map-styles/styles/:id/data': '/api/map-styles/styles/audit-style/data',
  'GET /api/themes/:slug': '/api/themes/mocha',
  'GET /api/backup/summary/:filename': '/api/backup/summary/audit-missing.db',
  'GET /api/backup/download/:filename': '/api/backup/download/audit-missing.db',
  'GET /api/system/backup/download/:dirname': '/api/system/backup/download/audit-missing',
  'GET /api/automations/:id': '/api/automations/1',
  'GET /api/automations/:id/runs': '/api/automations/1/runs',
  'GET /api/automations/:id/export': '/api/automations/1/export',
  'GET /api/channels/:id/export': '/api/channels/0/export',
  'GET /api/mqtt/root-finder/samples/:id': '/api/mqtt/root-finder/samples/audit-sample',
  'GET /api/packets/traffic-management/replay': '/api/packets/traffic-management/replay?sourceId=audit-mt',
  'GET /api/solar/estimates/range': '/api/solar/estimates/range?start=0&end=9999999999',
  'GET /api/messages/search': ['/api/messages/search?q=sntl', '/api/messages/search?q=sntl&sourceId=audit-mt', '/api/messages/search?q=sntl&sourceId=audit-mc'],
  'GET /api/translate/stored': '/api/translate/stored?sourceId=audit-mt&lang=en&messageIds=audit-mt_1578607073_1',
  'GET /api/sources/:id/meshcore/packets/receptions': '/api/sources/audit-mc/meshcore/packets/receptions?raw_hex=a5e7c0df1122334455667788',
  'GET /api/sources/:id/meshcore/ingest/overview': '/api/sources/audit-mci/meshcore/ingest/overview',
  'GET /api/sources/:id/meshcore/ingest/nodes': '/api/sources/audit-mci/meshcore/ingest/nodes',
  'GET /api/sources/:id/meshcore/ingest/messages': '/api/sources/audit-mci/meshcore/ingest/messages',
  'GET /api/sources/:id/meshcore/ingest/channels': '/api/sources/audit-mci/meshcore/ingest/channels',
  'GET /api/sources/:id/meshcore/hop-snr/latest-trace': '/api/sources/audit-mc/meshcore/hop-snr/latest-trace?publicKey=e4c7a19b3d5f8206e4c7a19b3d5f8206e4c7a19b3d5f8206e4c7a19b3d5f8206',
  'GET /api/sources/:id/meshcore/stats/:type': ['/api/sources/audit-mc/meshcore/stats/core', '/api/sources/audit-mc/meshcore/stats/radio', '/api/sources/audit-mc/meshcore/stats/packets'],
  'GET /api/sources/:id/meshcore/rooms/sync-config': '/api/sources/audit-mc/meshcore/rooms/sync-config?publicKey=7b2d90c8e1a4f635d87b2d90c8e1a4f6a7b2d90c8e1a4f635d87b2d90c8e1a4f',
  'GET /api/sources/:id/meshcore/automation/announce/preview': '/api/sources/audit-mc/meshcore/automation/announce/preview?message=hello',
  'GET /api/announce/preview': '/api/announce/preview?message=hello',
  'GET /api/sources/:id/mqtt/packets/receptions': '/api/sources/audit-mqtt/mqtt/packets/receptions?packetId=1578615006&fromNode=1578607073',
  'GET /api/sources/:id/observer/status': '/api/sources/audit-mc/observer/status',
  'GET /api/sources/:id/observer/key': '/api/sources/audit-mc/observer/key',
  'GET /api/sources/:id/observer/credentials': '/api/sources/audit-mc/observer/credentials',
  'GET /api/nodes/:nodeNum/position-estimate': '/api/nodes/1578607077/position-estimate?sourceId=audit-mt',
  'GET /api/embed/:profileId/geojson/layers/:id/data': '/api/embed/audit-embed/geojson/layers/audit-layer/data',
};

/** `data` routes overall. Raise only. */
export const DATA_FLOOR = 80;

/** `data` routes per store. Raise only. */
export const PROTOCOL_FLOORS = { MT: 45, MC: 25, RNS: 8, MQTT: 3, embed: 3 } as const;

