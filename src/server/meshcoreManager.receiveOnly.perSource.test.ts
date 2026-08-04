/**
 * MeshCore strict receive-only mode (#4547 epic, Phase 1 WP5) — per-source
 * isolation (spec §3.6).
 *
 * The whole point of this file: `meshcoreReceiveOnly` is a per-source
 * setting (CLAUDE.md "Per-source scoping is mandatory"). Two independent
 * `MeshCoreManager` instances must never leak the flag into one another —
 * neither through the manager's own TX guards nor through the
 * `computeSourceRadioSummary`-shaped read the dashboard consumes
 * (`src/server/routes/sourceRoutes.ts`).
 *
 * See docs/internal/dev-notes/MESHCORE_RECEIVE_ONLY_PHASE1_SPEC.md §3.6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';
import { isTxDisabledError } from './errors/txDisabledError.js';

const SOURCE_A = 'source-a';
const SOURCE_B = 'source-b';

/** Only source-a's meshcoreReceiveOnly setting is 'true'; everything else reads null. */
function mockPerSourceReceiveOnly(): void {
  vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
    async (sourceId: string | null | undefined, key: string) => {
      if (sourceId === SOURCE_A && key === 'meshcoreReceiveOnly') return 'true';
      return null;
    },
  );
}

/**
 * A manager wired just enough to reach the receive-only guard inside
 * `sendMessage` → `sendMessageWithResult`: connected, a non-repeater device
 * type, and `performScopedSend` stubbed so a "successful send" doesn't need
 * a real device/DB round trip (that machinery is exercised by its own
 * tests elsewhere; this file only cares about the receive-only gate).
 */
function connectedCompanion(sourceId: string): MeshCoreManager {
  const m = new MeshCoreManager(sourceId);
  (m as any).connected = true;
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).performScopedSend = vi.fn().mockResolvedValue({ ok: true });
  return m;
}

describe('MeshCoreManager receive-only — per-source isolation (#4547 WP5)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refreshReceiveOnly() on both managers only flips the flag for the source whose setting is true', async () => {
    mockPerSourceReceiveOnly();
    const a = new MeshCoreManager(SOURCE_A);
    const b = new MeshCoreManager(SOURCE_B);

    await a.refreshReceiveOnly();
    await b.refreshReceiveOnly();

    expect(a.isReceiveOnly()).toBe(true);
    expect(a.canTransmit()).toBe(false);
    expect(b.isReceiveOnly()).toBe(false);
    expect(b.canTransmit()).toBe(true);
  });

  it('source A rejects sendMessage with TxDisabledError while source B sends successfully', async () => {
    mockPerSourceReceiveOnly();
    const a = connectedCompanion(SOURCE_A);
    const b = connectedCompanion(SOURCE_B);

    await a.refreshReceiveOnly();
    await b.refreshReceiveOnly();

    let caught: unknown;
    try {
      await a.sendMessage('hello from A');
    } catch (err) {
      caught = err;
    }
    expect(isTxDisabledError(caught)).toBe(true);
    expect((a as any).performScopedSend).not.toHaveBeenCalled();

    const bOk = await b.sendMessage('hello from B');
    expect(bOk).toBe(true);
    expect((b as any).performScopedSend).toHaveBeenCalledTimes(1);
  });

  it('refreshMeshcoreReceiveOnly-style targeted refresh of source A does not change source B\'s cached flag', async () => {
    // Simulates the settings-write callback (settingsRoutes.ts → server.ts
    // refreshMeshcoreReceiveOnly(sourceId)): only the manager for the
    // written sourceId is refreshed.
    const a = new MeshCoreManager(SOURCE_A);
    const b = new MeshCoreManager(SOURCE_B);

    // Both start false (default).
    expect(a.isReceiveOnly()).toBe(false);
    expect(b.isReceiveOnly()).toBe(false);

    mockPerSourceReceiveOnly();
    await a.refreshReceiveOnly(); // only A is refreshed, as the real callback does

    expect(a.isReceiveOnly()).toBe(true);
    expect(b.isReceiveOnly()).toBe(false);
    expect(b.canTransmit()).toBe(true);
  });

  it('computeSourceRadioSummary-shaped read: A reports receiveOnly/canTransmit true/false, B reports the opposite', async () => {
    mockPerSourceReceiveOnly();
    const a = new MeshCoreManager(SOURCE_A);
    const b = new MeshCoreManager(SOURCE_B);
    await a.refreshReceiveOnly();
    await b.refreshReceiveOnly();

    // Mirrors the isMeshCoreManager branch added to computeSourceRadioSummary
    // in src/server/routes/sourceRoutes.ts (#4547 WP5).
    const summaryOf = (m: MeshCoreManager) => ({
      receiveOnly: m.isReceiveOnly(),
      canTransmit: m.canTransmit(),
    });

    expect(summaryOf(a)).toEqual({ receiveOnly: true, canTransmit: false });
    expect(summaryOf(b)).toEqual({ receiveOnly: false, canTransmit: true });
  });
});
