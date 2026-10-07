/**
 * System Routes
 *
 * GET  /system/status   — system statistics (uptime, memory, db, docker)
 * GET  /status          — up/version for anyone; node identity and counts by grant
 * GET  /version/check   — compare current version with latest GitHub release
 * POST /system/restart  — restart (Docker) or shutdown (baremetal) the process
 *
 * Extracted from server.ts. The Docker/version helpers live in
 * ../utils/systemInfo.js (shared with the startup auto-upgrade scheduler).
 * The restart handler needs the server-lifecycle `gracefulShutdown`, which is
 * injected from server.ts via setSystemCallbacks() so this module stays free
 * of the HTTP-server reference.
 */

import { createRequire } from 'module';
import { Router, Request, Response } from 'express';
import { optionalAuth, requirePermission, requireAdmin, hasPermission } from '../auth/authMiddleware.js';
import { fail } from '../utils/apiResponse.js';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { versionCheckService } from '../services/versionCheckService.js';
import { detectDeploymentMethod } from '../utils/deployment.js';
import { fallbackManager } from '../meshtasticManager.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getPrimaryMeshtasticManager } from '../sourceManagerTypes.js';
import {
  serverStartTime,
  isRunningInDocker,
} from '../utils/systemInfo.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');

const env = getEnvironmentConfig();

export interface SystemCallbacks {
  gracefulShutdown: (reason: string) => void;
}

let callbacks: SystemCallbacks = {
  gracefulShutdown: () => {
    logger.warn('gracefulShutdown called before system callbacks were registered');
  },
};

export function setSystemCallbacks(cb: SystemCallbacks): void {
  callbacks = cb;
}

const router: Router = Router();

// System status endpoint
router.get('/system/status', requirePermission('dashboard', 'read'), async (_req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  let uptimeString = '';
  if (days > 0) uptimeString += `${days}d `;
  if (hours > 0 || days > 0) uptimeString += `${hours}h `;
  if (minutes > 0 || hours > 0 || days > 0) uptimeString += `${minutes}m `;
  uptimeString += `${seconds}s`;

  // Get database info
  const databaseType = databaseService.getDatabaseType();
  const databaseVersion = await databaseService.getDatabaseVersion();

  res.json({
    version: packageJson.version,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    uptime: uptimeString,
    uptimeSeconds,
    environment: env.nodeEnv,
    isDocker: isRunningInDocker(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
    },
    database: {
      type: databaseType.charAt(0).toUpperCase() + databaseType.slice(1), // Capitalize
      version: databaseVersion,
    },
  });
});

// Status endpoint for health checks and monitors. Open to every caller, signed
// in or not; what comes back depends on the caller:
//
//   - anyone: that the server is up, its version, and whether the primary
//     source's link is up (`connection.connected`). No more than `/api/health`
//     and `GET /api/connection` already tell an anonymous caller.
//   - `nodes:read` on the primary source (or admin): `connection.localNode`,
//     the primary node's number, id and names.
//   - admin: `statistics`, the node, message and channel counts across EVERY
//     source. They describe the whole install, so no per-source grant covers
//     them.
//
// It used to give all of this to any caller. Named fields, not "the reply
// minus a few", so a field added later is not handed out by default.
router.get('/status', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const mgr = getPrimaryMeshtasticManager(sourceManagerRegistry) ?? fallbackManager;
    const connectionStatus = await mgr.getConnectionStatus();
    const user = req.user ?? null;
    const isAdmin = user?.isAdmin === true;
    const primarySourceId: string | undefined = mgr.sourceId || undefined;
    const maySeeNode = isAdmin
      || (!!user && !!primarySourceId && await hasPermission(user, 'nodes', 'read', primarySourceId));

    const connection: Record<string, unknown> = { connected: connectionStatus.connected === true };
    if (maySeeNode) {
      const localNode = mgr.getLocalNodeInfo();
      connection.localNode = localNode
        ? {
            nodeNum: localNode.nodeNum,
            nodeId: localNode.nodeId,
            longName: localNode.longName,
            shortName: localNode.shortName,
          }
        : null;
    }

    const body: Record<string, unknown> = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: packageJson.version,
      nodeEnv: env.nodeEnv,
      connection,
    };
    if (isAdmin) {
      // intentional cross-source, admin only: install-wide totals
      const [nodes, messages, channels] = await Promise.all([
        databaseService.nodes.getNodeCount(ALL_SOURCES),
        databaseService.messages.getMessageCount(ALL_SOURCES),
        databaseService.channels.getChannelCount(ALL_SOURCES),
      ]);
      body.statistics = { nodes, messages, channels };
    }
    body.uptime = process.uptime();
    res.json(body);
  } catch (error) {
    logger.error('Error getting status:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to get status');
  }
});

// Version check endpoint — cache read through versionCheckService. The single
// server-side poller (versionCheckService) performs the GitHub fetch, caches the
// result, and fires the `upgrade-available` automation event headlessly. This
// route no longer triggers any upgrade — detection/notification only.
//
// `deploymentMethod` tells the frontend which deployment-specific update
// instructions to show (docker / lxc / kubernetes / manual).
router.get('/version/check', optionalAuth(), async (_req: Request, res: Response) => {
  if (env.versionCheckDisabled) {
    return res.status(404).send();
  }

  const deploymentMethod = detectDeploymentMethod();
  const status = await versionCheckService.getStatus();

  if (status.error) {
    // Preserve the historical failure shape (bare object, updateAvailable:false).
    return res.json({
      updateAvailable: false,
      error: status.error,
      deploymentMethod,
    });
  }

  return res.json({
    updateAvailable: status.updateAvailable,
    currentVersion: status.currentVersion,
    latestVersion: status.latestVersion,
    releaseUrl: status.releaseUrl,
    releaseName: status.releaseName,
    publishedAt: status.publishedAt,
    imageReady: status.imageReady,
    deploymentMethod,
  });
});

// Restart/shutdown container endpoint
//
// Admin only. It stops the whole process, so every source and every user is
// affected; `settings:write` is held per source and covers one of them. It
// used to pass on `settings:write` for any source.
router.post('/system/restart', requireAdmin(), (_req: Request, res: Response) => {
  const isDocker = isRunningInDocker();

  if (isDocker) {
    logger.info('🔄 Container restart requested by admin');
    res.json({
      success: true,
      message: 'Container will restart now',
      action: 'restart',
    });

    // Gracefully shutdown - Docker will restart the container automatically
    setTimeout(() => {
      callbacks.gracefulShutdown('Admin-requested container restart');
    }, 500);
  } else {
    logger.info('🛑 Shutdown requested by admin');
    res.json({
      success: true,
      message: 'MeshMonitor will shut down now',
      action: 'shutdown',
    });

    // Gracefully shutdown - will need to be manually restarted
    setTimeout(() => {
      callbacks.gracefulShutdown('Admin-requested shutdown');
    }, 500);
  }
});

export default router;
