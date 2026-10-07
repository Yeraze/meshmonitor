/**
 * Embed Public Routes
 *
 * GET /:profileId/config — returns the public embed configuration
 * GET /:profileId/nodes  — returns nodes filtered by the profile's channels
 *
 * These routes are mounted outside the API router (no CSRF, no rate limiter).
 * The embed CSP middleware validates the profile and attaches it to the request.
 * The profile ID itself acts as the authorization token — no session required.
 *
 * What an embed may show is decided by the PROFILE alone, in one place
 * (`visibleEmbedNodes`): the viewer is anonymous and holds no grants. Every
 * data route below draws from that one node set, so a node the profile does
 * not show is not a marker, not a line end and not a name in a popup.
 * Responses carry no cache headers and nothing is cached server-side; each is
 * built from the profile named in the URL.
 */

import { Router, Request, Response } from 'express';
import { createEmbedCspMiddleware } from '../middleware/embedMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { loadSignFlipContexts, getDisplayDbNodePosition, rowSourceId } from '../services/signFlipCorrection.js';
import geojsonService from '../services/geojsonService.js';
import { decomposeTraceroute } from '../../utils/tracerouteSegments.js';
import { CHANNEL_DB_OFFSET } from '../constants/meshtastic.js';
import { fail } from '../utils/apiResponse.js';
import type { EmbedProfile } from '../../db/repositories/embedProfiles.js';
import type { DbNode } from '../../db/types.js';

const router = Router();

// Public/cacheable endpoint — hard ceiling on segment count regardless of how
// many traceroutes fall inside the 24h/100-row window (#4047 P6 §2.2 step 6).
const MAX_EMBED_TR_SEGMENTS = 500;

// Wire shape for GET /:profileId/traceroutes — an ADDITIVE SUPERSET of the
// pre-#4047-P6 shape. Legacy fields (fromNum..timestamp) are UNCHANGED so
// stale/cached embed bundles keep working; `leg`/`avgSnr`/`isMqtt` are new
// and ignored by old clients. See docs/internal/dev-notes/MAP_CONSOLIDATION_P6_SPEC.md §2.1.
interface EmbedTracerouteSegmentV2 {
  fromNum: number;
  toNum: number;
  fromLat: number;
  fromLng: number;
  fromName: string;
  toLat: number;
  toLng: number;
  toName: string;
  // CONSTRAINT (#4047 P6 §2.3): previously the raw un-scaled firmware int
  // (dB x4) — now carries the same /4-scaled value as `avgSnr`. This is an
  // intentional, non-breaking correction: an old cached client's popup
  // `{seg.snr} dB` now shows the CORRECT magnitude instead of 4x too large.
  snr: number | null;
  timestamp: number;
  leg: 'forward' | 'return';
  avgSnr: number | null;
  isMqtt: boolean;
}

/**
 * May the profile show something heard on `channel`?
 *
 * A profile lists device channels (0-7). An empty list means every device
 * channel. A channel-database (virtual) channel is one the server decrypts
 * with a stored key; a profile cannot name one, so it is never in scope.
 */
function channelInProfile(profileChannels: Set<number>, channel: number | null | undefined): boolean {
  const ch = channel ?? 0;
  if (ch >= CHANNEL_DB_OFFSET) return false;
  return profileChannels.size === 0 || profileChannels.has(ch);
}

interface EmbedNode {
  node: DbNode;
  latitude: number;
  longitude: number;
  altitude: number | null | undefined;
  name: string;
}

/**
 * The nodes one profile shows, each with the position it is shown at. The
 * single rule for every embed data route:
 *
 *  - the profile's source (every source when it names none);
 *  - not hidden from the map (#3549);
 *  - NOT a node whose position override is private. A private override needs
 *    `nodes_private:read` everywhere else; an anonymous viewer holds nothing
 *    and a profile has no setting that allows it, so the node is left out
 *    altogether, as `buildPositionFilter` does for a viewer without the grant.
 *    It used to be drawn at the private coordinates;
 *  - last heard on a channel in the profile;
 *  - the position shown is a public override, or a reported position that
 *    arrived on a channel in the profile;
 *  - MQTT nodes only when the profile shows them.
 *
 * One node read and one sign-flip read per request, none per node.
 */
async function visibleEmbedNodes(profile: EmbedProfile): Promise<EmbedNode[]> {
  const allNodes = await databaseService.nodes.getActiveNodes(7, profile.sourceId ?? ALL_SOURCES); // intentional cross-source: profile without a sourceId spans all sources
  const profileChannels = new Set(profile.channels);
  // #5363: display-only sign-flip correction, per row's own source.
  const signFlip = await loadSignFlipContexts(allNodes.map(rowSourceId));
  const visible: EmbedNode[] = [];
  for (const node of allNodes) {
    if (node.hideFromMap) continue;
    if (node.positionOverrideIsPrivate) continue;
    if (!channelInProfile(profileChannels, node.channel)) continue;
    if (!profile.showMqttNodes && node.viaMqtt) continue;

    // Effective position, so a (public) override is what is drawn (#2847).
    const eff = getDisplayDbNodePosition(node, signFlip.get(rowSourceId(node) ?? ''));
    if (eff.latitude == null || eff.longitude == null) continue;
    if (eff.latitude === 0 && eff.longitude === 0) continue;
    // A reported position carries the channel it arrived on. Outside the
    // profile's channels there is no position this profile may show.
    if (!eff.isOverride && node.positionChannel != null && !channelInProfile(profileChannels, node.positionChannel)) {
      continue;
    }
    visible.push({
      node,
      latitude: eff.latitude,
      longitude: eff.longitude,
      altitude: eff.altitude,
      name: node.longName || node.shortName || `!${node.nodeNum.toString(16)}`,
    });
  }
  return visible;
}

// GET /:profileId/config — return public config for the embed profile
// The CSP middleware is applied per-route so it can access req.params.profileId
router.get('/:profileId/config', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as { embedProfile?: EmbedProfile }).embedProfile;

  if (!profile) {
    return fail(res, 404, 'NOT_FOUND', 'Embed profile not found');
  }

  // Fall back to the global Default Map Center when the profile's coordinates
  // are unset (0,0). Issue #2668 — embed profiles created before per-profile
  // center was configured, or created without adjusting the default picker,
  // would otherwise load over the Atlantic.
  let defaultLat = profile.defaultLat;
  let defaultLng = profile.defaultLng;
  let defaultZoom = profile.defaultZoom;
  if (defaultLat === 0 && defaultLng === 0) {
    const globalLat = parseFloat(databaseService.getSetting('defaultMapCenterLat') ?? '');
    const globalLon = parseFloat(databaseService.getSetting('defaultMapCenterLon') ?? '');
    const globalZoom = parseInt(databaseService.getSetting('defaultMapCenterZoom') ?? '', 10);
    if (Number.isFinite(globalLat) && Number.isFinite(globalLon)) {
      defaultLat = globalLat;
      defaultLng = globalLon;
      if (Number.isFinite(globalZoom)) defaultZoom = globalZoom;
    }
  }

  // Deployment-wide Carto basemap API key (#4934). Publishable, domain-restricted
  // token applied to Carto tiles so the embed map loads without the "API key
  // required" watermark. Sent to anonymous embed viewers by design.
  const cartoApiKey = databaseService.getSetting('cartoApiKey') || null;

  // Return only public-facing configuration (exclude admin-only fields like name, allowedOrigins)
  res.json({
    id: profile.id,
    channels: profile.channels,
    tileset: profile.tileset,
    cartoApiKey,
    defaultLat,
    defaultLng,
    defaultZoom,
    showTooltips: profile.showTooltips,
    showPopups: profile.showPopups,
    showLegend: profile.showLegend,
    showPaths: profile.showPaths,
    showNeighborInfo: profile.showNeighborInfo,
    showTraceroutes: profile.showTraceroutes,
    showMqttNodes: profile.showMqttNodes,
    pollIntervalSeconds: profile.pollIntervalSeconds,
  });
});

// GET /:profileId/nodes — return nodes filtered by the profile's channel list
// The profile ID acts as the auth token — no session/login required.
// Only returns the minimal fields needed for map display (no sensitive data).
router.get('/:profileId/nodes', createEmbedCspMiddleware(), async (req: Request, res: Response) => {
  const profile = (req as { embedProfile?: EmbedProfile }).embedProfile;

  if (!profile) {
    return fail(res, 404, 'NOT_FOUND', 'Embed profile not found');
  }

  try {
    const visible = await visibleEmbedNodes(profile);

    // Return public-safe fields for map display
    const nodes = visible.map(({ node, latitude, longitude, altitude }) => ({
      nodeNum: node.nodeNum,
      nodeId: node.nodeId,
      user: {
        longName: node.longName,
        shortName: node.shortName,
        hwModel: node.hwModel,
      },
      position: {
        latitude,
        longitude,
        altitude,
      },
      lastHeard: node.lastHeard,
      // #5390: Unix seconds; undefined = unknown.
      firstHeard: node.firstHeard != null ? Number(node.firstHeard) : undefined,
      snr: node.snr,
      hopsAway: node.hopsAway ?? 999,
      role: node.role ?? 0,
      viaMqtt: node.viaMqtt || false,
      channel: node.channel ?? 0,
    }));

    res.json(nodes);
  } catch (error) {
    logger.error('Error fetching embed nodes:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch nodes');
  }
});

// GET /:profileId/neighborinfo — return neighbor info with positions for drawing connection lines
router.get('/:profileId/neighborinfo', createEmbedCspMiddleware(), async (req: Request, res: Response) => {
  const profile = (req as { embedProfile?: EmbedProfile }).embedProfile;

  if (!profile) {
    return fail(res, 404, 'NOT_FOUND', 'Embed profile not found');
  }

  // The profile must opt in, as it must for traceroutes. The embed page only
  // asks when the option is on; the route used to answer either way.
  if (!profile.showNeighborInfo) {
    return fail(res, 404, 'NOT_FOUND', 'Neighbor info not enabled for this profile');
  }

  try {
    // The nodes this profile shows. A link is drawn only between two of them,
    // so a hidden, private or out-of-profile node is never a line end. This
    // route used to skip the hideFromMap check the other two made.
    const nodeMap = new Map<number, EmbedNode>();
    for (const entry of await visibleEmbedNodes(profile)) nodeMap.set(entry.node.nodeNum, entry);

    const rawNeighbors = await databaseService.neighbors.getAllNeighborInfo(profile.sourceId ?? ALL_SOURCES); // intentional cross-source: profile without a sourceId spans all sources

    // Enrich with positions — only include pairs where both nodes are in the filtered set
    const segments = rawNeighbors
      .filter(ni => nodeMap.has(ni.nodeNum) && nodeMap.has(ni.neighborNodeNum))
      .map(ni => {
        const nodePos = nodeMap.get(ni.nodeNum)!;
        const neighborPos = nodeMap.get(ni.neighborNodeNum)!;
        return {
          nodeNum: ni.nodeNum,
          neighborNodeNum: ni.neighborNodeNum,
          snr: ni.snr ?? null,
          nodeLatitude: nodePos.latitude,
          nodeLongitude: nodePos.longitude,
          nodeName: nodePos.name,
          neighborLatitude: neighborPos.latitude,
          neighborLongitude: neighborPos.longitude,
          neighborName: neighborPos.name,
        };
      });

    res.json(segments);
  } catch (error) {
    logger.error('Error fetching embed neighbor info:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch neighbor info');
  }
});

// GET /:profileId/traceroutes — return pre-computed traceroute path segments with positions
router.get('/:profileId/traceroutes', createEmbedCspMiddleware(), async (req: Request, res: Response) => {
  const profile = (req as { embedProfile?: EmbedProfile }).embedProfile;

  if (!profile) {
    return fail(res, 404, 'NOT_FOUND', 'Embed profile not found');
  }

  // Profile must explicitly opt in to exposing traceroute topology.
  // Default false avoids leaking mesh topology to embed viewers.
  if (!profile.showTraceroutes) {
    return fail(res, 404, 'NOT_FOUND', 'Traceroutes not enabled for this profile');
  }

  try {
    const profileChannels = new Set(profile.channels);

    // Build position lookup for visible nodes — this is the leak boundary
    // (#4047 P6 §6.2): a segment is emitted below only when BOTH endpoints
    // resolve here, so hidden/filtered nodes never leave the server. The same
    // node set as GET /:profileId/nodes.
    const nodePositions = new Map<number, { lat: number; lng: number; name: string }>();
    for (const entry of await visibleEmbedNodes(profile)) {
      nodePositions.set(entry.node.nodeNum, { lat: entry.latitude, lng: entry.longitude, name: entry.name });
    }

    // Live-only position resolution — deliberately NO snapshot (#1862's
    // routePositions is not consulted here). This matches the embed's
    // pre-existing live-only behavior and avoids a new leak: a historical
    // snapshot could reveal where a now-hidden/filtered node used to be
    // (#4047 P6 §6.1). decomposeTraceroute skips any segment whose endpoint
    // resolves to null, so the visible-node filter above is the sole gate.
    const resolvePosition = (n: number): [number, number] | null => {
      const p = nodePositions.get(n);
      return p ? [p.lat, p.lng] : null;
    };

    // Get recent traceroutes and decompose via the shared util (the ONE
    // decomposition — also used by the app's TraceroutePathsLayer).
    const traceroutes = await databaseService.traceroutes.getAllTraceroutes(100, profile.sourceId ?? ALL_SOURCES); // intentional cross-source: profile without a sourceId spans all sources
    // Traceroute timestamps can be in ms or seconds — normalize to ms
    const cutoffMs = Date.now() - (24 * 60 * 60 * 1000); // last 24h

    // Dedup by the util's leg-scoped key (`${leg}:${fromNum}-${toNum}`) —
    // forward and return legs are distinct keys so both survive; keep the
    // newest timestamp per key. Do NOT collapse to a bidirectional pair key,
    // that would drop the return leg.
    const segmentMap = new Map<string, EmbedTracerouteSegmentV2>();

    for (const tr of traceroutes) {
      const tsMs = tr.timestamp < 1e12 ? tr.timestamp * 1000 : tr.timestamp;
      if (tsMs < cutoffMs) continue;
      // A traceroute heard on a channel outside the profile is not shown,
      // whoever its endpoints are. No channel recorded: no restriction.
      if (tr.channel != null && !channelInProfile(profileChannels, tr.channel)) continue;

      const renderSegments = decomposeTraceroute(tr, { resolvePosition });
      for (const seg of renderSegments) {
        const fromInfo = nodePositions.get(seg.fromNodeNum);
        const toInfo = nodePositions.get(seg.toNodeNum);
        // Both endpoints resolved (decomposeTraceroute already guarantees
        // this via resolvePosition), so the names are always present.
        if (!fromInfo || !toInfo) continue;

        const timestamp = seg.timestamp ?? tr.timestamp;
        const existing = segmentMap.get(seg.key);
        if (existing && existing.timestamp >= timestamp) continue;

        segmentMap.set(seg.key, {
          fromNum: seg.fromNodeNum,
          toNum: seg.toNodeNum,
          fromLat: seg.from[0],
          fromLng: seg.from[1],
          fromName: fromInfo.name,
          toLat: seg.to[0],
          toLng: seg.to[1],
          toName: toInfo.name,
          // §2.3: legacy `snr` now carries the /4-scaled `avgSnr` (was the
          // raw un-scaled dB x4 value) — intentional, non-breaking fix.
          snr: seg.avgSnr,
          timestamp,
          // decomposeTraceroute only ever assigns 'forward'/'return' to
          // segments it builds (the 'neutral' leg variant is unused here).
          leg: seg.leg as 'forward' | 'return',
          avgSnr: seg.avgSnr,
          isMqtt: seg.isMqtt,
        });
      }
    }

    // Cap the response — sort newest-first before slicing so the freshest
    // segments survive the cap (§2.2 step 6; public/cacheable endpoint).
    const segments = Array.from(segmentMap.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_EMBED_TR_SEGMENTS);

    res.json(segments);
  } catch (error) {
    logger.error('Error fetching embed traceroutes:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch traceroutes');
  }
});

// GET /:profileId/geojson/layers — public GeoJSON overlay layers (issue #3407).
// GeoJSON layers are global (not per-profile); only layers flagged
// publiclyVisible are exposed to embed/anonymous viewers.
router.get('/:profileId/geojson/layers', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as { embedProfile?: EmbedProfile }).embedProfile;
  if (!profile) {
    return fail(res, 404, 'NOT_FOUND', 'Embed profile not found');
  }
  try {
    return res.json(geojsonService.getPublicLayers());
  } catch (error) {
    logger.error('Error fetching embed geojson layers:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch geojson layers');
  }
});

// GET /:profileId/geojson/layers/:id/data — raw data for a PUBLIC layer only.
// A private (non-publiclyVisible) layer 404s.
router.get('/:profileId/geojson/layers/:id/data', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as { embedProfile?: EmbedProfile }).embedProfile;
  if (!profile) {
    return fail(res, 404, 'NOT_FOUND', 'Embed profile not found');
  }
  try {
    const data = geojsonService.getPublicLayerData(req.params.id);
    res.setHeader('Content-Type', 'application/geo+json');
    return res.send(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('not found')) {
      return fail(res, 404, 'NOT_FOUND', message);
    }
    logger.error('Error fetching embed geojson layer data:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch geojson layer data');
  }
});

export default router;
