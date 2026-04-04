import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import databaseService from '../../services/database.js';
import { requirePermission, optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { MeshtasticManager } from '../meshtasticManager.js';

const router = Router();

// List all sources — public so the landing page can redirect unauthenticated users
// to the single-source view (or show the login button on the source list page).
// Sensitive config fields are not exposed.
router.get('/', optionalAuth(), async (_req: Request, res: Response) => {
  try {
    const sources = await databaseService.sources.getAllSources();
    // Strip sensitive config (passwords, keys) before sending to unauthenticated callers
    // Strip password/key fields from config before sending to clients
    const safeSources = sources.map(s => {
      const { password, apiKey, ...safeConfig } = (s.config as any) ?? {};
      void password; void apiKey; // intentionally stripped
      return {
        id: s.id,
        name: s.name,
        type: s.type,
        enabled: s.enabled,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        config: safeConfig,
      };
    });
    res.json(safeSources);
  } catch (error) {
    logger.error('Error listing sources:', error);
    res.status(500).json({ error: 'Failed to list sources' });
  }
});

// Get single source
router.get('/:id', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    res.json(source);
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

    const source = await databaseService.sources.createSource({
      id: uuidv4(),
      name: name.trim(),
      type,
      config,
      enabled: enabled !== false,
      createdBy: req.user?.id,
    });

    // Start manager if source is enabled
    if (source.enabled && source.type === 'meshtastic_tcp') {
      try {
        const cfg = source.config as any;
        const manager = new MeshtasticManager(source.id, { host: cfg.host, port: cfg.port });
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

    const source = await databaseService.sources.updateSource(req.params.id, updates);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // Handle enable/disable transitions
    const wasEnabled = existing.enabled;
    const isNowEnabled = source.enabled;

    if (!wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp') {
      // Newly enabled: start manager if not already running
      if (!sourceManagerRegistry.getManager(source.id)) {
        try {
          const cfg = source.config as any;
          const manager = new MeshtasticManager(source.id, { host: cfg.host, port: cfg.port });
          await sourceManagerRegistry.addManager(manager);
        } catch (err) {
          logger.warn(`Could not start manager for source ${source.id}:`, err);
        }
      }
    } else if (wasEnabled && !isNowEnabled) {
      // Newly disabled: stop manager
      await sourceManagerRegistry.removeManager(source.id);
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
router.get('/:id/status', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
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
    res.json(status);
  } catch (error) {
    logger.error('Error fetching source status:', error);
    res.status(500).json({ error: 'Failed to fetch source status' });
  }
});

// ============ PER-SOURCE DATA ENDPOINTS ============
// These scope all queries to the given source, forming the backend for Phase 4 frontend.

// GET /api/sources/:id/nodes — all nodes for a source
router.get('/:id/nodes', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const nodes = await databaseService.nodes.getAllNodes(source.id);
    res.json(nodes);
  } catch (error) {
    logger.error('Error fetching nodes for source:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

// GET /api/sources/:id/messages?limit=100&offset=0 — messages for a source
router.get('/:id/messages', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const messages = await databaseService.messages.getMessages(limit, offset, source.id);
    res.json(messages);
  } catch (error) {
    logger.error('Error fetching messages for source:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/sources/:id/channels — channels for a source
router.get('/:id/channels', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const channels = await databaseService.channels.getAllChannels(source.id);
    res.json(channels);
  } catch (error) {
    logger.error('Error fetching channels for source:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// GET /api/sources/:id/traceroutes?limit=50 — traceroutes for a source
router.get('/:id/traceroutes', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
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
router.get('/:id/neighbor-info', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const neighborInfo = await databaseService.neighbors.getAllNeighborInfo(source.id);

    // Get max node age setting (default 24 hours)
    const maxNodeAgeStr = await databaseService.settings.getSetting('maxNodeAge');
    const maxNodeAgeHours = maxNodeAgeStr ? parseInt(maxNodeAgeStr, 10) : 24;
    const cutoffTime = Math.floor(Date.now() / 1000) - maxNodeAgeHours * 60 * 60;

    // Build a set of all link keys for bidirectionality detection
    const linkKeys = new Set(neighborInfo.map(ni => `${ni.nodeNum}-${ni.neighborNodeNum}`));

    const getEffectivePosition = (node: any) => {
      if (!node) return { latitude: undefined, longitude: undefined };
      if (node.positionOverrideEnabled && node.latitudeOverride != null && node.longitudeOverride != null) {
        return { latitude: node.latitudeOverride, longitude: node.longitudeOverride };
      }
      return { latitude: node.latitude, longitude: node.longitude };
    };

    // Enrich each record with node names, positions, and bidirectionality flag
    const enrichedNeighborInfo = (await Promise.all(neighborInfo.map(async ni => {
      const node = await databaseService.nodes.getNode(ni.nodeNum);
      const neighbor = await databaseService.nodes.getNode(ni.neighborNodeNum);
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
    })))
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

export default router;
