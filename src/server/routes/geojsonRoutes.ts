/**
 * GeoJSON Routes
 *
 * REST API routes for GeoJSON overlay layer management.
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import { GeoJsonService, LayerStyle } from '../services/geojsonService.js';
import { logger } from '../../utils/logger.js';
import { requirePermission } from '../auth/authMiddleware.js';

export function createGeoJsonRouter(service: GeoJsonService): Router {
  const router = Router();

  /**
   * GET /api/geojson/layers
   * Returns all GeoJSON layers
   */
  router.get('/layers', async (_req: Request, res: Response) => {
    try {
      const layers = service.getLayers();
      return res.json(layers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GeoJsonRoutes] Error getting layers:', error);
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/geojson/upload
   * Upload a new GeoJSON file.
   * Reads raw body, filename from X-Filename header.
   */
  router.post(
    '/upload',
    requirePermission('settings', 'write'),
    express.raw({ type: '*/*', limit: '10mb' }),
    async (req: Request, res: Response) => {
      try {
        const filename = req.headers['x-filename'] as string | undefined;
        if (!filename) {
          return res.status(400).json({ error: 'Missing X-Filename header' });
        }

        const content = req.body instanceof Buffer ? req.body.toString('utf-8') : String(req.body);

        if (!service.validateGeoJson(content)) {
          return res.status(400).json({ error: 'Invalid GeoJSON content' });
        }

        const layer = service.addLayer(filename, content);
        return res.status(201).json(layer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[GeoJsonRoutes] Error uploading layer:', error);
        if (message.toLowerCase().includes('not found')) {
          return res.status(404).json({ error: message });
        }
        return res.status(500).json({ error: message });
      }
    }
  );

  /**
   * PUT /api/geojson/layers/:id
   * Update layer metadata (name, visible, style)
   */
  router.put('/layers/:id', requirePermission('settings', 'write'), express.json(), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates = req.body as { name?: string; visible?: boolean; style?: LayerStyle };
      const layer = service.updateLayer(id, updates);
      return res.json(layer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GeoJsonRoutes] Error updating layer:', error);
      if (message.toLowerCase().includes('not found')) {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  /**
   * DELETE /api/geojson/layers/:id
   * Delete a GeoJSON layer
   */
  router.delete('/layers/:id', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      service.deleteLayer(id);
      return res.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GeoJsonRoutes] Error deleting layer:', error);
      if (message.toLowerCase().includes('not found')) {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/geojson/layers/:id/data
   * Returns raw GeoJSON data for a layer
   */
  router.get('/layers/:id/data', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data = service.getLayerData(id);
      res.setHeader('Content-Type', 'application/geo+json');
      return res.send(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[GeoJsonRoutes] Error getting layer data:', error);
      if (message.toLowerCase().includes('not found')) {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  return router;
}
