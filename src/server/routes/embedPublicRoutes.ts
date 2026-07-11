/**
 * Embed Public Routes
 *
 * GET /:profileId/config — returns the public embed configuration
 * GET /:profileId/nodes  — returns nodes filtered by the profile's channels
 *
 * These routes are mounted outside the API router (no CSRF, no rate limiter).
 * The embed CSP middleware validates the profile and attaches it to the request.
 * The profile ID itself acts as the authorization token — no session required.
 */

import { Router, Request, Response } from 'express';
import { createEmbedCspMiddleware } from '../middleware/embedMiddleware.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import geojsonService from '../services/geojsonService.js';
import { decomposeTraceroute } from '../../utils/tracerouteSegments.js';

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

// GET /:profileId/config — return public config for the embed profile
// The CSP middleware is applied per-route so it can access req.params.profileId
router.get('/:profileId/config', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
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

  // Return only public-facing configuration (exclude admin-only fields like name, allowedOrigins)
  res.json({
    id: profile.id,
    channels: profile.channels,
    tileset: profile.tileset,
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
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  try {
    const allNodes = await databaseService.nodes.getActiveNodes(7, profile.sourceId ?? ALL_SOURCES); // intentional cross-source: profile without a sourceId spans all sources

    // Filter by the profile's configured channels
    const profileChannels = new Set(profile.channels as number[]);
    // Resolve effective position once per node so the override (if set) is the
    // value used for both filtering and display (issue #2847).
    const filtered = allNodes
      .map(node => ({ node, eff: getEffectiveDbNodePosition(node) }))
      .filter(({ node, eff }) => {
        // #3549: per-node "Hide from Map" suppresses the marker on every map surface
        if (node.hideFromMap) return false;

        // Must have a position (override or device-reported)
        if (eff.latitude == null || eff.longitude == null) return false;
        if (eff.latitude === 0 && eff.longitude === 0) return false;

        // Filter by channels
        if (profileChannels.size > 0) {
          const ch = node.channel ?? 0;
          if (!profileChannels.has(ch)) return false;
        }

        // Filter out MQTT nodes if configured
        if (!profile.showMqttNodes && node.viaMqtt) return false;

        return true;
      });

    // Return public-safe fields for map display
    const nodes = filtered.map(({ node, eff }) => ({
      nodeNum: node.nodeNum,
      nodeId: node.nodeId,
      user: {
        longName: node.longName,
        shortName: node.shortName,
        hwModel: node.hwModel,
      },
      position: {
        latitude: eff.latitude,
        longitude: eff.longitude,
        altitude: eff.altitude,
      },
      lastHeard: node.lastHeard,
      snr: node.snr,
      hopsAway: node.hopsAway ?? 999,
      role: node.role ?? 0,
      viaMqtt: node.viaMqtt || false,
      channel: node.channel ?? 0,
    }));

    res.json(nodes);
  } catch (error) {
    logger.error('Error fetching embed nodes:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

// GET /:profileId/neighborinfo — return neighbor info with positions for drawing connection lines
router.get('/:profileId/neighborinfo', createEmbedCspMiddleware(), async (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  try {
    const allNodes = await databaseService.nodes.getActiveNodes(7, profile.sourceId ?? ALL_SOURCES); // intentional cross-source: profile without a sourceId spans all sources
    const profileChannels = new Set(profile.channels as number[]);

    // Build a lookup of nodes that pass the embed's filters. Use effective
    // position so a user-set override is what's drawn on the map (issue #2847).
    const nodeMap = new Map<number, { latitude: number; longitude: number; name: string }>();
    for (const node of allNodes) {
      const eff = getEffectiveDbNodePosition(node);
      if (eff.latitude == null || eff.longitude == null) continue;
      if (eff.latitude === 0 && eff.longitude === 0) continue;
      if (!profile.showMqttNodes && node.viaMqtt) continue;
      if (profileChannels.size > 0) {
        const ch = node.channel ?? 0;
        if (!profileChannels.has(ch)) continue;
      }
      nodeMap.set(node.nodeNum, {
        latitude: eff.latitude,
        longitude: eff.longitude,
        name: node.longName || node.shortName || `!${node.nodeNum.toString(16)}`,
      });
    }

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
    res.status(500).json({ error: 'Failed to fetch neighbor info' });
  }
});

// GET /:profileId/traceroutes — return pre-computed traceroute path segments with positions
router.get('/:profileId/traceroutes', createEmbedCspMiddleware(), async (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  // Profile must explicitly opt in to exposing traceroute topology.
  // Default false avoids leaking mesh topology to embed viewers.
  if (!profile.showTraceroutes) {
    return res.status(404).json({ error: 'Traceroutes not enabled for this profile' });
  }

  try {
    const allNodes = await databaseService.nodes.getActiveNodes(7, profile.sourceId ?? ALL_SOURCES); // intentional cross-source: profile without a sourceId spans all sources
    const profileChannels = new Set(profile.channels as number[]);

    // Build position lookup for visible nodes — this is the leak boundary
    // (#4047 P6 §6.2): a segment is emitted below only when BOTH endpoints
    // resolve here, so hidden/filtered nodes never leave the server. Same
    // filters as GET /:profileId/nodes: effective position (#2847), drop
    // (0,0), drop hideFromMap (#3549), MQTT filter, channel filter.
    const nodePositions = new Map<number, { lat: number; lng: number; name: string }>();
    for (const node of allNodes) {
      if (node.hideFromMap) continue;
      const eff = getEffectiveDbNodePosition(node);
      if (eff.latitude == null || eff.longitude == null) continue;
      if (eff.latitude === 0 && eff.longitude === 0) continue;
      if (!profile.showMqttNodes && node.viaMqtt) continue;
      if (profileChannels.size > 0) {
        const ch = node.channel ?? 0;
        if (!profileChannels.has(ch)) continue;
      }
      nodePositions.set(node.nodeNum, {
        lat: eff.latitude,
        lng: eff.longitude,
        name: node.longName || node.shortName || `!${node.nodeNum.toString(16)}`,
      });
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
    res.status(500).json({ error: 'Failed to fetch traceroutes' });
  }
});

// GET /:profileId/geojson/layers — public GeoJSON overlay layers (issue #3407).
// GeoJSON layers are global (not per-profile); only layers flagged
// publiclyVisible are exposed to embed/anonymous viewers.
router.get('/:profileId/geojson/layers', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;
  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }
  try {
    return res.json(geojsonService.getPublicLayers());
  } catch (error) {
    logger.error('Error fetching embed geojson layers:', error);
    return res.status(500).json({ error: 'Failed to fetch geojson layers' });
  }
});

// GET /:profileId/geojson/layers/:id/data — raw data for a PUBLIC layer only.
// A private (non-publiclyVisible) layer 404s.
router.get('/:profileId/geojson/layers/:id/data', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;
  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }
  try {
    const data = geojsonService.getPublicLayerData(req.params.id);
    res.setHeader('Content-Type', 'application/geo+json');
    return res.send(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes('not found')) {
      return res.status(404).json({ error: message });
    }
    logger.error('Error fetching embed geojson layer data:', error);
    return res.status(500).json({ error: 'Failed to fetch geojson layer data' });
  }
});

export default router;
