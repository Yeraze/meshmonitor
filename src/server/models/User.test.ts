/**
 * User Model Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { UserModel } from './User.js';
import { migration as authMigration } from '../migrations/001_add_auth_tables.js';
import { migration as passwordLockedMigration } from '../migrations/023_add_password_locked_flag.js';

describe('UserModel', () => {
  let db: Database.Database;
  let userModel: UserModel;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Run migrations
    authMigration.up(db);
    passwordLockedMigration.up(db);

    // Create model instance
    userModel = new UserModel(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Password Hashing', () => {
    it('should hash passwords', async () => {
      const password = 'testpassword123';
      const hash = await userModel.hashPassword(password);

      expect(hash).toBeTruthy();
      expect(hash).not.toBe(password);
      expect(hash.length).toBeGreaterThan(50); // bcrypt hashes are long
    });

    it('should verify correct passwords', async () => {
      const password = 'testpassword123';
      const hash = await userModel.hashPassword(password);

      const isValid = await userModel.verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect passwords', async () => {
      const password = 'testpassword123';
      const hash = await userModel.hashPassword(password);

      const isValid = await userModel.verifyPassword('wrongpassword', hash);
      expect(isValid).toBe(false);
    });
  });

  describe('User Creation', () => {
    it('should create a local auth user', async () => {
      const user = await userModel.create({
        username: 'testuser',
        password: 'password123',
        authProvider: 'local',
        email: 'test@example.com',
        displayName: 'Test User'
      });

      expect(user.id).toBeGreaterThan(0);
      expect(user.username).toBe('testuser');
      expect(user.email).toBe('test@example.com');
      expect(user.displayName).toBe('Test User');
      expect(user.authProvider).toBe('local');
      expect(user.passwordHash).toBeTruthy();
      expect(user.isAdmin).toBe(false);
      expect(user.isActive).toBe(true);
    });

    it('should create an OIDC user', async () => {
      const user = await userModel.create({
        username: 'oidcuser',
        authProvider: 'oidc',
        oidcSubject: 'google-oauth2|123456',
        email: 'oidc@example.com'
      });

      expect(user.id).toBeGreaterThan(0);
      expect(user.username).toBe('oidcuser');
      expect(user.authProvider).toBe('oidc');
      expect(user.oidcSubject).toBe('google-oauth2|123456');
      expect(user.passwordHash).toBeNull();
    });

    it('should create an admin user', async () => {
      const user = await userModel.create({
        username: 'admin',
        password: 'admin123',
        authProvider: 'local',
        isAdmin: true
      });

      expect(user.isAdmin).toBe(true);
    });
  });

  describe('User Retrieval', () => {
    it('should find user by ID', async () => {
      const created = await userModel.create({
        username: 'findme',
        password: 'pass123',
        authProvider: 'local'
      });

      const found = userModel.findById(created.id);
      expect(found).toBeTruthy();
      expect(found?.username).toBe('findme');
    });

    it('should find user by username', async () => {
      await userModel.create({
        username: 'uniqueuser',
        password: 'pass123',
        authProvider: 'local'
      });

      const found = userModel.findByUsername('uniqueuser');
      expect(found).toBeTruthy();
      expect(found?.username).toBe('uniqueuser');
    });

    it('should find user by OIDC subject', async () => {
      await userModel.create({
        username: 'oidcuser',
        authProvider: 'oidc',
        oidcSubject: 'auth0|12345'
      });

      const found = userModel.findByOIDCSubject('auth0|12345');
      expect(found).toBeTruthy();
      expect(found?.username).toBe('oidcuser');
    });

    it('should return null for non-existent users', () => {
      const found = userModel.findById(9999);
      expect(found).toBeNull();
    });
  });

  describe('User Authentication', () => {
    it('should authenticate valid credentials', async () => {
      await userModel.create({
        username: 'authuser',
        password: 'correctpassword',
        authProvider: 'local'
      });

      const user = await userModel.authenticate('authuser', 'correctpassword');
      expect(user).toBeTruthy();
      expect(user?.username).toBe('authuser');
    });

    it('should reject invalid credentials', async () => {
      await userModel.create({
        username: 'authuser',
        password: 'correctpassword',
        authProvider: 'local'
      });

      const user = await userModel.authenticate('authuser', 'wrongpassword');
      expect(user).toBeNull();
    });

    it('should not authenticate inactive users', async () => {
      const created = await userModel.create({
        username: 'inactiveuser',
        password: 'password123',
        authProvider: 'local'
      });

      // Deactivate user
      userModel.update(created.id, { isActive: false });

      const user = await userModel.authenticate('inactiveuser', 'password123');
      expect(user).toBeNull();
    });
  });

  describe('User Updates', () => {
    it('should update user information', async () => {
      const created = await userModel.create({
        username: 'updateme',
        password: 'pass123',
        authProvider: 'local'
      });

      const updated = userModel.update(created.id, {
        email: 'newemail@example.com',
        displayName: 'Updated Name'
      });

      expect(updated?.email).toBe('newemail@example.com');
      expect(updated?.displayName).toBe('Updated Name');
    });

    it('should update password', async () => {
      const created = await userModel.create({
        username: 'passchange',
        password: 'oldpassword',
        authProvider: 'local'
      });

      await userModel.updatePassword(created.id, 'newpassword');

      const user = await userModel.authenticate('passchange', 'newpassword');
      expect(user).toBeTruthy();
    });

    it('should update admin status', async () => {
      const created = await userModel.create({
        username: 'promote',
        password: 'pass123',
        authProvider: 'local'
      });

      expect(created.isAdmin).toBe(false);

      const updated = userModel.updateAdminStatus(created.id, true);
      expect(updated?.isAdmin).toBe(true);
    });
  });

  describe('User Queries', () => {
    it('should check if users exist', async () => {
      expect(userModel.hasUsers()).toBe(false);

      await userModel.create({
        username: 'firstuser',
        password: 'pass123',
        authProvider: 'local'
      });

      expect(userModel.hasUsers()).toBe(true);
    });

    it('should check if admin users exist', async () => {
      expect(userModel.hasAdminUser()).toBe(false);

      await userModel.create({
        username: 'regularuser',
        password: 'pass123',
        authProvider: 'local',
        isAdmin: false
      });

      expect(userModel.hasAdminUser()).toBe(false);

      await userModel.create({
        username: 'admin',
        password: 'pass123',
        authProvider: 'local',
        isAdmin: true
      });

      expect(userModel.hasAdminUser()).toBe(true);
    });

    it('should get all users', async () => {
      await userModel.create({
        username: 'user1',
        password: 'pass123',
        authProvider: 'local'
      });

      await userModel.create({
        username: 'user2',
        password: 'pass123',
        authProvider: 'local'
      });

      const users = userModel.findAll();
      expect(users.length).toBe(2);
    });
  });

  describe('User Deletion', () => {
    it('should deactivate users', async () => {
      const created = await userModel.create({
        username: 'deleteme',
        password: 'pass123',
        authProvider: 'local'
      });

      userModel.delete(created.id);

      const user = userModel.findById(created.id);
      expect(user?.isActive).toBe(false);
    });

    it('should hard delete users', async () => {
      const created = await userModel.create({
        username: 'harddelete',
        password: 'pass123',
        authProvider: 'local'
      });

      userModel.hardDelete(created.id);

      const user = userModel.findById(created.id);
      expect(user).toBeNull();
    });
  });
});
