/**
 * Per-source isolation tests for NotificationsRepository (#4020).
 *
 * Two users, two sources each — asserts that:
 *  - getUsersWithLowBatteryNotifications / getUsersWithInactiveNodeNotifications
 *    never leak one user's rows into another user's result set,
 *  - each returned row carries the correct sourceId and per-source values
 *    (no cross-source bleed within a single user's row set either),
 *  - getUserPreferenceRows only ever returns the requesting user's own rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NotificationsRepository, NotificationPreferences } from './notifications.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

function makeDefaultPrefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    enableWebPush: false,
    enableApprise: false,
    enabledChannels: [],
    enableDirectMessages: false,
    notifyOnEmoji: false,
    notifyOnMqtt: false,
    notifyOnNewNode: false,
    notifyOnTraceroute: false,
    notifyOnInactiveNode: false,
    notifyOnLowBattery: false,
    lowBatteryThreshold: 20,
    lowBatteryVoltageThreshold: 3300,
    notifyOnServerEvents: false,
    prefixWithNodeName: false,
    monitoredNodes: [],
    whitelist: [],
    blacklist: [],
    appriseUrls: [],
    mutedChannels: [],
    mutedDMs: [],
    ...overrides,
  };
}

describe('NotificationsRepository — per-source isolation (#4020)', () => {
  let t: TestDb;
  let repo: NotificationsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new NotificationsRepository(t.db, 'sqlite');

    const now = Date.now();
    t.sqlite.exec(`
      INSERT INTO users (id, username, password_hash, auth_provider, is_admin, is_active, mfa_enabled, created_at, updated_at)
      VALUES
        (1, 'user-alpha', 'hash', 'local', 0, 1, 0, ${now}, ${now}),
        (2, 'user-beta', 'hash', 'local', 0, 1, 0, ${now}, ${now})
    `);
  });

  afterEach(() => {
    t.close();
  });

  it('getUsersWithLowBatteryNotifications: rows for two users on two sources do not cross-contaminate', async () => {
    // user 1: flagged on source-a only, with its own threshold + monitored node.
    await repo.saveUserPreferences(1, makeDefaultPrefs({
      notifyOnLowBattery: true,
      enableWebPush: true,
      lowBatteryThreshold: 5,
      monitoredNodes: ['!user1sourceA'],
    }), 'source-a');
    // user 1 also has an unflagged row on source-b — must still come back
    // (all rows for a flagged user), but must never be mistaken for user 2's data.
    await repo.saveUserPreferences(1, makeDefaultPrefs({
      notifyOnLowBattery: false,
      enableApprise: true,
      monitoredNodes: ['!user1sourceB'],
    }), 'source-b');

    // user 2: flagged on source-b only, with a different threshold + monitored node.
    await repo.saveUserPreferences(2, makeDefaultPrefs({
      notifyOnLowBattery: true,
      enableWebPush: true,
      lowBatteryThreshold: 45,
      monitoredNodes: ['!user2sourceB'],
    }), 'source-b');

    const rows = await repo.getUsersWithLowBatteryNotifications();

    const user1Rows = rows.filter((r) => r.userId === 1);
    const user2Rows = rows.filter((r) => r.userId === 2);

    expect(user1Rows).toHaveLength(2);
    expect(user2Rows).toHaveLength(1);

    const user1SourceA = user1Rows.find((r) => r.sourceId === 'source-a');
    const user1SourceB = user1Rows.find((r) => r.sourceId === 'source-b');
    expect(user1SourceA?.lowBatteryThreshold).toBe(5);
    expect(JSON.parse(user1SourceA?.monitoredNodes || '[]')).toEqual(['!user1sourceA']);
    expect(JSON.parse(user1SourceB?.monitoredNodes || '[]')).toEqual(['!user1sourceB']);

    const user2SourceB = user2Rows.find((r) => r.sourceId === 'source-b');
    expect(user2SourceB?.lowBatteryThreshold).toBe(45);
    expect(JSON.parse(user2SourceB?.monitoredNodes || '[]')).toEqual(['!user2sourceB']);

    // Cross-contamination guards: user1's rows never carry user2's monitored
    // node and vice versa.
    for (const row of user1Rows) {
      expect(JSON.parse(row.monitoredNodes || '[]')).not.toContain('!user2sourceB');
    }
    for (const row of user2Rows) {
      expect(JSON.parse(row.monitoredNodes || '[]')).not.toContain('!user1sourceA');
      expect(JSON.parse(row.monitoredNodes || '[]')).not.toContain('!user1sourceB');
    }
  });

  it('getUsersWithInactiveNodeNotifications: rows for two users on two sources do not cross-contaminate', async () => {
    await repo.saveUserPreferences(1, makeDefaultPrefs({
      notifyOnInactiveNode: true,
      enableWebPush: true,
      monitoredNodes: ['!user1sourceA'],
    }), 'source-a');
    await repo.saveUserPreferences(2, makeDefaultPrefs({
      notifyOnInactiveNode: true,
      enableApprise: true,
      appriseUrls: ['http://apprise.example.com/user2'],
      monitoredNodes: ['!user2sourceB'],
    }), 'source-b');

    const rows = await repo.getUsersWithInactiveNodeNotifications();

    const user1Rows = rows.filter((r) => r.userId === 1);
    const user2Rows = rows.filter((r) => r.userId === 2);

    expect(user1Rows).toHaveLength(1);
    expect(user2Rows).toHaveLength(1);
    expect(user1Rows[0].sourceId).toBe('source-a');
    expect(user2Rows[0].sourceId).toBe('source-b');
    expect(JSON.parse(user1Rows[0].monitoredNodes || '[]')).toEqual(['!user1sourceA']);
    expect(JSON.parse(user2Rows[0].monitoredNodes || '[]')).toEqual(['!user2sourceB']);
    expect(user2Rows[0].appriseUrlCount).toBe(1);
    // #3884-style regression: no web push on user2's row — must not affect user1.
    expect(user1Rows[0].notifyOnMessage).toBe(true);
  });

  it('getUserPreferenceRows: only returns the requesting user\'s own rows', async () => {
    await repo.saveUserPreferences(1, makeDefaultPrefs({ enableWebPush: true }), 'source-a');
    await repo.saveUserPreferences(1, makeDefaultPrefs({ enableApprise: true }), 'source-b');
    await repo.saveUserPreferences(2, makeDefaultPrefs({ enableApprise: true }), 'source-a');

    const user1Rows = await repo.getUserPreferenceRows(1);
    const user2Rows = await repo.getUserPreferenceRows(2);

    expect(user1Rows.map((r) => r.sourceId).sort()).toEqual(['source-a', 'source-b']);
    expect(user2Rows.map((r) => r.sourceId)).toEqual(['source-a']);

    // Cross-user leakage guard.
    expect(user1Rows.every((r) => r.prefs !== undefined)).toBe(true);
    expect(user2Rows).toHaveLength(1);
    expect(user2Rows[0].prefs.enableApprise).toBe(true);
    expect(user2Rows[0].prefs.enableWebPush).toBe(false);
  });
});
