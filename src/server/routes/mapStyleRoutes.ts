/**
 * MapStyle Routes
 *
 * REST API routes for MapLibre GL style management.
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import { MapStyleService } from '../services/mapStyleService.js';
import { logger } from '../../utils/logger.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { generateStyleFromTileJson, type TileJsonResponse } from '../utils/tileStyleGenerator.js';
import { safeFetch, SsrfBlockedError } from '../utils/ssrfGuard.js';

export function createMapStyleRouter(service: MapStyleService): Router {
  const router = Router();

  /**
   * GET /api/map-styles/styles
   * Returns all map styles
   */
  router.get('/styles', async (_req: Request, res: Response) => {
    try {
      const styles = service.getStyles();
      return res.json(styles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[MapStyleRoutes] Error getting styles:', error);
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/map-styles/upload
   * Upload a new MapLibre GL style JSON file.
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

        const rawBuffer = req.body instanceof Buffer ? req.body : Buffer.from(req.body);
        const content = rawBuffer.toString('utf-8');

        // Extract name from filename (strip extension)
        const name = filename.replace(/\.[^.]+$/, '');

        const style = service.addStyle(name, content, 'upload');
        logger.info(`[MapStyleRoutes] Style uploaded: ${style.name} (${style.id})`);
        return res.status(201).json(style);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[MapStyleRoutes] Error uploading style:', error);
        if (message.toLowerCase().includes('not found')) {
          return res.status(404).json({ error: message });
        }
        return res.status(400).json({ error: message });
      }
    }
  );

  /**
   * POST /api/map-styles/from-url
   * Fetch and store a MapLibre GL style from a remote URL.
   */
  router.post(
    '/from-url',
    requirePermission('settings', 'write'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const { url, name: requestedName } = req.body as { url?: string; name?: string };

        if (!url) {
          return res.status(400).json({ error: 'Missing url in request body' });
        }

        // Fetch URL server-side with 15s timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        let content: string;
        try {
          const response = await safeFetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'MeshMonitor/1.0' },
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            return res.status(400).json({ error: `Failed to fetch URL: HTTP ${response.status}` });
          }
          content = await response.text();
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError instanceof SsrfBlockedError) {
            logger.warn(`[MapStyleRoutes] Style URL blocked by SSRF guard (${fetchError.reason}): ${url}`);
            return res.status(400).json({ error: 'URL target not allowed' });
          }
          const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
          return res.status(400).json({ error: `Failed to fetch URL: ${msg}` });
        }

        // Derive name from provided name or URL path
        let name = 'Imported Style';
        if (requestedName) {
          name = requestedName;
        } else {
          try {
            name = new URL(url).pathname.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Imported Style';
          } catch { /* malformed URL, use default name */ }
        }

        const style = service.addStyle(name, content, 'url', url);
        logger.info(`[MapStyleRoutes] Style added from URL: ${style.name} (${style.id})`);
        return res.status(201).json(style);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[MapStyleRoutes] Error adding style from URL:', error);
        if (message.toLowerCase().includes('not found')) {
          return res.status(404).json({ error: message });
        }
        return res.status(400).json({ error: message });
      }
    }
  );

  /**
   * PUT /api/map-styles/styles/:id
   * Update style metadata (name)
   */
  router.put('/styles/:id', requirePermission('settings', 'write'), express.json(), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates = req.body as { name?: string };
      const style = service.updateStyle(id, updates);
      return res.json(style);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[MapStyleRoutes] Error updating style:', error);
      if (message.toLowerCase().includes('not found')) {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  /**
   * DELETE /api/map-styles/styles/:id
   * Delete a map style
   */
  router.delete('/styles/:id', requirePermission('settings', 'write'), async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      service.deleteStyle(id);
      return res.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[MapStyleRoutes] Error deleting style:', error);
      if (message.toLowerCase().includes('not found')) {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/map-styles/styles/:id/data
   * Returns raw MapLibre GL style JSON
   */
  router.get('/styles/:id/data', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const data = service.getStyleData(id);
      res.setHeader('Content-Type', 'application/json');
      return res.send(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[MapStyleRoutes] Error getting style data:', error);
      if (message.toLowerCase().includes('not found')) {
        return res.status(404).json({ error: message });
      }
      return res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/map-styles/generate-from-tileserver
   * Fetch a TileJSON endpoint and generate a default MapLibre GL style.json.
   * Returns the generated style as JSON for the client to download.
   */
  router.post(
    '/generate-from-tileserver',
    requirePermission('settings', 'write'),
    express.json(),
    async (req: Request, res: Response) => {
      try {
        const { tileJsonUrl, name: requestedName } = req.body as {
          tileJsonUrl?: string;
          name?: string;
        };

        if (!tileJsonUrl || typeof tileJsonUrl !== 'string') {
          return res.status(400).json({ error: 'Missing tileJsonUrl in request body' });
        }

        // Validate protocol
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(tileJsonUrl);
        } catch {
          return res.status(400).json({ error: 'Invalid tileJsonUrl: not a valid URL' });
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          return res.status(400).json({ error: 'Invalid tileJsonUrl: only http and https are supported' });
        }

        // Fetch TileJSON server-side (avoids CORS)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        let tileJson: TileJsonResponse;
        try {
          const response = await safeFetch(tileJsonUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': 'MeshMonitor/1.0' },
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            return res.status(400).json({ error: `Failed to fetch TileJSON: HTTP ${response.status}` });
          }
          tileJson = (await response.json()) as TileJsonResponse;
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError instanceof SsrfBlockedError) {
            logger.warn(`[MapStyleRoutes] TileJSON URL blocked by SSRF guard (${fetchError.reason}): ${tileJsonUrl}`);
            return res.status(400).json({ error: 'URL target not allowed' });
          }
          const msg = fetchError instanceof Error ? fetchError.message : String(fetchError);
          return res.status(400).json({ error: `Failed to fetch TileJSON: ${msg}` });
        }

        // Validate TileJSON structure
        if (!Array.isArray(tileJson.tiles) || tileJson.tiles.length === 0) {
          return res.status(400).json({
            error: 'TileJSON is missing a tiles array. Ensure the URL points to a vector TileJSON endpoint.',
          });
        }
        if (!Array.isArray(tileJson.vector_layers) || tileJson.vector_layers.length === 0) {
          return res.status(400).json({
            error:
              'TileJSON has no vector_layers. This may be a raster tileset; only vector tilesets are supported for style generation.',
          });
        }

        const name = requestedName?.trim() || tileJson.name || 'Generated Style';
        const style = generateStyleFromTileJson(tileJson, { name });

        logger.info(`[MapStyleRoutes] Generated style from TileJSON at: ${tileJsonUrl}`);
        return res.json({ style, filename: `${name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}-style.json` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[MapStyleRoutes] Error generating style from tileserver:', error);
        return res.status(500).json({ error: message });
      }
    }
  );

  return router;
}
