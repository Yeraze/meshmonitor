/**
 * webSocketService — join-source per-source permission tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';

vi.mock('../../services/database.js', () => ({
  default: {
    checkPermissionAsync: vi.fn(),
    validateApiTokenAsync: vi.fn(),
  }
}));

vi.mock('../config/environment.js', () => ({
  getEnvironmentConfig: () => ({ baseUrl: '' }),
}));

import databaseService from '../../services/database.js';
import { initializeWebSocket, shutdownWebSocket } from './webSocketService.js';

const mockDb = databaseService as any;

// Fake session middleware: assigns a session.userId based on handshake auth.token
// (so we don't need real express-session)
const fakeSessionMiddleware: any = (req: any, _res: any, next: any) => {
  req.session = req.session || { userId: 99, username: 'test', isAdmin: false };
  next();
};

describe('webSocketService join-source per-source permission', () => {
  let httpServer: HttpServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    httpServer = createServer();
    initializeWebSocket(httpServer, fakeSessionMiddleware);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await shutdownWebSocket();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const connectClient = (): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = ioClient(`http://localhost:${port}`, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      client.on('connect', () => resolve(client));
      client.on('connect_error', reject);
    });

  it('joins room when checkPermissionAsync returns true for that source', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, _r: string, _a: string, sid?: string) => Promise.resolve(sid === 'allowed')
    );

    const client = await connectClient();
    const errorPromise = new Promise<any>((resolve) => {
      client.on('join-source:error', (err) => resolve(err));
      setTimeout(() => resolve(null), 200);
    });
    client.emit('join-source', 'allowed');
    const err = await errorPromise;
    expect(err).toBeNull();
    expect(mockDb.checkPermissionAsync).toHaveBeenCalledWith(99, 'messages', 'read', 'allowed');
    client.disconnect();
  });

  it('emits join-source:error forbidden when permission denied', async () => {
    mockDb.checkPermissionAsync.mockImplementation(
      (_uid: number, _r: string, _a: string, sid?: string) => Promise.resolve(sid === 'allowed')
    );

    const client = await connectClient();
    const errorPromise = new Promise<any>((resolve) => {
      client.on('join-source:error', (err) => resolve(err));
      setTimeout(() => resolve(null), 500);
    });
    client.emit('join-source', 'denied');
    const err = await errorPromise;
    expect(err).not.toBeNull();
    expect(err.sourceId).toBe('denied');
    expect(err.error).toBe('forbidden');
    client.disconnect();
  });
});
