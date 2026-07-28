/**
 * MeshCore Auto-Acknowledge sender ignore list — skip decision (#4391).
 *
 * A sender on `meshcoreAutoAckIgnoredNodes` must get no auto-reply; everyone
 * else still does. Entries match a public key (or key prefix) and/or a
 * contact/sender name, and the setting is read per source.
 *
 * Stubs the bridge transport and the settings/channels DB the same way
 * meshcoreManager.autoAckScope.test.ts does — no real backend or DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';

const FULL_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const DM_PREFIX = 'a1b2c3d4e5f6';

/** Records every (sourceId, key) pair the manager asked the settings store for. */
type SettingsRead = { sourceId: string; key: string };

function makeManager(opts: {
  sourceId?: string;
  /** Per-source ignore-list value; keyed by sourceId. */
  ignoredBySource?: Record<string, string | null>;
  contacts?: Array<{ publicKey: string; advName?: string; name?: string }>;
} = {}) {
  const sourceId = opts.sourceId ?? 'source-a';
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;

  for (const c of opts.contacts ?? []) {
    (m as any).contacts.set(c.publicKey, c);
  }

  const sends: Array<{ text: string; dest?: string; channel?: number }> = [];
  (m as any).sendMessage = vi.fn(async (text: string, dest?: string, channel?: number) => {
    sends.push({ text, dest, channel });
    return true;
  });

  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    getChannelById: vi.fn(async (id: number) => ({ id, name: `ch${id}`, scope: null })),
    updateChannelScope: vi.fn(async () => {}),
    upsertChannel: vi.fn(async () => {}),
    getAllChannels: vi.fn(async () => []),
    deleteChannel: vi.fn(async () => {}),
  } as any);

  const base: Record<string, string | null> = {
    meshcoreAutoAckEnabled: 'true',
    meshcoreAutoAckRegex: '^(test|ping)',
    meshcoreAutoAckChannels: '1',
    meshcoreAutoAckDirectMessages: 'true',
    meshcoreAutoAckCooldownSeconds: '0',
    meshcoreAutoAckUseDM: 'false',
    meshcoreAutoAckMessage: 'ack',
    meshcoreAutoAckPreSendDelaySeconds: '0',
    meshcoreAutoAckScopeMode: 'inherit',
  };

  const reads: SettingsRead[] = [];
  vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
    getSettingForSource: vi.fn(async (sid: string, key: string) => {
      reads.push({ sourceId: sid, key });
      if (key === 'meshcoreAutoAckIgnoredNodes') return opts.ignoredBySource?.[sid] ?? null;
      return key in base ? base[key] : null;
    }),
    setSourceSetting: vi.fn(async () => {}),
  } as any);

  return { manager: m, sends, reads };
}

function dmMessage(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'm1',
    fromPublicKey: DM_PREFIX,
    fromName: 'Echo Bot',
    text: 'ping',
    timestamp: Date.now(),
    scopeCode: null,
    scopeName: null,
    ...overrides,
  };
}

function channelMessage(overrides: Partial<MeshCoreMessage> = {}): MeshCoreMessage {
  return {
    id: 'm2',
    // Channel packets carry no sender key — the manager synthesises this.
    fromPublicKey: 'channel-1',
    fromName: 'Echo Bot',
    text: 'ping',
    timestamp: Date.now(),
    scopeCode: null,
    scopeName: null,
    ...overrides,
  };
}

describe('MeshCoreManager — Auto-Ack sender ignore list (#4391)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('replies when the ignore list is unset', async () => {
    const { manager, sends } = makeManager();
    await (manager as any).checkAutoAcknowledge(channelMessage(), false, 1, null, null);
    expect(sends).toHaveLength(1);
  });

  it('replies when the ignore list is whitespace-only', async () => {
    const { manager, sends } = makeManager({ ignoredBySource: { 'source-a': '  \n , \n ' } });
    await (manager as any).checkAutoAcknowledge(channelMessage(), false, 1, null, null);
    expect(sends).toHaveLength(1);
  });

  it('skips a DM sender listed by full public key (message carries only the prefix)', async () => {
    const { manager, sends } = makeManager({
      ignoredBySource: { 'source-a': FULL_KEY },
      contacts: [{ publicKey: FULL_KEY, advName: 'Echo Bot' }],
    });
    await (manager as any).checkAutoAcknowledge(dmMessage(), true, undefined, null, null);
    expect(sends).toHaveLength(0);
  });

  it('skips a DM sender listed by short key prefix with a leading "!"', async () => {
    const { manager, sends } = makeManager({
      ignoredBySource: { 'source-a': '!A1B2C3' },
      contacts: [{ publicKey: FULL_KEY, advName: 'Echo Bot' }],
    });
    await (manager as any).checkAutoAcknowledge(dmMessage(), true, undefined, null, null);
    expect(sends).toHaveLength(0);
  });

  it('replies to a DM sender whose key is not on the list', async () => {
    const { manager, sends } = makeManager({
      ignoredBySource: { 'source-a': 'ffeeddcc' },
      contacts: [{ publicKey: FULL_KEY, advName: 'Echo Bot' }],
    });
    await (manager as any).checkAutoAcknowledge(dmMessage(), true, undefined, null, null);
    expect(sends).toHaveLength(1);
  });

  it('skips a channel sender listed by name (case/space-insensitive)', async () => {
    const { manager, sends } = makeManager({ ignoredBySource: { 'source-a': 'echo   BOT' } });
    await (manager as any).checkAutoAcknowledge(channelMessage(), false, 1, null, null);
    expect(sends).toHaveLength(0);
  });

  it('skips a sender matched via the resolved contact name, not the message name', async () => {
    const { manager, sends } = makeManager({
      ignoredBySource: { 'source-a': 'Weather Relay' },
      contacts: [{ publicKey: FULL_KEY, advName: 'Weather Relay' }],
    });
    await (manager as any).checkAutoAcknowledge(
      dmMessage({ fromName: undefined }), true, undefined, null, null,
    );
    expect(sends).toHaveLength(0);
  });

  it('replies to a channel sender whose name is not on the list', async () => {
    const { manager, sends } = makeManager({ ignoredBySource: { 'source-a': 'Someone Else' } });
    await (manager as any).checkAutoAcknowledge(channelMessage(), false, 1, null, null);
    expect(sends).toHaveLength(1);
  });

  it('reads the ignore list for its own sourceId', async () => {
    const { manager, reads } = makeManager({ sourceId: 'source-b' });
    await (manager as any).checkAutoAcknowledge(channelMessage(), false, 1, null, null);
    const ignoreReads = reads.filter(r => r.key === 'meshcoreAutoAckIgnoredNodes');
    expect(ignoreReads).toHaveLength(1);
    expect(ignoreReads[0].sourceId).toBe('source-b');
  });

  it('isolates the list per source — source-a skips, source-b still replies', async () => {
    const ignoredBySource = { 'source-a': 'Echo Bot', 'source-b': null };

    const a = makeManager({ sourceId: 'source-a', ignoredBySource });
    await (a.manager as any).checkAutoAcknowledge(channelMessage(), false, 1, null, null);
    expect(a.sends).toHaveLength(0);

    vi.restoreAllMocks();
    const b = makeManager({ sourceId: 'source-b', ignoredBySource });
    await (b.manager as any).checkAutoAcknowledge(channelMessage(), false, 1, null, null);
    expect(b.sends).toHaveLength(1);
  });

  it('does not consume a cooldown slot for an ignored sender', async () => {
    const { manager, sends } = makeManager({ ignoredBySource: { 'source-a': 'Echo Bot' } });
    await (manager as any).checkAutoAcknowledge(channelMessage(), false, 1, null, null);
    expect((manager as any).autoAckCooldowns.size).toBe(0);
    expect(sends).toHaveLength(0);
  });
});
