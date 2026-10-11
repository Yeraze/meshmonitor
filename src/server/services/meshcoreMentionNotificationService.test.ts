/**
 * MeshCore mention notifications: who alerts, who does not, and the persisted
 * 5-minute per-sender quiet period.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/database.js', () => ({ default: {} }));
vi.mock('./notificationService.js', () => ({ notificationService: { broadcastToPreferenceUsers: vi.fn() } }));
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: { getManager: vi.fn() } }));

import {
  MeshCoreMentionNotificationService,
  MENTION_COOLDOWN_MS,
  SETTING_MENTION_STATE,
  mentionSenderKey,
  mentionVenue,
  parseMentionState,
  type MentionNotificationDeps,
} from './meshcoreMentionNotificationService.js';
import type { MeshCoreMessage } from '../meshcoreManager.js';

const SRC = 'mc-1';
const OWN_KEY = 'aa'.repeat(32);
const T0 = 1_760_000_000_000;

function harness(over: Partial<MentionNotificationDeps> = {}) {
  const settings = new Map<string, string>();
  const clock = { now: T0 };
  const notify = vi.fn(async () => ({ sent: 1, failed: 0, filtered: 0 }));
  const deps: MentionNotificationDeps = {
    now: () => clock.now,
    getOwnNode: () => ({ name: 'MC-Sandbox', publicKey: OWN_KEY }),
    isOwnPublicKey: () => false,
    getSourceName: async () => 'Sandbox',
    getChannelName: async (_s, idx) => (idx === 0 ? 'Public' : null),
    getSourceSetting: async (s, k) => settings.get(`${s}:${k}`) ?? null,
    setSourceSetting: async (s, k, v) => { settings.set(`${s}:${k}`, v); },
    notify,
    ...over,
  };
  return { deps, settings, clock, notify, service: new MeshCoreMentionNotificationService(deps) };
}

const channelMsg = (over: Partial<MeshCoreMessage> = {}): MeshCoreMessage => ({
  id: 'm1',
  fromPublicKey: 'channel-0',
  fromName: 'Ann',
  text: '@[MC-Sandbox] are you there?',
  timestamp: T0,
  messageType: 'channel',
  ...over,
});

describe('mentionVenue / mentionSenderKey', () => {
  it('classifies channel, room post and DM', () => {
    expect(mentionVenue({ fromPublicKey: 'channel-3' })).toEqual({ kind: 'channel', channelIdx: 3 });
    expect(mentionVenue({ fromPublicKey: OWN_KEY, toPublicKey: 'channel-2' })).toEqual({ kind: 'channel', channelIdx: 2 });
    expect(mentionVenue({ fromPublicKey: 'bb'.repeat(32), toPublicKey: 'cc'.repeat(32), messageType: 'room_post' })).toEqual({ kind: 'room' });
    expect(mentionVenue({ fromPublicKey: 'bb'.repeat(32), toPublicKey: OWN_KEY })).toBeNull();
  });

  it('keys a sender by name, else by public key', () => {
    expect(mentionSenderKey({ fromPublicKey: 'channel-0', fromName: ' Ann ' })).toBe('n:ann');
    expect(mentionSenderKey({ fromPublicKey: 'BB'.repeat(32) })).toBe(`k:${'bb'.repeat(32)}`);
  });
});

describe('parseMentionState', () => {
  it('keeps live entries and drops expired, far-future and malformed ones', () => {
    const raw = JSON.stringify({ live: T0 - 1000, old: T0 - MENTION_COOLDOWN_MS, farFuture: T0 + MENTION_COOLDOWN_MS, bad: 'x' });
    expect(parseMentionState(raw, T0)).toEqual({ live: T0 - 1000 });
  });

  it('a stamp just ahead of the clock still holds the window (clock stepped back)', () => {
    expect(parseMentionState(JSON.stringify({ ahead: T0 + 30_000 }), T0)).toEqual({ ahead: T0 + 30_000 });
    expect(parseMentionState('not json', T0)).toEqual({});
    expect(parseMentionState('[1]', T0)).toEqual({});
  });
});

describe('MeshCoreMentionNotificationService', () => {
  it('alerts on a channel mention, naming the node, channel and source', async () => {
    const h = harness();
    expect(await h.service.handleMessage(channelMsg(), SRC)).toBe('sent');
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({
      title: 'MC-Sandbox mentioned in #Public · Sandbox',
      body: 'Ann: @[MC-Sandbox] are you there?',
      sourceId: SRC,
      sourceName: 'Sandbox',
      data: { type: 'channel', channelId: 0, messageId: 'm1' },
    });
  });

  it('alerts on a room post', async () => {
    const h = harness();
    const msg = channelMsg({ fromPublicKey: 'bb'.repeat(32), toPublicKey: 'cc'.repeat(32), messageType: 'room_post' });
    expect(await h.service.handleMessage(msg, SRC)).toBe('sent');
    expect(h.notify.mock.calls[0][0].title).toBe('MC-Sandbox mentioned in a room · Sandbox');
    expect(h.notify.mock.calls[0][0].data).toBeUndefined();
  });

  it('skips a DM, a message with no mention, and a mention of another node', async () => {
    const h = harness();
    expect(await h.service.handleMessage(channelMsg({ fromPublicKey: 'bb'.repeat(32), toPublicKey: OWN_KEY, messageType: 'direct' }), SRC)).toBe('out_of_scope');
    expect(await h.service.handleMessage(channelMsg({ text: 'hello all' }), SRC)).toBe('not_mentioned');
    expect(await h.service.handleMessage(channelMsg({ text: '@[MC-Sandbox2] hi' }), SRC)).toBe('not_mentioned');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('skips an ignored sender', async () => {
    const h = harness();
    expect(await h.service.handleMessage(channelMsg({ filtered: 'ignore' }), SRC)).toBe('out_of_scope');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('skips our own messages: by flag, by key, by another source of ours, and by echoed name', async () => {
    const h = harness({ isOwnPublicKey: (k) => k === 'dd'.repeat(32) });
    expect(await h.service.handleMessage(channelMsg({ selfOrigin: true }), SRC)).toBe('own_message');
    expect(await h.service.handleMessage(channelMsg({ fromPublicKey: OWN_KEY, toPublicKey: 'channel-0' }), SRC)).toBe('own_message');
    expect(await h.service.handleMessage(channelMsg({ fromPublicKey: 'dd'.repeat(32), toPublicKey: 'channel-0' }), SRC)).toBe('own_message');
    expect(await h.service.handleMessage(channelMsg({ fromName: 'mc-sandbox' }), SRC)).toBe('own_message');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('does nothing for a source with no own node name', async () => {
    const h = harness({ getOwnNode: () => null });
    expect(await h.service.handleMessage(channelMsg(), SRC)).toBe('no_own_name');
    const h2 = harness({ getOwnNode: () => ({ name: '  ', publicKey: OWN_KEY }) });
    expect(await h2.service.handleMessage(channelMsg(), SRC)).toBe('no_own_name');
  });

  it('one alert per sender per 5 minutes; another sender still gets through', async () => {
    const h = harness();
    expect(await h.service.handleMessage(channelMsg(), SRC)).toBe('sent');
    h.clock.now = T0 + MENTION_COOLDOWN_MS - 1;
    expect(await h.service.handleMessage(channelMsg({ id: 'm2' }), SRC)).toBe('cooldown');
    expect(await h.service.handleMessage(channelMsg({ id: 'm3', fromName: 'Bob' }), SRC)).toBe('sent');
    h.clock.now = T0 + MENTION_COOLDOWN_MS;
    expect(await h.service.handleMessage(channelMsg({ id: 'm4' }), SRC)).toBe('sent');
    expect(h.notify).toHaveBeenCalledTimes(3);
  });

  it('the quiet period is per source', async () => {
    const h = harness();
    expect(await h.service.handleMessage(channelMsg(), SRC)).toBe('sent');
    expect(await h.service.handleMessage(channelMsg(), 'mc-2')).toBe('sent');
  });

  it('the quiet period survives a restart: a new service reads the stored state', async () => {
    const h = harness();
    await h.service.handleMessage(channelMsg(), SRC);
    expect(JSON.parse(h.settings.get(`${SRC}:${SETTING_MENTION_STATE}`)!)).toEqual({ 'n:ann': T0 });

    const restarted = new MeshCoreMentionNotificationService(h.deps);
    h.clock.now = T0 + 60_000;
    expect(await restarted.handleMessage(channelMsg({ id: 'm2' }), SRC)).toBe('cooldown');
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('two mentions arriving together raise one alert', async () => {
    const h = harness();
    const results = await Promise.all([
      h.service.handleMessage(channelMsg({ id: 'a' }), SRC),
      h.service.handleMessage(channelMsg({ id: 'b' }), SRC),
    ]);
    expect(results.sort()).toEqual(['cooldown', 'sent']);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('a failed delivery still uses the slot, so it is not retried on the next mention', async () => {
    const h = harness({ notify: vi.fn(async () => { throw new Error('push down'); }) });
    await expect(h.service.handleMessage(channelMsg(), SRC)).rejects.toThrow('push down');
    h.deps.notify = vi.fn(async () => ({}));
    expect(await h.service.handleMessage(channelMsg({ id: 'm2' }), SRC)).toBe('cooldown');
  });

  it('trims a very long body', async () => {
    const h = harness();
    await h.service.handleMessage(channelMsg({ text: `@[MC-Sandbox] ${'x'.repeat(400)}` }), SRC);
    expect(h.notify.mock.calls[0][0].body.length).toBe(240);
  });
});
