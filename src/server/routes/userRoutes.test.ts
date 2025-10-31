/**
 * User Management Routes Integration Tests
 *
 * Tests admin-only user management endpoints and permission boundaries
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';
import { UserModel } from '../models/User.js';
import { PermissionModel } from '../models/Permission.js';
import { migration as authMigration } from '../migrations/001_add_auth_tables.js';
import { migration as channelsMigration } from '../migrations/002_add_channels_permission.js';
import { migration as connectionMigration } from '../migrations/003_add_connection_permission.js';
import { migration as tracerouteMigration } from '../migrations/004_add_traceroute_permission.js';
import { migration as auditPermissionMigration } from '../migrations/006_add_audit_permission.js';
import { migration as securityPermissionMigration } from '../migrations/016_add_security_permission.js';
import userRoutes from './userRoutes.js';
import authRoutes from './authRoutes.js';

// Mock the DatabaseService to prevent auto-initialization
vi.mock('../../services/database.js', () => ({
  default: {}
}));

import DatabaseService from '../../services/database.js';

describe('User Management Routes', () => {
  let app: Express;
  let db: Database.Database;
  let userModel: UserModel;
  let permissionModel: PermissionModel;
  let adminAgent: any;
  let userAgent: any;

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
    channelsMigration.up(db);
    connectionMigration.up(db);
    tracerouteMigration.up(db);
    auditPermissionMigration.up(db);
    securityPermissionMigration.up(db);

    userModel = new UserModel(db);
    permissionModel = new PermissionModel(db);

    // Mock database service
    (DatabaseService as any).userModel = userModel;
    (DatabaseService as any).permissionModel = permissionModel;
    (DatabaseService as any).auditLog = () => {};

    app.use('/api/auth', authRoutes);
    app.use('/api/users', userRoutes);
  });

  beforeEach(async () => {
    // Clear tables
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM permissions').run();

    // Create admin user
    const admin = await userModel.create({
      username: 'admin',
      password: 'admin123',
      email: 'admin@example.com',
      authProvider: 'local',
      isAdmin: true
    });
    permissionModel.grantDefaultPermissions(admin.id, true);

    // Create regular user
    const user = await userModel.create({
      username: 'user',
      password: 'user123',
      email: 'user@example.com',
      authProvider: 'local',
      isAdmin: false
    });
    permissionModel.grantDefaultPermissions(user.id, false);

    // Create authenticated agents
    adminAgent = request.agent(app);
    await adminAgent
      .post('/api/auth/login')
      .send({ username: 'admin', password: 'admin123' });

    userAgent = request.agent(app);
    await userAgent
      .post('/api/auth/login')
      .send({ username: 'user', password: 'user123' });
  });

  describe('GET /api/users', () => {
    it('should allow admin to list all users', async () => {
      const response = await adminAgent
        .get('/api/users')
        .expect(200);

      expect(response.body.users).toBeDefined();
      expect(response.body.users.length).toBeGreaterThan(0);
      expect(response.body.users[0].passwordHash).toBeUndefined();
    });

    it('should deny regular user access', async () => {
      await userAgent
        .get('/api/users')
        .expect(403);
    });

    it('should deny unauthenticated access', async () => {
      await request(app)
        .get('/api/users')
        .expect(401);
    });
  });

  describe('GET /api/users/:id', () => {
    it('should allow admin to get user by ID', async () => {
      const users = userModel.findAll();
      const userId = users[0].id;

      const response = await adminAgent
        .get(`/api/users/${userId}`)
        .expect(200);

      expect(response.body.user).toBeDefined();
      expect(response.body.user.id).toBe(userId);
      expect(response.body.user.passwordHash).toBeUndefined();
    });

    it('should deny regular user access', async () => {
      const users = userModel.findAll();
      const userId = users[0].id;

      await userAgent
        .get(`/api/users/${userId}`)
        .expect(403);
    });

    it('should return 404 for non-existent user', async () => {
      await adminAgent
        .get('/api/users/99999')
        .expect(404);
    });

    it('should return 400 for invalid user ID', async () => {
      await adminAgent
        .get('/api/users/invalid')
        .expect(400);
    });
  });

  describe('POST /api/users', () => {
    it('should allow admin to create new local user', async () => {
      const response = await adminAgent
        .post('/api/users')
        .send({
          username: 'newuser',
          password: 'newpassword123',
          email: 'newuser@example.com',
          displayName: 'New User',
          isAdmin: false
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.user.username).toBe('newuser');
      expect(response.body.user.passwordHash).toBeUndefined();
    });

    it('should deny regular user from creating users', async () => {
      await userAgent
        .post('/api/users')
        .send({
          username: 'newuser',
          password: 'newpassword123'
        })
        .expect(403);
    });

    it('should reject user creation with missing required fields', async () => {
      await adminAgent
        .post('/api/users')
        .send({
          username: 'newuser'
          // Missing password
        })
        .expect(400);
    });

    it('should reject user creation with duplicate username', async () => {
      await adminAgent
        .post('/api/users')
        .send({
          username: 'admin', // Already exists
          password: 'password123'
        })
        .expect(400);
    });
  });

  describe('PUT /api/users/:id', () => {
    it('should allow admin to update user', async () => {
      const users = userModel.findAll();
      const userId = users.find(u => u.username === 'user')!.id;

      const response = await adminAgent
        .put(`/api/users/${userId}`)
        .send({
          email: 'newemail@example.com',
          displayName: 'Updated Name'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.user.email).toBe('newemail@example.com');
      expect(response.body.user.displayName).toBe('Updated Name');
    });

    it('should deny regular user from updating users', async () => {
      const users = userModel.findAll();
      const userId = users[0].id;

      await userAgent
        .put(`/api/users/${userId}`)
        .send({ email: 'newemail@example.com' })
        .expect(403);
    });

    it('should return 404 for non-existent user', async () => {
      await adminAgent
        .put('/api/users/99999')
        .send({ email: 'newemail@example.com' })
        .expect(404);
    });
  });

  describe('DELETE /api/users/:id', () => {
    it('should allow admin to deactivate user', async () => {
      const users = userModel.findAll();
      const userId = users.find(u => u.username === 'user')!.id;

      const response = await adminAgent
        .delete(`/api/users/${userId}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify user is deactivated
      const user = userModel.findById(userId);
      expect(user?.isActive).toBe(false);
    });

    it('should prevent admin from deleting themselves', async () => {
      const users = userModel.findAll();
      const adminId = users.find(u => u.username === 'admin')!.id;

      await adminAgent
        .delete(`/api/users/${adminId}`)
        .expect(400);
    });

    it('should deny regular user from deleting users', async () => {
      const users = userModel.findAll();
      const userId = users[0].id;

      await userAgent
        .delete(`/api/users/${userId}`)
        .expect(403);
    });
  });

  describe('PUT /api/users/:id/admin', () => {
    it('should allow admin to promote user to admin', async () => {
      const users = userModel.findAll();
      const userId = users.find(u => u.username === 'user')!.id;

      const response = await adminAgent
        .put(`/api/users/${userId}/admin`)
        .send({ isAdmin: true })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify user is now admin
      const user = userModel.findById(userId);
      expect(user?.isAdmin).toBe(true);
    });

    it('should allow admin to demote user from admin', async () => {
      // First create another admin
      const newAdmin = await userModel.create({
        username: 'admin2',
        password: 'admin123',
        authProvider: 'local',
        isAdmin: true
      });

      const response = await adminAgent
        .put(`/api/users/${newAdmin.id}/admin`)
        .send({ isAdmin: false })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify user is no longer admin
      const user = userModel.findById(newAdmin.id);
      expect(user?.isAdmin).toBe(false);
    });

    it('should prevent admin from removing own admin status', async () => {
      const users = userModel.findAll();
      const adminId = users.find(u => u.username === 'admin')!.id;

      await adminAgent
        .put(`/api/users/${adminId}/admin`)
        .send({ isAdmin: false })
        .expect(400);
    });

    it('should deny regular user from changing admin status', async () => {
      const users = userModel.findAll();
      const userId = users[0].id;

      await userAgent
        .put(`/api/users/${userId}/admin`)
        .send({ isAdmin: true })
        .expect(403);
    });

    it('should reject invalid isAdmin value', async () => {
      const users = userModel.findAll();
      const userId = users.find(u => u.username === 'user')!.id;

      await adminAgent
        .put(`/api/users/${userId}/admin`)
        .send({ isAdmin: 'yes' })
        .expect(400);
    });
  });

  describe('POST /api/users/:id/reset-password', () => {
    it('should allow admin to reset user password', async () => {
      const users = userModel.findAll();
      const userId = users.find(u => u.username === 'user')!.id;

      const response = await adminAgent
        .post(`/api/users/${userId}/reset-password`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.password).toBeDefined();
      expect(response.body.password.length).toBeGreaterThan(0);
    });

    it('should deny regular user from resetting passwords', async () => {
      const users = userModel.findAll();
      const userId = users[0].id;

      await userAgent
        .post(`/api/users/${userId}/reset-password`)
        .expect(403);
    });

    it('should reject password reset for OIDC users', async () => {
      // Create OIDC user
      const oidcUser = await userModel.create({
        username: 'oidcuser',
        authProvider: 'oidc',
        oidcSubject: 'sub123',
        isAdmin: false
      });

      await adminAgent
        .post(`/api/users/${oidcUser.id}/reset-password`)
        .expect(400);
    });
  });

  describe('GET /api/users/:id/permissions', () => {
    it('should allow admin to view user permissions', async () => {
      const users = userModel.findAll();
      const userId = users.find(u => u.username === 'user')!.id;

      const response = await adminAgent
        .get(`/api/users/${userId}/permissions`)
        .expect(200);

      expect(response.body.permissions).toBeDefined();
      expect(typeof response.body.permissions).toBe('object');
    });

    it('should deny regular user from viewing permissions', async () => {
      const users = userModel.findAll();
      const userId = users[0].id;

      await userAgent
        .get(`/api/users/${userId}/permissions`)
        .expect(403);
    });
  });

  describe('PUT /api/users/:id/permissions', () => {
    it('should allow admin to update user permissions', async () => {
      const users = userModel.findAll();
      const userId = users.find(u => u.username === 'user')!.id;

      const newPermissions = {
        dashboard: { read: true, write: true },
        nodes: { read: true, write: false },
        messages: { read: false, write: false }
      };

      const response = await adminAgent
        .put(`/api/users/${userId}/permissions`)
        .send({ permissions: newPermissions })
        .expect(200);

      expect(response.body.success).toBe(true);

      // Verify permissions were updated
      const permissionSet = permissionModel.getUserPermissionSet(userId);
      expect(permissionSet.dashboard).toEqual({ read: true, write: true });
      expect(permissionSet.nodes).toEqual({ read: true, write: false });
    });

    it('should deny regular user from updating permissions', async () => {
      const users = userModel.findAll();
      const userId = users[0].id;

      await userAgent
        .put(`/api/users/${userId}/permissions`)
        .send({
          permissions: {
            dashboard: { read: true, write: true }
          }
        })
        .expect(403);
    });

    it('should reject invalid permissions format', async () => {
      const users = userModel.findAll();
      const userId = users.find(u => u.username === 'user')!.id;

      await adminAgent
        .put(`/api/users/${userId}/permissions`)
        .send({ permissions: 'invalid' })
        .expect(400);
    });
  });

  describe('Permission Boundary Tests', () => {
    it('should enforce admin-only access across all endpoints', async () => {
      const endpoints = [
        { method: 'get', path: '/api/users' },
        { method: 'post', path: '/api/users' },
        { method: 'get', path: '/api/users/1' },
        { method: 'put', path: '/api/users/1' },
        { method: 'delete', path: '/api/users/1' },
        { method: 'put', path: '/api/users/1/admin' },
        { method: 'post', path: '/api/users/1/reset-password' },
        { method: 'get', path: '/api/users/1/permissions' },
        { method: 'put', path: '/api/users/1/permissions' }
      ];

      for (const endpoint of endpoints) {
        const response = await (userAgent as any)[endpoint.method](endpoint.path);
        expect(response.status).toBe(403);
      }
    });

    it('should require authentication for all endpoints', async () => {
      const endpoints = [
        { method: 'get', path: '/api/users' },
        { method: 'post', path: '/api/users' },
        { method: 'get', path: '/api/users/1' },
        { method: 'put', path: '/api/users/1' },
        { method: 'delete', path: '/api/users/1' },
        { method: 'put', path: '/api/users/1/admin' },
        { method: 'post', path: '/api/users/1/reset-password' },
        { method: 'get', path: '/api/users/1/permissions' },
        { method: 'put', path: '/api/users/1/permissions' }
      ];

      for (const endpoint of endpoints) {
        const response = await (request(app) as any)[endpoint.method](endpoint.path);
        expect(response.status).toBe(401);
      }
    });
  });
});
