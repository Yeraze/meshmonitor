/**
 * v1 API — Sources listing (global, unscoped).
 *
 * Lets API consumers discover the sources their token can access. Returns
 * only enabled sources and only those the caller has read permission on
 * (via any of the per-source resources: `nodes`, `messages`, or a
 * `channel_*` grant). Admin tokens see every enabled source.
 *
 * Response shape is intentionally lean — consumers that need richer metadata
 * can hit `GET /api/v1/sources/:sourceId/status`.
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import type { ResourceType } from '../../../types/permission.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * Returns true if the user has ANY read permission on the given source
 * (nodes, messages, or any channel_*).
 */
async function hasAnyReadForSource(userId: number, sourceId: string): Promise<boolean> {
  const probes: ResourceType[] = ['nodes', 'messages'];
  for (const probe of probes) {
    if (await databaseService.checkPermissionAsync(userId, probe, 'read', sourceId)) {
      return true;
    }
  }
  for (let ch = 0; ch <= 7; ch++) {
    if (
      await databaseService.checkPermissionAsync(
        userId,
        `channel_${ch}` as ResourceType,
        'read',
        sourceId
      )
    ) {
      return true;
    }
  }
  return false;
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const sources = (await databaseService.sources.getAllSources())
      .filter((s) => s.enabled)
      .sort((a, b) => a.createdAt - b.createdAt);

    const primaryId = sources[0]?.id ?? null;

    const visible = user.isAdmin
      ? sources
      : (
          await Promise.all(
            sources.map(async (s) =>
              (await hasAnyReadForSource(user.id, s.id)) ? s : null
            )
          )
        ).filter((s): s is (typeof sources)[number] => s !== null);

    res.json({
      success: true,
      count: visible.length,
      data: visible.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        enabled: s.enabled,
        isPrimary: s.id === primaryId,
      })),
    });
  } catch (error) {
    logger.error('Error listing sources (v1):', error);
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to list sources',
    });
  }
});

export default router;
