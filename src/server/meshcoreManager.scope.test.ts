/**
 * Tests for MeshCore region/scope on the send path (#3667).
 *
 * The device holds a SINGLE global flood scope; the manager asserts it via the
 * `set_flood_scope` bridge command immediately before each `send_message`,
 * resolving channel-scope ?? source-default-scope ?? unscoped. Because the
 * scope is global+stateful, the set-scope→send pair is serialised per source.
 *
 * These tests stub the bridge transport and the DB the same way
 * meshcoreManager.channels.test.ts does — no real backend or DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

function makeManager(opts: {
  /** scope stored on a channel, keyed by idx */
  channelScopes?: Record<number, string | null>;
  /** value returned for the meshcoreDefaultScope per-source setting */
  defaultScope?: string | null;
  /** make the first N `set_flood_scope` bridge calls fail (transport error) */
  failFloodScopeTimes?: number;
} = {}): { manager: MeshCoreManager; bridgeCalls: BridgeCall[]; scopeUpdates: Array<{ id: number; scope: string | null }> } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;

  const bridgeCalls: BridgeCall[] = [];
  const scopeUpdates: Array<{ id: number; scope: string | null }> = [];
  let floodScopeFailsLeft = opts.failFloodScopeTimes ?? 0;

  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'get_channels') return { id: '1', success: true, data: [] };
    if (cmd === 'set_flood_scope' && floodScopeFailsLeft > 0) {
      floodScopeFailsLeft -= 1;
      return { id: '1', success: false, error: 'transport closed' };
    }
    return { id: '1', success: true, data: {} };
  };

  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    getChannelById: vi.fn(async (id: number, _sourceId?: string) => {
      const scope = opts.channelScopes?.[id];
      return scope === undefined ? null : { id, name: `ch${id}`, scope };
    }),
    updateChannelScope: vi.fn(async (id: number, scope: string | null) => {
      scopeUpdates.push({ id, scope });
    }),
    upsertChannel: vi.fn(async () => {}),
    getAllChannels: vi.fn(async () => []),
    deleteChannel: vi.fn(async () => {}),
  } as any);

  vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
    getSettingForSource: vi.fn(async (_sourceId: string, key: string) => {
      if (key === 'meshcoreDefaultScope') return opts.defaultScope ?? null;
      return null;
    }),
    setSourceSetting: vi.fn(async () => {}),
  } as any);

  return { manager: m, bridgeCalls, scopeUpdates };
}

const scopeOf = (calls: BridgeCall[]) =>
  calls.filter(c => c.cmd === 'set_flood_scope').map(c => c.params.region);

const cmdSeq = (calls: BridgeCall[]) =>
  calls.filter(c => c.cmd === 'set_flood_scope' || c.cmd === 'send_message').map(c => c.cmd);

describe('MeshCoreManager — scope resolution on send (#3667)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('asserts the channel scope before a channel send', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' } });
    await manager.sendMessage('hi', undefined, 1);

    expect(cmdSeq(bridgeCalls)).toEqual(['set_flood_scope', 'send_message']);
    expect(bridgeCalls.find(c => c.cmd === 'set_flood_scope')!.params).toEqual({ region: 'muenchen' });
  });

  it('falls back to the source default scope when the channel has none', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: null }, defaultScope: 'berlin' });
    await manager.sendMessage('hi', undefined, 1);
    expect(scopeOf(bridgeCalls)).toEqual(['berlin']);
  });

  it('channel scope overrides the default scope', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' }, defaultScope: 'berlin' });
    await manager.sendMessage('hi', undefined, 1);
    expect(scopeOf(bridgeCalls)).toEqual(['muenchen']);
  });

  it('a DM uses the default scope', async () => {
    const { manager, bridgeCalls } = makeManager({ defaultScope: 'berlin' });
    await manager.sendMessage('hi', 'deadbeef');
    expect(scopeOf(bridgeCalls)).toEqual(['berlin']);
  });

  it('asserts null (unscoped) when neither channel nor default scope is set', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: null } });
    await manager.sendMessage('hi', undefined, 1);
    expect(scopeOf(bridgeCalls)).toEqual([null]);
  });

  it('does not re-assert when the next send needs the same scope (cache)', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' } });
    await manager.sendMessage('one', undefined, 1);
    await manager.sendMessage('two', undefined, 1);
    // set_flood_scope only once; both messages sent.
    expect(scopeOf(bridgeCalls)).toEqual(['muenchen']);
    expect(bridgeCalls.filter(c => c.cmd === 'send_message')).toHaveLength(2);
  });

  it('re-asserts when a later send needs a different scope', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen', 2: 'berlin' } });
    await manager.sendMessage('one', undefined, 1);
    await manager.sendMessage('two', undefined, 2);
    expect(scopeOf(bridgeCalls)).toEqual(['muenchen', 'berlin']);
  });

  it('does NOT send when the scope assertion fails, and re-asserts on the next send', async () => {
    // Load-bearing for the Germany use case: if we can't assert the scope we
    // must not fall back to an unscoped send (which the mesh would drop). The
    // failed send returns false and leaves the cached scope invalidated so the
    // next attempt re-asserts.
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' }, failFloodScopeTimes: 1 });

    const first = await manager.sendMessage('one', undefined, 1);
    expect(first).toBe(false);
    // set_flood_scope was attempted but send_message was NOT reached.
    expect(cmdSeq(bridgeCalls)).toEqual(['set_flood_scope']);

    // Next send re-asserts the scope (cache was invalidated) and goes through.
    const second = await manager.sendMessage('two', undefined, 1);
    expect(second).toBe(true);
    expect(cmdSeq(bridgeCalls)).toEqual(['set_flood_scope', 'set_flood_scope', 'send_message']);
  });

  it('serialises concurrent sends so each scope is asserted right before its own send', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen', 2: 'berlin' } });
    // Fire two sends with different scopes without awaiting between them.
    await Promise.all([
      manager.sendMessage('one', undefined, 1),
      manager.sendMessage('two', undefined, 2),
    ]);
    // The interleaving must be scope→send, scope→send — never scope, scope, send, send.
    expect(cmdSeq(bridgeCalls)).toEqual(['set_flood_scope', 'send_message', 'set_flood_scope', 'send_message']);
  });
});

describe('MeshCoreManager — setChannel / setDefaultScope scope handling (#3667)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('setChannel persists the scope and invalidates the cached device scope', async () => {
    const { manager, bridgeCalls, scopeUpdates } = makeManager({ channelScopes: { 3: 'oldscope' } });
    // Prime the cache so we can prove invalidation.
    await manager.sendMessage('prime', undefined, 3);
    expect(scopeOf(bridgeCalls)).toEqual(['oldscope']);

    await manager.setChannel(3, 'Town', 'aa'.repeat(16), 'newscope');
    expect(scopeUpdates).toContainEqual({ id: 3, scope: 'newscope' });

    // Make the channel now resolve to the new scope and confirm a re-assert.
    (databaseService.channels.getChannelById as any) = vi.fn(async (id: number) => ({ id, name: 't', scope: 'newscope' }));
    await manager.sendMessage('after', undefined, 3);
    expect(scopeOf(bridgeCalls)).toEqual(['oldscope', 'newscope']);
  });

  it('setChannel with undefined scope leaves scope untouched (no updateChannelScope call)', async () => {
    const { manager, scopeUpdates } = makeManager({});
    await manager.setChannel(2, 'New', 'bb'.repeat(16));
    expect(scopeUpdates).toHaveLength(0);
  });

  it('setDefaultScope normalizes a leading # and clears on empty', async () => {
    const { manager } = makeManager({});
    expect(await manager.setDefaultScope('#muenchen')).toBe('muenchen');
    expect(await manager.setDefaultScope('  ')).toBe('');
  });
});
