/**
 * MeshCore message notifications, end to end (P11 #6253 WP2).
 *
 * Runs the REAL adapter, dispatcher, delivery wrappers, filter, dedup store and
 * mention service. Only the edges are stubbed: the database, the `web-push`
 * client and the source registry. Nothing leaves the process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fixturePrefs,
  subscriptionFor,
  type FixturePrefs,
  type FixtureState,
} from '../test-helpers/messageNotificationFixture.js';

const OWN_KEY = 'aa'.repeat(32);
const FRIEND_KEY = 'bb'.repeat(32);
const ROOM_KEY = 'cc'.repeat(32);
const FP = 'aabbccdd11223344';

const SOURCES: Record<string, { id: string; name: string; type: string }> = {
  'mc-a': { id: 'mc-a', name: 'Companion', type: 'meshcore' },
  'mc-b': { id: 'mc-b', name: 'Repeater', type: 'meshcore' },
  'mc-mqtt': { id: 'mc-mqtt', name: 'Analyzer', type: 'meshcore_mqtt' },
};

const h = vi.hoisted(() => ({
  state: null as unknown as FixtureState,
  webPushSend: vi.fn(async (..._args: unknown[]) => ({})),
  keys: new Map<number, string[] | 'all'>(),
  settings: new Map<string, string>(),
  getChannelDbById: vi.fn(async (..._a: unknown[]) => null),
  summaries: [] as Array<{ channelKey: string; keyFingerprint: string; keySourceId: string | null; keyChannelIdx: number | null }>,
  virtual: [] as Array<{ name: string; psk: string }>,
}));

vi.mock('../../services/database.js', async () => {
  const { buildDatabaseMock, emptyState } = await import('../test-helpers/messageNotificationFixture.js');
  h.state = emptyState();
  const base = buildDatabaseMock(h.state);
  return {
    default: {
      ...base,
      settings: {
        ...base.settings,
        getSettingForSource: async (s: string, k: string) => h.settings.get(`${s}:${k}`) ?? null,
        setSourceSetting: async (s: string, k: string, v: string) => { h.settings.set(`${s}:${k}`, v); },
      },
      sources: { getSource: async (id: string) => SOURCES[id] ?? null },
      channels: {
        getChannelById: async (idx: number) => (idx === 0 ? { id: 0, name: 'Public' } : null),
        getAllChannels: async () => [],
      },
      meshcore: { getKeyedChannelSummaries: async () => h.summaries },
      channelDatabase: { getByIdAsync: h.getChannelDbById, getAllAsync: async () => h.virtual },
    },
  };
});
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../meshtasticManager.js', () => ({
  fallbackManager: { getLocalNodeInfo: vi.fn(() => ({ longName: 'LocalNode' })), sourceId: 'mc-a' },
}));

const managers = vi.hoisted(() => {
  const make = (name: string, key: string) => ({
    sourceType: 'meshcore',
    getLocalNode: () => ({ name, publicKey: key }),
    getLocalNodeInfo: () => null,
    getContact: (k: string) => contacts.get(k),
    resolveContactByPrefix: (p: string) => [...contacts.values()].find((c) => c.publicKey.startsWith(p.toLowerCase())),
  });
  const contacts = new Map<string, { publicKey: string; advName: string }>();
  return { contacts, byId: { 'mc-a': make('MC-Sandbox', 'aa'.repeat(32)), 'mc-b': make('MC-Rptr', 'dd'.repeat(32)) } as Record<string, unknown> };
});
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => managers.byId[id],
    getAllManagers: () => Object.values(managers.byId),
  },
}));
vi.mock('../sourceManagerTypes.js', () => ({
  getPrimaryMeshtasticManager: () => undefined,
  isMeshCoreManager: (m: { sourceType?: string }) => m.sourceType === 'meshcore',
  isReticulumManager: () => false,
}));
vi.mock('web-push', () => ({
  default: {
    sendNotification: h.webPushSend,
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    setVapidDetails: () => undefined,
  },
}));
vi.mock('../utils/meshcoreKeyAccess.js', () => ({
  resolveMeshcoreKeyAccess: async (user: { id: number }) => h.keys.get(user.id) ?? [],
  canSeeKeyedMessage: (access: 'all' | string[], row: { keyFingerprint?: string | null }) =>
    access === 'all' || !row.keyFingerprint || access.includes(row.keyFingerprint),
}));

import { pushNotificationService } from './pushNotificationService.js';
import { appriseNotificationService } from './appriseNotificationService.js';
import { notificationDedup } from './notificationDedup.js';
import { sendMeshCoreMessageNotification } from './meshcoreMessageNotifier.js';
import { channelKeyFingerprint } from './meshcoreFrameIngest.js';
import { meshcoreMentionNotificationService } from './meshcoreMentionNotificationService.js';
import { meshcoreNotificationKey } from './meshcoreNotificationKey.js';
import type { MeshCoreMessage } from '../meshcoreManager.js';

interface WirePush { endpoint: string; title: string; body: string; silent?: boolean; tag?: string; data?: Record<string, unknown> }
const pushes = (): WirePush[] =>
  h.webPushSend.mock.calls.map((c) => ({
    endpoint: (c[0] as { endpoint: string }).endpoint,
    ...(JSON.parse(c[1] as string) as Omit<WirePush, 'endpoint'>),
  }));
const pushesTo = (u: number | 'anon') => pushes().filter((p) => p.endpoint.endsWith(`/${u}`));
const alertsTo = (u: number | 'anon') => pushesTo(u).filter((p) => p.silent !== true);

function addUser(id: number, sources: Record<string, Partial<FixturePrefs>>, isAdmin = false) {
  h.state.users.push({ id, isActive: true, isAdmin });
  for (const [sourceId, prefs] of Object.entries(sources)) {
    h.state.prefs.set(`${id}|${sourceId}`, fixturePrefs({ enableApprise: false, appriseUrls: [], ...prefs }));
    h.state.subscriptions.push(subscriptionFor(id, sourceId));
  }
}

let seq = 1_760_000_000;
function chan(over: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    fromPublicKey: 'channel-0',
    fromName: 'Ann',
    toPublicKey: undefined,
    text: `hello ${seq}`,
    timestamp: seq * 1000,
    senderTimestamp: seq,
    messageType: 'channel',
    ...over,
  };
}
function dm(over: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  seq += 1;
  return {
    id: `d${seq}`,
    fromPublicKey: FRIEND_KEY,
    fromName: 'Bob',
    toPublicKey: OWN_KEY,
    text: `psst ${seq}`,
    timestamp: seq * 1000,
    senderTimestamp: seq,
    ...over,
  };
}
function room(over: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  seq += 1;
  return {
    id: `r${seq}`,
    fromPublicKey: FRIEND_KEY,
    fromName: 'Bob',
    toPublicKey: ROOM_KEY,
    text: `post ${seq}`,
    timestamp: seq * 1000,
    messageType: 'room_post',
    ...over,
  };
}
const send = (m: MeshCoreMessage, source = 'mc-a') => sendMeshCoreMessageNotification(m, source);

describe('MeshCore message notifications', () => {
  beforeEach(async () => {
    await pushNotificationService.waitForInit();
    await appriseNotificationService.waitForInit();
    (pushNotificationService as unknown as { isConfigured: boolean }).isConfigured = true;
    notificationDedup.clear();
    h.settings.clear();
    h.keys.clear();
    h.summaries = [];
    h.virtual = [];
    h.getChannelDbById.mockClear();
    h.state.prefs.clear();
    h.state.deniedUsers.clear();
    h.state.deniedPairs = new Set();
    h.state.subscriptions = [];
    h.state.appriseUsers = [];
    h.state.users = [];
    h.webPushSend.mockClear();
    h.webPushSend.mockImplementation(async () => ({}));
    managers.contacts.clear();
    managers.contacts.set(FRIEND_KEY, { publicKey: FRIEND_KEY, advName: 'Bob' });
    managers.contacts.set(ROOM_KEY, { publicKey: ROOM_KEY, advName: 'Hilltop Room' });
  });
  afterEach(() => vi.restoreAllMocks());

  describe('channels', () => {
    it('alerts a user with the channel enabled, with the channel name and sender', async () => {
      addUser(1, { 'mc-a': { enabledChannels: [0] } });
      expect(await send(chan({ text: 'hi all' }))).toBe('sent');
      const p = alertsTo(1);
      expect(p).toHaveLength(1);
      expect(p[0].title).toBe('Public · Companion');
      expect(p[0].body).toBe('Ann: hi all');
      expect(p[0].data).toMatchObject({ type: 'channel', channelId: 0, sourceId: 'mc-a' });
    });

    it('does not alert when the channel is not enabled, and an index above 7 works when enabled', async () => {
      addUser(1, { 'mc-a': { enabledChannels: [3] } });
      addUser(2, { 'mc-a': { enabledChannels: [12] } });
      await send(chan());
      expect(pushes()).toHaveLength(0);
      await send(chan({ fromPublicKey: 'channel-12' }));
      expect(alertsTo(2)).toHaveLength(1);
      expect(alertsTo(2)[0].title).toBe('Channel 12 · Companion');
      expect(alertsTo(1)).toHaveLength(0);
    });

    it('a muted channel (by index) is silent; an expired mute is not', async () => {
      addUser(1, { 'mc-a': { mutedChannels: [{ channelId: 0, muteUntil: null }] } });
      addUser(2, { 'mc-a': { mutedChannels: [{ channelId: 0, muteUntil: Date.now() - 1000 }] } });
      await send(chan());
      expect(alertsTo(1)).toHaveLength(0);
      expect(alertsTo(2)).toHaveLength(1);
    });

    it('whitelist beats a disabled channel; blacklist filters', async () => {
      addUser(1, { 'mc-a': { enabledChannels: [], whitelist: ['urgent'] } });
      addUser(2, { 'mc-a': { blacklist: ['spam'] } });
      await send(chan({ text: 'urgent spam' }));
      expect(alertsTo(1)).toHaveLength(1);
      expect(alertsTo(2)).toHaveLength(0);
    });

    it('emoji off filters a reactionEmoji row and raw reaction text', async () => {
      addUser(1, { 'mc-a': { notifyOnEmoji: false } });
      addUser(2, { 'mc-a': { notifyOnEmoji: true } });
      await send(chan({ text: '', reactionEmoji: '👍' } as Partial<MeshCoreMessage>));
      expect(alertsTo(1)).toHaveLength(0);
      expect(alertsTo(2)).toHaveLength(1);
      h.webPushSend.mockClear();
      await send(chan({ text: 'r:AB12CD34:👍' }));
      expect(alertsTo(1)).toHaveLength(0);
    });

    it('a keyed message reaches only users with access to the key', async () => {
      addUser(1, { 'mc-a': {} }, true);
      addUser(2, { 'mc-a': {} });
      addUser(3, { 'mc-a': {} });
      h.keys.set(1, 'all');
      h.keys.set(2, [FP]);
      h.state.subscriptions.push(subscriptionFor(null, 'mc-a'));
      await send(chan({ keyFingerprint: FP }));
      expect(alertsTo(1)).toHaveLength(1);
      expect(alertsTo(2)).toHaveLength(1);
      expect(alertsTo(3)).toHaveLength(0);
      expect(alertsTo('anon')).toHaveLength(0);
    });
  });

  describe('direct messages', () => {
    it('follows the DM toggle', async () => {
      addUser(1, { 'mc-a': { enableDirectMessages: true } });
      addUser(2, { 'mc-a': { enableDirectMessages: false } });
      await send(dm({ text: 'hey' }));
      expect(alertsTo(1)).toHaveLength(1);
      expect(alertsTo(1)[0].title).toBe('Bob · Companion');
      expect(alertsTo(1)[0].body).toBe('hey');
      expect(alertsTo(1)[0].data).toMatchObject({ type: 'dm', senderNodeId: FRIEND_KEY });
      expect(alertsTo(2)).toHaveLength(0);
    });

    it('a mute on the full key silences a DM that arrives with a 12-hex prefix', async () => {
      addUser(1, { 'mc-a': { mutedDMs: [{ nodeUuid: FRIEND_KEY, muteUntil: null }] } });
      addUser(2, { 'mc-a': { mutedDMs: [{ nodeUuid: FRIEND_KEY, muteUntil: Date.now() - 1000 }] } });
      await send(dm({ fromPublicKey: FRIEND_KEY.slice(0, 12) }));
      expect(alertsTo(1)).toHaveLength(0);
      expect(alertsTo(2)).toHaveLength(1);
    });
  });

  describe('room posts', () => {
    it('follow the DM toggle and render "{Room} · {Source}" with "{Sender}: text"', async () => {
      addUser(1, { 'mc-a': { enableDirectMessages: true } });
      addUser(2, { 'mc-a': { enableDirectMessages: false } });
      await send(room({ text: 'lunch?' }));
      expect(alertsTo(1)).toHaveLength(1);
      expect(alertsTo(1)[0].title).toBe('Hilltop Room · Companion');
      expect(alertsTo(1)[0].body).toBe('Bob: lunch?');
      expect(alertsTo(1)[0].data).toMatchObject({ type: 'dm', senderNodeId: ROOM_KEY });
      expect(alertsTo(2)).toHaveLength(0);
    });

    it('a mute on the room key silences the room, not the author as a DM', async () => {
      addUser(1, { 'mc-a': { mutedDMs: [{ nodeUuid: ROOM_KEY, muteUntil: null }] } });
      addUser(2, { 'mc-a': { mutedDMs: [{ nodeUuid: FRIEND_KEY, muteUntil: null }] } });
      await send(room());
      expect(alertsTo(1)).toHaveLength(0);
      expect(alertsTo(2)).toHaveLength(1);
    });
  });

  describe('skips', () => {
    beforeEach(() => addUser(1, { 'mc-a': {} }));

    it.each([
      ['selfOrigin', () => chan({ selfOrigin: true })],
      ['own key (DM)', () => dm({ fromPublicKey: OWN_KEY })],
      ["'local' sender", () => dm({ fromPublicKey: 'local' })],
      ['own name on a channel', () => chan({ fromName: 'mc-sandbox' })],
      ['sibling source key on a DM', () => dm({ fromPublicKey: 'dd'.repeat(32) })],
      ['own room echo', () => room({ fromPublicKey: OWN_KEY })],
    ])('%s is skipped', async (label, build) => {
      expect(label).toBeTruthy();
      expect(await send(build())).toBe('skipped:self');
      expect(pushes()).toHaveLength(0);
    });

    it('a sender named like us in a DM is not self (name check is channel-only)', async () => {
      expect(await send(dm({ fromName: 'MC-Sandbox' }))).toBe('sent');
    });

    it('filtered ignore/block messages are skipped', async () => {
      expect(await send(chan({ filtered: 'ignore' }))).toBe('skipped:filtered');
      expect(await send(dm({ filtered: 'block' }))).toBe('skipped:filtered');
      expect(pushes()).toHaveLength(0);
    });

    it('empty text is skipped', async () => {
      expect(await send(chan({ text: '  ' }))).toBe('skipped:empty');
    });
  });

  describe('mention plus message', () => {
    it('alerts once per recipient; users without mentions still get the message', async () => {
      addUser(1, { 'mc-a': { notifyOnMention: true } });
      addUser(2, { 'mc-a': { notifyOnMention: false } });
      const msg = chan({ fromName: 'Cara', text: '@[MC-Sandbox] ping' });
      await meshcoreMentionNotificationService.handleMessage(msg, 'mc-a');
      await send(msg);
      expect(alertsTo(1)).toHaveLength(1);
      expect(alertsTo(1)[0].title).toContain('mentioned');
      expect(alertsTo(2)).toHaveLength(1);
      expect(alertsTo(2)[0].title).toBe('Public · Companion');
    });

    it('a muted channel stays silent even for a mention', async () => {
      addUser(1, { 'mc-a': { notifyOnMention: true, mutedChannels: [{ channelId: 0, muteUntil: null }] } });
      const msg = chan({ fromName: 'Dan', text: '@[MC-Sandbox] ping' });
      await meshcoreMentionNotificationService.handleMessage(msg, 'mc-a');
      await send(msg);
      expect(pushes()).toHaveLength(0);
    });

    it('a muted room (room key) stays silent for a mention', async () => {
      addUser(1, { 'mc-a': { notifyOnMention: true, enableDirectMessages: true, mutedDMs: [{ nodeUuid: ROOM_KEY, muteUntil: null }] } });
      const msg = room({ text: '@[MC-Sandbox] hi' });
      await meshcoreMentionNotificationService.handleMessage(msg, 'mc-a');
      await send(msg);
      expect(pushes()).toHaveLength(0);
    });

    it('a keyed mention does not reach a user without the key', async () => {
      addUser(1, { 'mc-a': { notifyOnMention: true } });
      const msg = chan({ fromName: 'Eve', text: '@[MC-Sandbox] secret', keyFingerprint: FP });
      await meshcoreMentionNotificationService.handleMessage(msg, 'mc-a');
      expect(pushes()).toHaveLength(0);
    });
  });

  describe('cross-source and MQTT', () => {
    it('the same channel message on a Companion and a Repeater alerts once and lists both', async () => {
      addUser(1, { 'mc-a': {}, 'mc-b': { enabledChannels: [5] } });
      const a = chan({ fromName: 'Fay', text: 'same words', senderTimestamp: 1_800_000_000 });
      const b = { ...a, id: 'other-id', fromPublicKey: 'channel-5' };
      await send(a, 'mc-a');
      await send(b, 'mc-b');
      expect(alertsTo(1)).toHaveLength(1);
      expect(pushesTo(1)).toHaveLength(2);
      expect(pushesTo(1)[1].title).toContain('Companion, Repeater');
    });

    it('an MQTT slot message is named "Channel N" and marked viaMqtt (#6307)', async () => {
      addUser(1, { 'mc-mqtt': { enabledChannels: [3] } });
      expect(await send(chan({ fromPublicKey: 'channel-3', text: 'region chat' }), 'mc-mqtt')).toBe('sent');
      const p = alertsTo(1);
      expect(p).toHaveLength(1);
      expect(p[0].title).toBe('Channel 3 · Analyzer');
      expect(p[0].data).toMatchObject({ channelId: 3, sourceId: 'mc-mqtt' });
    });

    it('a virtual-key MQTT message uses the virtual name and the key gate (#6307)', async () => {
      const secret = '11'.repeat(16);
      const fp = channelKeyFingerprint(secret);
      const idx = 1234;
      h.virtual = [{ name: 'Secret Club', psk: secret }];
      h.summaries = [{ channelKey: `channel-${idx}`, keyFingerprint: fp, keySourceId: null, keyChannelIdx: null }];
      addUser(1, { 'mc-mqtt': { enabledChannels: [idx] } });
      addUser(2, { 'mc-mqtt': { enabledChannels: [idx] } });
      h.keys.set(1, [fp]);
      await send(chan({ fromPublicKey: `channel-${idx}`, keyFingerprint: fp }), 'mc-mqtt');
      expect(alertsTo(1)).toHaveLength(1);
      expect(alertsTo(1)[0].title).toBe('Secret Club · Analyzer');
      expect(alertsTo(2)).toHaveLength(0);
      expect(h.getChannelDbById).not.toHaveBeenCalled();
    });

    it('a Repeater keyed message is named from its key, not the channel_database offset (#6307)', async () => {
      const secret = '22'.repeat(16);
      const fp = channelKeyFingerprint(secret);
      const idx = 1100; // idx - 100 would hit channel_database id 1000 on the old path
      h.virtual = [{ name: 'Hill Net', psk: secret }];
      h.summaries = [{ channelKey: `channel-${idx}`, keyFingerprint: fp, keySourceId: null, keyChannelIdx: null }];
      addUser(1, { 'mc-b': { enabledChannels: [idx] } });
      h.keys.set(1, [fp]);
      await send(chan({ fromPublicKey: `channel-${idx}`, keyFingerprint: fp }), 'mc-b');
      expect(alertsTo(1)[0].title).toBe('Hill Net · Repeater');
      expect(h.getChannelDbById).not.toHaveBeenCalled();
    });

    it('an unnamed keyed channel falls back to "Channel N" without a channel_database lookup (#6307)', async () => {
      addUser(1, { 'mc-b': { enabledChannels: [1500] } });
      h.keys.set(1, 'all');
      await send(chan({ fromPublicKey: 'channel-1500', keyFingerprint: FP }), 'mc-b');
      expect(alertsTo(1)[0].title).toBe('Channel 1500 · Repeater');
      expect(h.getChannelDbById).not.toHaveBeenCalled();
    });

    it('a meshcore_mqtt source marks viaMqtt, which a user can turn off', async () => {
      addUser(1, { 'mc-mqtt': { notifyOnMqtt: false } });
      addUser(2, { 'mc-mqtt': { notifyOnMqtt: true } });
      await send(chan(), 'mc-mqtt');
      expect(alertsTo(1)).toHaveLength(0);
      expect(alertsTo(2)).toHaveLength(1);
      expect(alertsTo(2)[0].title).toBe('Public · Analyzer');
    });
  });

  describe('meshcoreNotificationKey', () => {
    const base = { id: 'x', fromPublicKey: 'channel-0', fromName: 'Ann', text: 'hi', senderTimestamp: 100, timestamp: 100000 };
    it('channel key ignores channel index, id and name case', () => {
      const k = meshcoreNotificationKey(base);
      expect(k).toMatch(/^meshcore-ch:100:[0-9a-f]{16}$/);
      expect(meshcoreNotificationKey({ ...base, id: 'y', fromPublicKey: 'channel-7', fromName: 'ANN' })).toBe(k);
      expect(meshcoreNotificationKey({ ...base, text: 'bye' })).not.toBe(k);
    });
    it('falls back to the row id without a timestamp', () => {
      expect(meshcoreNotificationKey({ ...base, senderTimestamp: undefined })).toBe('meshcore-id:x');
    });
    it('DM and room keys', () => {
      expect(meshcoreNotificationKey({ ...base, fromPublicKey: FRIEND_KEY, toPublicKey: OWN_KEY })).toMatch(
        new RegExp(`^meshcore-dm:${FRIEND_KEY}:100:`),
      );
      expect(
        meshcoreNotificationKey({ ...base, fromPublicKey: FRIEND_KEY, toPublicKey: ROOM_KEY, messageType: 'room_post' }),
      ).toMatch(new RegExp(`^meshcore-room:${ROOM_KEY}:${FRIEND_KEY}:100:`));
    });
  });
});
