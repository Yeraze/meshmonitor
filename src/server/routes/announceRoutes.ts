import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { fail } from '../utils/apiResponse.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { requireDeviceSourcePermission, getDeviceSourceTarget } from '../utils/deviceSourcePermission.js';

const router = Router();

// Each route acts on ONE source: the `sourceId` in the request, or the primary
// Meshtastic source when it is omitted. `automation` is a per-source
// permission, so it is checked on that source.

// Sends through the source's own radio; no primary-radio fallback (#5375).
router.post('/send', requireDeviceSourcePermission('automation', 'write', 'body', 'announcements'), async (req: Request, res: Response) => {
  try {
    const { manager, sourceId, named } = getDeviceSourceTarget(req);
    await manager.sendAutoAnnouncement();
    // A request that named no source keeps stamping the global key, as before.
    if (named) {
      await databaseService.settings.setSourceSetting(sourceId, 'lastAnnouncementTime', Date.now().toString());
    } else {
      await databaseService.settings.setSetting('lastAnnouncementTime', Date.now().toString());
    }
    res.json({ success: true, message: 'Announcement sent successfully' });
  } catch (error) {
    logger.error('Error sending announcement:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to send announcement');
  }
});

const isBlank = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * The source GET /last is authorised against: the one it names, or the primary
 * Meshtastic source when it names none. This route reads a stored timestamp
 * and needs no live device, so it does not use the device gate: a source that
 * is offline still has a last announcement time.
 */
const lastAnnouncementSource = (req: Request): unknown =>
  isBlank(req.query.sourceId) ? resolveSourceManager(undefined).sourceId : req.query.sourceId;

router.get('/last', requirePermission('automation', 'read', { sourceIdFrom: lastAnnouncementSource, requireSourceId: true }), async (req: Request, res: Response) => {
  try {
    // requirePermission has refused a sourceId that is not a string. A request
    // that named no source keeps reading the global key, as before.
    const named = isBlank(req.query.sourceId) ? null : (req.query.sourceId as string);
    const lastAnnouncementTime = await databaseService.settings.getSettingForSource(named, 'lastAnnouncementTime');
    res.json({ lastAnnouncementTime: lastAnnouncementTime ? parseInt(lastAnnouncementTime) : null });
  } catch (error) {
    logger.error('Error fetching last announcement time:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to fetch last announcement time');
  }
});

// Preview tokens resolve against the source's local node; a non-Meshtastic
// source has none, so refuse rather than preview the primary's (#5375).
router.get('/preview', requireDeviceSourcePermission('automation', 'read', 'query', 'announcements'), async (req: Request, res: Response) => {
  try {
    const message = req.query.message as string;
    if (!message) {
      return fail(res, 400, 'INVALID_INPUT', 'Missing message parameter');
    }
    const preview = await getDeviceSourceTarget(req).manager.previewAnnouncementMessage(message);
    res.json({ preview });
  } catch (error) {
    logger.error('Error generating announcement preview:', error);
    fail(res, 500, 'INTERNAL_ERROR', 'Failed to generate preview');
  }
});

export default router;
