import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getUserNotificationPreferencesAsync,
  saveUserNotificationPreferencesAsync,
  getUsersWithServiceEnabledAsync,
  shouldFilterNotificationAsync,
  applyNodeNamePrefixAsync,
  type NotificationFilterContext,
  type NotificationPreferences,
} from './notificationFiltering.js';
import databaseService from '../../services/database.js';

vi.mock('../../services/database.js', () => ({
  default: {
    notifications: {
      getUserPreferences: vi.fn(),
      saveUserPreferences: vi.fn(),
      getUsersWithServiceEnabled: vi.fn(),
    },
    getSettingAsync: vi.fn(),
  },
}));

const mockDb = databaseService as any;

const defaultPrefs: NotificationPreferences = {
  enableWebPush: true,
  enableApprise: false,
  enabledChannels: [1, 2, 5],
  enableDirectMessages: true,
  notifyOnEmoji: true,
  notifyOnMqtt: true,
  notifyOnNewNode: true,
  notifyOnTraceroute: true,
  notifyOnInactiveNode: false,
  notifyOnServerEvents: false,
  prefixWithNodeName: false,
  monitoredNodes: [],
  whitelist: [],
  blacklist: [],
  appriseUrls: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.notifications.getUserPreferences.mockResolvedValue(defaultPrefs);
  mockDb.notifications.saveUserPreferences.mockResolvedValue(true);
  mockDb.notifications.getUsersWithServiceEnabled.mockReturnValue([1, 2, 3]);
  mockDb.getSettingAsync.mockResolvedValue(null);
});

// ─── getUserNotificationPreferencesAsync ─────────────────────────────────────

describe('getUserNotificationPreferencesAsync', () => {
  it('returns null for invalid userId (0)', async () => {
    const result = await getUserNotificationPreferencesAsync(0);
    expect(result).toBeNull();
    expect(mockDb.notifications.getUserPreferences).not.toHaveBeenCalled();
  });

  it('returns null for negative userId', async () => {
    const result = await getUserNotificationPreferencesAsync(-5);
    expect(result).toBeNull();
  });

  it('returns null for non-integer userId', async () => {
    const result = await getUserNotificationPreferencesAsync(1.5);
    expect(result).toBeNull();
  });

  it('returns preferences from database when found', async () => {
    const result = await getUserNotificationPreferencesAsync(42);
    expect(result).toEqual(defaultPrefs);
    expect(mockDb.notifications.getUserPreferences).toHaveBeenCalledWith(42);
  });

  it('falls back to settings table when no preferences in notifications table', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue(null);
    mockDb.getSettingAsync.mockResolvedValue(
      JSON.stringify({ enabledChannels: [3], whitelist: ['urgent'] })
    );

    const result = await getUserNotificationPreferencesAsync(5);
    expect(result).not.toBeNull();
    expect(result!.enabledChannels).toEqual([3]);
    expect(result!.whitelist).toEqual(['urgent']);
    expect(result!.enableWebPush).toBe(true); // default for old users
    expect(result!.enableApprise).toBe(false); // new feature default
  });

  it('returns null when neither notifications nor settings found', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue(null);
    mockDb.getSettingAsync.mockResolvedValue(null);

    const result = await getUserNotificationPreferencesAsync(5);
    expect(result).toBeNull();
  });

  it('returns null on database error', async () => {
    mockDb.notifications.getUserPreferences.mockRejectedValue(new Error('DB error'));
    const result = await getUserNotificationPreferencesAsync(1);
    expect(result).toBeNull();
  });
});

// ─── saveUserNotificationPreferencesAsync ────────────────────────────────────

describe('saveUserNotificationPreferencesAsync', () => {
  it('returns false for invalid userId (0)', async () => {
    const result = await saveUserNotificationPreferencesAsync(0, defaultPrefs);
    expect(result).toBe(false);
    expect(mockDb.notifications.saveUserPreferences).not.toHaveBeenCalled();
  });

  it('saves preferences and returns true', async () => {
    const result = await saveUserNotificationPreferencesAsync(10, defaultPrefs);
    expect(result).toBe(true);
    expect(mockDb.notifications.saveUserPreferences).toHaveBeenCalledWith(10, defaultPrefs);
  });

  it('returns false on database error', async () => {
    mockDb.notifications.saveUserPreferences.mockRejectedValue(new Error('DB error'));
    const result = await saveUserNotificationPreferencesAsync(1, defaultPrefs);
    expect(result).toBe(false);
  });
});

// ─── getUsersWithServiceEnabledAsync ─────────────────────────────────────────

describe('getUsersWithServiceEnabledAsync', () => {
  it('returns users with web_push enabled', async () => {
    const result = await getUsersWithServiceEnabledAsync('web_push');
    expect(result).toEqual([1, 2, 3]);
    expect(mockDb.notifications.getUsersWithServiceEnabled).toHaveBeenCalledWith('web_push');
  });

  it('returns users with apprise enabled', async () => {
    mockDb.notifications.getUsersWithServiceEnabled.mockReturnValue([5]);
    const result = await getUsersWithServiceEnabledAsync('apprise');
    expect(result).toEqual([5]);
  });

  it('returns empty array on error', async () => {
    mockDb.notifications.getUsersWithServiceEnabled.mockImplementation(() => {
      throw new Error('DB error');
    });
    const result = await getUsersWithServiceEnabledAsync('web_push');
    expect(result).toEqual([]);
  });
});

// ─── shouldFilterNotificationAsync ───────────────────────────────────────────

describe('shouldFilterNotificationAsync', () => {
  const baseContext: NotificationFilterContext = {
    messageText: 'Hello world',
    channelId: 1,
    isDirectMessage: false,
    viaMqtt: false,
  };

  it('returns false (allow) for invalid userId', async () => {
    const result = await shouldFilterNotificationAsync(0, baseContext);
    expect(result).toBe(false);
  });

  it('returns false (allow) when no preferences found', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue(null);
    mockDb.getSettingAsync.mockResolvedValue(null);
    const result = await shouldFilterNotificationAsync(1, baseContext);
    expect(result).toBe(false);
  });

  it('returns false (allow) for message on enabled channel', async () => {
    const result = await shouldFilterNotificationAsync(1, { ...baseContext, channelId: 1 });
    expect(result).toBe(false);
  });

  it('returns true (filter) for message on disabled channel', async () => {
    const result = await shouldFilterNotificationAsync(1, { ...baseContext, channelId: 99 });
    expect(result).toBe(true);
  });

  it('returns false (allow) for DM when DMs enabled', async () => {
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      isDirectMessage: true,
    });
    expect(result).toBe(false);
  });

  it('returns true (filter) for DM when DMs disabled', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue({
      ...defaultPrefs,
      enableDirectMessages: false,
    });
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      isDirectMessage: true,
    });
    expect(result).toBe(true);
  });

  it('filters emoji-only message when notifyOnEmoji is false', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue({
      ...defaultPrefs,
      notifyOnEmoji: false,
    });
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      messageText: '😀',
    });
    expect(result).toBe(true);
  });

  it('allows emoji-only message when notifyOnEmoji is true', async () => {
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      messageText: '😀',
    });
    expect(result).toBe(false);
  });

  it('filters MQTT message when notifyOnMqtt is false', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue({
      ...defaultPrefs,
      notifyOnMqtt: false,
    });
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      viaMqtt: true,
    });
    expect(result).toBe(true);
  });

  it('allows MQTT message when notifyOnMqtt is true', async () => {
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      viaMqtt: true,
    });
    expect(result).toBe(false);
  });

  it('whitelist overrides blacklist (highest priority)', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue({
      ...defaultPrefs,
      whitelist: ['urgent'],
      blacklist: ['urgent'], // same word in both
    });
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      messageText: 'This is urgent',
    });
    expect(result).toBe(false); // whitelist wins
  });

  it('blacklist filters message containing blacklisted word', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue({
      ...defaultPrefs,
      blacklist: ['spam'],
    });
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      messageText: 'This is spam',
    });
    expect(result).toBe(true);
  });

  it('blacklist is case-insensitive', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue({
      ...defaultPrefs,
      blacklist: ['SPAM'],
    });
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      messageText: 'This is spam',
    });
    expect(result).toBe(true);
  });

  it('whitelist allows message on disabled channel (whitelist is highest priority)', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue({
      ...defaultPrefs,
      enabledChannels: [], // no channels enabled
      whitelist: ['urgent'],
    });
    const result = await shouldFilterNotificationAsync(1, {
      ...baseContext,
      channelId: 99,
      messageText: 'This is urgent',
    });
    expect(result).toBe(false); // whitelist saves it
  });
});

// ─── applyNodeNamePrefixAsync ─────────────────────────────────────────────────

describe('applyNodeNamePrefixAsync', () => {
  it('returns original body when userId is null', async () => {
    const result = await applyNodeNamePrefixAsync(null, 'Hello', 'MyNode');
    expect(result).toBe('Hello');
  });

  it('returns original body when nodeName is null', async () => {
    const result = await applyNodeNamePrefixAsync(1, 'Hello', null);
    expect(result).toBe('Hello');
  });

  it('returns original body when userId is undefined', async () => {
    const result = await applyNodeNamePrefixAsync(undefined, 'Hello', 'MyNode');
    expect(result).toBe('Hello');
  });

  it('returns original body when prefixWithNodeName is false', async () => {
    const result = await applyNodeNamePrefixAsync(1, 'Hello', 'MyNode');
    expect(result).toBe('Hello');
  });

  it('returns prefixed body when prefixWithNodeName is true', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue({
      ...defaultPrefs,
      prefixWithNodeName: true,
    });
    const result = await applyNodeNamePrefixAsync(1, 'Hello', 'MyNode');
    expect(result).toBe('[MyNode] Hello');
  });

  it('returns original body when no preferences found', async () => {
    mockDb.notifications.getUserPreferences.mockResolvedValue(null);
    mockDb.getSettingAsync.mockResolvedValue(null);
    const result = await applyNodeNamePrefixAsync(1, 'Hello', 'MyNode');
    expect(result).toBe('Hello');
  });
});
