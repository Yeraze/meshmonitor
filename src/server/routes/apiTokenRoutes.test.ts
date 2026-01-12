import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import apiTokenRoutes from './apiTokenRoutes.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    apiTokenModel: {
      getUserToken: vi.fn(),
      create: vi.fn(),
      revoke: vi.fn()
    },
    userModel: {
      findById: vi.fn()
    },
    auditLog: vi.fn(),
    // Async methods required by authMiddleware
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn()
  }
}));

const mockDatabase = databaseService as unknown as {
  apiTokenModel: {
    getUserToken: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
  };
  userModel: {
    findById: ReturnType<typeof vi.fn>;
  };
  auditLog: ReturnType<typeof vi.fn>;
  // Async methods
  findUserByIdAsync: ReturnType<typeof vi.fn>;
  findUserByUsernameAsync: ReturnType<typeof vi.fn>;
  checkPermissionAsync: ReturnType<typeof vi.fn>;
  getUserPermissionSetAsync: ReturnType<typeof vi.fn>;
};

const defaultUser = {
  id: 42,
  username: 'token-tester',
  isActive: true,
  isAdmin: false
};

const createApp = (options: { authenticated?: boolean } = {}): Express => {
  const { authenticated = true } = options;
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

  if (authenticated) {
    app.use((req, _res, next) => {
      req.session.userId = defaultUser.id;
      req.session.username = defaultUser.username;
      next();
    });
  }

  app.use('/api/token', apiTokenRoutes);
  return app;
};

describe('API Token Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDatabase.userModel.findById.mockReturnValue(defaultUser);
    mockDatabase.apiTokenModel.getUserToken.mockReturnValue(null);
    // Configure async mocks for authMiddleware
    mockDatabase.findUserByIdAsync.mockResolvedValue(defaultUser);
    mockDatabase.findUserByUsernameAsync.mockResolvedValue(null);
    mockDatabase.checkPermissionAsync.mockResolvedValue(true);
    mockDatabase.getUserPermissionSetAsync.mockResolvedValue({
      resources: {},
      isAdmin: false
    });
  });

  it('requires authentication for token endpoints', async () => {
    const app = createApp({ authenticated: false });

    const response = await request(app).get('/api/token');

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty('code', 'UNAUTHORIZED');
  });

  describe('GET /api/token', () => {
    it('returns empty token state when user has no token', async () => {
      const app = createApp();

      const response = await request(app).get('/api/token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        hasToken: false,
        token: null
      });
      expect(mockDatabase.apiTokenModel.getUserToken).toHaveBeenCalledWith(defaultUser.id);
    });

    it('returns token metadata when token exists', async () => {
      const tokenInfo = {
        id: 7,
        prefix: 'mm_v1_abc',
        createdAt: 1700000000000,
        lastUsedAt: 1700000100000,
        isActive: true
      };
      mockDatabase.apiTokenModel.getUserToken.mockReturnValue(tokenInfo);

      const app = createApp();
      const response = await request(app).get('/api/token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        hasToken: true,
        token: {
          id: tokenInfo.id,
          prefix: tokenInfo.prefix,
          createdAt: tokenInfo.createdAt,
          lastUsedAt: tokenInfo.lastUsedAt,
          isActive: tokenInfo.isActive
        }
      });
    });

    it('returns 500 when database lookup fails', async () => {
      mockDatabase.apiTokenModel.getUserToken.mockImplementation(() => {
        throw new Error('db down');
      });

      const app = createApp();
      const response = await request(app).get('/api/token');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: 'Internal Server Error',
        message: 'Failed to retrieve API token information'
      });
    });
  });

  describe('POST /api/token/generate', () => {
    it('creates a new token and logs audit trail', async () => {
      const tokenInfo = {
        id: 9,
        prefix: 'mm_v1_xyz',
        createdAt: 1700000200000,
        isActive: true
      };
      mockDatabase.apiTokenModel.create.mockResolvedValue({
        token: 'mm_v1_xyz_secret',
        tokenInfo
      });

      const app = createApp();
      const response = await request(app).post('/api/token/generate');

      expect(response.status).toBe(200);
      expect(mockDatabase.apiTokenModel.create).toHaveBeenCalledWith({
        userId: defaultUser.id,
        createdBy: defaultUser.id
      });
      expect(response.body).toMatchObject({
        message: expect.stringContaining('generated successfully'),
        token: 'mm_v1_xyz_secret',
        tokenInfo
      });
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'api_token_generated',
        'api_token',
        expect.any(String),
        expect.any(String)
      );
    });

    it('returns 500 when token generation fails', async () => {
      mockDatabase.apiTokenModel.create.mockRejectedValue(new Error('db failure'));

      const app = createApp();
      const response = await request(app).post('/api/token/generate');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: 'Internal Server Error',
        message: 'Failed to generate API token'
      });
    });
  });

  describe('DELETE /api/token', () => {
    it('returns 404 when user has no active token', async () => {
      mockDatabase.apiTokenModel.getUserToken.mockReturnValue(null);

      const app = createApp();
      const response = await request(app).delete('/api/token');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: 'Not Found',
        message: 'No active API token found'
      });
    });

    it('returns 404 when revoke fails despite existing token', async () => {
      const existingToken = {
        id: 12,
        prefix: 'mm_v1_old',
        createdAt: 1699999999999,
        lastUsedAt: null,
        isActive: true
      };
      mockDatabase.apiTokenModel.getUserToken.mockReturnValue(existingToken);
      mockDatabase.apiTokenModel.revoke.mockReturnValue(false);

      const app = createApp();
      const response = await request(app).delete('/api/token');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: 'Not Found',
        message: 'Token not found or already revoked'
      });
    });

    it('revokes the token and records audit log', async () => {
      const existingToken = {
        id: 15,
        prefix: 'mm_v1_active',
        createdAt: 1699999999999,
        lastUsedAt: 1700000300000,
        isActive: true
      };
      mockDatabase.apiTokenModel.getUserToken.mockReturnValue(existingToken);
      mockDatabase.apiTokenModel.revoke.mockReturnValue(true);

      const app = createApp();
      const response = await request(app).delete('/api/token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        message: 'API token revoked successfully'
      });
      expect(mockDatabase.apiTokenModel.revoke).toHaveBeenCalledWith(existingToken.id, defaultUser.id);
      expect(mockDatabase.auditLog).toHaveBeenCalledWith(
        defaultUser.id,
        'api_token_revoked',
        'api_token',
        expect.any(String),
        expect.any(String)
      );
    });

    it('returns 500 when revoke throws', async () => {
      const existingToken = {
        id: 99,
        prefix: 'mm_v1_oops',
        createdAt: 1700000000000,
        lastUsedAt: null,
        isActive: true
      };
      mockDatabase.apiTokenModel.getUserToken.mockReturnValue(existingToken);
      mockDatabase.apiTokenModel.revoke.mockImplementation(() => {
        throw new Error('db failure');
      });

      const app = createApp();
      const response = await request(app).delete('/api/token');

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: 'Internal Server Error',
        message: 'Failed to revoke API token'
      });
    });
  });
});
