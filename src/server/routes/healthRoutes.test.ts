import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import healthRoutes from './healthRoutes.js';
import DatabaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    drizzleDbType: 'sqlite',
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  },
}));

/** App with no session — unauthenticated callers. */
const createAnonApp = () => {
  const app = express();
  app.use('/health', healthRoutes);
  return app;
};

/**
 * App that seeds a session userId so optionalAuth resolves a real
 * (non-anonymous) user via findUserByIdAsync.
 */
const createAuthedApp = () => {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).session = { userId: 1 };
    next();
  });
  app.use('/health', healthRoutes);
  return app;
};

describe('Health Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /health does not require authentication and returns 200', async () => {
    const app = createAnonApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('GET /health does NOT leak version/stack detail to unauthenticated callers (#6084)', async () => {
    const app = createAnonApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.body.version).toBeUndefined();
    expect(response.body.databaseType).toBeUndefined();
    expect(response.body.uptime).toBeUndefined();
    expect(response.body.firmwareOtaEnabled).toBeUndefined();
  });

  it('GET /health returns full detail to an authenticated user', async () => {
    (DatabaseService as any).findUserByIdAsync.mockResolvedValue({
      id: 1,
      username: 'realuser',
      isActive: true,
      isAdmin: true,
    });
    const app = createAuthedApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(typeof response.body.version).toBe('string');
    expect(typeof response.body.uptime).toBe('number');
    expect(response.body.databaseType).toBe('sqlite');
    expect(typeof response.body.firmwareOtaEnabled).toBe('boolean');
  });

  it('GET /health does NOT leak detail to the anonymous account', async () => {
    // optionalAuth attaches the shared "anonymous" user when no real session —
    // the endpoint must still withhold detail from it.
    (DatabaseService as any).findUserByIdAsync.mockResolvedValue({
      id: 2,
      username: 'anonymous',
      isActive: true,
      isAdmin: false,
    });
    const app = createAuthedApp();
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
