/**
 * Permission Model Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { UserModel } from './User.js';
import { PermissionModel } from './Permission.js';
import { migration as authMigration } from '../migrations/001_add_auth_tables.js';
import { migration as channelsMigration } from '../migrations/002_add_channels_permission.js';
import { migration as connectionMigration } from '../migrations/003_add_connection_permission.js';
import { migration as tracerouteMigration } from '../migrations/004_add_traceroute_permission.js';
import { migration as auditPermissionMigration } from '../migrations/006_add_audit_permission.js';
import { migration as securityPermissionMigration } from '../migrations/016_add_security_permission.js';
import { migration as themesMigration } from '../migrations/022_add_custom_themes.js';
import { migration as passwordLockedMigration } from '../migrations/023_add_password_locked_flag.js';
import { migration as perChannelPermissionsMigration } from '../migrations/024_add_per_channel_permissions.js';
import { migration as nodesPrivatePermissionMigration } from '../migrations/044_add_nodes_private_permission.js';
import { migration as viewOnMapPermissionMigration } from '../migrations/053_add_view_on_map_permission.js';
import { migration as meshcorePermissionMigration } from '../migrations/067_add_meshcore_permission.js';

describe('PermissionModel', () => {
  let db: Database.Database;
  let userModel: UserModel;
  let permissionModel: PermissionModel;
  let testUserId: number;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Run migrations
    authMigration.up(db);
    channelsMigration.up(db);
    connectionMigration.up(db);
    tracerouteMigration.up(db);
    auditPermissionMigration.up(db);
    securityPermissionMigration.up(db);
    themesMigration.up(db);
    passwordLockedMigration.up(db);
    perChannelPermissionsMigration.up(db);
    nodesPrivatePermissionMigration.up(db);
    viewOnMapPermissionMigration.up(db);
    meshcorePermissionMigration.up(db);

    // Create model instances
    userModel = new UserModel(db);
    permissionModel = new PermissionModel(db);

    // Create a test user
    const user = await userModel.create({
      username: 'testuser',
      password: 'password123',
      authProvider: 'local'
    });
    testUserId = user.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('Permission Granting', () => {
    it('should grant a permission to a user', () => {
      const permission = permissionModel.grant({
        userId: testUserId,
        resource: 'dashboard',
        canRead: true,
        canWrite: false
      });

      expect(permission.userId).toBe(testUserId);
      expect(permission.resource).toBe('dashboard');
      expect(permission.canRead).toBe(true);
      expect(permission.canWrite).toBe(false);
    });

    it('should update existing permissions', () => {
      // Grant initial permission
      permissionModel.grant({
        userId: testUserId,
        resource: 'messages',
        canRead: true,
        canWrite: false
      });

      // Update to add write permission
      const updated = permissionModel.grant({
        userId: testUserId,
        resource: 'messages',
        canRead: true,
        canWrite: true
      });

      expect(updated.canRead).toBe(true);
      expect(updated.canWrite).toBe(true);
    });

    it('should grant multiple permissions', () => {
      permissionModel.grant({
        userId: testUserId,
        resource: 'dashboard',
        canRead: true,
        canWrite: false
      });

      permissionModel.grant({
        userId: testUserId,
        resource: 'nodes',
        canRead: true,
        canWrite: true
      });

      const permissions = permissionModel.getUserPermissions(testUserId);
      expect(permissions.length).toBe(2);
    });
  });

  describe('Permission Checking', () => {
    beforeEach(() => {
      permissionModel.grant({
        userId: testUserId,
        resource: 'messages',
        canRead: true,
        canWrite: false
      });
    });

    it('should check read permission', () => {
      const hasRead = permissionModel.check(testUserId, 'messages', 'read');
      expect(hasRead).toBe(true);
    });

    it('should check write permission', () => {
      const hasWrite = permissionModel.check(testUserId, 'messages', 'write');
      expect(hasWrite).toBe(false);
    });

    it('should return false for non-existent permissions', () => {
      const hasRead = permissionModel.check(testUserId, 'configuration', 'read');
      expect(hasRead).toBe(false);
    });
  });

  describe('Permission Retrieval', () => {
    beforeEach(() => {
      permissionModel.grant({
        userId: testUserId,
        resource: 'dashboard',
        canRead: true,
        canWrite: false
      });

      permissionModel.grant({
        userId: testUserId,
        resource: 'nodes',
        canRead: true,
        canWrite: true
      });
    });

    it('should get all user permissions', () => {
      const permissions = permissionModel.getUserPermissions(testUserId);
      expect(permissions.length).toBe(2);
    });

    it('should get user permission set', () => {
      const permissionSet = permissionModel.getUserPermissionSet(testUserId);

      // viewOnMap defaults to false for non-channel resources
      expect(permissionSet.dashboard).toEqual({ viewOnMap: false, read: true, write: false });
      expect(permissionSet.nodes).toEqual({ viewOnMap: false, read: true, write: true });
    });

    it('should find permission by user and resource', () => {
      const permission = permissionModel.findByUserAndResource(testUserId, 'dashboard');

      expect(permission).toBeTruthy();
      expect(permission?.resource).toBe('dashboard');
      expect(permission?.canRead).toBe(true);
    });
  });

  describe('Permission Revocation', () => {
    beforeEach(() => {
      permissionModel.grant({
        userId: testUserId,
        resource: 'messages',
        canRead: true,
        canWrite: true
      });
    });

    it('should revoke a specific permission', () => {
      permissionModel.revoke(testUserId, 'messages');

      const permission = permissionModel.findByUserAndResource(testUserId, 'messages');
      expect(permission).toBeNull();
    });

    it('should revoke all user permissions', () => {
      permissionModel.grant({
        userId: testUserId,
        resource: 'dashboard',
        canRead: true,
        canWrite: false
      });

      permissionModel.grant({
        userId: testUserId,
        resource: 'nodes',
        canRead: true,
        canWrite: true
      });

      permissionModel.revokeAll(testUserId);

      const permissions = permissionModel.getUserPermissions(testUserId);
      expect(permissions.length).toBe(0);
    });
  });

  describe('Default Permissions', () => {
    it('should grant default user permissions', () => {
      permissionModel.grantDefaultPermissions(testUserId, false);

      const permissionSet = permissionModel.getUserPermissionSet(testUserId);

      // Check default read permissions
      expect(permissionSet.dashboard?.read).toBe(true);
      expect(permissionSet.nodes?.read).toBe(true);
      expect(permissionSet.messages?.read).toBe(true);
      expect(permissionSet.info?.read).toBe(true);
      expect(permissionSet.connection?.read).toBe(true);
      expect(permissionSet.traceroute?.read).toBe(true);
      expect(permissionSet.nodes_private?.read).toBe(false);

      // Check default write permissions (should be false)
      expect(permissionSet.dashboard?.write).toBe(false);
      expect(permissionSet.configuration?.read).toBe(false);
      expect(permissionSet.automation?.read).toBe(false);
      expect(permissionSet.connection?.write).toBe(false);
      expect(permissionSet.traceroute?.write).toBe(false);
    });

    it('should grant admin permissions', () => {
      permissionModel.grantDefaultPermissions(testUserId, true);

      const permissionSet = permissionModel.getUserPermissionSet(testUserId);

      // Admins should have all permissions (viewOnMap is false for non-channel resources)
      expect(permissionSet.dashboard).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.nodes).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.messages).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.settings).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.configuration).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.info).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.automation).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.connection).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.traceroute).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.nodes_private).toEqual({ viewOnMap: false, read: true, write: true });
      // Channel permissions have viewOnMap: true
      expect(permissionSet.channel_0).toEqual({ viewOnMap: true, read: true, write: true });
    });
  });

  describe('Batch Permission Updates', () => {
    it('should update multiple permissions at once', () => {
      const newPermissions = {
        dashboard: { read: true, write: true },
        nodes: { read: true, write: false },
        messages: { read: false, write: false }
      };

      permissionModel.updateUserPermissions(testUserId, newPermissions);

      const permissionSet = permissionModel.getUserPermissionSet(testUserId);

      // viewOnMap defaults to false for non-channel resources
      expect(permissionSet.dashboard).toEqual({ viewOnMap: false, read: true, write: true });
      expect(permissionSet.nodes).toEqual({ viewOnMap: false, read: true, write: false });
      expect(permissionSet.messages).toEqual({ viewOnMap: false, read: false, write: false });
    });
  });

  describe('Permission Queries', () => {
    beforeEach(async () => {
      // Create multiple users with different permissions
      const user1 = await userModel.create({
        username: 'user1',
        password: 'pass123',
        authProvider: 'local'
      });

      const user2 = await userModel.create({
        username: 'user2',
        password: 'pass123',
        authProvider: 'local'
      });

      permissionModel.grant({
        userId: user1.id,
        resource: 'messages',
        canRead: true,
        canWrite: false
      });

      permissionModel.grant({
        userId: user2.id,
        resource: 'messages',
        canRead: true,
        canWrite: true
      });
    });

    it('should get users with read permission', () => {
      const userIds = permissionModel.getUsersWithPermission('messages', 'read');
      expect(userIds.length).toBe(2);
    });

    it('should get users with write permission', () => {
      const userIds = permissionModel.getUsersWithPermission('messages', 'write');
      expect(userIds.length).toBe(1);
    });
  });
});
