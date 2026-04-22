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

// Mock traceroutes repository for direct repo access
const mockTraceroutesRepo = {
  deleteTraceroutesForNode: vi.fn(),
};

// Mock messages repository for direct repo access
const mockMessagesRepo = {
  deleteMessage: vi.fn(),
  purgeChannelMessages: vi.fn(),
  purgeDirectMessages: vi.fn(),
};

// Mock telemetry repository for direct repo access
const mockTelemetryRepo = {
  purgeNodeTelemetry: vi.fn(),
  purgePositionHistory: vi.fn(),
};

describe('Message Deletion Routes', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    // Mock auth-related async methods used by route handlers
    (databaseService as any).getUserPermissionSetAsync = vi.fn().mockResolvedValue({
      messages: { read: true, write: true, viewOnMap: false },
      dashboard: { read: true, write: true, viewOnMap: false },
    });
    // Per-source split (default: messages:write granted on source-a so DELETE /:id
    // passes the "has any write grant" gate). Individual tests override this.
    (databaseService as any).getUserPermissionSetsBySourceAsync = vi.fn().mockResolvedValue({
      global: {},
      bySource: {
        'source-a': { messages: { read: true, write: true, viewOnMap: false } },
      },
    });
    (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(true);
    // Set up traceroutes repo mock
    Object.defineProperty(databaseService, 'messages', {
      get: () => mockMessagesRepo,
      configurable: true,
    });
    Object.defineProperty(databaseService, 'telemetry', {
      get: () => mockTelemetryRepo,
      configurable: true,
    });
    Object.defineProperty(databaseService, 'traceroutes', {
      get: () => mockTraceroutesRepo,
      configurable: true,
    });
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
      mockMessagesRepo.deleteMessage.mockResolvedValue(true);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/msg-123');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'Message deleted successfully');
      expect(response.body).toHaveProperty('id', 'msg-123');
      expect(mockMessagesRepo.deleteMessage).toHaveBeenCalledWith('msg-123');
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
      (databaseService as any).getUserPermissionSetsBySourceAsync = vi.fn().mockResolvedValue({
        global: {},
        bySource: {},
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
      (databaseService as any).getUserPermissionSetsBySourceAsync = vi.fn().mockResolvedValue({
        global: {},
        bySource: {},
      });

      const response = await request(app).delete('/api/messages/msg-dm');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('write permission');
    });

    it('should allow user with channels:write to delete channel messages', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      const mockChannelMessage = {
        id: 'msg-channel',
        channel: 5,
        sourceId: 'source-a',
        text: 'Channel message'
      };

      vi.spyOn(databaseService, 'getMessageAsync').mockResolvedValue(mockChannelMessage as any);
      mockMessagesRepo.deleteMessage.mockResolvedValue(true);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);
      (databaseService as any).getUserPermissionSetsBySourceAsync = vi.fn().mockResolvedValue({
        global: {},
        bySource: {
          'source-a': { channel_5: { read: true, write: true } },
        },
      });
      (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(true);

      const response = await request(app).delete('/api/messages/msg-channel');

      expect(response.status).toBe(200);
      expect(mockMessagesRepo.deleteMessage).toHaveBeenCalledWith('msg-channel');
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
      mockMessagesRepo.deleteMessage.mockResolvedValue(true);
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
      vi.spyOn(databaseService, 'checkPermissionAsync').mockResolvedValue(false);

      const response = await request(app).delete('/api/messages/channels/5?sourceId=test');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('channel_5:write');
    });

    it('should return 400 for invalid channel ID', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/channels/invalid?sourceId=test');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid channel ID');
    });

    it('should allow admin to purge channel messages', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockMessagesRepo.purgeChannelMessages.mockResolvedValue(15);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/channels/5?sourceId=test');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 15);
      expect(response.body).toHaveProperty('channelId', 5);
      expect(response.body).toHaveProperty('sourceId', 'test');
      expect(mockMessagesRepo.purgeChannelMessages).toHaveBeenCalledWith(5, 'test');
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
      vi.spyOn(databaseService, 'checkPermissionAsync').mockResolvedValue(true);
      mockMessagesRepo.purgeChannelMessages.mockResolvedValue(10);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/channels/3?sourceId=test');

      expect(response.status).toBe(200);
      expect(mockMessagesRepo.purgeChannelMessages).toHaveBeenCalledWith(3, 'test');
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
      mockMessagesRepo.purgeChannelMessages.mockResolvedValue(20);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app).delete('/api/messages/channels/7?sourceId=test');

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
    it('should return 403 for users without messages:write on this source', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(false);

      const response = await request(app).delete('/api/messages/direct-messages/123456?sourceId=source-a');

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('messages:write');
    });

    it('should return 400 for invalid node number', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/direct-messages/invalid?sourceId=source-a');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid node number');
    });

    it('should return 400 when sourceId is missing', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });

      const response = await request(app).delete('/api/messages/direct-messages/123456');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'sourceId is required');
    });

    it('should allow admin to purge direct messages', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockMessagesRepo.purgeDirectMessages.mockResolvedValue(25);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/direct-messages/999999999?sourceId=test');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 25);
      expect(response.body).toHaveProperty('nodeNum', 999999999);
      expect(response.body).toHaveProperty('sourceId', 'test');
      expect(mockMessagesRepo.purgeDirectMessages).toHaveBeenCalledWith(999999999, 'test');
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
      mockMessagesRepo.purgeDirectMessages.mockResolvedValue(12);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/direct-messages/123456?sourceId=test');

      expect(response.status).toBe(200);
      expect(mockMessagesRepo.purgeDirectMessages).toHaveBeenCalledWith(123456, 'test');
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
      mockMessagesRepo.purgeDirectMessages.mockResolvedValue(30);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app).delete('/api/messages/direct-messages/123456?sourceId=test');

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
    it('should return 403 for users without messages:write on this source', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(false);

      const response = await request(app)
        .delete('/api/messages/nodes/123456/traceroutes')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('messages:write');
    });

    it('should return 400 for invalid node number', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app)
        .delete('/api/messages/nodes/invalid/traceroutes')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid node number');
    });

    it('should return 400 when sourceId is missing', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/nodes/123456/traceroutes');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'sourceId is required');
    });

    it('should successfully purge traceroutes for admin user', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTraceroutesRepo.deleteTraceroutesForNode.mockResolvedValue(15);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/messages/nodes/123456/traceroutes')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 15);
      expect(response.body).toHaveProperty('message', 'Node traceroutes purged successfully');
      expect(mockTraceroutesRepo.deleteTraceroutesForNode).toHaveBeenCalledWith(123456, 'source-a');
    });

    it('should scope purge to the provided sourceId', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTraceroutesRepo.deleteTraceroutesForNode.mockResolvedValue(8);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app)
        .delete('/api/messages/nodes/123456/traceroutes')
        .send({ sourceId: 'source-b' });

      expect(mockTraceroutesRepo.deleteTraceroutesForNode).toHaveBeenCalledWith(123456, 'source-b');
    });

    it('should successfully purge traceroutes for user with messages:write', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: true, write: true }
      });
      mockTraceroutesRepo.deleteTraceroutesForNode.mockResolvedValue(8);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/messages/nodes/123456/traceroutes')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(200);
      expect(mockTraceroutesRepo.deleteTraceroutesForNode).toHaveBeenCalledWith(123456, 'source-a');
    });

    it('should log audit event for traceroutes purge', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTraceroutesRepo.deleteTraceroutesForNode.mockResolvedValue(20);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app)
        .delete('/api/messages/nodes/123456/traceroutes')
        .send({ sourceId: 'source-a' });

      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'node_traceroutes_purged',
        'traceroute',
        expect.stringContaining('20'),
        expect.any(String)
      );
    });
  });

  describe('DELETE /api/messages/nodes/:nodeNum/position-history - Node position history purge', () => {
    it('should return 403 for users without messages:write on this source', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(false);

      const response = await request(app)
        .delete('/api/messages/nodes/123456/position-history')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('messages:write');
    });

    it('should return 400 for invalid node number', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app)
        .delete('/api/messages/nodes/invalid/position-history')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid node number');
    });

    it('should return 400 when sourceId is missing', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/nodes/123456/position-history');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'sourceId is required');
    });

    it('should successfully purge position history for admin', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTelemetryRepo.purgePositionHistory.mockResolvedValue(18);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/messages/nodes/123456/position-history')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 18);
      expect(response.body).toHaveProperty('message', 'Node position history purged successfully');
      expect(mockTelemetryRepo.purgePositionHistory).toHaveBeenCalledWith(123456, 'source-a');
    });

    it('should scope purge to the provided sourceId', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTelemetryRepo.purgePositionHistory.mockResolvedValue(3);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app)
        .delete('/api/messages/nodes/123456/position-history')
        .send({ sourceId: 'source-b' });

      expect(mockTelemetryRepo.purgePositionHistory).toHaveBeenCalledWith(123456, 'source-b');
    });

    it('should log audit event for position history purge', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTelemetryRepo.purgePositionHistory.mockResolvedValue(5);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app)
        .delete('/api/messages/nodes/123456/position-history')
        .send({ sourceId: 'source-a' });

      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'node_position_history_purged',
        'telemetry',
        expect.stringContaining('5'),
        expect.any(String)
      );
    });
  });

  describe('DELETE /api/messages/nodes/:nodeNum - Delete entire node', () => {
    it('should return 403 for users without messages:write on this source', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(false);

      const response = await request(app).delete('/api/messages/nodes/123456?sourceId=source-a');

      expect(response.status).toBe(403);
    });

    it('should return 400 for invalid node number', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/nodes/invalid?sourceId=source-a');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid node number');
    });

    it('should return 404 when node not found', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'nodes' as any, 'get').mockReturnValue({
        getAllNodes: vi.fn().mockResolvedValue([])
      });
      vi.spyOn(databaseService, 'deleteNodeAsync').mockResolvedValue({
        nodeDeleted: false,
        messagesDeleted: 0,
        traceroutesDeleted: 0,
        telemetryDeleted: 0
      } as any);

      const response = await request(app).delete('/api/messages/nodes/999999?sourceId=default');

      expect(response.status).toBe(404);
    });

    it('should delete node and return 200', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      vi.spyOn(databaseService, 'nodes' as any, 'get').mockReturnValue({
        getAllNodes: vi.fn().mockResolvedValue([
          { nodeNum: 123456, shortName: 'Test', longName: 'Test Node' }
        ])
      });
      vi.spyOn(databaseService, 'deleteNodeAsync').mockResolvedValue({
        nodeDeleted: true,
        messagesDeleted: 10,
        traceroutesDeleted: 5,
        telemetryDeleted: 20
      } as any);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app).delete('/api/messages/nodes/123456?sourceId=default');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('message', 'Node deleted successfully');
      expect(response.body).toHaveProperty('nodeNum', 123456);
      expect(response.body).toHaveProperty('messagesDeleted', 10);
    });
  });

  describe('DELETE /api/messages/nodes/:nodeNum/telemetry - Node telemetry purge', () => {
    it('should return 403 for users without messages:write on this source', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(false);

      const response = await request(app)
        .delete('/api/messages/nodes/123456/telemetry')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(403);
      expect(response.body.message).toContain('messages:write');
    });

    it('should return 400 for invalid node number', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app)
        .delete('/api/messages/nodes/invalid/telemetry')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'Invalid node number');
    });

    it('should return 400 when sourceId is missing', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      const response = await request(app).delete('/api/messages/nodes/123456/telemetry');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('message', 'sourceId is required');
    });

    it('should successfully purge telemetry for admin user', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTelemetryRepo.purgeNodeTelemetry.mockResolvedValue(45);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/messages/nodes/123456/telemetry')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('deletedCount', 45);
      expect(response.body).toHaveProperty('message', 'Node telemetry purged successfully');
      expect(mockTelemetryRepo.purgeNodeTelemetry).toHaveBeenCalledWith(123456, 'source-a');
    });

    it('should scope purge to the provided sourceId', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTelemetryRepo.purgeNodeTelemetry.mockResolvedValue(10);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app)
        .delete('/api/messages/nodes/123456/telemetry')
        .send({ sourceId: 'source-b' });

      expect(mockTelemetryRepo.purgeNodeTelemetry).toHaveBeenCalledWith(123456, 'source-b');
    });

    it('should successfully purge telemetry for user with messages:write', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      vi.spyOn(databaseService, 'getUserPermissionSetAsync').mockResolvedValue({
        messages: { read: true, write: true }
      });
      mockTelemetryRepo.purgeNodeTelemetry.mockResolvedValue(12);
      vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/messages/nodes/123456/telemetry')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(200);
      expect(mockTelemetryRepo.purgeNodeTelemetry).toHaveBeenCalledWith(123456, 'source-a');
    });

    it('should log audit event for telemetry purge', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      mockTelemetryRepo.purgeNodeTelemetry.mockResolvedValue(30);
      const auditLogSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined);

      await request(app)
        .delete('/api/messages/nodes/123456/telemetry')
        .send({ sourceId: 'source-a' });

      expect(auditLogSpy).toHaveBeenCalledWith(
        1,
        'node_telemetry_purged',
        'telemetry',
        expect.stringContaining('30'),
        expect.any(String)
      );
    });
  });

  describe('GET /api/messages/search - Message search', () => {
    beforeEach(() => {
      (databaseService as any).searchMessagesAsync = vi.fn().mockResolvedValue({
        messages: [],
        total: 0,
      });
      (databaseService as any).getUserPermissionSetAsync = vi.fn().mockResolvedValue({
        messages: { read: true, write: true },
        channel_0: { read: true },
        channel_1: { read: true },
      });
    });

    it('should return 400 when no query parameter provided', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });

      const response = await request(app).get('/api/messages/search');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 400 when query is empty string', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });

      const response = await request(app).get('/api/messages/search?q=');

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('required');
    });

    it('should return search results for admin', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      (databaseService as any).searchMessagesAsync = vi.fn().mockResolvedValue({
        messages: [
          { id: 1, text: 'hello world', channelId: 0, fromNodeId: '!abc', timestamp: 1000 }
        ],
        total: 1,
      });

      const response = await request(app).get('/api/messages/search?q=hello');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
    });

    it('should filter by channels for non-admin user', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      (databaseService as any).getUserPermissionSetAsync = vi.fn().mockResolvedValue({
        channel_0: { read: true },
        messages: { read: true },
      });
      (databaseService as any).searchMessagesAsync = vi.fn().mockResolvedValue({
        messages: [],
        total: 0,
      });

      const response = await request(app).get('/api/messages/search?q=test');

      expect(response.status).toBe(200);
      expect(databaseService.searchMessagesAsync).toHaveBeenCalled();
    });

    it('should handle caseSensitive=true parameter', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      (databaseService as any).searchMessagesAsync = vi.fn().mockResolvedValue({
        messages: [],
        total: 0,
      });

      const response = await request(app).get('/api/messages/search?q=Test&caseSensitive=true');

      expect(response.status).toBe(200);
      expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
        expect.objectContaining({ caseSensitive: true })
      );
    });

    it('should handle channel filter parameter', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      (databaseService as any).searchMessagesAsync = vi.fn().mockResolvedValue({
        messages: [],
        total: 0,
      });

      const response = await request(app).get('/api/messages/search?q=test&channels=0,1,2');

      expect(response.status).toBe(200);
    });

    it('should handle database error gracefully', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      (databaseService as any).searchMessagesAsync = vi.fn().mockRejectedValue(
        new Error('DB error')
      );

      const response = await request(app).get('/api/messages/search?q=test');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });

    it('should handle limit and offset parameters', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      (databaseService as any).searchMessagesAsync = vi.fn().mockResolvedValue({
        messages: [],
        total: 0,
      });

      const response = await request(app).get('/api/messages/search?q=test&limit=20&offset=10');

      expect(response.status).toBe(200);
      expect(databaseService.searchMessagesAsync).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20, offset: 10 })
      );
    });
  });

  describe('POST /api/messages/nodes/:nodeNum/purge-from-device', () => {
    it('should return 500 when meshtasticManager not available', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });

      // Ensure global meshtasticManager is not set
      const originalManager = (global as any).meshtasticManager;
      delete (global as any).meshtasticManager;

      const response = await request(app)
        .post('/api/messages/nodes/123456/purge-from-device')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal server error');

      // Restore
      if (originalManager) (global as any).meshtasticManager = originalManager;
    });

    it('should return 400 for invalid nodeNum', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      (global as any).meshtasticManager = {
        getLocalNodeInfo: () => ({ nodeNum: 1 }),
        sendRemoveNode: vi.fn().mockResolvedValue(undefined),
      };

      const response = await request(app)
        .post('/api/messages/nodes/invalid/purge-from-device')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Invalid node number');

      delete (global as any).meshtasticManager;
    });

    it('should return 400 when trying to purge local node', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      (global as any).meshtasticManager = {
        getLocalNodeInfo: () => ({ nodeNum: 123456 }),
        sendRemoveNode: vi.fn(),
      };

      const response = await request(app)
        .post('/api/messages/nodes/123456/purge-from-device')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Cannot purge the local node');

      delete (global as any).meshtasticManager;
    });

    it('should return 403 when user lacks messages:write permission on this source', async () => {
      const app = createApp({ id: 2, username: 'user', isAdmin: false });
      (databaseService as any).checkPermissionAsync = vi.fn().mockResolvedValue(false);

      const response = await request(app)
        .post('/api/messages/nodes/123456/purge-from-device')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(403);
    });

    it('should return 500 when sendRemoveNode fails', async () => {
      const app = createApp({ id: 1, username: 'admin', isAdmin: true });
      (global as any).meshtasticManager = {
        getLocalNodeInfo: () => ({ nodeNum: 999 }),
        sendRemoveNode: vi.fn().mockRejectedValue(new Error('Device error')),
      };
      Object.defineProperty(databaseService, 'nodes', {
        get: () => ({ getAllNodes: vi.fn().mockResolvedValue([]) }),
        configurable: true,
      });

      const response = await request(app)
        .post('/api/messages/nodes/123456/purge-from-device')
        .send({ sourceId: 'source-a' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Device communication error');

      delete (global as any).meshtasticManager;
    });
  });
});
