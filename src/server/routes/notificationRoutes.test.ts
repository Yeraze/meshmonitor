import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const mockPush = vi.hoisted(() => ({
  getPublicKeyAsync: vi.fn(),
  getVapidStatusAsync: vi.fn(),
  updateVapidSubject: vi.fn(),
  saveSubscription: vi.fn(),
  removeSubscription: vi.fn(),
  sendToUser: vi.fn(),
  isAvailable: vi.fn(),
}));

const mockApprise = vi.hoisted(() => ({
  isAvailable: vi.fn(),
  sendNotificationToUrls: vi.fn(),
  configureUrls: vi.fn(),
}));

const mockNotif = vi.hoisted(() => ({
  getUserNotificationPreferencesAsync: vi.fn(),
  saveUserNotificationPreferencesAsync: vi.fn(),
  applyNodeNamePrefixAsync: vi.fn(),
}));

const mockManager = vi.hoisted(() => ({
  getLocalNodeInfo: vi.fn(),
}));

vi.mock('../services/pushNotificationService.js', () => ({
  pushNotificationService: mockPush,
}));

vi.mock('../services/appriseNotificationService.js', () => ({
  appriseNotificationService: mockApprise,
}));

vi.mock('../utils/notificationFiltering.js', () => mockNotif);

vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: mockManager,
}));

// No primary meshtastic_tcp source registered — falls through to
// fallbackManager above (#3962 Phase 4.2a WP4).
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {},
}));

vi.mock('../sourceManagerTypes.js', () => ({
  getPrimaryMeshtasticManager: () => undefined,
}));

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(),
      setSetting: vi.fn(),
    },
    sources: {
      getSource: vi.fn(),
    },
  },
}));

// Auth middleware mocks: inject a session/user so handlers proceed.
vi.mock('../auth/authMiddleware.js', () => ({
  optionalAuth: () => (req: any, _res: any, next: any) => {
    req.session = req.session || { userId: 1 };
    next();
  },
  requireAuth: () => (req: any, _res: any, next: any) => {
    req.session = req.session || { userId: 1 };
    next();
  },
  requireAdmin: () => (req: any, _res: any, next: any) => {
    req.session = req.session || { userId: 1 };
    req.user = { id: 1, isAdmin: true };
    next();
  },
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.session = req.session || { userId: 1 };
    next();
  },
}));

import databaseService from '../../services/database.js';
import { pushRouter, appriseRouter } from './notificationRoutes.js';

const app = express();
app.use(express.json());
app.use('/push', pushRouter);
app.use('/apprise', appriseRouter);

describe('notificationRoutes - push', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /push/vapid-key returns publicKey and status', async () => {
    mockPush.getPublicKeyAsync.mockResolvedValue('PUBKEY');
    mockPush.getVapidStatusAsync.mockResolvedValue({ configured: true });

    const res = await request(app).get('/push/vapid-key');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: 'PUBKEY', status: { configured: true } });
  });

  it('GET /push/status returns vapid status', async () => {
    mockPush.getVapidStatusAsync.mockResolvedValue({ configured: false });

    const res = await request(app).get('/push/status');

    expect(res.body).toEqual({ configured: false });
  });

  it('PUT /push/vapid-subject rejects missing subject', async () => {
    const res = await request(app).put('/push/vapid-subject').send({});
    expect(res.status).toBe(400);
  });

  it('PUT /push/vapid-subject updates subject', async () => {
    mockPush.updateVapidSubject.mockResolvedValue(undefined);

    const res = await request(app)
      .put('/push/vapid-subject')
      .send({ subject: 'mailto:a@b.com' });

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('mailto:a@b.com');
  });

  it('POST /push/subscribe rejects invalid subscription', async () => {
    const res = await request(app)
      .post('/push/subscribe')
      .send({ sourceId: 's1', subscription: {} });
    expect(res.status).toBe(400);
  });

  it('POST /push/subscribe rejects unknown sourceId', async () => {
    (databaseService.sources.getSource as any).mockResolvedValue(null);

    const res = await request(app)
      .post('/push/subscribe')
      .send({ sourceId: 's1', subscription: { endpoint: 'e', keys: {} } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown sourceId/);
  });

  it('POST /push/subscribe saves valid subscription', async () => {
    (databaseService.sources.getSource as any).mockResolvedValue({ id: 's1' });
    mockPush.saveSubscription.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/push/subscribe')
      .send({ sourceId: 's1', subscription: { endpoint: 'e', keys: { a: 1 } } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPush.saveSubscription).toHaveBeenCalled();
  });

  it('POST /push/unsubscribe rejects missing endpoint', async () => {
    const res = await request(app).post('/push/unsubscribe').send({ sourceId: 's1' });
    expect(res.status).toBe(400);
  });

  it('POST /push/test sends a notification', async () => {
    mockManager.getLocalNodeInfo.mockReturnValue({ longName: 'Node' });
    mockNotif.applyNodeNamePrefixAsync.mockResolvedValue('body');
    mockPush.sendToUser.mockResolvedValue({ sent: 2, failed: 0 });

    const res = await request(app).post('/push/test').send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, sent: 2, failed: 0 });
  });

  it('GET /push/preferences returns defaults when none stored', async () => {
    mockNotif.getUserNotificationPreferencesAsync.mockResolvedValue(null);

    const res = await request(app).get('/push/preferences');

    expect(res.status).toBe(200);
    expect(res.body.enableWebPush).toBe(true);
    expect(res.body.whitelist).toEqual(['Hi', 'Help']);
  });

  it('GET /push/preferences returns stored prefs', async () => {
    mockNotif.getUserNotificationPreferencesAsync.mockResolvedValue({ enableWebPush: false });

    const res = await request(app).get('/push/preferences');

    expect(res.body).toEqual({ enableWebPush: false });
  });

  it('POST /push/preferences rejects invalid payload', async () => {
    const res = await request(app).post('/push/preferences').send({ enableWebPush: 'nope' });
    expect(res.status).toBe(400);
  });

  it('POST /push/preferences saves valid prefs', async () => {
    mockNotif.saveUserNotificationPreferencesAsync.mockResolvedValue(true);

    const res = await request(app).post('/push/preferences').send({
      enableWebPush: true,
      enableApprise: false,
      enabledChannels: [],
      enableDirectMessages: true,
      notifyOnEmoji: true,
      notifyOnMqtt: true,
      notifyOnNewNode: true,
      notifyOnTraceroute: true,
      notifyOnInactiveNode: false,
      notifyOnServerEvents: false,
      prefixWithNodeName: false,
      whitelist: [],
      blacklist: [],
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockNotif.saveUserNotificationPreferencesAsync).toHaveBeenCalled();
  });
});

describe('notificationRoutes - apprise', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /apprise/status returns availability and settings', async () => {
    mockApprise.isAvailable.mockReturnValue(true);
    (databaseService.settings.getSetting as any)
      .mockResolvedValueOnce('true') // apprise_enabled
      .mockResolvedValueOnce('http://x:8000'); // apprise_url

    const res = await request(app).get('/apprise/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, enabled: true, url: 'http://x:8000' });
  });

  it('POST /apprise/test rejects missing sourceId', async () => {
    const res = await request(app).post('/apprise/test').send({});
    expect(res.status).toBe(400);
  });

  it('POST /apprise/test reports when no urls configured', async () => {
    (databaseService.sources.getSource as any).mockResolvedValue({ id: 's1', name: 'S1' });
    mockNotif.getUserNotificationPreferencesAsync.mockResolvedValue({ appriseUrls: [] });

    const res = await request(app).post('/apprise/test').send({ sourceId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/No Apprise URLs/);
  });

  it('POST /apprise/test sends to configured urls', async () => {
    (databaseService.sources.getSource as any).mockResolvedValue({ id: 's1', name: 'S1' });
    mockNotif.getUserNotificationPreferencesAsync.mockResolvedValue({ appriseUrls: ['ntfy://x'] });
    mockManager.getLocalNodeInfo.mockReturnValue({ longName: 'Node' });
    mockNotif.applyNodeNamePrefixAsync.mockResolvedValue('body');
    mockApprise.sendNotificationToUrls.mockResolvedValue(true);

    const res = await request(app).post('/apprise/test').send({ sourceId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockApprise.sendNotificationToUrls).toHaveBeenCalled();
  });

  it('POST /apprise/configure rejects non-array urls', async () => {
    const res = await request(app).post('/apprise/configure').send({ urls: 'x' });
    expect(res.status).toBe(400);
  });

  it('POST /apprise/configure rejects disallowed schemes', async () => {
    const res = await request(app)
      .post('/apprise/configure')
      .send({ urls: ['evilscheme://x'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/disallowed/i);
  });

  it('POST /apprise/configure accepts allowed schemes', async () => {
    mockApprise.configureUrls.mockResolvedValue({ success: true });

    const res = await request(app)
      .post('/apprise/configure')
      .send({ urls: ['ntfy://topic', 'discord://id/token'] });

    expect(res.status).toBe(200);
    expect(mockApprise.configureUrls).toHaveBeenCalledWith(['ntfy://topic', 'discord://id/token']);
  });

  it('PUT /apprise/enabled rejects non-boolean', async () => {
    const res = await request(app).put('/apprise/enabled').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('PUT /apprise/enabled saves enabled flag', async () => {
    (databaseService.settings.setSetting as any).mockResolvedValue(undefined);

    const res = await request(app).put('/apprise/enabled').send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(databaseService.settings.setSetting).toHaveBeenCalledWith('apprise_enabled', 'true');
  });
});
