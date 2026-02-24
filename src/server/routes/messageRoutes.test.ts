/**
 * Message Routes Unit Tests
 *
 * Tests message deletion endpoints with permission checks
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import databaseService from '../../services/database.js';
import messageRoutes from './messageRoutes.js';

// Helper to create app with specific user
const createApp = (user: any = null) => {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: false }
    })
  );

  // Mock authentication middleware
  app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });

  // Mount message routes
  app.use('/api/messages', messageRoutes);

  return app;
};

describe('Message Deletion Routes', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
  });

  describe('DELETE /api/messages/:id - Single message deletion', () => {
    it('should return 403 for unauthenticated users', async () => {
      const app = createApp(null);
      const response = await request(app).delete('/api/messages/test-message-id');

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error', 'Forbidden');
    });

    it('should return 404 for non-existent message', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'getMessageAsync').mockResolvedValue(null);

      const response = await request(app).delete('/api/messages/nonexistent');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('message', 'Message not found');
    });

    it('should allow admin to delete any message', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const mockMessage = {
        id: 'msg-123',
        channel: 5,
        text: 'Test message'
      };

      vi.spyOn(databaseService, 'getMessageAsync').mockResolvedValue(mockMessage as any);
      vi.spyOn(databaseService, 'deleteMessageAsync').mockResolvedValue(true);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/msg-123');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'Message deleted successfully');
      expect(response.body).toHaveProperty('id', 'msg-123');
      expect(databaseService.deleteMessageAsync).toHaveBeenCalledWith('msg-123');
      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'message_deleted',
        'messages',
        expect.stringContaining('msg-123'),
        expect.any(String)
      );
    });

    it('should require channels:write for channel messages', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      const mockChannelMessage = {
        id: 'msg-channel',
        channel: 5,
        text: 'Channel message'
      };

      vi.spyOn(databaseService, 'getMessageAsync').mockResolvedValue(mockChannelMessage as any);
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: false, write: false },
        channel_0: { read: false, write: false }
      });

      const response = await request(app).delete('/api/messages/msg-channel');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('write permission');
    });

    it('should require messages:write for DM messages', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      const mockDMMessage = {
        id: 'msg-dm',
        channel: 0,
        text: 'Direct message'
      };

      vi.spyOn(databaseService, 'getMessageAsync').mockResolvedValue(mockDMMessage as any);
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: false, write: false },
        channel_0: { read: false, write: false }
      });

      const response = await request(app).delete('/api/messages/msg-dm');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('messages:write');
    });

    it('should allow user with channels:write to delete channel messages', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      const mockChannelMessage = {
        id: 'msg-channel',
        channel: 5,
        text: 'Channel message'
      };

      vi.spyOn(databaseService, 'getMessageAsync').mockResolvedValue(mockChannelMessage as any);
      vi.spyOn(databaseService, 'deleteMessageAsync').mockResolvedValue(true);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        channel_5: { read: true, write: true }
      });

      const response = await request(app).delete('/api/messages/msg-channel');

      expect(response.status).toBe(200);
      expect(databaseService.deleteMessageAsync).toHaveBeenCalledWith('msg-channel');
      expect(auditLogSpy).toHaveBeenCalledWith(
        2,
        'message_deleted',
        'messages',
        expect.stringContaining('msg-channel'),
        expect.any(String)
      );
    });

    it('should log deletion to audit log', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const mockMessage = {
        id: 'msg-123',
        channel: 5,
        text: 'Test message'
      };

      vi.spyOn(databaseService, 'getMessageAsync').mockResolvedValue(mockMessage as any);
      vi.spyOn(databaseService, 'deleteMessageAsync').mockResolvedValue(true);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app).delete('/api/messages/msg-123');

      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'message_deleted',
        'messages',
        expect.stringContaining('msg-123'),
        expect.any(String)
      );
    });
  });

  describe('DELETE /api/messages/channels/:channelId - Channel purge', () => {
    it('should return 403 for users without channel_5:write', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        channel_0: { read: false, write: false }
      });

      const response = await request(app).delete('/api/messages/channels/5');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('channel_5:write');
    });

    it('should return 400 for invalid channel ID', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/channels/invalid');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid channel ID');
    });

    it('should allow admin to purge channel messages', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'purgeChannelMessagesAsync').mockResolvedValue(15);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/channels/5');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 15);
      expect(response.body).toHaveProperty('channelId', 5);
      expect(databaseService.purgeChannelMessagesAsync).toHaveBeenCalledWith(5);
      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'channel_messages_purged',
        'messages',
        expect.stringContaining('15'),
        expect.any(String)
      );
    });

    it('should allow user with channel_3:write to purge channel messages', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        channel_3: { read: true, write: true }
      });
      vi.spyOn(databaseService, 'purgeChannelMessagesAsync').mockResolvedValue(10);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/channels/3');

      expect(response.status).toBe(200);
      expect(databaseService.purgeChannelMessagesAsync).toHaveBeenCalledWith(3);
      expect(auditLogSpy).toHaveBeenCalledWith(
        2,
        'channel_messages_purged',
        'messages',
        expect.stringContaining('10'),
        expect.any(String)
      );
    });

    it('should log purge to audit log', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'purgeChannelMessagesAsync').mockResolvedValue(20);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app).delete('/api/messages/channels/7');

      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'channel_messages_purged',
        'messages',
        expect.stringContaining('20'),
        expect.any(String)
      );
    });
  });

  describe('DELETE /api/messages/direct-messages/:nodeNum - DM purge', () => {
    it('should return 403 for users without messages:write', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: false, write: false }
      });

      const response = await request(app).delete('/api/messages/direct-messages/123456');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('messages:write');
    });

    it('should return 400 for invalid node number', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/direct-messages/invalid');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid node number');
    });

    it('should allow admin to purge direct messages', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'purgeDirectMessagesAsync').mockResolvedValue(25);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/direct-messages/999999999');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 25);
      expect(response.body).toHaveProperty('nodeNum', 999999999);
      expect(databaseService.purgeDirectMessagesAsync).toHaveBeenCalledWith(999999999);
      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'dm_messages_purged',
        'messages',
        expect.stringContaining('25'),
        expect.any(String)
      );
    });

    it('should allow user with messages:write to purge direct messages', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: true, write: true }
      });
      vi.spyOn(databaseService, 'purgeDirectMessagesAsync').mockResolvedValue(12);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/direct-messages/123456');

      expect(response.status).toBe(200);
      expect(databaseService.purgeDirectMessagesAsync).toHaveBeenCalledWith(123456);
      expect(auditLogSpy).toHaveBeenCalledWith(
        2,
        'dm_messages_purged',
        'messages',
        expect.stringContaining('12'),
        expect.any(String)
      );
    });

    it('should log purge to audit log', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'purgeDirectMessagesAsync').mockResolvedValue(30);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app).delete('/api/messages/direct-messages/123456');

      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'dm_messages_purged',
        'messages',
        expect.stringContaining('30'),
        expect.any(String)
      );
    });
  });

  describe('DELETE /api/messages/nodes/:nodeNum/traceroutes - Node traceroutes purge', () => {
    it('should return 403 for users without messages:write', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: false, write: false }
      });

      const response = await request(app).delete('/api/messages/nodes/123456/traceroutes');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('messages:write');
    });

    it('should return 400 for invalid node number', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/nodes/invalid/traceroutes');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid node number');
    });

    it('should successfully purge traceroutes for admin user', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'purgeNodeTraceroutesAsync').mockResolvedValue(15);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/nodes/123456/traceroutes');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 15);
      expect(response.body).toHaveProperty('message', 'Node traceroutes purged successfully');
      expect(databaseService.purgeNodeTraceroutesAsync).toHaveBeenCalledWith(123456);
    });

    it('should successfully purge traceroutes for user with messages:write', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: true, write: true }
      });
      vi.spyOn(databaseService, 'purgeNodeTraceroutesAsync').mockResolvedValue(8);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/nodes/123456/traceroutes');

      expect(response.status).toBe(200);
      expect(databaseService.purgeNodeTraceroutesAsync).toHaveBeenCalledWith(123456);
    });

    it('should log audit event for traceroutes purge', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'purgeNodeTraceroutesAsync').mockResolvedValue(20);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app).delete('/api/messages/nodes/123456/traceroutes');

      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'node_traceroutes_purged',
        'traceroutes',
        expect.stringContaining('20'),
        expect.any(String)
      );
    });
  });

  describe('DELETE /api/messages/nodes/:nodeNum/telemetry - Node telemetry purge', () => {
    it('should return 403 for users without messages:write', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: false, write: false }
      });

      const response = await request(app).delete('/api/messages/nodes/123456/telemetry');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('messages:write');
    });

    it('should return 400 for invalid node number', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/nodes/invalid/telemetry');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid node number');
    });

    it('should successfully purge telemetry for admin user', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'purgeNodeTelemetryAsync').mockResolvedValue(45);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/nodes/123456/telemetry');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 45);
      expect(response.body).toHaveProperty('message', 'Node telemetry purged successfully');
      expect(databaseService.purgeNodeTelemetryAsync).toHaveBeenCalledWith(123456);
    });

    it('should successfully purge telemetry for user with messages:write', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: true, write: true }
      });
      vi.spyOn(databaseService, 'purgeNodeTelemetryAsync').mockResolvedValue(12);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/nodes/123456/telemetry');

      expect(response.status).toBe(200);
      expect(databaseService.purgeNodeTelemetryAsync).toHaveBeenCalledWith(123456);
    });

    it('should log audit event for telemetry purge', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'purgeNodeTelemetryAsync').mockResolvedValue(30);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app).delete('/api/messages/nodes/123456/telemetry');

      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'node_telemetry_purged',
        'telemetry',
        expect.stringContaining('30'),
        expect.any(String)
      );
    });
  });
});
