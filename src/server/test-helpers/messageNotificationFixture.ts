/**
 * Shared fixture for the message-notification delivery tests (#5593).
 *
 * Runs the REAL delivery wrappers (web push, Apprise, desktop) and the REAL
 * filter (`notificationFiltering.ts`) against an in-memory stand-in for the
 * database, so a test can count sends and read what was sent.
 *
 * Not a test file: it holds no `vi.mock` calls (those must sit in the test
 * file to be hoisted). It only builds the state the mocks read.
 */

export interface FixturePrefs {
  enableWebPush: boolean;
  enableApprise: boolean;
  enabledChannels: number[];
  enableDirectMessages: boolean;
  notifyOnEmoji: boolean;
  notifyOnMqtt: boolean;
  prefixWithNodeName: boolean;
  whitelist: string[];
  blacklist: string[];
  appriseUrls: string[];
  mutedChannels: Array<{ channelId: number; muteUntil: number | null }>;
  mutedDMs: Array<{ nodeUuid: string; muteUntil: number | null }>;
  messageTitleTemplate: string | null;
  messageBodyTemplate: string | null;
}

export function fixturePrefs(over: Partial<FixturePrefs> = {}): FixturePrefs {
  return {
    enableWebPush: true,
    enableApprise: true,
    enabledChannels: [0],
    enableDirectMessages: true,
    notifyOnEmoji: true,
    notifyOnMqtt: true,
    prefixWithNodeName: false,
    whitelist: [],
    blacklist: [],
    appriseUrls: ['json://example.invalid/hook'],
    mutedChannels: [],
    mutedDMs: [],
    messageTitleTemplate: null,
    messageBodyTemplate: null,
    ...over,
  };
}

export interface FixtureState {
  /** `${userId}|${sourceId}` → prefs row. */
  prefs: Map<string, FixturePrefs>;
  /** Users who lack messages:read. */
  deniedUsers: Set<number>;
  subscriptions: Array<{ id: number; userId: number | null; sourceId: string; endpoint: string; p256dhKey: string; authKey: string }>;
  appriseUsers: number[];
  users: Array<{ id: number; isActive: boolean }>;
}

export function emptyState(): FixtureState {
  return { prefs: new Map(), deniedUsers: new Set(), subscriptions: [], appriseUsers: [], users: [] };
}

/** The object the tests hand to `vi.mock('../../services/database.js')`. */
export function buildDatabaseMock(state: FixtureState) {
  return {
    notificationsRepo: {
      getAllSubscriptions: async (sourceId?: string) =>
        state.subscriptions.filter((s) => sourceId === undefined || s.sourceId === sourceId),
      updateSubscriptionLastUsed: async () => undefined,
      getUsersWithAppriseEnabled: async () => state.appriseUsers,
    },
    notifications: {
      getUserPreferences: async (userId: number, sourceId?: string) =>
        state.prefs.get(`${userId}|${sourceId ?? ''}`) ?? null,
      getUserPreferenceRows: async () => [],
      getUsersWithServiceEnabled: async () => state.appriseUsers,
    },
    settings: {
      getSetting: async () => null,
      getSettingForSource: async () => null,
      getLocalNodeNumForSource: async () => null,
    },
    auth: { getAllUsers: async () => state.users },
    getSettingAsync: async () => null,
    checkPermissionAsync: async (userId: number) => !state.deniedUsers.has(userId),
    waitForReady: async () => undefined,
  };
}

export function subscriptionFor(userId: number | null, sourceId: string) {
  return {
    id: userId ?? 0,
    userId,
    sourceId,
    endpoint: `https://push.example.invalid/${userId ?? 'anon'}`,
    p256dhKey: 'p',
    authKey: 'a',
  };
}
