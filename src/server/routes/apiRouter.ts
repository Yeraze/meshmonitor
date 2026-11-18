import type { Router } from 'express';
import express from 'express';
import { optionalAuth } from '../auth/authMiddleware.js';
import settingsRoutes from './settingsRoutes.js';
import nodeNameSanitizerRoutes from './nodeNameSanitizerRoutes.js';
import { publicInstanceRedaction } from '../middleware/publicInstanceRedaction.js';
import { csrfTokenEndpoint } from '../middleware/csrf.js';
import authRoutes from './authRoutes.js';
import passkeyRoutes from './passkeyRoutes.js';
import automationRoutes from './automationRoutes.js';
import autoAckConverterRoutes from './autoAckConverterRoutes.js';
import userRoutes from './userRoutes.js';
import auditRoutes from './auditRoutes.js';
import securityRoutes from './securityRoutes.js';
import packetRoutes from './packetRoutes.js';
import solarRoutes from './solarRoutes.js';
import messageRoutes from './messageRoutes.js';
import readStateRoutes from './readStateRoutes.js';
import linkPreviewRoutes from './linkPreviewRoutes.js';
import scriptContentRoutes from './scriptContentRoutes.js';
import apiTokenRoutes from './apiTokenRoutes.js';
import mfaRoutes from './mfaRoutes.js';
import channelDatabaseRoutes from './channelDatabaseRoutes.js';
import newsRoutes from './newsRoutes.js';
import tileServerRoutes from './tileServerTest.js';
import v1Router from './v1/index.js';
import meshcoreRoutes from './meshcoreRoutes.js';
import meshtasticAdminRoutes from './meshtasticAdminRoutes.js';
import { unifiedCliHistoryRouter } from './meshcoreCliHistoryRoutes.js';
import mqttPacketRoutes from './mqttPacketRoutes.js';
import mqttNativeRoutes from './mqttNativeRoutes.js';
import forwardingRoutes from './forwardingRoutes.js';
import atakRoutes from './atakRoutes.js';
import surveyRoutes from './surveyRoutes.js';
import directRfContactsRoutes from './directRfContactsRoutes.js';
import beaconOfferRoutes from './beaconOfferRoutes.js';
import reticulumRoutes from './reticulumRoutes.js';
import embedProfileRoutes from './embedProfileRoutes.js';
import { privacyAdminRouter } from './privacyRoutes.js';
import firmwareUpdateRoutes from './firmwareUpdateRoutes.js';
import sourceRoutes from './sourceRoutes.js';
import unifiedRoutes from './unifiedRoutes.js';
import analysisRoutes from './analysisRoutes.js';
import aircraftRoutes from './aircraftRoutes.js';
import assetRoutes from './assetRoutes.js';
import meshIssuesRoutes from './meshIssuesRoutes.js';
import coverageRoutes from './coverageRoutes.js';
import crossSourceLinkRoutes from './crossSourceLinkRoutes.js';
import elevationRoutes from './elevationRoutes.js';
import gnssRoutes from './gnssRoutes.js';
import rfCoverageRoutes from './rfCoverageRoutes.js';
import healthRoutes from './healthRoutes.js';
import cleanupRoutes from './cleanupRoutes.js';
import maintenanceRoutes from './maintenanceRoutes.js';
import themeRoutes from './themeRoutes.js';
import purgeRoutes from './purgeRoutes.js';
import tracerouteRoutes from './tracerouteRoutes.js';
import routeSegmentRoutes from './routeSegmentRoutes.js';
import neighborInfoRoutes from './neighborInfoRoutes.js';
import ignoredNodeRoutes from './ignoredNodeRoutes.js';
import announceRoutes from './announceRoutes.js';
import { backupRouter, systemBackupRouter } from './backupRoutes.js';
import { pushRouter, appriseRouter } from './notificationRoutes.js';
import meshRequestRoutes from './meshRequestRoutes.js';
import telemetryRoutes from './telemetryRoutes.js';
import connectionRoutes from './connectionRoutes.js';
import deviceStatusRoutes from './deviceStatusRoutes.js';
import statusRoutes from './statusRoutes.js';
import dataExchangeRoutes from './dataExchangeRoutes.js';
import serverInfoRoutes from './serverInfoRoutes.js';
import scriptRoutes from './scriptRoutes.js';
import scriptSecretRoutes from './scriptSecretRoutes.js';
import deviceRoutes from './deviceRoutes.js';
import systemRoutes from './systemRoutes.js';
import channelRoutes from './channelRoutes.js';
import pollRoutes from './pollRoutes.js';
import configRoutes from './configRoutes.js';
import userPreferencesRoutes from './userPreferencesRoutes.js';
import adminRoutes from './adminRoutes.js';
import nodesRoutes from './nodesRoutes.js';
import nodeNameHistoryRoutes from './nodeNameHistoryRoutes.js';
import mqttBrokerPresetRoutes from './mqttBrokerPresetRoutes.js';
import mqttRootFinderRoutes from './mqttRootFinderRoutes.js';
import ductingRoutes from './ductingRoutes.js';
import translationRoutes from './translationRoutes.js';

export interface ApiRouterDeps {
  geojsonRouter: Router;
  mapStyleRouter: Router;
  /** Mount the development-only `/debug/ip` endpoint (true outside production). */
  includeDebugRoutes: boolean;
}

/**
 * Build the `/api` router. Mount order is load-bearing (more specific mounts
 * precede general ones), and `publicInstanceRedaction()` must stay first (#5156).
 */
export function createApiRouter({ geojsonRouter, mapStyleRouter, includeDebugRoutes }: ApiRouterDeps): Router {
  const apiRouter = express.Router();

  apiRouter.use(publicInstanceRedaction());

  // CSRF token endpoint (must be before CSRF protection middleware)
  apiRouter.get('/csrf-token', csrfTokenEndpoint);

  // Health check endpoints (for upgrade watchdog and monitoring)
  apiRouter.use('/health', healthRoutes);

  // Debug endpoint for IP detection (development only)
  // Helps diagnose reverse proxy and rate limiting issues
  if (includeDebugRoutes) {
    apiRouter.get('/debug/ip', (req, res) => {
      res.json({
        'req.ip': req.ip,
        'req.ips': req.ips,
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-real-ip': req.headers['x-real-ip'],
        'trust-proxy': req.app.get('trust proxy'),
        note: 'The rate limiter uses req.ip to identify clients',
      });
    });

  }

  // Authentication routes
  // Passkeys (#5841) mount first so '/auth' never sees '/auth/passkey/*'.
  apiRouter.use('/auth/passkey', passkeyRoutes);
  apiRouter.use('/auth', authRoutes);

  // API Token management routes (requires auth)
  apiRouter.use('/token', apiTokenRoutes);

  // MFA management routes (requires auth)
  apiRouter.use('/mfa', mfaRoutes);

  // v1 API routes (requires API token)
  apiRouter.use('/v1', v1Router);

  // User management routes (admin only)
  apiRouter.use('/users', optionalAuth(), userRoutes);

  // Audit log routes (admin only)
  apiRouter.use('/audit', optionalAuth(), auditRoutes);

  // Channel database routes (admin only, session-based)
  apiRouter.use('/channel-database', optionalAuth(), channelDatabaseRoutes);

  // Security routes (requires security:read)
  apiRouter.use('/security', optionalAuth(), securityRoutes);

  // Packet log routes (requires channels:read AND messages:read)
  apiRouter.use('/packets', optionalAuth(), packetRoutes);

  // Solar monitoring routes
  apiRouter.use('/solar', optionalAuth(), solarRoutes);

  // News routes (public feed, authenticated status endpoints)
  apiRouter.use('/news', newsRoutes);

  // Message routes (requires appropriate write permissions)
  apiRouter.use('/messages', optionalAuth(), messageRoutes);

  // Translation routes
  apiRouter.use('/translate', optionalAuth(), translationRoutes);

  // Per-user conversation read watermarks (#4607) — the durable anchor for the
  // unread divider and the jump-to-first-unread entry scroll on MeshCore.
  apiRouter.use('/read-state', readStateRoutes);

  // MeshCore routes — nested under `/api/sources/:id/meshcore/*` so each
  // request resolves the manager bound to a specific source. The legacy
  // un-nested `/api/meshcore/*` mount was dropped in slice 3 along with
  // the global `meshcore` permission resource; the new frontend talks to
  // the per-source surface only.
  apiRouter.use('/sources/:id/meshcore', meshcoreRoutes);
  // MeshCore CLI command history across every readable source (#5892).
  apiRouter.use('/meshcore/cli-history', unifiedCliHistoryRouter);

  // Meshtastic remote-admin routes — nested under `/api/sources/:id/meshtastic/*`
  // so each request resolves the manager (and its Virtual Node) bound to a
  // specific source. Hosts the free-form remote-admin CLI console (#6154).
  apiRouter.use('/sources/:id/meshtastic', meshtasticAdminRoutes);

  // MQTT Packet Monitor routes — nested under `/api/sources/:id/mqtt/packets`
  // so each request resolves the retention log bound to a specific source.
  // No source-type check (mirrors meshcore): retained rows stay readable while
  // a source is disconnected or reconfigured. See
  // docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md §2.11/§2.12.
  apiRouter.use('/sources/:id/mqtt/packets', mqttPacketRoutes);

  // MQTT-native ("nodeless") send (#4305) — per-source, MQTT sources only.
  apiRouter.use('/sources/:id/mqtt/native', mqttNativeRoutes);

  // Message Forwarding rules (#5446) — per-source, Meshtastic + MeshCore.
  apiRouter.use('/sources/:id/forwarding', forwardingRoutes);

  // ATAK Contacts routes — nested under `/api/sources/:id/atak` so each
  // request resolves the contact table bound to a specific source. No
  // source-type check (mirrors meshcore/mqtt): a non-Meshtastic or
  // disconnected source simply has no rows. See
  // docs/internal/dev-notes/ATAK_COT_PHASE2_SPEC.md §2g.
  apiRouter.use('/sources/:id/atak', atakRoutes);

  // MeshBeacon offer routes (#4723) — nested under `/api/sources/:id/beacon-offers`.
  // Per-source because accepting an offer is a device write against one radio.
  apiRouter.use('/sources/:id/beacon-offers', beaconOfferRoutes);

  // Network survey (#4726) — nested under `/api/sources/:id/survey`. Read-only
  // synthesis of already-collected data; emits no radio traffic.
  apiRouter.use('/sources/:id/survey', surveyRoutes);
  apiRouter.use('/sources/:id/direct-rf-contacts', directRfContactsRoutes);

  // Predictive RF coverage (#4727) — terrain-modelled, read-only, and NOT
  // per-source: the origin and radio parameters come from the request, so this
  // is a planning tool rather than a property of a configured radio.
  apiRouter.use('/rf', rfCoverageRoutes);

  // Reticulum routes — nested under `/api/sources/:id/reticulum` so each
  // request resolves the destinations/interfaces bound to a specific source.
  // Unlike meshcore, the manager is REMOVED from the registry on disconnect
  // (build spec §3.6/§7 risk 2), so the route guard tolerates an absent
  // manager and read endpoints keep serving persisted rows. See
  // docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md §3.7.
  apiRouter.use('/sources/:id/reticulum', reticulumRoutes);

  // Link preview routes
  apiRouter.use('/', linkPreviewRoutes);

  // Script content proxy routes (for User Scripts Gallery)
  apiRouter.use('/', scriptContentRoutes);

  // Tile server testing routes (for Custom Tileset Manager autodetect)
  apiRouter.use('/tile-server', optionalAuth(), tileServerRoutes);

  // Settings routes (GET/POST/DELETE /settings)
  apiRouter.use('/settings', settingsRoutes);
  apiRouter.use('/node-name-sanitizer', nodeNameSanitizerRoutes);

  // Configuration routes (GET /config, GET /config/current, POST /config/*)
  apiRouter.use('/config', configRoutes);

  // User preferences routes (GET/POST /user/map-preferences)
  apiRouter.use('/user', userPreferencesRoutes);

  // Admin routes (all requireAdmin(); config load/export/import, channel/owner
  // load, device metadata, reboot/set-time, suppressed-ghost mgmt, commands)
  apiRouter.use('/admin', adminRoutes);

  // Embed profile admin routes (admin only)
  apiRouter.use('/embed-profiles', embedProfileRoutes);

  // Firmware OTA update routes (admin only)
  apiRouter.use('/firmware', firmwareUpdateRoutes);

  // Sources management routes
  apiRouter.use('/sources', sourceRoutes);

  // Unified cross-source views
  apiRouter.use('/unified', unifiedRoutes);

  // Mesh issues analysis (#4964 Phase 1) — passive findings from data already
  // on disk. Separate router (analysisRoutes.ts is already 1000+ lines); see
  // meshIssuesRoutes.ts header for the cross-source permission filtering.
  // NOTE: More specific route must come BEFORE general /analysis router
  apiRouter.use('/analysis/mesh-issues', meshIssuesRoutes);

  // Coverage Report (#5277 Phase 1 WP3) — RF-reception query API. Also more
  // specific than /analysis and must be mounted before it; does not collide
  // with /analysis/coverage-grid since Express mount paths match whole
  // segments.
  apiRouter.use('/analysis/coverage', coverageRoutes);

  // Cross-source "heard here" map edges (#5561). More specific than /analysis;
  // mounted before it.
  apiRouter.use('/analysis/cross-source-links', crossSourceLinkRoutes);

  // Cross-source analysis workspace
  apiRouter.use('/analysis', analysisRoutes);

  // Likely-aircraft flight trails (#5364/#5365 Phase 3) — stored telemetry only.
  apiRouter.use('/aircraft', aircraftRoutes);

  // Asset Tracking (#5354) — global per-node asset flag + telemetry retention.
  apiRouter.use('/assets', assetRoutes);

  // Terrain link elevation profile (#4111 Phase 1)
  apiRouter.use('/elevation', elevationRoutes);

  // GNSS/GPS constellation overlay (#4729) — sky view + DOP compute over live TLEs
  apiRouter.use('/gnss', gnssRoutes);

  // GeoJSON overlay layer routes
  apiRouter.use('/geojson', geojsonRouter);
  // Privacy disclosure admin (#5156). The PUBLIC half is mounted below, before
  // the api router, so a logged-out visitor can read the policy; this half stays
  // behind rate limiting, CSRF and settings permissions.
  apiRouter.use('/privacy/admin', privacyAdminRouter);

  // MapLibre GL style routes
  apiRouter.use('/map-styles', mapStyleRouter);
  apiRouter.use('/cleanup', cleanupRoutes);
  apiRouter.use('/maintenance', maintenanceRoutes);
  apiRouter.use('/themes', themeRoutes);
  apiRouter.use('/purge', purgeRoutes);
  apiRouter.use('/traceroutes', tracerouteRoutes);
  apiRouter.use('/route-segments', routeSegmentRoutes);
  apiRouter.use('/neighbor-info', neighborInfoRoutes);
  apiRouter.use('/ignored-nodes', ignoredNodeRoutes);
  apiRouter.use('/announce', announceRoutes);
  apiRouter.use('/backup', backupRouter);
  apiRouter.use('/system/backup', systemBackupRouter);
  apiRouter.use('/push', pushRouter);
  apiRouter.use('/apprise', appriseRouter);
  apiRouter.use('/connection', connectionRoutes);
  // Mounted immediately before '/automations' so its '/:id' route cannot swallow
  // '/automations/convert/*' (#4340 Phase 4 WP3).
  apiRouter.use('/automations/convert', autoAckConverterRoutes);
  apiRouter.use('/automations', automationRoutes);
  // Mounted at '/' because these routers contain mixed top-level paths
  // (e.g. /traceroute, /telemetry/:nodeId, /device/tx-status, /virtual-node/status).
  apiRouter.use('/', meshRequestRoutes);
  apiRouter.use('/', telemetryRoutes);
  apiRouter.use('/', deviceStatusRoutes);
  apiRouter.use('/', statusRoutes);
  apiRouter.use('/', serverInfoRoutes);
  apiRouter.use('/', dataExchangeRoutes);
  // Mounted at '/' because these routers contain mixed top-level paths
  // (/device-config, /device/*, /system/*, /status, /version/check).
  apiRouter.use('/', deviceRoutes);
  apiRouter.use('/', systemRoutes);
  apiRouter.use('/channels', channelRoutes);
  // Mounted at '/' because the script routes use mixed top-level paths
  // (/scripts/*, /http/test). The public /api/scripts listing endpoint is
  // mounted separately on the app below (bypasses CSRF).
  apiRouter.use('/', scriptRoutes);
  // Script Secrets (admin only, write only). Not under /scripts: Express
  // paths are case-insensitive, so /scripts/:name would collide with
  // /scripts/:filename/source.
  apiRouter.use('/script-secrets', scriptSecretRoutes);

  // Consolidated polling endpoint (GET /poll). Mounted at '/' — appended after
  // the existing '/'-mounted routers per #3502 PR1 mount-placement rules.
  apiRouter.use('/', pollRoutes);

  // Node CRUD/favorite/ignore/position-override/notes/etc endpoints
  // (incl. /auto-favorite/status and /auto-ping/stop/:nodeNum). Mounted at
  // '/' — appended after the existing '/'-mounted routers per #3502 PR3
  // mount-placement rules (none of nodesRoutes' paths overlap an existing
  // '/'-mounted module's paths).
  apiRouter.use('/', nodesRoutes);
  // #5862: GET /nodes/:nodeId/name-history
  apiRouter.use('/', nodeNameHistoryRoutes);
  // #5794: saved MQTT broker presets (global, admin-managed)
  apiRouter.use('/mqtt-broker-presets', mqttBrokerPresetRoutes);
  // #6287: MQTT root topic finder (subscribe-only sampler, start-and-poll)
  apiRouter.use('/mqtt/root-finder', mqttRootFinderRoutes);
  // #5734: tropospheric ducting forecast from NOAA GFS (gated by ductingOverlayEnabled + map read)
  apiRouter.use('/ducting', ductingRoutes);

  return apiRouter;
}
