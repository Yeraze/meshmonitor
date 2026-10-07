import { Router, Request, Response } from 'express';
import { requireAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { fail } from '../utils/apiResponse.js';
import { requireDeviceSourcePermission, getDeviceSourceTarget } from '../utils/deviceSourcePermission.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { listPermittedSourceIds } from '../utils/sourceScopedAccess.js';
import { mayViewSourceEndpoint } from '../utils/sourceConfigRedaction.js';

const router = Router();

// Virtual-node status, one row per source. Signed-in callers only.
//
// A row says whether a source runs a virtual node, what it allows, and who is
// connected to it, so it is per-source data: a source appears only when the
// caller holds `connection:read` on it (admins see all). It used to list every
// source to any signed-in user. The client list carries each client's IP
// address. Those are other people's addresses, not where the source connects
// to, so they stay stricter than the source's own address (which follows
// `sources:read` alone): a caller needs `connection:read` on the source, which
// lists the row at all, AND `sources:read`. Without the second the count
// stays and the list is empty.
router.get('/virtual-node/status', requireAuth(), async (req: Request, res: Response) => {
  try {
    const [readable, mayViewAddresses] = await Promise.all([
      listPermittedSourceIds(req.user, 'connection', 'read'),
      mayViewSourceEndpoint(req),
    ]);
    const managers = sourceManagerRegistry.getAllManagers() as any[];
    const sources: unknown[] = [];
    for (const mgr of managers) {
      const vn = mgr.virtualNodeServer;
      const status = mgr.getStatus?.();
      const sourceId = status?.sourceId ?? mgr.sourceId;
      if (readable !== 'all' && !readable.includes(sourceId)) continue;
      const sourceName = status?.sourceName ?? sourceId;
      if (!vn) {
        sources.push({
          sourceId,
          sourceName,
          enabled: false,
          isRunning: false,
          allowAdminCommands: false,
          clientCount: 0,
          clients: [],
        });
        continue;
      }
      sources.push({
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
        clients: mayViewAddresses && typeof vn.getClientDetails === 'function' ? vn.getClientDetails() : [],
      });
    }

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
