import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import databaseService from '../../services/database.js';
import { requirePermission, optionalAuth, hasPermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { MeshtasticManager } from '../meshtasticManager.js';
import { filterNodesByChannelPermission, maskNodeLocationByChannel, getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { PortNum } from '../constants/meshtastic.js';
import { transformChannel } from '../utils/channelView.js';
import type { ResourceType } from '../../types/permission.js';

const router = Router();

// Validate virtualNode config nested inside a source config blob.
// Returns null on success, or { status, error } on failure.
async function validateVirtualNodeConfig(
  type: string,
  config: any,
  excludeSourceId?: string
): Promise<{ status: number; error: string } | null> {
  const vn = config?.virtualNode;
  if (vn === undefined || vn === null) return null;
  if (type !== 'meshtastic_tcp') {
    return { status: 400, error: 'virtualNode config is only supported on meshtastic_tcp sources' };
  }
  if (vn.enabled !== true) return null;
  const port = vn.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 400, error: 'virtualNode.port must be an integer between 1 and 65535' };
  }
  const all = await databaseService.sources.getAllSources();
  for (const s of all) {
    if (s.id === excludeSourceId) continue;
    const otherVn = (s.config as any)?.virtualNode;
    if (otherVn?.enabled === true && otherVn.port === port) {
      return { status: 409, error: `virtualNode.port ${port} is already in use by source "${s.name}"` };
    }
  }
  return null;
}

// Pure utility — no request-specific state. Delegates to the shared helper
// so override behaviour matches the rest of the API surface (issue #2847).
const getEffectivePosition = (node: any) => getEffectiveDbNodePosition(node);

// MM-SEC-8: shared credential strip applied to source records leaving the
// HTTP boundary. The `mqtt` and `meshcore` source types carry connection
// credentials in their `config` blob; both the list and singular GET
// endpoints must remove them for non-admin callers. Admins receive the
// full record so the existing source-edit UI continues to round-trip
// values (the form re-posts the same blob it loaded).
function stripSourceSecrets<T extends { config?: unknown } | null | undefined>(
  source: T,
  isAdmin: boolean,
): T {
  if (!source || isAdmin) return source;
  const { password, apiKey, ...safeConfig } = (source.config as any) ?? {};
  void password;
  void apiKey;
  return { ...source, config: safeConfig };
}

// List all sources — public so the landing page can redirect unauthenticated users
// to the single-source view (or show the login button on the source list page).
// Sensitive config fields are not exposed.
router.get('/', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const sources = await databaseService.sources.getAllSources();
    const isAdmin = req.user?.isAdmin === true;
    // Project to public-safe metadata, then run through the shared
    // credential strip so admins still receive `password`/`apiKey`
    // (needed for the source-edit UI round-trip) and everyone else
    // does not.
    const projected = sources.map(s => stripSourceSecrets({
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      config: s.config,
    }, isAdmin));
    res.json(projected);
  } catch (error) {
    logger.error('Error listing sources:', error);
    res.status(500).json({ error: 'Failed to list sources' });
  }
});

// Get single source
//
// MM-SEC-8: pass the row through the same `stripSourceSecrets` helper as the
// list endpoint above. `sources:read` covers source metadata (name, type,
// enabled, etc.); credentials embedded in the `config` blob are admin-only,
// matching the MM-SEC-1 pattern for `GET /api/settings`.
router.get('/:id', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    const isAdmin = req.user?.isAdmin === true;
    res.json(stripSourceSecrets(source, isAdmin));
  } catch (error) {
    logger.error('Error fetching source:', error);
    res.status(500).json({ error: 'Failed to fetch source' });
  }
});

// Create source
router.post('/', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, type, config, enabled } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required and must be a string' });
    }
    if (!['meshtastic_tcp', 'mqtt', 'meshcore'].includes(type)) {
      return res.status(400).json({ error: 'type must be meshtastic_tcp, mqtt, or meshcore' });
    }
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config is required and must be an object' });
    }

    const vnErr = await validateVirtualNodeConfig(type, config);
    if (vnErr) {
      return res.status(vnErr.status).json({ error: vnErr.error });
    }

    // Prevent duplicate host:port combinations
    if (type === 'meshtastic_tcp' && config.host && config.port) {
      const existing = await databaseService.sources.getAllSources();
      const duplicate = existing.find((s) => {
        const cfg = s.config as any;
        return cfg?.host === config.host && cfg?.port === config.port;
      });
      if (duplicate) {
        return res.status(409).json({
          error: `A source already exists with host ${config.host}:${config.port} ("${duplicate.name}")`,
        });
      }
    }

    const source = await databaseService.sources.createSource({
      id: uuidv4(),
      name: name.trim(),
      type,
      config,
      enabled: enabled !== false,
      createdBy: req.user?.id,
    });

    // Start manager if source is enabled and autoConnect is not explicitly false.
    // autoConnect=false means the source is registered but won't start monitoring
    // until a user explicitly clicks Connect (issue #2773).
    const cfgForStart = source.config as any;
    if (source.enabled && source.type === 'meshtastic_tcp' && cfgForStart?.autoConnect !== false) {
      try {
        const manager = new MeshtasticManager(source.id, {
          host: cfgForStart.host,
          port: cfgForStart.port,
          heartbeatIntervalSeconds: cfgForStart.heartbeatIntervalSeconds,
          virtualNode: cfgForStart.virtualNode,
        });
        await sourceManagerRegistry.addManager(manager);
      } catch (err) {
        logger.warn(`Could not start manager for new source ${source.id}:`, err);
      }
    }

    res.status(201).json(source);
  } catch (error) {
    logger.error('Error creating source:', error);
    res.status(500).json({ error: 'Failed to create source' });
  }
});

// Update source
router.put('/:id', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, config, enabled } = req.body;
    const existing = await databaseService.sources.getSource(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Source not found' });
    }

    const updates: any = {};
    if (name !== undefined) updates.name = name.trim();
    if (config !== undefined) updates.config = config;
    if (enabled !== undefined) updates.enabled = enabled;

    // Validate VN config if config is being updated
    if (config !== undefined) {
      const vnErr = await validateVirtualNodeConfig(existing.type, config, existing.id);
      if (vnErr) {
        return res.status(vnErr.status).json({ error: vnErr.error });
      }

      // Prevent duplicate host:port combinations (exclude self)
      if (existing.type === 'meshtastic_tcp' && config.host && config.port) {
        const allSources = await databaseService.sources.getAllSources();
        const duplicate = allSources.find((s) => {
          if (s.id === req.params.id) return false;
          const cfg = s.config as any;
          return cfg?.host === config.host && cfg?.port === config.port;
        });
        if (duplicate) {
          return res.status(409).json({
            error: `A source already exists with host ${config.host}:${config.port} ("${duplicate.name}")`,
          });
        }
      }
    }

    const source = await databaseService.sources.updateSource(req.params.id, updates);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // Handle enable/disable transitions
    const wasEnabled = existing.enabled;
    const isNowEnabled = source.enabled;
    const oldAutoConnect = (existing.config as any)?.autoConnect !== false;
    const newAutoConnect = (source.config as any)?.autoConnect !== false;

    if (!wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp' && newAutoConnect) {
      // Newly enabled and autoConnect on: start manager if not already running.
      // When autoConnect is false, the source stays enabled but idle until the
      // user explicitly clicks Connect (issue #2773).
      if (!sourceManagerRegistry.getManager(source.id)) {
        try {
          const cfg = source.config as any;
          const manager = new MeshtasticManager(source.id, {
            host: cfg.host,
            port: cfg.port,
            heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
            virtualNode: cfg.virtualNode,
          });
          await sourceManagerRegistry.addManager(manager);
        } catch (err) {
          logger.warn(`Could not start manager for source ${source.id}:`, err);
        }
      }
    } else if (wasEnabled && !isNowEnabled) {
      // Newly disabled: stop manager
      await sourceManagerRegistry.removeManager(source.id);
    } else if (wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp' && oldAutoConnect && !newAutoConnect) {
      // autoConnect just turned off — stop the running manager. The source
      // stays enabled so the user can manually reconnect.
      await sourceManagerRegistry.removeManager(source.id);
    } else if (wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp' && !oldAutoConnect && newAutoConnect) {
      // autoConnect just turned on — start the manager if not already running.
      if (!sourceManagerRegistry.getManager(source.id)) {
        try {
          const cfg = source.config as any;
          const manager = new MeshtasticManager(source.id, {
            host: cfg.host,
            port: cfg.port,
            heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
            virtualNode: cfg.virtualNode,
          });
          await sourceManagerRegistry.addManager(manager);
        } catch (err) {
          logger.warn(`Could not start manager for source ${source.id}:`, err);
        }
      }
    } else if (wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp' && config !== undefined) {
      // Still enabled, config possibly changed. Detect what changed and act.
      const oldCfg = (existing.config as any) || {};
      const newCfg = (source.config as any) || {};
      const transportChanged =
        oldCfg.host !== newCfg.host ||
        oldCfg.port !== newCfg.port ||
        // Heartbeat changes require a restart because the interval is baked
        // into the transport at construct-time (issue 2609).
        (oldCfg.heartbeatIntervalSeconds ?? 0) !== (newCfg.heartbeatIntervalSeconds ?? 0);
      const oldVn = JSON.stringify(oldCfg.virtualNode ?? null);
      const newVn = JSON.stringify(newCfg.virtualNode ?? null);
      const vnChanged = oldVn !== newVn;

      if (transportChanged) {
        // Full restart — upstream TCP target or heartbeat config changed.
        try {
          await sourceManagerRegistry.removeManager(source.id);
          const manager = new MeshtasticManager(source.id, {
            host: newCfg.host,
            port: newCfg.port,
            heartbeatIntervalSeconds: newCfg.heartbeatIntervalSeconds,
            virtualNode: newCfg.virtualNode,
          });
          await sourceManagerRegistry.addManager(manager);
        } catch (err) {
          logger.warn(`Could not restart manager for source ${source.id}:`, err);
        }
      } else if (vnChanged) {
        // Hot-swap only the virtual node sub-feature.
        try {
          await sourceManagerRegistry.reconfigureVirtualNode(source.id, newCfg.virtualNode);
        } catch (err) {
          logger.warn(`Could not hot-swap virtual node for source ${source.id}:`, err);
        }
      }
    }

    res.json(source);
  } catch (error) {
    logger.error('Error updating source:', error);
    res.status(500).json({ error: 'Failed to update source' });
  }
});

// Delete source
router.delete('/:id', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    // Stop the manager before deleting
    await sourceManagerRegistry.removeManager(req.params.id);

    const deleted = await databaseService.sources.deleteSource(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Source not found' });
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting source:', error);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

// Get source status (connection state from registry)
//
// Includes a `nodeCount` field so the dashboard sidebar can show how many nodes
// each source has heard without having to fetch every source's full node list
// (the sidebar polls /status for every source on a 15s interval, but the
// expensive /nodes endpoint is only fetched for the *selected* source).
// `optionalAuth` (not requirePermission) so anonymous viewers see live
// connection state — same approach as /api/unified/sources-status. The
// sidebar badge is operational signal, not user-scoped data, and gating it
// caused anonymous users to see "Connecting"/"Idle" forever (issue #2883).
// Node counts remain permission-scoped: only included when the caller has
// `nodes:read` for this source, mirroring the unified endpoint.
router.get('/:id/status', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    const manager = sourceManagerRegistry.getManager(req.params.id);
    const status = manager ? manager.getStatus() : {
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      connected: false,
    };

    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const canReadNodes = isAdmin || (user
      ? await databaseService.checkPermissionAsync(user.id, 'nodes', 'read', source.id)
      : false);

    if (!canReadNodes) {
      return res.json(status);
    }

    // Cheap COUNT(*) queries — never throw on empty source.
    // `activeNodeCount` is the count of nodes heard in the last 2h, used by
    // the sidebar's node-activity badge (issue #2883). Kept parallel with
    // the total count so source status fans out in a single round-trip.
    const [nodeCount, activeNodeCount] = await Promise.all([
      databaseService.nodes.getNodeCount(source.id).catch(() => 0),
      databaseService.nodes.getActiveNodeCount(source.id).catch(() => 0),
    ]);
    res.json({ ...status, nodeCount, activeNodeCount });
  } catch (error) {
    logger.error('Error fetching source status:', error);
    res.status(500).json({ error: 'Failed to fetch source status' });
  }
});

// ============ PER-SOURCE DATA ENDPOINTS ============
// These scope all queries to the given source, forming the backend for Phase 4 frontend.

// GET /api/sources/:id/nodes — all nodes for a source
// Uses nodes:read permission (not sources:read) so anonymous users with channel viewOnMap
// permissions can access node data for map display, filtered by their channel permissions.
router.get('/:id/nodes', requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    // Nodes are stored per-source (composite PK (nodeNum, sourceId) since
    // migration 029). Filter strictly by this source so two sources viewing
    // overlapping meshes show only what each has actually heard.
    const nodes = await databaseService.nodes.getAllNodes(source.id);

    // The local node for this source may not be in DB yet (brand new device).
    // Always include the manager's local node if absent.
    const manager = sourceManagerRegistry.getManager(source.id);
    if (manager) {
      const localNodeInfo = manager.getLocalNodeInfo();
      if (localNodeInfo && localNodeInfo.nodeNum && !nodes.some(n => n.nodeNum === localNodeInfo.nodeNum)) {
        // Fetch the full node record from DB (regardless of sourceId) and inject it
        const localNode = await databaseService.nodes.getNode(localNodeInfo.nodeNum);
        if (localNode) {
          nodes.push(localNode);
        } else {
          // Synthesize a minimal record if not yet in DB
          nodes.push({
            nodeNum: localNodeInfo.nodeNum,
            nodeId: localNodeInfo.nodeId,
            longName: localNodeInfo.longName,
            shortName: localNodeInfo.shortName,
            hwModel: localNodeInfo.hwModel ?? 0,
            lastHeard: Math.floor(Date.now() / 1000),
            sourceId: source.id,
          } as any);
        }
      }
    }

    const user = (req as any).user ?? null;

    // Filter by channel viewOnMap permissions and mask private position channels
    const filtered = await filterNodesByChannelPermission(nodes, user, source.id);
    const masked = await maskNodeLocationByChannel(filtered, user, source.id);
    res.json(masked);
  } catch (error) {
    logger.error('Error fetching nodes for source:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

// GET /api/sources/:id/messages?limit=100&offset=0 — messages for a source
router.get('/:id/messages', requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    // Exclude traceroute responses from the per-source UI feed. The client
    // filters them out anyway (they render from the `traceroutes` table);
    // letting them occupy slots in the capped window evicts real DMs
    // (issue #2741).
    const messages = await databaseService.messages.getMessages(limit, offset, source.id, [PortNum.TRACEROUTE_APP]);
    res.json(messages);
  } catch (error) {
    logger.error('Error fetching messages for source:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/sources/:id/channels — channels for a source
//
// MM-SEC-7: same root cause as MM-SEC-2 — `getAllChannels(sourceId)` returns
// the raw `psk` column for every slot, and the gate `messages:read` is
// unrelated to channel cryptographic material. Apply the MM-SEC-2 pattern:
// optionalAuth + per-row `channel_${id}:read` gate scoped to this source +
// `transformChannel` projection so the raw PSK never reaches the response.
router.get('/:id/channels', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const allChannels = await databaseService.channels.getAllChannels(source.id);
    const isAdmin = req.user?.isAdmin === true;

    const accessible: typeof allChannels = [];
    for (const channel of allChannels) {
      if (isAdmin) {
        accessible.push(channel);
        continue;
      }
      const channelResource = `channel_${channel.id}` as ResourceType;
      if (req.user && await hasPermission(req.user, channelResource, 'read', source.id)) {
        accessible.push(channel);
      }
    }

    res.json(accessible.map(transformChannel));
  } catch (error) {
    logger.error('Error fetching channels for source:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// GET /api/sources/:id/traceroutes?limit=50 — traceroutes for a source
router.get('/:id/traceroutes', requirePermission('traceroute', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const traceroutes = await databaseService.traceroutes.getAllTraceroutes(limit, source.id);
    res.json(traceroutes);
  } catch (error) {
    logger.error('Error fetching traceroutes for source:', error);
    res.status(500).json({ error: 'Failed to fetch traceroutes' });
  }
});

// GET /api/sources/:id/neighbor-info — enriched neighbor info scoped to a source
router.get('/:id/neighbor-info', requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const neighborInfo = await databaseService.neighbors.getAllNeighborInfo(source.id);

    // Get max node age setting (default 24 hours)
    const maxNodeAgeStr = await databaseService.settings.getSetting('maxNodeAgeHours');
    const maxNodeAgeHours = maxNodeAgeStr ? (parseInt(maxNodeAgeStr, 10) || 24) : 24;
    const cutoffTime = Math.floor(Date.now() / 1000) - maxNodeAgeHours * 60 * 60;

    // Build a set of all link keys for bidirectionality detection
    const linkKeys = new Set(neighborInfo.map(ni => `${ni.nodeNum}-${ni.neighborNodeNum}`));

    // Batch-fetch all nodes referenced in neighbor info
    const allNodeNums = [...new Set([
      ...neighborInfo.map(ni => ni.nodeNum),
      ...neighborInfo.map(ni => ni.neighborNodeNum),
    ])];
    const nodeMap = await databaseService.nodes.getNodesByNums(allNodeNums);

    // Enrich each record with node names, positions, and bidirectionality flag
    const enrichedNeighborInfo = neighborInfo.map(ni => {
      const node = nodeMap.get(ni.nodeNum) ?? null;
      const neighbor = nodeMap.get(ni.neighborNodeNum) ?? null;
      const nodePos = getEffectivePosition(node);
      const neighborPos = getEffectivePosition(neighbor);

      return {
        ...ni,
        nodeId: node?.nodeId || `!${ni.nodeNum.toString(16).padStart(8, '0')}`,
        nodeName: node?.longName || `Node !${ni.nodeNum.toString(16).padStart(8, '0')}`,
        neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        bidirectional: linkKeys.has(`${ni.neighborNodeNum}-${ni.nodeNum}`),
        nodeLatitude: nodePos.latitude,
        nodeLongitude: nodePos.longitude,
        neighborLatitude: neighborPos.latitude,
        neighborLongitude: neighborPos.longitude,
        node,
        neighbor,
      };
    })
      .filter(ni => {
        // Filter out connections where either node is too old or missing lastHeard
        if (!ni.node?.lastHeard || !ni.neighbor?.lastHeard) {
          return false;
        }
        return ni.node.lastHeard >= cutoffTime && ni.neighbor.lastHeard >= cutoffTime;
      })
      .map(({ node, neighbor, ...rest }) => rest);

    res.json(enrichedNeighborInfo);
  } catch (error) {
    logger.error('Error fetching neighbor info for source:', error);
    res.status(500).json({ error: 'Failed to fetch neighbor info' });
  }
});

// POST /api/sources/:id/connect — manually start the manager for a source.
// Used when autoConnect is disabled (issue #2773) so a user can bring the
// source online on demand without changing persisted config.
router.post('/:id/connect', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (!source.enabled) {
      return res.status(409).json({ error: 'Source is disabled; enable it first' });
    }
    if (source.type !== 'meshtastic_tcp') {
      return res.status(400).json({ error: 'Manual connect is only supported for meshtastic_tcp sources' });
    }
    if (sourceManagerRegistry.getManager(source.id)) {
      return res.json({ success: true, alreadyRunning: true });
    }
    const cfg = source.config as any;
    const manager = new MeshtasticManager(source.id, {
      host: cfg.host,
      port: cfg.port,
      heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
      virtualNode: cfg.virtualNode,
    });
    await sourceManagerRegistry.addManager(manager);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error connecting source:', err);
    res.status(500).json({ error: 'Failed to connect source' });
  }
});

// POST /api/sources/:id/disconnect — manually stop the manager without disabling
// the source. Paired with /connect for autoConnect=false workflows.
router.post('/:id/disconnect', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (!sourceManagerRegistry.getManager(source.id)) {
      return res.json({ success: true, alreadyStopped: true });
    }
    await sourceManagerRegistry.removeManager(source.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error disconnecting source:', err);
    res.status(500).json({ error: 'Failed to disconnect source' });
  }
});

export default router;
