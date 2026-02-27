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
import { logger } from '../../utils/logger.js';

const router = Router();

// GET /:profileId/config — return public config for the embed profile
// The CSP middleware is applied per-route so it can access req.params.profileId
router.get('/:profileId/config', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  // Return only public-facing configuration (exclude admin-only fields like name, allowedOrigins)
  res.json({
    id: profile.id,
    channels: profile.channels,
    tileset: profile.tileset,
    defaultLat: profile.defaultLat,
    defaultLng: profile.defaultLng,
    defaultZoom: profile.defaultZoom,
    showTooltips: profile.showTooltips,
    showPopups: profile.showPopups,
    showLegend: profile.showLegend,
    showPaths: profile.showPaths,
    showNeighborInfo: profile.showNeighborInfo,
    showMqttNodes: profile.showMqttNodes,
    pollIntervalSeconds: profile.pollIntervalSeconds,
  });
});

// GET /:profileId/nodes — return nodes filtered by the profile's channel list
// The profile ID acts as the auth token — no session/login required.
// Only returns the minimal fields needed for map display (no sensitive data).
router.get('/:profileId/nodes', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  try {
    const allNodes = databaseService.getActiveNodes(7);

    // Filter by the profile's configured channels
    const profileChannels = new Set(profile.channels as number[]);
    const filtered = allNodes.filter(node => {
      // Must have a position
      if (!node.latitude || !node.longitude) return false;
      if (node.latitude === 0 && node.longitude === 0) return false;

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
    const nodes = filtered.map(node => ({
      nodeNum: node.nodeNum,
      nodeId: node.nodeId,
      user: {
        longName: node.longName,
        shortName: node.shortName,
        hwModel: node.hwModel,
      },
      position: {
        latitude: node.latitude,
        longitude: node.longitude,
        altitude: node.altitude,
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
router.get('/:profileId/neighborinfo', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  try {
    const allNodes = databaseService.getActiveNodes(7);
    const profileChannels = new Set(profile.channels as number[]);

    // Build a lookup of nodes that pass the embed's filters
    const nodeMap = new Map<number, { latitude: number; longitude: number; name: string }>();
    for (const node of allNodes) {
      if (!node.latitude || !node.longitude) continue;
      if (node.latitude === 0 && node.longitude === 0) continue;
      if (!profile.showMqttNodes && node.viaMqtt) continue;
      if (profileChannels.size > 0) {
        const ch = node.channel ?? 0;
        if (!profileChannels.has(ch)) continue;
      }
      nodeMap.set(node.nodeNum, {
        latitude: node.latitude,
        longitude: node.longitude,
        name: node.longName || node.shortName || `!${node.nodeNum.toString(16)}`,
      });
    }

    const rawNeighbors = databaseService.getAllNeighborInfo();

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
router.get('/:profileId/traceroutes', createEmbedCspMiddleware(), (req: Request, res: Response) => {
  const profile = (req as any).embedProfile;

  if (!profile) {
    return res.status(404).json({ error: 'Embed profile not found' });
  }

  try {
    const allNodes = databaseService.getActiveNodes(7);
    const profileChannels = new Set(profile.channels as number[]);

    // Build position lookup for visible nodes
    const nodePositions = new Map<number, { lat: number; lng: number; name: string }>();
    for (const node of allNodes) {
      if (!node.latitude || !node.longitude) continue;
      if (node.latitude === 0 && node.longitude === 0) continue;
      if (!profile.showMqttNodes && node.viaMqtt) continue;
      if (profileChannels.size > 0) {
        const ch = node.channel ?? 0;
        if (!profileChannels.has(ch)) continue;
      }
      nodePositions.set(node.nodeNum, {
        lat: node.latitude,
        lng: node.longitude,
        name: node.longName || node.shortName || `!${node.nodeNum.toString(16)}`,
      });
    }

    // Get recent traceroutes and decompose into point-to-point segments
    const traceroutes = databaseService.getAllTraceroutes(100);
    // Traceroute timestamps can be in ms or seconds — normalize to ms
    const cutoffMs = Date.now() - (24 * 60 * 60 * 1000); // last 24h

    // Deduplicate segments by pair (keep most recent)
    const segmentMap = new Map<string, {
      fromNum: number; toNum: number;
      fromLat: number; fromLng: number; fromName: string;
      toLat: number; toLng: number; toName: string;
      snr: number | null; timestamp: number;
    }>();

    for (const tr of traceroutes) {
      // Normalize timestamp: if < 1e12 it's in seconds, convert to ms
      const tsMs = tr.timestamp < 1e12 ? tr.timestamp * 1000 : tr.timestamp;
      if (tsMs < cutoffMs) continue;
      if (!tr.route || tr.route === 'null') continue;

      // Parse the route string — stored as JSON array e.g. "[123,456]"
      let routeNums: number[];
      try {
        const parsed = JSON.parse(tr.route);
        routeNums = Array.isArray(parsed) ? parsed : [];
      } catch {
        continue;
      }

      // Build full path: from -> route hops -> to
      const fullPath = [tr.fromNodeNum, ...routeNums, tr.toNodeNum];

      // Parse SNR values if available — also stored as JSON array
      let snrValues: number[] = [];
      if (tr.snrTowards) {
        try {
          const parsed = JSON.parse(tr.snrTowards);
          snrValues = Array.isArray(parsed) ? parsed : [];
        } catch {
          // ignore
        }
      }

      // Create segments between consecutive nodes in the path
      for (let i = 0; i < fullPath.length - 1; i++) {
        const fromNum = fullPath[i];
        const toNum = fullPath[i + 1];
        if (!fromNum || !toNum || fromNum === toNum) continue;

        const fromPos = nodePositions.get(fromNum);
        const toPos = nodePositions.get(toNum);
        if (!fromPos || !toPos) continue;

        // Canonical key — always lower nodeNum first for dedup
        const key = fromNum < toNum ? `${fromNum}-${toNum}` : `${toNum}-${fromNum}`;
        const existing = segmentMap.get(key);
        if (!existing || tr.timestamp > existing.timestamp) {
          segmentMap.set(key, {
            fromNum, toNum,
            fromLat: fromPos.lat, fromLng: fromPos.lng, fromName: fromPos.name,
            toLat: toPos.lat, toLng: toPos.lng, toName: toPos.name,
            snr: snrValues[i] ?? null,
            timestamp: tr.timestamp,
          });
        }
      }
    }

    res.json(Array.from(segmentMap.values()));
  } catch (error) {
    logger.error('Error fetching embed traceroutes:', error);
    res.status(500).json({ error: 'Failed to fetch traceroutes' });
  }
});

export default router;
