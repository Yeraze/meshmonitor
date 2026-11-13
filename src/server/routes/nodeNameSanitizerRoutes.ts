/**
 * Node-name anti-spam sanitizer routes (#6382). Admin only.
 *
 *   GET  /api/node-name-sanitizer/status  — on/off and the in-memory hit counter
 *   POST /api/node-name-sanitizer/rescan  — run the rules once over stored names
 *
 * The settings themselves save through POST /api/settings (validated there).
 * Nothing here sends packets.
 */
import { Router, Request, Response } from 'express';
import { requireAdmin } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { getNodeNameSanitizerStats, isNodeNameSanitizerActive } from '../../utils/nodeNameSanitizerRuntime.js';
import { rescanNodeNames } from '../services/nodeNameSanitizerService.js';

const router = Router();

let rescanRunning = false;

router.get('/status', requireAdmin(), (_req: Request, res: Response) => {
  return ok(res, { active: isNodeNameSanitizerActive(), hits: getNodeNameSanitizerStats() });
});

router.post('/rescan', requireAdmin(), async (req: Request, res: Response) => {
  if (!isNodeNameSanitizerActive()) {
    return fail(res, 409, 'NODE_NAME_SANITIZER_DISABLED', 'Turn on node-name anti-spam and save before re-scanning');
  }
  if (rescanRunning) {
    return fail(res, 409, 'RESCAN_IN_PROGRESS', 'A re-scan is already running');
  }
  rescanRunning = true;
  try {
    const result = await rescanNodeNames(sourceManagerRegistry);
    void databaseService.auditLogAsync(
      req.user!.id,
      'node_name_rescan',
      'settings',
      `Node-name re-scan rewrote ${result.nodesChanged} Meshtastic and ${result.meshcoreNodesChanged} MeshCore name(s)`,
      req.ip || null,
      null,
      null,
    );
    return ok(res, result);
  } catch (error) {
    logger.error('Node-name re-scan failed:', error);
    return fail(res, 500, 'RESCAN_FAILED', 'Node-name re-scan failed');
  } finally {
    rescanRunning = false;
  }
});

export default router;
