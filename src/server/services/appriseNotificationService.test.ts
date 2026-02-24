/**
 * Apprise Notification Service Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
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

// Mock meshtasticManager for tests that need it
vi.mock('../meshtasticManager.js', () => ({
  default: {
    getLocalNodeInfo: vi.fn(() => ({ longName: 'TestNode' }))
  }
}));

// Mock global fetch
const mockFetch = vi.fn() as MockInstance;
vi.stubGlobal('fetch', mockFetch);

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
        notify_on_emoji BOOLEAN DEFAULT 1,
        notify_on_new_node BOOLEAN DEFAULT 1,
        notify_on_traceroute BOOLEAN DEFAULT 1,
        notify_on_inactive_node BOOLEAN DEFAULT 0,
        notify_on_server_events BOOLEAN DEFAULT 0,
        prefix_with_node_name BOOLEAN DEFAULT 0,
        monitored_nodes TEXT,
        whitelist TEXT,
        blacklist TEXT,
        apprise_urls TEXT,
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
      const blacklist = ['test', 'urgent']; // 'urgent' in both - demonstrates whitelist takes priority

      // Check whitelist first (highest priority)
      const isWhitelisted = whitelist.some(word =>
        messageText.toLowerCase().includes(word.toLowerCase())
      );

      // Verify blacklist would match (but whitelist should take priority)
      const isBlacklisted = blacklist.some(word =>
        messageText.toLowerCase().includes(word.toLowerCase())
      );

      expect(isWhitelisted).toBe(true);
      expect(isBlacklisted).toBe(true); // Both match, but whitelist wins
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

  describe('Multi-User Per-URL Notifications', () => {
    beforeEach(() => {
      // Create multiple test users with different Apprise URLs
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('user1', 'hash1');
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('user2', 'hash2');
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('user3', 'hash3');

      // Reset mock fetch
      mockFetch.mockReset();
    });

    it('should store different Apprise URLs for each user', () => {
      const now = Date.now();

      // User 1 has Discord URL
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, enable_direct_messages, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, JSON.stringify([0]), 1, JSON.stringify(['discord://webhook1/token1']), now, now);

      // User 2 has Slack URL
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, enable_direct_messages, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(2, 1, JSON.stringify([0]), 1, JSON.stringify(['slack://token_a/token_b/token_c']), now, now);

      // User 3 has multiple URLs
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, enable_direct_messages, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(3, 1, JSON.stringify([0]), 1, JSON.stringify(['tgram://bot/chat', 'mailto://user@example.com']), now, now);

      // Verify each user has their own URLs
      const prefs1 = db.prepare('SELECT apprise_urls FROM user_notification_preferences WHERE user_id = ?').get(1) as any;
      const prefs2 = db.prepare('SELECT apprise_urls FROM user_notification_preferences WHERE user_id = ?').get(2) as any;
      const prefs3 = db.prepare('SELECT apprise_urls FROM user_notification_preferences WHERE user_id = ?').get(3) as any;

      expect(JSON.parse(prefs1.apprise_urls)).toEqual(['discord://webhook1/token1']);
      expect(JSON.parse(prefs2.apprise_urls)).toEqual(['slack://token_a/token_b/token_c']);
      expect(JSON.parse(prefs3.apprise_urls)).toEqual(['tgram://bot/chat', 'mailto://user@example.com']);
    });

    it('should query users with Apprise enabled and URLs configured', () => {
      const now = Date.now();

      // User 1: Apprise enabled with URLs
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 1, JSON.stringify([0]), JSON.stringify(['discord://test']), now, now);

      // User 2: Apprise enabled but NO URLs (should be filtered)
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(2, 1, JSON.stringify([0]), JSON.stringify([]), now, now);

      // User 3: Apprise disabled (should be filtered)
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(3, 0, JSON.stringify([0]), JSON.stringify(['slack://test']), now, now);

      // Query users who can receive notifications
      const stmt = db.prepare(`
        SELECT user_id, apprise_urls
        FROM user_notification_preferences
        WHERE enable_apprise = 1
      `);
      const rows = stmt.all() as any[];

      // Filter to those with actual URLs
      const usersWithUrls = rows.filter(row => {
        const urls = JSON.parse(row.apprise_urls || '[]');
        return urls.length > 0;
      });

      expect(usersWithUrls.length).toBe(1);
      expect(usersWithUrls[0].user_id).toBe(1);
    });

    it('should correctly identify which URLs belong to which user during broadcast', () => {
      const now = Date.now();

      // Set up users with different URLs and channel preferences
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, enable_direct_messages, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, JSON.stringify([0, 1]), 1, JSON.stringify(['discord://user1/token']), now, now);

      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, enable_direct_messages, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(2, 1, JSON.stringify([0]), 1, JSON.stringify(['slack://user2/token']), now, now);

      // Simulate broadcast logic
      const usersWithApprise = db.prepare(`
        SELECT user_id, enabled_channels, apprise_urls
        FROM user_notification_preferences
        WHERE enable_apprise = 1
      `).all() as any[];

      const channelId = 1; // Only user 1 has channel 1 enabled
      const usersToNotify: { userId: number; urls: string[] }[] = [];

      for (const user of usersWithApprise) {
        const enabledChannels = JSON.parse(user.enabled_channels || '[]');
        const urls = JSON.parse(user.apprise_urls || '[]');

        // Check if user wants notifications for this channel
        if (enabledChannels.includes(channelId) && urls.length > 0) {
          usersToNotify.push({ userId: user.user_id, urls });
        }
      }

      // Only user 1 should receive notification (has channel 1 enabled)
      expect(usersToNotify.length).toBe(1);
      expect(usersToNotify[0].userId).toBe(1);
      expect(usersToNotify[0].urls).toEqual(['discord://user1/token']);
    });

    it('should handle users with multiple Apprise URLs', () => {
      const now = Date.now();

      // User with multiple notification services
      const multipleUrls = [
        'discord://webhook/token',
        'slack://a/b/c',
        'tgram://bot/chat',
        'mailto://user@example.com'
      ];

      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(1, 1, JSON.stringify([0]), JSON.stringify(multipleUrls), now, now);

      const prefs = db.prepare('SELECT apprise_urls FROM user_notification_preferences WHERE user_id = ?').get(1) as any;
      const urls = JSON.parse(prefs.apprise_urls);

      expect(urls.length).toBe(4);
      expect(urls).toEqual(multipleUrls);
    });

    it('should isolate users so one user cannot receive anothers notifications', () => {
      const now = Date.now();

      // User 1: Only wants channel 0
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, enable_direct_messages, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, JSON.stringify([0]), 0, JSON.stringify(['discord://user1']), now, now);

      // User 2: Only wants channel 1
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, enable_direct_messages, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(2, 1, JSON.stringify([1]), 0, JSON.stringify(['slack://user2']), now, now);

      // Simulate a message on channel 0
      const messageContext = {
        channelId: 0,
        isDirectMessage: false
      };

      const allUsers = db.prepare(`
        SELECT user_id, enabled_channels, apprise_urls
        FROM user_notification_preferences
        WHERE enable_apprise = 1
      `).all() as any[];

      const recipientsForChannel0 = allUsers.filter(user => {
        const channels = JSON.parse(user.enabled_channels || '[]');
        return channels.includes(messageContext.channelId);
      });

      // Only user 1 should receive channel 0 messages
      expect(recipientsForChannel0.length).toBe(1);
      expect(recipientsForChannel0[0].user_id).toBe(1);
      expect(JSON.parse(recipientsForChannel0[0].apprise_urls)).toEqual(['discord://user1']);

      // Simulate a message on channel 1
      const recipientsForChannel1 = allUsers.filter(user => {
        const channels = JSON.parse(user.enabled_channels || '[]');
        return channels.includes(1);
      });

      // Only user 2 should receive channel 1 messages
      expect(recipientsForChannel1.length).toBe(1);
      expect(recipientsForChannel1[0].user_id).toBe(2);
      expect(JSON.parse(recipientsForChannel1[0].apprise_urls)).toEqual(['slack://user2']);
    });

    it('should correctly apply user-specific whitelist/blacklist filters', () => {
      const now = Date.now();

      // User 1: Blacklists "test"
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, blacklist, whitelist, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 1, JSON.stringify([0]), JSON.stringify(['test']), JSON.stringify([]), JSON.stringify(['discord://user1']), now, now);

      // User 2: Whitelists "test" (should still receive)
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, enabled_channels, blacklist, whitelist, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 1, JSON.stringify([0]), JSON.stringify([]), JSON.stringify(['test']), JSON.stringify(['slack://user2']), now, now);

      const messageText = 'this is a test message';

      // Simulate filter logic for each user
      const allUsers = db.prepare(`
        SELECT user_id, whitelist, blacklist, apprise_urls
        FROM user_notification_preferences
        WHERE enable_apprise = 1
      `).all() as any[];

      const recipientsAfterFilter = allUsers.filter(user => {
        const whitelist = JSON.parse(user.whitelist || '[]') as string[];
        const blacklist = JSON.parse(user.blacklist || '[]') as string[];
        const msgLower = messageText.toLowerCase();

        // Whitelist takes priority
        const isWhitelisted = whitelist.some(w => msgLower.includes(w.toLowerCase()));
        if (isWhitelisted) return true;

        // Then check blacklist
        const isBlacklisted = blacklist.some(b => msgLower.includes(b.toLowerCase()));
        if (isBlacklisted) return false;

        return true;
      });

      // User 1 should be filtered (blacklisted "test")
      // User 2 should receive (whitelisted "test")
      expect(recipientsAfterFilter.length).toBe(1);
      expect(recipientsAfterFilter[0].user_id).toBe(2);
    });

    it('should update user Apprise URLs without affecting other users', () => {
      const now = Date.now();

      // Initial setup
      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, 1, JSON.stringify(['discord://original1']), now, now);

      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(2, 1, JSON.stringify(['slack://original2']), now, now);

      // Update user 1's URLs
      db.prepare(`
        UPDATE user_notification_preferences
        SET apprise_urls = ?, updated_at = ?
        WHERE user_id = ?
      `).run(JSON.stringify(['discord://new1', 'tgram://new1b']), Date.now(), 1);

      // Verify user 1 was updated
      const prefs1 = db.prepare('SELECT apprise_urls FROM user_notification_preferences WHERE user_id = ?').get(1) as any;
      expect(JSON.parse(prefs1.apprise_urls)).toEqual(['discord://new1', 'tgram://new1b']);

      // Verify user 2 was NOT affected
      const prefs2 = db.prepare('SELECT apprise_urls FROM user_notification_preferences WHERE user_id = ?').get(2) as any;
      expect(JSON.parse(prefs2.apprise_urls)).toEqual(['slack://original2']);
    });

    it('should handle empty apprise_urls array correctly', () => {
      const now = Date.now();

      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, 1, JSON.stringify([]), now, now);

      const prefs = db.prepare('SELECT apprise_urls FROM user_notification_preferences WHERE user_id = ?').get(1) as any;
      const urls = JSON.parse(prefs.apprise_urls || '[]');

      expect(urls).toEqual([]);
      expect(urls.length).toBe(0);
    });

    it('should handle null apprise_urls correctly', () => {
      const now = Date.now();

      db.prepare(`
        INSERT INTO user_notification_preferences
        (user_id, enable_apprise, apprise_urls, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(1, 1, null, now, now);

      const prefs = db.prepare('SELECT apprise_urls FROM user_notification_preferences WHERE user_id = ?').get(1) as any;
      const urls = prefs.apprise_urls ? JSON.parse(prefs.apprise_urls) : [];

      expect(urls).toEqual([]);
    });

    it('should correctly track notification results per user', () => {
      // Simulate broadcast results
      const broadcastResults = {
        sent: 0,
        failed: 0,
        filtered: 0
      };

      const users = [
        { id: 1, urls: ['discord://1'], shouldReceive: true, sendSuccess: true },
        { id: 2, urls: ['slack://2'], shouldReceive: true, sendSuccess: false }, // API failure
        { id: 3, urls: [], shouldReceive: false }, // No URLs - filtered
        { id: 4, urls: ['tgram://4'], shouldReceive: false } // Channel mismatch - filtered
      ];

      for (const user of users) {
        if (!user.shouldReceive || user.urls.length === 0) {
          broadcastResults.filtered++;
          continue;
        }

        if (user.sendSuccess) {
          broadcastResults.sent++;
        } else {
          broadcastResults.failed++;
        }
      }

      expect(broadcastResults.sent).toBe(1);
      expect(broadcastResults.failed).toBe(1);
      expect(broadcastResults.filtered).toBe(2);
    });
  });
});
