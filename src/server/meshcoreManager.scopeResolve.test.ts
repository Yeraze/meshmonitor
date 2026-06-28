/**
 * Integration test for #3742 Phase 2 — the manager wires a received message's
 * raw OTA bytes + the cached known-scope set through resolveMessageScope and
 * stamps scopeCode/scopeName onto the stored MeshCoreMessage.
 *
 * The crypto itself is covered exhaustively in meshcoreScopeResolve.test.ts;
 * here we prove the handler plumbing (raw_hex → knownScopes → message fields).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const insertMessage = vi.fn().mockResolvedValue(undefined);
const getSettingForSource = vi.fn().mockResolvedValue(undefined);
const getAllSavedRegions = vi.fn().mockResolvedValue([]);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: { insertMessage: (...a: unknown[]) => insertMessage(...a) },
    settings: { getSettingForSource: (...a: unknown[]) => getSettingForSource(...a) },
    channels: { getAllChannels: vi.fn().mockResolvedValue([]) },
    savedRegions: { getAllAsync: (...a: unknown[]) => getAllSavedRegions(...a) },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreOtaPacket: vi.fn(),
    emitMeshCoreChannelHeard: vi.fn(),
    emitMeshCoreContactUpdated: vi.fn(),
  },
}));

import { MeshCoreManager } from './meshcoreManager.js';

// TRANSPORT_FLOOD packet sent under scope "muenchen": header 0x14 (payloadType
// 5), transportCode1 30479, path byte 0x02 (2 hops a3,7f), payload cafe0102.
const SCOPED_RAW = '140f77000002a37fcafe0102';
// Same packet sent FLOOD (route_type 1) → no transport code → unscoped.
const UNSCOPED_RAW = '1502a37fcafe0102';

function dispatch(m: MeshCoreManager, data: Record<string, unknown>): void {
  // @ts-expect-error - exercising the private bridge-event handler
  m.handleBridgeEvent({ event_type: 'channel_message', data });
}

function lastMessage(m: MeshCoreManager) {
  const all = m.getRecentMessages(10);
  return all[all.length - 1];
}

describe('MeshCoreManager scope resolution (#3742 Phase 2)', () => {
  let m: MeshCoreManager;

  beforeEach(() => {
    vi.clearAllMocks();
    getAllSavedRegions.mockResolvedValue([]);
    m = new MeshCoreManager('src-a');
    // Seed the known-scope cache directly (normally primed on connect).
    (m as any).knownScopes = new Set(['muenchen']);
  });

  it('resolves a scoped message to a known scope name', () => {
    dispatch(m, { channel_idx: 0, text: 'Bob: hi', path_len: 2, path_hops: ['a3', '7f'], raw_hex: SCOPED_RAW });
    const msg = lastMessage(m);
    expect(msg.scopeCode).toBe(30479);
    expect(msg.scopeName).toBe('muenchen');
  });

  it('marks a scoped message from an UNKNOWN scope with the raw code and no name', () => {
    (m as any).knownScopes = new Set(['some-other-region']);
    dispatch(m, { channel_idx: 0, text: 'Bob: hi', path_len: 2, path_hops: ['a3', '7f'], raw_hex: SCOPED_RAW });
    const msg = lastMessage(m);
    expect(msg.scopeCode).toBe(30479);
    expect(msg.scopeName).toBeNull();
  });

  it('marks an unscoped (non-transport route) message with scopeCode 0', () => {
    dispatch(m, { channel_idx: 0, text: 'Bob: hi', path_len: 2, path_hops: ['a3', '7f'], raw_hex: UNSCOPED_RAW });
    const msg = lastMessage(m);
    expect(msg.scopeCode).toBe(0);
    expect(msg.scopeName).toBeNull();
  });

  it('leaves scope null when no raw_hex was correlated to the message', () => {
    dispatch(m, { channel_idx: 0, text: 'Bob: hi', path_len: 2, path_hops: ['a3', '7f'] });
    const msg = lastMessage(m);
    expect(msg.scopeCode).toBeNull();
    expect(msg.scopeName).toBeNull();
  });
});

describe('MeshCoreManager refreshKnownScopes includes saved regions (#3829)', () => {
  it('populates knownScopes from the saved-regions catalog', async () => {
    vi.clearAllMocks();
    // saved-regions catalog has "muenchen"; no per-channel scope, no default scope
    getAllSavedRegions.mockResolvedValue([{ id: 1, name: 'muenchen', note: null, createdAt: 0, updatedAt: 0 }]);
    getSettingForSource.mockResolvedValue(null);

    const m2 = new MeshCoreManager('src-b');
    await (m2 as any).refreshKnownScopes();

    expect((m2 as any).knownScopes.has('muenchen')).toBe(true);
  });

  it('resolves inbound message scope when scope is only in the saved-regions catalog', async () => {
    vi.clearAllMocks();
    getAllSavedRegions.mockResolvedValue([{ id: 1, name: 'muenchen', note: null, createdAt: 0, updatedAt: 0 }]);
    getSettingForSource.mockResolvedValue(null);

    const m2 = new MeshCoreManager('src-b');
    await (m2 as any).refreshKnownScopes();

    // Dispatch the scoped packet — knownScopes now includes "muenchen" from the catalog
    // @ts-expect-error exercising private handler
    m2.handleBridgeEvent({ event_type: 'channel_message', data: { channel_idx: 0, text: 'hi', path_len: 2, path_hops: ['a3', '7f'], raw_hex: SCOPED_RAW } });
    const all = m2.getRecentMessages(10);
    const msg = all[all.length - 1];
    expect(msg.scopeCode).toBe(30479);
    expect(msg.scopeName).toBe('muenchen');
  });
});
