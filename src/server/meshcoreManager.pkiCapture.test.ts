/**
 * Tests for MeshCoreManager.maybeExportAndStorePkiKey (#6195) — the automatic,
 * Companion-only device-key capture on connect.
 *
 * Verifies:
 *  - Companion stores the exported key (encrypted via the store) and caches it;
 *  - Repeater / Room Server are skipped (no key to export);
 *  - a firmware that returns no key persists a negative "unsupported" marker and
 *    does not retry within the connection;
 *  - an existing row under a DIFFERENT public key sets keyMismatch and is NOT
 *    overwritten;
 *  - a matching stored key is loaded into the hot-path cache without re-export.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted so the vi.mock factories (also hoisted) can safely reference them.
const { sourcePkiKeys, settings, store } = vi.hoisted(() => ({
  sourcePkiKeys: {
    getBySourceId: vi.fn(),
    setKeyMismatch: vi.fn(),
    deleteBySourceId: vi.fn(),
  },
  settings: {
    getSettingForSource: vi.fn(),
    setSourceSetting: vi.fn(),
  },
  store: {
    capability: { canStore: true } as { canStore: boolean; reason?: string },
    load: vi.fn(),
    store: vi.fn(),
  },
}));

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      recordHeardRepeater: vi.fn(),
      getHeardRepeatersForMessage: vi.fn(),
    },
    meshcoreSourcePkiKeys: sourcePkiKeys,
    settings,
    channels: { getChannelById: vi.fn() },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreChannelHeard: vi.fn(),
    emitMeshCoreOtaPacket: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreStatusUpdated: vi.fn(),
    emitMeshCoreLocalNodeUpdated: vi.fn(),
  },
}));

vi.mock('./services/meshcoreSourcePkiKeyStore.js', () => ({
  getMeshCoreSourcePkiKeyStore: () => store,
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const PRIV = '11'.repeat(64);
const PUB = 'ab'.repeat(32);
const OTHER_PUB = 'cd'.repeat(32);

function makeCompanion(): MeshCoreManager {
  const m = new MeshCoreManager('src-1');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).localNode = { publicKey: PUB, name: 'MyNode' };
  return m;
}

describe('MeshCoreManager.maybeExportAndStorePkiKey (#6195)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.capability = { canStore: true };
    store.load.mockResolvedValue({ kind: 'none' });
    sourcePkiKeys.getBySourceId.mockResolvedValue(null);
    settings.getSettingForSource.mockResolvedValue(null);
    settings.setSourceSetting.mockResolvedValue(undefined);
  });

  it('Companion: exports, stores encrypted, and caches the key', async () => {
    const m = makeCompanion();
    (m as any).exportPrivateKey = vi.fn().mockResolvedValue(PRIV);

    await (m as any).maybeExportAndStorePkiKey();

    expect((m as any).exportPrivateKey).toHaveBeenCalledTimes(1);
    expect(store.store).toHaveBeenCalledWith('src-1', PRIV, PUB);
    expect((m as any).selfPkiPrivateKeyHex).toBe(PRIV);
  });

  it('Repeater / Room Server are skipped (no export, no store)', async () => {
    for (const type of [MeshCoreDeviceType.REPEATER, MeshCoreDeviceType.ROOM_SERVER]) {
      const m = new MeshCoreManager('src-r');
      (m as any).deviceType = type;
      (m as any).localNode = { publicKey: PUB };
      const exportSpy = vi.fn().mockResolvedValue(PRIV);
      (m as any).exportPrivateKey = exportSpy;

      await (m as any).maybeExportAndStorePkiKey();
      expect(exportSpy).not.toHaveBeenCalled();
      expect(store.store).not.toHaveBeenCalled();
    }
  });

  it('skips entirely when SESSION_SECRET is auto-generated (canStore=false)', async () => {
    store.capability = { canStore: false, reason: 'auto-generated' };
    const m = makeCompanion();
    const exportSpy = vi.fn().mockResolvedValue(PRIV);
    (m as any).exportPrivateKey = exportSpy;

    await (m as any).maybeExportAndStorePkiKey();
    expect(exportSpy).not.toHaveBeenCalled();
    expect(store.store).not.toHaveBeenCalled();
  });

  it('export returns null: persists the unsupported marker and does not retry this connection', async () => {
    const m = makeCompanion();
    const exportSpy = vi.fn().mockResolvedValue(null);
    (m as any).exportPrivateKey = exportSpy;

    await (m as any).maybeExportAndStorePkiKey();
    expect(store.store).not.toHaveBeenCalled();
    expect(settings.setSourceSetting).toHaveBeenCalledWith('src-1', 'meshcorePkiExportUnsupported', PUB);

    // Second call within the same connection is a no-op (pkiExportAttempted).
    await (m as any).maybeExportAndStorePkiKey();
    expect(exportSpy).toHaveBeenCalledTimes(1);
  });

  it('a prior unsupported marker for THIS identity skips the export', async () => {
    settings.getSettingForSource.mockResolvedValue(PUB);
    const m = makeCompanion();
    const exportSpy = vi.fn().mockResolvedValue(PRIV);
    (m as any).exportPrivateKey = exportSpy;

    await (m as any).maybeExportAndStorePkiKey();
    expect(exportSpy).not.toHaveBeenCalled();
    expect(store.store).not.toHaveBeenCalled();
  });

  it('existing row under a DIFFERENT public key: sets keyMismatch and does NOT overwrite', async () => {
    sourcePkiKeys.getBySourceId.mockResolvedValue({
      sourceId: 'src-1',
      encryptedPrivateKey: '{}',
      publicKey: OTHER_PUB,
      keyMismatch: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const m = makeCompanion();
    (m as any).exportPrivateKey = vi.fn().mockResolvedValue(PRIV);

    await (m as any).maybeExportAndStorePkiKey();
    expect(sourcePkiKeys.setKeyMismatch).toHaveBeenCalledWith('src-1', true);
    expect(store.store).not.toHaveBeenCalled();
    expect((m as any).selfPkiPrivateKeyHex).toBeNull();
  });

  it('a matching stored key is loaded into the cache without re-exporting', async () => {
    store.load.mockResolvedValue({ kind: 'ok', privateKeyHex: PRIV, publicKeyHex: PUB, keyMismatch: false });
    const m = makeCompanion();
    const exportSpy = vi.fn().mockResolvedValue(PRIV);
    (m as any).exportPrivateKey = exportSpy;

    await (m as any).maybeExportAndStorePkiKey();
    expect(exportSpy).not.toHaveBeenCalled();
    expect(store.store).not.toHaveBeenCalled();
    expect((m as any).selfPkiPrivateKeyHex).toBe(PRIV);
  });
});
