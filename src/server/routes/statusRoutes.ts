import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { fail } from '../utils/apiResponse.js';
import { requireDeviceSourcePermission, getDeviceSourceTarget } from '../utils/deviceSourcePermission.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';

const router = Router();

router.get('/virtual-node/status', requireAuth(), (_req: Request, res: Response) => {
  try {
    const managers = sourceManagerRegistry.getAllManagers() as any[];
    const sources = managers.map((mgr) => {
      const vn = mgr.virtualNodeServer;
      const status = mgr.getStatus?.();
      const sourceId = status?.sourceId ?? mgr.sourceId;
      const sourceName = status?.sourceName ?? sourceId;
      if (!vn) {
        return {
          sourceId,
          sourceName,
          enabled: false,
          isRunning: false,
          allowAdminCommands: false,
          clientCount: 0,
          clients: [],
        };
      }
      return {
        sourceId,
        sourceName,
        enabled: true,
        isRunning: vn.isRunning(),
        allowAdminCommands: vn.isAdminCommandsAllowed(),
        // MeshCore VNs only — the Meshtastic virtual node has no key-export
        // command, so it reports undefined and the UI omits the row entirely
        // rather than showing a permanently-"Blocked" toggle that isn't real.
        allowPkiExport: typeof vn.isPkiExportAllowed === 'function' ? vn.isPkiExportAllowed() : undefined,
        allowPkiImport: typeof vn.isPkiImportAllowed === 'function' ? vn.isPkiImportAllowed() : undefined,
        clientCount: vn.getClientCount(),
        // Duck-typed like the rest of this handler: `getAllManagers()` mixes VN
        // implementations, and one missing method used to take the whole
        // endpoint down with a 500 rather than degrading that single source.
        clients: typeof vn.getClientDetails === 'function' ? vn.getClientDetails() : [],
      };
    });

    res.json({ sources });
  } catch (error) {
    logger.error('Error getting virtual node status:', error);
    res.status(500).json({ error: 'Failed to get virtual node status' });
  }
});

// Reads ONE source's device: the `sourceId` in the query, or the primary
// Meshtastic source when it is omitted. `automation` is a per-source
// permission, so it is checked on that source. A source with no live
// Meshtastic device is refused; it used to report the primary's airtime.
router.get('/automation/airtime-status', requireDeviceSourcePermission('automation', 'read', 'query', 'airtime status'), async (req: Request, res: Response) => {
  try {
    res.json(await getDeviceSourceTarget(req).manager.getAirtimeCutoffStatus());
  } catch (error) {
    logger.error('Error fetching airtime cutoff status:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch airtime cutoff status');
  }
});

export default router;
