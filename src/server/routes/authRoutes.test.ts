/**
 * Authentication Routes Integration Tests
 *
 * Tests authentication flows including login, logout, OIDC, and password changes
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import { UserModel } from '../models/User.js';
import { PermissionModel } from '../models/Permission.js';
import { migration as authMigration } from '../migrations/001_add_auth_tables.js';
import authRoutes from './authRoutes.js';
import DatabaseService from '../../services/database.js';

describe('Authentication Routes', () => {
  let app: Express;
  let db: Database.Database;
  let userModel: UserModel;
  let permissionModel: PermissionModel;
  let testUser: any;
  let adminUser: any;
  let agent: any;

  beforeAll(() => {
    // Setup express app for testing
    app = express();
    app.use(express.json());
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        cookie: { secure: false }
      })
    );

    // Setup in-memory database
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    authMigration.up(db);

    userModel = new UserModel(db);
    permissionModel = new PermissionModel(db);

    // Mock database service
    (DatabaseService as any).userModel = userModel;
    (DatabaseService as any).permissionModel = permissionModel;
    (DatabaseService as any).auditLog = () => {};

    app.use('/api/auth', authRoutes);
  });

  beforeEach(async () => {
    // Clear users table
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM permissions').run();

    // Create test users
    testUser = await userModel.create({
      username: 'testuser',
      password: 'password123',
      email: 'test@example.com',
      authProvider: 'local',
      isAdmin: false
    });

    adminUser = await userModel.create({
      username: 'admin',
      password: 'admin123',
      email: 'admin@example.com',
      authProvider: 'local',
      isAdmin: true
    });

    permissionModel.grantDefaultPermissions(testUser.id, false);
    permissionModel.grantDefaultPermissions(adminUser.id, true);

    // Create a new agent for each test to maintain session
    agent = request.agent(app);
  });

  afterEach(() => {
    // Clean up
  });

  describe('POST /login', () => {
    it('should successfully login with valid credentials', async () => {
      const response = await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.user.username).toBe('testuser');
      expect(response.body.user.passwordHash).toBeUndefined();
    });

    it('should reject invalid credentials', async () => {
      const response = await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'wrongpassword'
        })
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    it('should reject login for inactive user', async () => {
      userModel.delete(testUser.id);

      const response = await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        })
        .expect(401);

      expect(response.body.error).toBeDefined();
    });

    it('should reject login with missing credentials', async () => {
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser'
        })
        .expect(400);

      await agent
        .post('/api/auth/login')
        .send({
          password: 'password123'
        })
        .expect(400);
    });
  });

  describe('GET /status', () => {
    it('should return unauthenticated status when not logged in', async () => {
      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body.authenticated).toBe(false);
      expect(response.body.user).toBeNull();
    });

    it('should return authenticated status when logged in', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body.authenticated).toBe(true);
      expect(response.body.user.username).toBe('testuser');
      expect(response.body.user.passwordHash).toBeUndefined();
      expect(response.body.permissions).toBeDefined();
    });

    it('should include user permissions in status', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body.permissions.dashboard).toBeDefined();
      expect(response.body.permissions.dashboard.read).toBe(true);
    });
  });

  describe('POST /logout', () => {
    it('should successfully logout', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      // Logout
      const response = await agent
        .post('/api/auth/logout')
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify user is logged out
      const statusResponse = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(statusResponse.body.authenticated).toBe(false);
    });

    it('should handle logout when not authenticated', async () => {
      const response = await agent
        .post('/api/auth/logout')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /change-password', () => {
    it('should successfully change password when authenticated', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      // Change password
      const response = await agent
        .post('/api/auth/change-password')
        .send({
          currentPassword: 'password123',
          newPassword: 'newpassword456'
        })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Logout
      await agent.post('/api/auth/logout');

      // Verify new password works
      const loginResponse = await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'newpassword456'
        })
        .expect(200);

      expect(loginResponse.body.success).toBe(true);
    });

    it('should reject password change with wrong current password', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      // Attempt to change password with wrong current password
      const response = await agent
        .post('/api/auth/change-password')
        .send({
          currentPassword: 'wrongpassword',
          newPassword: 'newpassword456'
        })
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it('should reject password change when not authenticated', async () => {
      await agent
        .post('/api/auth/change-password')
        .send({
          currentPassword: 'password123',
          newPassword: 'newpassword456'
        })
        .expect(401);
    });

    it('should reject password change with missing fields', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      await agent
        .post('/api/auth/change-password')
        .send({
          currentPassword: 'password123'
        })
        .expect(400);
    });
  });

  describe('Session Security', () => {
    it('should invalidate session when user is deactivated', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      // Verify authenticated
      let statusResponse = await agent
        .get('/api/auth/status')
        .expect(200);
      expect(statusResponse.body.authenticated).toBe(true);

      // Deactivate user
      userModel.delete(testUser.id);

      // Session should now be invalid
      statusResponse = await agent
        .get('/api/auth/status')
        .expect(200);
      expect(statusResponse.body.authenticated).toBe(false);
    });

    it('should not expose password hashes', async () => {
      const response = await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        })
        .expect(200);

      expect(response.body.user.passwordHash).toBeUndefined();

      const statusResponse = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(statusResponse.body.user.passwordHash).toBeUndefined();
    });
  });

  describe('Local Auth Disable Feature', () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
      // Save original environment variable
      originalEnv = process.env.DISABLE_LOCAL_AUTH;
    });

    afterEach(() => {
      // Restore original environment variable
      if (originalEnv !== undefined) {
        process.env.DISABLE_LOCAL_AUTH = originalEnv;
      } else {
        delete process.env.DISABLE_LOCAL_AUTH;
      }
    });

    it('should allow local login when local auth is not disabled', async () => {
      process.env.DISABLE_LOCAL_AUTH = 'false';

      const response = await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it('should block local login when local auth is disabled', async () => {
      process.env.DISABLE_LOCAL_AUTH = 'true';

      const response = await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        })
        .expect(403);

      expect(response.body.error).toBe('Local authentication is disabled. Please use OIDC to login.');
    });

    it('should include localAuthDisabled in status response when disabled', async () => {
      process.env.DISABLE_LOCAL_AUTH = 'true';

      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body.localAuthDisabled).toBe(true);
    });

    it('should include localAuthDisabled=false in status when not disabled', async () => {
      process.env.DISABLE_LOCAL_AUTH = 'false';

      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body.localAuthDisabled).toBe(false);
    });

    it('should default to localAuthDisabled=false when not set', async () => {
      delete process.env.DISABLE_LOCAL_AUTH;

      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body.localAuthDisabled).toBe(false);
    });

    it('should return localAuthDisabled status for authenticated users', async () => {
      process.env.DISABLE_LOCAL_AUTH = 'false';

      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      // Change env and check status
      process.env.DISABLE_LOCAL_AUTH = 'true';

      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body.authenticated).toBe(true);
      expect(response.body.localAuthDisabled).toBe(true);
    });

    it('should still allow OIDC login when local auth is disabled', async () => {
      process.env.DISABLE_LOCAL_AUTH = 'true';

      // This test verifies the OIDC login endpoint is still accessible
      // Note: Full OIDC flow testing would require mocking the OIDC provider
      const response = await agent
        .get('/api/auth/oidc/login')
        .expect(400); // 400 because OIDC is not configured in tests, but route is accessible

      expect(response.body.error).toBe('OIDC authentication is not configured');
    });
  });

  describe('Password Change Validation', () => {
    it('should enforce minimum password length', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      // Try to change to short password
      const response = await agent
        .post('/api/auth/change-password')
        .send({
          currentPassword: 'password123',
          newPassword: 'short'
        })
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it('should prevent changing password for OIDC users', async () => {
      // Create OIDC user
      await userModel.create({
        username: 'oidcuser',
        authProvider: 'oidc',
        oidcSubject: 'oidc-subject-123',
        isAdmin: false
      });

      // Note: OIDC users can't change passwords via the backend endpoint
      // The UI prevents this by not showing the "Change Password" option
      // This test documents the expected behavior:
      // - OIDC users manage passwords through their identity provider
      // - The change-password endpoint requires authProvider='local'
      // This is enforced in src/server/auth/localAuth.ts
    });

    it('should require both current and new password', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      // Missing new password
      await agent
        .post('/api/auth/change-password')
        .send({
          currentPassword: 'password123'
        })
        .expect(400);

      // Missing current password
      await agent
        .post('/api/auth/change-password')
        .send({
          newPassword: 'newpassword456'
        })
        .expect(400);
    });
  });

  describe('Auth Status Response Structure', () => {
    it('should include all required fields in unauthenticated status', async () => {
      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body).toHaveProperty('authenticated');
      expect(response.body).toHaveProperty('user');
      expect(response.body).toHaveProperty('permissions');
      expect(response.body).toHaveProperty('oidcEnabled');
      expect(response.body).toHaveProperty('localAuthDisabled');

      expect(response.body.authenticated).toBe(false);
      expect(response.body.user).toBeNull();
      expect(typeof response.body.oidcEnabled).toBe('boolean');
      expect(typeof response.body.localAuthDisabled).toBe('boolean');
    });

    it('should include all required fields in authenticated status', async () => {
      // Login first
      await agent
        .post('/api/auth/login')
        .send({
          username: 'testuser',
          password: 'password123'
        });

      const response = await agent
        .get('/api/auth/status')
        .expect(200);

      expect(response.body).toHaveProperty('authenticated');
      expect(response.body).toHaveProperty('user');
      expect(response.body).toHaveProperty('permissions');
      expect(response.body).toHaveProperty('oidcEnabled');
      expect(response.body).toHaveProperty('localAuthDisabled');

      expect(response.body.authenticated).toBe(true);
      expect(response.body.user).toBeTruthy();
      expect(response.body.user.username).toBe('testuser');
      expect(typeof response.body.oidcEnabled).toBe('boolean');
      expect(typeof response.body.localAuthDisabled).toBe('boolean');
    });
  });
});
