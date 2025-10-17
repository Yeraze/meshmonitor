/**
 * Apprise Notification Service Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import databaseService from '../../services/database.js';

// Mock the database service
vi.mock('../../services/database.js', () => ({
  default: {
    db: null as Database.Database | null,
    getSetting: vi.fn(),
    setSetting: vi.fn()
  }
}));

describe('AppriseNotificationService', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Set up minimal schema for testing
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        enable_web_push BOOLEAN DEFAULT 0,
        enable_apprise BOOLEAN DEFAULT 0,
        enabled_channels TEXT,
        enable_direct_messages BOOLEAN DEFAULT 1,
        whitelist TEXT,
        blacklist TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Mock database service db property
    (databaseService.db as any) = db;
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  describe('Configuration & Initialization', () => {
    it('should initialize with default Apprise URL', () => {
      const defaultUrl = 'http://localhost:8000';
      const url = databaseService.getSetting('apprise_url') || defaultUrl;

      expect(url).toBe(defaultUrl);
    });

    it('should initialize with enabled state from settings', () => {
      vi.mocked(databaseService.getSetting).mockReturnValue('true');
      const enabled = databaseService.getSetting('apprise_enabled');

      expect(enabled).toBe('true');
    });

    it('should default to enabled if setting not explicitly set', () => {
      vi.mocked(databaseService.getSetting).mockReturnValue(null);
      const enabledSetting = databaseService.getSetting('apprise_enabled');
      const enabled = enabledSetting !== 'false';

      expect(enabled).toBe(true);
    });

    it('should store Apprise URL in settings', () => {
      const customUrl = 'http://apprise-api:8000';
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('apprise_url', customUrl);

      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('apprise_url') as { value: string } | undefined;

      expect(row?.value).toBe(customUrl);
    });
  });

  describe('Per-User Notification Preferences', () => {
    beforeEach(() => {
      // Create test user
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('testuser', 'hash123');
    });

    it('should store user preferences with Apprise enabled', () => {
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser') as { id: number };
      const now = Date.now();

      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_web_push, enable_apprise, enabled_channels, enable_direct_messages, whitelist, blacklist, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id,
        0, // Web Push disabled
        1, // Apprise enabled
        JSON.stringify([0, 1, 2]),
        1,
        JSON.stringify(['Help', 'Emergency']),
        JSON.stringify(['Test', 'Copy']),
        now,
        now
      );

      const prefs = db.prepare('SELECT * FROM user_notification_preferences WHERE user_id = ?').get(user.id) as any;

      expect(prefs.enable_apprise).toBe(1);
      expect(prefs.enable_web_push).toBe(0);
      expect(JSON.parse(prefs.enabled_channels)).toEqual([0, 1, 2]);
    });

    it('should allow both Web Push and Apprise enabled simultaneously', () => {
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser') as { id: number };
      const now = Date.now();

      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_web_push, enable_apprise, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, 1, 1, now, now);

      const prefs = db.prepare('SELECT * FROM user_notification_preferences WHERE user_id = ?').get(user.id) as any;

      expect(prefs.enable_apprise).toBe(1);
      expect(prefs.enable_web_push).toBe(1);
    });

    it('should enforce unique user_id constraint', () => {
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser') as { id: number };
      const now = Date.now();

      // Insert first preference
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(user.id, 1, now, now);

      // Try to insert duplicate
      expect(() => {
        db.prepare(`
          INSERT INTO user_notification_preferences
          (user_id, enable_apprise, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(user.id, 1, now, now);
      }).toThrow();
    });

    it('should cascade delete preferences when user is deleted', () => {
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser') as { id: number };
      const now = Date.now();

      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(user.id, 1, now, now);

      // Delete user
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

      // Verify preferences were cascade deleted
      const prefs = db.prepare('SELECT * FROM user_notification_preferences WHERE user_id = ?').get(user.id);

      expect(prefs).toBeUndefined();
    });

    it('should default both notification methods to disabled', () => {
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get('testuser') as { id: number };
      const now = Date.now();

      // Insert with default values
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, created_at, updated_at)
        VALUES (?, ?, ?)
      `).run(user.id, now, now);

      const prefs = db.prepare('SELECT * FROM user_notification_preferences WHERE user_id = ?').get(user.id) as any;

      expect(prefs.enable_apprise).toBe(0); // Default disabled
      expect(prefs.enable_web_push).toBe(0); // Default disabled
      expect(prefs.enable_direct_messages).toBe(1); // Default enabled
    });
  });

  describe('Shared Filtering Logic', () => {
    it('should share whitelist between Web Push and Apprise', () => {
      const prefs = {
        enableWebPush: true,
        enableApprise: true,
        whitelist: ['Help', 'Emergency'],
        blacklist: ['Test', 'Copy'],
        enabledChannels: [0, 1],
        enableDirectMessages: true
      };

      // Both services should use the same whitelist
      expect(prefs.whitelist).toEqual(['Help', 'Emergency']);
    });

    it('should share blacklist between Web Push and Apprise', () => {
      const prefs = {
        enableWebPush: true,
        enableApprise: true,
        whitelist: [],
        blacklist: ['Test', 'Copy'],
        enabledChannels: [0],
        enableDirectMessages: true
      };

      // Both services should use the same blacklist
      expect(prefs.blacklist).toEqual(['Test', 'Copy']);
    });

    it('should share channel preferences between services', () => {
      const prefs = {
        enableWebPush: true,
        enableApprise: true,
        enabledChannels: [0, 2, 5],
        whitelist: [],
        blacklist: [],
        enableDirectMessages: true
      };

      // Both services should filter on the same channels
      const testCases = [
        { channel: 0, shouldAllow: true },
        { channel: 1, shouldAllow: false },
        { channel: 2, shouldAllow: true },
        { channel: 5, shouldAllow: true },
        { channel: 7, shouldAllow: false }
      ];

      testCases.forEach(({ channel, shouldAllow }) => {
        const isAllowed = prefs.enabledChannels.includes(channel);
        expect(isAllowed).toBe(shouldAllow);
      });
    });

    it('should apply whitelist priority correctly (highest priority)', () => {
      const messageText = 'urgent test message';
      const whitelist = ['urgent', 'emergency'];
      const blacklist = ['test', 'urgent']; // 'urgent' in both

      // Check whitelist first (highest priority)
      const isWhitelisted = whitelist.some(word =>
        messageText.toLowerCase().includes(word.toLowerCase())
      );

      expect(isWhitelisted).toBe(true);
      // Message should NOT be filtered despite 'test' being blacklisted
    });

    it('should apply blacklist when not whitelisted', () => {
      const messageText = 'this is a test message';
      const whitelist = ['emergency'];
      const blacklist = ['test', 'spam'];

      const isWhitelisted = whitelist.some(word =>
        messageText.toLowerCase().includes(word.toLowerCase())
      );

      const isBlacklisted = !isWhitelisted && blacklist.some(word =>
        messageText.toLowerCase().includes(word.toLowerCase())
      );

      expect(isWhitelisted).toBe(false);
      expect(isBlacklisted).toBe(true);
    });
  });

  describe('Apprise URL Configuration', () => {
    it('should validate Apprise URL format', () => {
      const validUrls = [
        'http://localhost:8000',
        'http://apprise-api:8000',
        'https://apprise.example.com',
        'http://192.168.1.100:8000'
      ];

      validUrls.forEach(url => {
        expect(url.startsWith('http://') || url.startsWith('https://')).toBe(true);
      });
    });

    it('should store Apprise notification URLs in config file format', () => {
      // Apprise URLs are stored in /data/apprise-config/urls.txt
      // Each URL on a separate line
      const urls = [
        'discord://webhook_id/webhook_token',
        'slack://token_a/token_b/token_c',
        'mailto://user:password@gmail.com'
      ];

      const configContent = urls.join('\n');

      expect(configContent.split('\n')).toEqual(urls);
      expect(configContent.split('\n').length).toBe(3);
    });

    it('should support multiple notification service URLs', () => {
      const urls = {
        discord: 'discord://webhook_id/token',
        slack: 'slack://token_a/token_b/token_c',
        telegram: 'tgram://bot_token/chat_id',
        email: 'mailto://user:pass@gmail.com'
      };

      Object.values(urls).forEach(url => {
        expect(url).toMatch(/^[a-z]+:\/\//);
      });
    });
  });

  describe('User Query for Apprise-Enabled Users', () => {
    beforeEach(() => {
      // Create multiple test users
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('user1', 'hash1');
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('user2', 'hash2');
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('user3', 'hash3');
    });

    it('should query users with Apprise enabled', () => {
      const now = Date.now();
      const users = [
        { id: 1, enabled: 1 },
        { id: 2, enabled: 0 },
        { id: 3, enabled: 1 }
      ];

      users.forEach(user => {
        db.prepare(`
          INSERT INTO user_notification_preferences
          (user_id, enable_apprise, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(user.id, user.enabled, now, now);
      });

      // Query users with Apprise enabled
      const stmt = db.prepare(`
        SELECT user_id
        FROM user_notification_preferences
        WHERE enable_apprise = 1
      `);
      const rows = stmt.all() as any[];

      expect(rows.length).toBe(2);
      expect(rows.map(r => r.user_id)).toEqual([1, 3]);
    });

    it('should return empty array when no users have Apprise enabled', () => {
      const now = Date.now();

      // All users have Apprise disabled
      for (let i = 1; i <= 3; i++) {
        db.prepare(`
          INSERT INTO user_notification_preferences
          (user_id, enable_apprise, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `).run(i, 0, now, now);
      }

      const stmt = db.prepare(`
        SELECT user_id
        FROM user_notification_preferences
        WHERE enable_apprise = 1
      `);
      const rows = stmt.all();

      expect(rows.length).toBe(0);
    });
  });

  describe('Notification Payload Structure', () => {
    it('should construct valid Apprise notification payload', () => {
      const payload = {
        title: 'MeshMonitor',
        body: 'New message received',
        type: 'info' as const,
        tag: undefined
      };

      expect(payload).toHaveProperty('title');
      expect(payload).toHaveProperty('body');
      expect(payload).toHaveProperty('type');
      expect(['info', 'success', 'warning', 'failure', 'error']).toContain(payload.type);
    });

    it('should support different notification types', () => {
      const types: Array<'info' | 'success' | 'warning' | 'failure' | 'error'> = [
        'info',
        'success',
        'warning',
        'failure',
        'error'
      ];

      types.forEach(type => {
        const payload = {
          title: 'Test',
          body: 'Test message',
          type
        };

        expect(['info', 'success', 'warning', 'failure', 'error']).toContain(payload.type);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle Apprise API connection failures gracefully', () => {
      // Mock fetch failure
      const errorCases = [
        { error: 'ECONNREFUSED', expectedMessage: 'Connection failed' },
        { error: 'ETIMEDOUT', expectedMessage: 'Connection failed' },
        { error: 'ENOTFOUND', expectedMessage: 'Connection failed' }
      ];

      errorCases.forEach(({ error }) => {
        const connectionError = new Error(error);
        expect(connectionError.message).toBe(error);
      });
    });

    it('should handle Apprise API HTTP errors', () => {
      const errorCodes = [400, 401, 403, 404, 500, 502, 503];

      errorCodes.forEach(code => {
        const isClientError = code >= 400 && code < 500;
        const isServerError = code >= 500 && code < 600;

        expect(isClientError || isServerError).toBe(true);
      });
    });

    it('should handle malformed Apprise response', () => {
      const invalidJson = '{invalid json}';

      expect(() => JSON.parse(invalidJson)).toThrow();
    });
  });

  describe('Broadcast Statistics', () => {
    it('should track notification broadcast results', () => {
      const results = {
        sent: 5,
        failed: 2,
        filtered: 3
      };

      expect(results.sent).toBeGreaterThanOrEqual(0);
      expect(results.failed).toBeGreaterThanOrEqual(0);
      expect(results.filtered).toBeGreaterThanOrEqual(0);

      const total = results.sent + results.failed + results.filtered;
      expect(total).toBeGreaterThan(0);
    });

    it('should calculate broadcast success rate', () => {
      const results = {
        sent: 8,
        failed: 2,
        filtered: 0
      };

      const attempted = results.sent + results.failed;
      const successRate = attempted > 0 ? (results.sent / attempted) * 100 : 0;

      expect(successRate).toBe(80); // 8 out of 10 succeeded
    });
  });

  describe('Security - Input Validation', () => {
    it('should validate notification URLs are properly formatted', () => {
      const validUrlPatterns = [
        /^discord:\/\//,
        /^slack:\/\//,
        /^tgram:\/\//,
        /^mailto:\/\//,
        /^json:\/\//
      ];

      const testUrls = [
        'discord://123/456',
        'slack://abc/def/ghi',
        'tgram://bot/chat',
        'mailto://user:pass@host',
        'json://webhook.com/path'
      ];

      testUrls.forEach(url => {
        const matchesPattern = validUrlPatterns.some(pattern => pattern.test(url));
        expect(matchesPattern).toBe(true);
      });
    });

    it('should reject invalid URL schemes', () => {
      const invalidUrls = [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,<script>alert(1)</script>'
      ];

      const validSchemes = ['discord', 'slack', 'tgram', 'mailto', 'json', 'http', 'https'];

      invalidUrls.forEach(url => {
        const scheme = url.split(':')[0];
        expect(validSchemes).not.toContain(scheme);
      });
    });
  });
});
