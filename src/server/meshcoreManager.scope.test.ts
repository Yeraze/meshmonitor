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
  /** make `set_flood_scope` await a real macrotask so interleaving is actually
   *  exercised (the lock must hold scope-assert→send together) */
  floodScopeDelayMs?: number;
  /** contacts to seed for region discovery (advType 2=repeater, 3=room) */
  contacts?: Array<{ publicKey: string; advType: number; name?: string }>;
  /** per-repeater `request_regions` replies, keyed by publicKey. A value of
   *  'fail' makes that repeater's request reject. */
  regionsByRepeater?: Record<string, string[] | 'fail'>;
  /** Simulated 0-hop discovery sweep result(s) for discoverRegions (#3743).
   *  - omitted → every sweep "discovers" all seeded repeater/room contacts
   *  - string[] → every sweep discovers exactly these keys (in this order)
   *  - string[][] → attempt i discovers zeroHop[i] (drives the retry path);
   *    attempts past the end repeat the last entry. Pass [] for always-empty. */
  zeroHop?: string[] | string[][];
} = {}): { manager: MeshCoreManager; bridgeCalls: BridgeCall[]; scopeUpdates: Array<{ id: number; scope: string | null }> } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  if (opts.contacts) {
    (m as any).contacts = new Map(opts.contacts.map((c) => [c.publicKey, c]));
  }

  const bridgeCalls: BridgeCall[] = [];
  const scopeUpdates: Array<{ id: number; scope: string | null }> = [];
  let floodScopeFailsLeft = opts.failFloodScopeTimes ?? 0;

  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'get_channels') return { id: '1', success: true, data: [] };
    if (cmd === 'request_regions') {
      const pk = params.public_key as string;
      const r = opts.regionsByRepeater?.[pk];
      if (r === 'fail') throw new Error('repeater did not answer');
      return { id: '1', success: true, data: { clock: 0, regions: r ?? [] } };
    }
    if (cmd === 'set_flood_scope') {
      if (floodScopeFailsLeft > 0) {
        floodScopeFailsLeft -= 1;
        return { id: '1', success: false, error: 'transport closed' };
      }
      if (opts.floodScopeDelayMs) {
        await new Promise((r) => setTimeout(r, opts.floodScopeDelayMs));
      }
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

  // Simulate the 0-hop discovery sweep that discoverRegions() runs (#3743) so
  // tests don't wait on the real 8s collection window or fake discovery packets.
  const defaultZeroHop = (opts.contacts ?? [])
    .filter((c) => c.advType === 2 || c.advType === 3)
    .map((c) => c.publicKey);
  const sweepAttempts: string[][] =
    opts.zeroHop === undefined
      ? [defaultZeroHop]
      : opts.zeroHop.length > 0 && Array.isArray(opts.zeroHop[0])
        ? (opts.zeroHop as string[][])
        : [opts.zeroHop as string[]];
  let sweepIdx = 0;
  vi.spyOn(m as any, 'discoverNodes').mockImplementation(async () => {
    const seen = sweepAttempts[Math.min(sweepIdx, sweepAttempts.length - 1)] ?? [];
    sweepIdx += 1;
    return { returned: seen.length, newCount: 0, seen };
  });
  // discoverRegions installs a zero-hop direct out_path before each
  // request_regions (#3743) so the ANON_REQ routes direct. Stub the device
  // round-trip + DB mirror; these tests assert selection/ordering, not routing.
  vi.spyOn(m as any, 'setContactOutPath').mockResolvedValue(true);

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

describe('MeshCoreManager — per-message scope override (#3701)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('a per-message override beats the channel scope (and still asserts before send)', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' } });
    const ok = await manager.sendMessage('hi', undefined, 1, 'augsburg');
    expect(ok).toBe(true);
    // The override is asserted on the device immediately before the send.
    expect(cmdSeq(bridgeCalls)).toEqual(['set_flood_scope', 'send_message']);
    expect(scopeOf(bridgeCalls)).toEqual(['augsburg']);
  });

  it('a per-message override beats the source default scope', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: null }, defaultScope: 'berlin' });
    await manager.sendMessage('hi', undefined, 1, 'augsburg');
    expect(scopeOf(bridgeCalls)).toEqual(['augsburg']);
  });

  it('normalizes the override (strips leading # and disallowed chars)', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' } });
    await manager.sendMessage('hi', undefined, 1, '#Bad Scope!');
    // '#' stripped, space + '!' removed, letters/digits kept.
    expect(scopeOf(bridgeCalls)).toEqual(['BadScope']);
  });

  it('an empty/whitespace override is an explicit unscoped send (null)', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' }, defaultScope: 'berlin' });
    await manager.sendMessage('hi', undefined, 1, '   ');
    expect(scopeOf(bridgeCalls)).toEqual([null]);
  });

  it('omitting the override falls back to the channel scope (unchanged behaviour)', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' }, defaultScope: 'berlin' });
    await manager.sendMessage('hi', undefined, 1);
    expect(scopeOf(bridgeCalls)).toEqual(['muenchen']);
  });

  it('does NOT persist the override — the next normal send re-asserts the channel scope', async () => {
    const { manager, bridgeCalls, scopeUpdates } = makeManager({ channelScopes: { 1: 'muenchen' } });
    await manager.sendMessage('one', undefined, 1, 'augsburg');
    await manager.sendMessage('two', undefined, 1);
    // First send used the override, second re-asserts the channel scope.
    expect(scopeOf(bridgeCalls)).toEqual(['augsburg', 'muenchen']);
    // The channel row was never written.
    expect(scopeUpdates).toHaveLength(0);
  });

  it('serialises a per-message override send concurrent with a normal send so each scope pairs with its own send', async () => {
    // #3704 review item 4: the existing concurrency test (above, in the #3667
    // block) only covers two different *channel* scopes. This proves the
    // serializer also atomically pairs an explicit per-message override with its
    // send, and the channel/default scope with the non-override send, without
    // interleaving. floodScopeDelayMs forces a real yield between scope-assert
    // and send, so a broken lock would let the second send slip in between.
    const { manager, bridgeCalls } = makeManager({
      channelScopes: { 1: 'muenchen' },
      defaultScope: 'berlin',
      floodScopeDelayMs: 5,
    });
    // Fire both at once: an override send on ch1, and a normal send on ch1.
    await Promise.all([
      manager.sendMessage('override', undefined, 1, 'augsburg'),
      manager.sendMessage('normal', undefined, 1),
    ]);
    // Each scope is asserted immediately before its own send — never the broken
    // ordering scope, scope, send, send. The override asserts 'augsburg', the
    // normal send re-asserts the channel scope 'muenchen'.
    const relevant = bridgeCalls
      .filter(c => c.cmd === 'set_flood_scope' || c.cmd === 'send_message')
      .map(c => c.cmd === 'set_flood_scope' ? `scope:${c.params.region}` : c.cmd);
    expect(relevant).toEqual(['scope:augsburg', 'send_message', 'scope:muenchen', 'send_message']);
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

describe('MeshCoreManager — Phase 2: scope on originated flood traffic (#3667)', () => {
  beforeEach(() => vi.restoreAllMocks());

  // Sequence of scope-asserts + the originated command under test.
  const seq = (calls: BridgeCall[], cmd: string) =>
    calls.filter(c => c.cmd === 'set_flood_scope' || c.cmd === cmd).map(c => c.cmd);

  it('asserts the default scope before a companion advert', async () => {
    const { manager, bridgeCalls } = makeManager({ defaultScope: 'berlin' });
    const ok = await manager.sendAdvert();
    expect(ok).toBe(true);
    expect(seq(bridgeCalls, 'send_advert')).toEqual(['set_flood_scope', 'send_advert']);
    expect(scopeOf(bridgeCalls)).toEqual(['berlin']);
  });

  it('asserts the default scope before a remote login', async () => {
    const { manager, bridgeCalls } = makeManager({ defaultScope: 'berlin' });
    await manager.loginToNode('deadbeef', 'pw');
    expect(seq(bridgeCalls, 'login')).toEqual(['set_flood_scope', 'login']);
  });

  it('asserts the default scope before a telemetry request', async () => {
    const { manager, bridgeCalls } = makeManager({ defaultScope: 'berlin' });
    await manager.requestRemoteTelemetry('deadbeef');
    expect(seq(bridgeCalls, 'request_telemetry')).toEqual(['set_flood_scope', 'request_telemetry']);
  });

  it('asserts unscoped (null) for originated traffic when no default scope is set', async () => {
    const { manager, bridgeCalls } = makeManager({});
    await manager.sendAdvert();
    expect(scopeOf(bridgeCalls)).toEqual([null]);
  });

  it('asserts the default scope before a remote CLI command', async () => {
    const { manager, bridgeCalls } = makeManager({ defaultScope: 'berlin' });
    // The reply never arrives in the harness, so the command times out — but by
    // then the scope-assert→send ordering is already observable.
    await expect(manager.sendCliCommand('ab'.repeat(32), 'ver', { timeoutMs: 50 }))
      .rejects.toThrow(/timed out/);
    expect(seq(bridgeCalls, 'send_cli')).toEqual(['set_flood_scope', 'send_cli']);
  });

  it('rejects a CLI command without sending when the scope assertion fails', async () => {
    const { manager, bridgeCalls } = makeManager({ defaultScope: 'berlin', failFloodScopeTimes: 1 });
    await expect(manager.sendCliCommand('ab'.repeat(32), 'ver', { timeoutMs: 1000 }))
      .rejects.toThrow('transport closed');
    expect(bridgeCalls.some(c => c.cmd === 'send_cli')).toBe(false);
  });

  it('serialises an advert (default scope) concurrent with a channel send (channel scope)', async () => {
    // floodScopeDelayMs forces a real yield between scope-assert and send, so a
    // broken lock would let the second send interleave — the ordering assertion
    // below would then fail.
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: 'muenchen' }, defaultScope: 'berlin', floodScopeDelayMs: 5 });
    // Advert first, then a channel message — both serialise on the same lock.
    await Promise.all([
      manager.sendAdvert(),
      manager.sendMessage('hi', undefined, 1),
    ]);
    // Each scope is asserted immediately before its own send — never interleaved.
    const relevant = bridgeCalls
      .filter(c => ['set_flood_scope', 'send_advert', 'send_message'].includes(c.cmd))
      .map(c => c.cmd === 'set_flood_scope' ? `scope:${c.params.region}` : c.cmd);
    expect(relevant).toEqual(['scope:berlin', 'send_advert', 'scope:muenchen', 'send_message']);
  });

  it('does not emit the advert when the scope assertion fails', async () => {
    const { manager, bridgeCalls } = makeManager({ defaultScope: 'berlin', failFloodScopeTimes: 1 });
    const ok = await manager.sendAdvert();
    expect(ok).toBe(false);
    expect(bridgeCalls.some(c => c.cmd === 'send_advert')).toBe(false);
  });
});

describe('MeshCoreManager — Phase 3: region discovery (#3667)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('queries repeater/room contacts and returns the de-duplicated, sorted region set', async () => {
    const { manager, bridgeCalls } = makeManager({
      contacts: [
        { publicKey: 'aa'.repeat(32), advType: 2, name: 'Rptr-A' }, // repeater
        { publicKey: 'bb'.repeat(32), advType: 3, name: 'Room-B' },  // room server
        { publicKey: 'cc'.repeat(32), advType: 0, name: 'Chat-C' },  // plain chat — must be skipped
      ],
      regionsByRepeater: {
        ['aa'.repeat(32)]: ['muenchen', 'bayern', '*'], // '*' wildcard must be filtered
        ['bb'.repeat(32)]: ['bayern', 'augsburg'],       // 'bayern' overlaps → deduped
      },
    });

    const result = await manager.discoverRegions();

    // Only the two infra contacts were queried (chat contact skipped).
    expect(bridgeCalls.filter(c => c.cmd === 'request_regions').map(c => c.params.public_key))
      .toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
    // De-duplicated, sorted, wildcard removed.
    expect(result.regions).toEqual(['augsburg', 'bayern', 'muenchen']);
    expect(result.perRepeater).toHaveLength(2);
    expect(result.perRepeater[0].regions).toEqual(['muenchen', 'bayern']);
  });

  it('skips repeaters that do not answer and still returns the rest', async () => {
    const { manager } = makeManager({
      contacts: [
        { publicKey: 'aa'.repeat(32), advType: 2 },
        { publicKey: 'bb'.repeat(32), advType: 2 },
      ],
      regionsByRepeater: {
        ['aa'.repeat(32)]: 'fail',
        ['bb'.repeat(32)]: ['muenchen'],
      },
    });
    const result = await manager.discoverRegions();
    expect(result.regions).toEqual(['muenchen']);
    expect(result.perRepeater.map(r => r.publicKey)).toEqual(['bb'.repeat(32)]);
  });

  it('returns empty on a non-companion device without querying', async () => {
    const { manager, bridgeCalls } = makeManager({
      contacts: [{ publicKey: 'aa'.repeat(32), advType: 2 }],
      regionsByRepeater: { ['aa'.repeat(32)]: ['muenchen'] },
    });
    (manager as any).deviceType = MeshCoreDeviceType.REPEATER;
    const result = await manager.discoverRegions();
    expect(result).toEqual({ regions: [], perRepeater: [] });
    expect(bridgeCalls.some(c => c.cmd === 'request_regions')).toBe(false);
    expect(manager.discoverNodes).not.toHaveBeenCalled();
  });

  it('runs a repeater+room-server (0x0C) sweep before querying', async () => {
    const { manager } = makeManager({
      contacts: [{ publicKey: 'aa'.repeat(32), advType: 2 }],
      regionsByRepeater: { ['aa'.repeat(32)]: ['muenchen'] },
    });
    await manager.discoverRegions();
    expect(manager.discoverNodes).toHaveBeenCalledWith(0x0c, expect.any(Number));
  });

  it('queries only the repeaters returned by the 0-hop sweep, not every known repeater', async () => {
    const aa = 'aa'.repeat(32), bb = 'bb'.repeat(32), dd = 'dd'.repeat(32);
    const { manager, bridgeCalls } = makeManager({
      contacts: [
        { publicKey: aa, advType: 2 }, // known but far — not in sweep
        { publicKey: bb, advType: 2 }, // 0-hop
        { publicKey: dd, advType: 3 }, // known but far — not in sweep
      ],
      regionsByRepeater: { [bb]: ['muenchen'] },
      zeroHop: [bb], // only bb answered the sweep
    });
    const result = await manager.discoverRegions();
    expect(bridgeCalls.filter(c => c.cmd === 'request_regions').map(c => c.params.public_key)).toEqual([bb]);
    expect(result.perRepeater.map(r => r.publicKey)).toEqual([bb]);
    expect(result.regions).toEqual(['muenchen']);
    // Installs a zero-hop direct out_path (empty bytes) before querying, so the
    // regions ANON_REQ routes direct rather than flooding (#3743).
    expect(manager.setContactOutPath).toHaveBeenCalledWith(bb, expect.any(Uint8Array), 1, expect.any(Number));
    const [, installedPath] = (manager.setContactOutPath as any).mock.calls.find((c: any[]) => c[0] === bb);
    expect(installedPath.length).toBe(0);
  });

  it('queries in sweep arrival order, not contact-map order', async () => {
    const aa = 'aa'.repeat(32), bb = 'bb'.repeat(32);
    const { manager, bridgeCalls } = makeManager({
      contacts: [
        { publicKey: aa, advType: 2 }, // inserted first
        { publicKey: bb, advType: 2 },
      ],
      regionsByRepeater: { [aa]: ['augsburg'], [bb]: ['muenchen'] },
      zeroHop: [bb, aa], // bb answered the sweep first
    });
    await manager.discoverRegions();
    expect(bridgeCalls.filter(c => c.cmd === 'request_regions').map(c => c.params.public_key)).toEqual([bb, aa]);
  });

  it('retries the sweep once when the first finds no 0-hop repeaters, then queries', async () => {
    const bb = 'bb'.repeat(32);
    const { manager, bridgeCalls } = makeManager({
      contacts: [{ publicKey: bb, advType: 2 }],
      regionsByRepeater: { [bb]: ['muenchen'] },
      zeroHop: [[], [bb]], // first sweep empty, retry finds bb
    });
    const result = await manager.discoverRegions();
    expect(manager.discoverNodes).toHaveBeenCalledTimes(2);
    expect(result.regions).toEqual(['muenchen']);
    expect(result.noZeroHopRepeaters).toBeUndefined();
    expect(bridgeCalls.filter(c => c.cmd === 'request_regions')).toHaveLength(1);
  });

  it('returns noZeroHopRepeaters after two empty sweeps, querying nobody', async () => {
    const { manager, bridgeCalls } = makeManager({
      contacts: [{ publicKey: 'bb'.repeat(32), advType: 2 }], // known but none answered
      zeroHop: [], // every sweep empty
    });
    const result = await manager.discoverRegions();
    expect(manager.discoverNodes).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ regions: [], perRepeater: [], noZeroHopRepeaters: true });
    expect(bridgeCalls.some(c => c.cmd === 'request_regions')).toBe(false);
  });

  it('reports noZeroHopRepeaters when no known contact is a repeater', async () => {
    const { manager, bridgeCalls } = makeManager({
      contacts: [{ publicKey: 'cc'.repeat(32), advType: 0 }], // plain chat only
    });
    const result = await manager.discoverRegions();
    expect(result).toEqual({ regions: [], perRepeater: [], noZeroHopRepeaters: true });
    expect(bridgeCalls.some(c => c.cmd === 'request_regions')).toBe(false);
  });
});
