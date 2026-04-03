import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import databaseService from '../../services/database.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { MeshtasticManager } from '../meshtasticManager.js';

const router = Router();

// List all sources
router.get('/', requirePermission('sources', 'read'), async (_req: Request, res: Response) => {
  try {
    const sources = await databaseService.sources.getAllSources();
    res.json(sources);
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
        const manager = new MeshtasticManager(source.id);
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
          const manager = new MeshtasticManager(source.id);
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

export default router;
