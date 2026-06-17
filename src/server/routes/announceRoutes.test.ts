import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import announceRoutes from './announceRoutes.js';

const mockManager = {
  sendAutoAnnouncement: vi.fn(),
  previewAnnouncementMessage: vi.fn(),
};

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn().mockReturnValue(mockManager),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      setSourceSetting: vi.fn(),
      setSetting: vi.fn(),
      getSettingForSource: vi.fn(),
    },
  },
}));

vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import databaseService from '../../services/database.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';

const app = express();
app.use(express.json());
app.use('/', announceRoutes);

describe('POST /send', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends announcement and returns success', async () => {
    mockManager.sendAutoAnnouncement.mockResolvedValue(undefined);
    (databaseService.settings.setSetting as any).mockResolvedValue(undefined);

    const res = await request(app).post('/send').send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockManager.sendAutoAnnouncement).toHaveBeenCalled();
  });

  it('uses setSourceSetting when sourceId provided', async () => {
    mockManager.sendAutoAnnouncement.mockResolvedValue(undefined);
    (databaseService.settings.setSourceSetting as any).mockResolvedValue(undefined);

    await request(app).post('/send').send({ sourceId: 'src1' });

    expect(databaseService.settings.setSourceSetting).toHaveBeenCalledWith(
      'src1', 'lastAnnouncementTime', expect.any(String)
    );
  });

  it('uses setSetting when no sourceId', async () => {
    mockManager.sendAutoAnnouncement.mockResolvedValue(undefined);
    (databaseService.settings.setSetting as any).mockResolvedValue(undefined);

    await request(app).post('/send').send({});

    expect(databaseService.settings.setSetting).toHaveBeenCalledWith(
      'lastAnnouncementTime', expect.any(String)
    );
  });

  it('returns 500 when announcement fails', async () => {
    mockManager.sendAutoAnnouncement.mockRejectedValue(new Error('send error'));

    const res = await request(app).post('/send').send({});

    expect(res.status).toBe(500);
  });
});

describe('GET /last', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns parsed timestamp', async () => {
    (databaseService.settings.getSettingForSource as any).mockResolvedValue('1700000000000');

    const res = await request(app).get('/last');

    expect(res.status).toBe(200);
    expect(res.body.lastAnnouncementTime).toBe(1700000000000);
  });

  it('returns null when no announcement recorded', async () => {
    (databaseService.settings.getSettingForSource as any).mockResolvedValue(null);

    const res = await request(app).get('/last');

    expect(res.body.lastAnnouncementTime).toBeNull();
  });

  it('returns 500 on database error', async () => {
    (databaseService.settings.getSettingForSource as any).mockRejectedValue(new Error('db error'));

    const res = await request(app).get('/last');

    expect(res.status).toBe(500);
  });
});

describe('GET /preview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns preview for a valid message', async () => {
    mockManager.previewAnnouncementMessage.mockResolvedValue('Expanded message');

    const res = await request(app).get('/preview?message=Hello');

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe('Expanded message');
  });

  it('returns 400 when message param is missing', async () => {
    const res = await request(app).get('/preview');

    expect(res.status).toBe(400);
  });

  it('passes sourceId to resolveSourceManager', async () => {
    mockManager.previewAnnouncementMessage.mockResolvedValue('msg');

    await request(app).get('/preview?message=Hi&sourceId=src1');

    expect(resolveSourceManager).toHaveBeenCalledWith('src1');
  });

  it('returns 500 on manager error', async () => {
    mockManager.previewAnnouncementMessage.mockRejectedValue(new Error('error'));

    const res = await request(app).get('/preview?message=Hello');

    expect(res.status).toBe(500);
  });
});
