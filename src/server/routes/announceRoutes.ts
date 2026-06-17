import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';

const router = Router();

router.post('/send', requirePermission('automation', 'write'), async (req: Request, res: Response) => {
  try {
    const { sourceId: announceSourceId } = req.body;
    const announceManager = resolveSourceManager(announceSourceId);
    await announceManager.sendAutoAnnouncement();
    if (announceSourceId) {
      await databaseService.settings.setSourceSetting(announceSourceId, 'lastAnnouncementTime', Date.now().toString());
    } else {
      await databaseService.settings.setSetting('lastAnnouncementTime', Date.now().toString());
    }
    res.json({ success: true, message: 'Announcement sent successfully' });
  } catch (error) {
    logger.error('Error sending announcement:', error);
    res.status(500).json({ error: 'Failed to send announcement' });
  }
});

router.get('/last', requirePermission('automation', 'read'), async (req: Request, res: Response) => {
  try {
    const announceLastSourceId = (req.query.sourceId as string) || null;
    const lastAnnouncementTime = await databaseService.settings.getSettingForSource(announceLastSourceId, 'lastAnnouncementTime');
    res.json({ lastAnnouncementTime: lastAnnouncementTime ? parseInt(lastAnnouncementTime) : null });
  } catch (error) {
    logger.error('Error fetching last announcement time:', error);
    res.status(500).json({ error: 'Failed to fetch last announcement time' });
  }
});

router.get('/preview', requirePermission('automation', 'read'), async (req: Request, res: Response) => {
  try {
    const message = req.query.message as string;
    if (!message) {
      return res.status(400).json({ error: 'Missing message parameter' });
    }
    const previewSourceId = req.query.sourceId as string | undefined;
    const previewManager = resolveSourceManager(previewSourceId);
    const preview = await previewManager.previewAnnouncementMessage(message);
    res.json({ preview });
  } catch (error) {
    logger.error('Error generating announcement preview:', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
});

export default router;
