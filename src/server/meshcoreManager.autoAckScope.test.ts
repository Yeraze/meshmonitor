/**
 * Tests for MeshCore Auto-Acknowledge "trigger" scope mode (#3833, #3887).
 *
 * `resolveAutomationScopeOverride('trigger', ...)` picks the reply's scope
 * override from the triggering message. #3887: when the trigger's scope could
 * not be resolved at all (`scopeCode: null` — a common outcome, since scope
 * resolution depends on best-effort raw-packet correlation), the reply must
 * go out unscoped rather than silently falling back to the channel default —
 * the far side's own unscoped repeater won't forward a scoped reply back.
 *
 * These stub the bridge transport and settings/channels DB the same way
 * meshcoreManager.scope.test.ts does — no real backend or DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

function makeManager(opts: {
  scopeMode?: string;
  channelScopes?: Record<number, string | null>;
  defaultScope?: string | null;
} = {}): { manager: MeshCoreManager; bridgeCalls: BridgeCall[] } {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;

  const bridgeCalls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    if (cmd === 'get_channels') return { id: '1', success: true, data: [] };
    return { id: '1', success: true, data: {} };
  };

  vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
    getChannelById: vi.fn(async (id: number, _sourceId?: string) => {
      const scope = opts.channelScopes?.[id];
      return scope === undefined ? null : { id, name: `ch${id}`, scope };
    }),
    updateChannelScope: vi.fn(async () => {}),
    upsertChannel: vi.fn(async () => {}),
    getAllChannels: vi.fn(async () => []),
    deleteChannel: vi.fn(async () => {}),
  } as any);

  const autoAckSettings: Record<string, string | null> = {
    meshcoreAutoAckEnabled: 'true',
    meshcoreAutoAckRegex: '^(test|ping)',
    meshcoreAutoAckChannels: '1',
    meshcoreAutoAckDirectMessages: 'false',
    meshcoreAutoAckCooldownSeconds: '0',
    meshcoreAutoAckUseDM: 'false',
    meshcoreAutoAckMessage: 'ack',
    meshcoreAutoAckPreSendDelaySeconds: '0',
    meshcoreAutoAckScopeMode: opts.scopeMode ?? 'trigger',
    meshcoreDefaultScope: opts.defaultScope ?? null,
  };
  vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
    getSettingForSource: vi.fn(async (_sourceId: string, key: string) =>
      key in autoAckSettings ? autoAckSettings[key] : null),
    setSourceSetting: vi.fn(async () => {}),
  } as any);

  return { manager: m, bridgeCalls };
}

const scopeOf = (calls: BridgeCall[]) =>
  calls.filter(c => c.cmd === 'set_flood_scope').map(c => c.params.region);

function triggerMessage(overrides: Partial<MeshCoreMessage>): MeshCoreMessage {
  return {
    id: 'm1',
    fromPublicKey: 'aa'.repeat(32),
    fromName: 'Alice',
    text: 'ping',
    timestamp: Date.now(),
    scopeName: null,
    scopeCode: null,
    ...overrides,
  };
}

describe('MeshCoreManager — Auto-Ack "trigger" scope mode (#3887)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('replies unscoped when the trigger scope could not be resolved at all (scopeCode: null)', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: null }, defaultScope: 'berlin' });
    const msg = triggerMessage({ scopeCode: null, scopeName: null });
    await (manager as any).checkAutoAcknowledge(msg, false, 1, null, null);
    expect(scopeOf(bridgeCalls)).toEqual([null]);
  });

  it('replies unscoped when the trigger arrived explicitly unscoped (scopeCode: 0)', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: null }, defaultScope: 'berlin' });
    const msg = triggerMessage({ scopeCode: 0, scopeName: null });
    await (manager as any).checkAutoAcknowledge(msg, false, 1, null, null);
    expect(scopeOf(bridgeCalls)).toEqual([null]);
  });

  it('replies on the trigger\'s named scope when resolved', async () => {
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: null }, defaultScope: 'berlin' });
    const msg = triggerMessage({ scopeCode: 123, scopeName: 'lyon' });
    await (manager as any).checkAutoAcknowledge(msg, false, 1, null, null);
    expect(scopeOf(bridgeCalls)).toEqual(['lyon']);
  });

  it('replies unscoped for a known-but-unmapped scope code (#3998)', async () => {
    // scopeCode > 0 but no resolved region name: scoped to a region we can't name,
    // so it can't be reproduced. "Match the trigger scope" degrades to unscoped
    // rather than substituting the node's unrelated default (was: 'berlin', #3887).
    const { manager, bridgeCalls } = makeManager({ channelScopes: { 1: null }, defaultScope: 'berlin' });
    const msg = triggerMessage({ scopeCode: 456, scopeName: null });
    await (manager as any).checkAutoAcknowledge(msg, false, 1, null, null);
    expect(scopeOf(bridgeCalls)).toEqual([null]);
  });
});
