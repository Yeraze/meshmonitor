/**
 * Mesh-wide default vs per-source override vs permission (#5729, decision 6).
 *
 * Runs the REAL resolver, repository (in-memory SQLite with every migration)
 * and Web Push wrapper. Only the permission check, the source lookup and the
 * push client are stubbed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  repo: null as any,
  sqlite: null as any,
  /** `${userId}|${sourceId}` pairs without messages:read. */
  denied: new Set<string>(),
  blob: null as string | null,
}));

vi.mock('../../services/database.js', async () => {
  const { createTestDb } = await import('../test-helpers/testDb.js');
  const { NotificationsRepository } = await import('../../db/repositories/notifications.js');
  const t = createTestDb();
  h.repo = new NotificationsRepository(t.db, 'sqlite');
  h.sqlite = t.sqlite;
  return {
    default: {
      notifications: h.repo,
      notificationsRepo: h.repo,
      settings: {
        getSetting: async () => null,
        getSettingForSource: async () => null,
        getLocalNodeNumForSource: async () => null,
      },
      sources: { getSource: async (id: string) => ({ id, name: id, type: 'meshtastic_tcp' }) },
      getSettingAsync: async (key: string) => (key === 'push_prefs_1' ? h.blob : null),
      checkPermissionAsync: async (userId: number, _r: string, _a: string, sourceId?: string) =>
        !h.denied.has(`${userId}|${sourceId ?? ''}`),
      findUserByIdAsync: async (id: number) => ({ id, isActive: true, isAdmin: false }),
      findUserByUsernameAsync: async () => null,
      auth: { getAllUsers: async () => [{ id: 1, isActive: true }] },
      waitForReady: async () => undefined,
    },
  };
});
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../meshtasticManager.js', () => ({ fallbackManager: { getLocalNodeInfo: vi.fn(() => null) } }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: {} }));
vi.mock('../sourceManagerTypes.js', () => ({ getPrimaryMeshtasticManager: () => undefined }));

import { resolveNotificationPreferencesAsync, resolveMeshPreferencesAsync, renderMessagePayloadForUserAsync, pushSourceAllowedAsync } from './notificationFiltering.js';
import { pushNotificationService } from '../services/pushNotificationService.js';
import { defaultNotificationPreferences, MESH_PREFERENCES_SOURCE_ID } from '../../utils/notificationDefaults.js';

const USER = 1;
const A = 'src-a';
const B = 'src-b';

const prefs = (over: Record<string, unknown> = {}) => ({ ...defaultNotificationPreferences(), ...over });

async function saveMesh(over: Record<string, unknown>, pushSourceIds?: string[] | null) {
  await h.repo.saveUserPreferences(USER, prefs(over), MESH_PREFERENCES_SOURCE_ID, {
    meshDefaultsSaved: true,
    ...(pushSourceIds !== undefined ? { pushSourceIds } : {}),
  });
}

describe('mesh-wide default and per-source overrides (#5729)', () => {
  beforeAll(() => {
    const now = Date.now();
    h.sqlite.exec(`INSERT INTO users (id, username, password_hash, auth_provider, is_admin, is_active, mfa_enabled, created_at, updated_at)
      VALUES (1, 'mesh-user', 'hash', 'local', 0, 1, 0, ${now}, ${now})`);
  });

  beforeEach(() => {
    h.sqlite.exec(`DELETE FROM user_notification_preferences; DELETE FROM push_subscriptions;`);
    h.denied.clear();
    h.blob = null;
  });

  describe('pushSourceAllowedAsync', () => {
    it('no mesh row: every source is allowed', async () => {
      expect(await pushSourceAllowedAsync(USER, A)).toBe(true);
    });

    it('a null list means every source', async () => {
      await saveMesh({}, null);
      expect(await pushSourceAllowedAsync(USER, B)).toBe(true);
    });

    it('a list allows only the sources it names', async () => {
      await saveMesh({}, [A]);
      expect(await pushSourceAllowedAsync(USER, A)).toBe(true);
      expect(await pushSourceAllowedAsync(USER, B)).toBe(false);
    });
  });

  describe('resolution', () => {
    it('nothing saved: the built-in defaults', async () => {
      const r = await resolveNotificationPreferencesAsync(USER, A);
      expect(r?.origin).toBe('default');
      expect(r?.prefs).toEqual(defaultNotificationPreferences());
    });

    it('a saved mesh-wide default answers for every source without a row of its own', async () => {
      await saveMesh({ notifyOnNewNode: true, enableDirectMessages: false });
      for (const sourceId of [A, B]) {
        const r = await resolveNotificationPreferencesAsync(USER, sourceId);
        expect(r?.origin, sourceId).toBe('mesh');
        expect(r?.prefs.notifyOnNewNode).toBe(true);
        expect(r?.prefs.enableDirectMessages).toBe(false);
      }
    });

    it('a per-source row overrides the mesh-wide default for that source only', async () => {
      await saveMesh({ notifyOnNewNode: true });
      await h.repo.saveUserPreferences(USER, prefs({ notifyOnNewNode: false, enabledChannels: [3] }), A);

      const onA = await resolveNotificationPreferencesAsync(USER, A);
      expect(onA?.origin).toBe('row');
      expect(onA?.prefs.notifyOnNewNode).toBe(false);
      expect(onA?.prefs.enabledChannels).toEqual([3]);

      const onB = await resolveNotificationPreferencesAsync(USER, B);
      expect(onB?.origin).toBe('mesh');
      expect(onB?.prefs.notifyOnNewNode).toBe(true);
      expect(onB?.prefs.enabledChannels).toEqual([]); // never another source's channels
    });

    it('dropping the override returns the source to the mesh-wide default', async () => {
      await saveMesh({ notifyOnTraceroute: true });
      await h.repo.saveUserPreferences(USER, prefs({ notifyOnTraceroute: false }), A);
      expect(await h.repo.deleteUserPreferences(USER, A)).toBe(true);
      const r = await resolveNotificationPreferencesAsync(USER, A);
      expect(r?.origin).toBe('mesh');
      expect(r?.prefs.notifyOnTraceroute).toBe(true);
    });

    it('an unsaved mesh row (only a push source list) changes nothing', async () => {
      await h.repo.setPushSourceIds(USER, [A]);
      const r = await resolveNotificationPreferencesAsync(USER, B);
      expect(r?.origin).toBe('default');
      expect(r?.prefs).toEqual(defaultNotificationPreferences());
      // And it is invisible to the raw "who has X on" reads.
      expect(await h.repo.getUserPreferenceRows(USER)).toEqual([]);
      expect(await h.repo.getUsersWithServiceEnabled('web_push')).toEqual([]);
      expect(await h.repo.getUsersWithServiceEnabled('apprise')).toEqual([]);
    });

    it('with no saved mesh default, the pre-4.0 blob still answers, as before', async () => {
      h.blob = JSON.stringify({ notifyOnNewNode: false, enableApprise: true });
      await h.repo.setPushSourceIds(USER, [A]);
      expect((await resolveNotificationPreferencesAsync(USER, A))?.origin).toBe('legacyBlob');
      const mesh = await resolveMeshPreferencesAsync(USER);
      expect(mesh).toMatchObject({ saved: false, pushSourceIds: [A] });
      expect(mesh?.prefs.enableApprise).toBe(true);
    });

    it('a saved mesh default wins over the pre-4.0 blob', async () => {
      h.blob = JSON.stringify({ notifyOnNewNode: true });
      await saveMesh({ notifyOnNewNode: false });
      expect((await resolveNotificationPreferencesAsync(USER, A))?.prefs.notifyOnNewNode).toBe(false);
    });

    it('a source with no override renders with the mesh-wide template', async () => {
      await saveMesh({ messageTitleTemplate: 'MESH {{ sourceName }}' });
      const message = { channelName: 'LongFast', sourceName: 'Hilltop', senderName: 'Al', senderShortName: 'AL', text: 'hi', serviceLabel: 'Meshtastic', isDM: false };
      const out = await renderMessagePayloadForUserAsync(USER, { title: 't', body: 'b', message }, A, 'Hilltop', 'push');
      expect(out.title).toBe('MESH Hilltop');
    });
  });

  describe('delivery: the mesh-wide default reaches only sources the user can read', () => {
    let send: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      send = vi.spyOn(pushNotificationService, 'sendToSubscription').mockResolvedValue(true);
      await h.repo.saveSubscription({ userId: USER, sourceId: MESH_PREFERENCES_SOURCE_ID, endpoint: 'https://push/1', p256dhKey: 'p', authKey: 'a' });
      await saveMesh({ enableWebPush: true, enableDirectMessages: true });
    });
    afterEach(() => {
      send.mockRestore();
    });

    const dm = (sourceId: string) => pushNotificationService.broadcastWithFiltering(
      { title: 'DM', body: 'hello', sourceId, sourceName: sourceId },
      { messageText: 'hello', channelId: -1, isDirectMessage: true, sourceId, sourceName: sourceId },
    );

    it('a readable source is delivered under the mesh-wide default', async () => {
      expect((await dm(A)).sent).toBe(1);
    });

    it('a source the user cannot read gets nothing, whatever the mesh-wide default says', async () => {
      h.denied.add(`${USER}|${B}`);
      const result = await dm(B);
      expect(result.sent).toBe(0);
      expect(send).not.toHaveBeenCalled();
    });

    it('the Web Push source list filters sources (one subscription for the mesh)', async () => {
      await h.repo.setPushSourceIds(USER, [A]);
      expect((await dm(A)).sent).toBe(1);
      expect((await dm(B)).sent).toBe(0);
    });

    it('an override with Web Push off silences that source only', async () => {
      await h.repo.saveUserPreferences(USER, prefs({ enableWebPush: false }), B);
      expect((await dm(A)).sent).toBe(1);
      expect((await dm(B)).sent).toBe(0);
    });
  });
});
