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
  messageTextMaxPush: number | null;
  messageTextMaxApprise: number | null;
  /** Event toggles read by `broadcastToPreferenceUsers`; absent = off. */
  notifyOnNewNode?: boolean;
  notifyOnWaypoint?: boolean;
  notifyOnMention?: boolean;
  notifyOnAutoTrace?: boolean;
  notifyOnServerEvents?: boolean;
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
    messageTextMaxPush: null,
    messageTextMaxApprise: null,
    ...over,
  };
}

export interface FixtureState {
  /** `${userId}|${sourceId}` → prefs row. */
  prefs: Map<string, FixturePrefs>;
  /** Users who lack messages:read. */
  deniedUsers: Set<number>;
  /** `${userId}|${sourceId}` pairs that lack messages:read on that one source (#5729). */
  deniedPairs?: Set<string>;
  subscriptions: Array<{ id: number; userId: number | null; sourceId: string; endpoint: string; p256dhKey: string; authKey: string }>;
  appriseUsers: number[];
  users: Array<{ id: number; isActive: boolean; isAdmin?: boolean }>;
  /**
   * The user's mesh-wide row (#5729). Absent: a user with push rows gets the
   * list migration 235 would have written (the sources of their rows), so a
   * test written against per-source subscriptions keeps its meaning.
   */
  mesh?: Map<number, { prefs?: FixturePrefs; saved: boolean; pushSourceIds: string[] | null }>;
  /** Id of the active anonymous account; null = none. Default 999. */
  anonymousUserId?: number | null;
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
      // Every saved row of the user, as the targeted alert path reads them.
      getUserPreferenceRows: async (userId: number) =>
        [...state.prefs.entries()]
          .filter(([key]) => key.startsWith(`${userId}|`))
          .map(([key, prefs]) => ({ sourceId: key.slice(key.indexOf('|') + 1), prefs })),
      getUsersWithServiceEnabled: async () => state.appriseUsers,
      getMeshPreferences: async (userId: number) => {
        const stored = state.mesh?.get(userId);
        if (stored) return { prefs: stored.prefs ?? fixturePrefs(), saved: stored.saved, pushSourceIds: stored.pushSourceIds };
        const subscribed = [...new Set(state.subscriptions
          .filter((s) => s.userId === userId && s.sourceId !== '__mesh__')
          .map((s) => s.sourceId))];
        return subscribed.length > 0 ? { prefs: fixturePrefs(), saved: false, pushSourceIds: subscribed } : null;
      },
    },
    settings: {
      getSetting: async () => null,
      getSettingForSource: async () => null,
      getLocalNodeNumForSource: async () => null,
    },
    auth: { getAllUsers: async () => state.users },
    getSettingAsync: async () => null,
    checkPermissionAsync: async (userId: number, _resource?: string, _action?: string, sourceId?: string) =>
      !state.deniedUsers.has(userId) && !state.deniedPairs?.has(`${userId}|${sourceId ?? ''}`),
    findUserByIdAsync: async (id: number) => state.users.find((u) => u.id === id) ?? null,
    findUserByUsernameAsync: async (name: string) => {
      const anonId = state.anonymousUserId === undefined ? 999 : state.anonymousUserId;
      return name === 'anonymous' && anonId !== null ? { id: anonId, isActive: true } : null;
    },
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
