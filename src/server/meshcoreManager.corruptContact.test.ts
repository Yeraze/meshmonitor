/**
 * Corrupt MeshCore contact frames must not reach meshcore_nodes.
 *
 * The companion serial link has no checksum. When the USB-serial stream
 * drops bytes, meshcore.js re-syncs on the next `>` and parses a spliced
 * frame as a Contact / NewAdvert record: the name field then holds binary
 * junk and adv_type is out of range. These records were being persisted as
 * phantom nodes (or over a real node's name) and showed as garbage in the
 * node list.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const upsertNode = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      upsertNode: (...args: unknown[]) => upsertNode(...args),
      getNodesBySource: vi.fn().mockResolvedValue([]),
    },
    sources: {
      getSource: vi.fn().mockResolvedValue({ name: 'Source A' }),
    },
  },
}));

vi.mock('./services/notificationService.js', () => ({
  notificationService: { notifyNewMeshCoreNode: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreContactUpdated: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreSelfInfoUpdated: vi.fn(),
  },
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Decode like meshcore.js readCString: stop at NUL, lenient UTF-8. */
function readCString(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  const nul = bytes.indexOf(0);
  return new TextDecoder().decode(nul === -1 ? bytes : bytes.subarray(0, nul));
}

// Public key + name bytes from real corrupt rows (the key embeds the ASCII
// "CS187 SC Solar" of a neighbouring record — a spliced frame).
const SPLICED_KEY = '8f6ef823eb2d80886ee0009900000000435331383720534320536f6c61720000';
const SPLICED_NAME = readCString('7c02');
const GOOD_KEY = 'c'.repeat(64);

function companion(contacts: Array<Record<string, unknown>>): MeshCoreManager {
  const m = new MeshCoreManager('src-a');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).sendBridgeCommand = async (cmd: string) => {
    if (cmd === 'get_contacts') return { success: true, data: contacts };
    return { success: true };
  };
  return m;
}

function dispatch(m: MeshCoreManager, event_type: string, data: Record<string, unknown>): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent({ event_type, data });
}

describe('MeshCoreManager corrupt contact frames', () => {
  beforeEach(() => {
    upsertNode.mockClear();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  it('skips a get_contacts record with a binary name and keeps the good ones', async () => {
    const m = companion([
      { public_key: SPLICED_KEY, adv_name: SPLICED_NAME, name: SPLICED_NAME, adv_type: 0 },
      { public_key: GOOD_KEY, adv_name: 'Good Repeater', name: 'Good Repeater', adv_type: 2 },
    ]);
    await m.refreshContacts();
    await flush();

    const keys = upsertNode.mock.calls.map((c) => (c[0] as { publicKey: string }).publicKey);
    expect(keys).toContain(GOOD_KEY);
    expect(keys).not.toContain(SPLICED_KEY);
    expect((m as any).contacts.has(SPLICED_KEY)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('corrupt contact record'));
  });

  it('skips a get_contacts record whose adv_type is out of range', async () => {
    const m = companion([
      { public_key: 'd'.repeat(64), adv_name: 'j>', adv_type: 79 },
    ]);
    await m.refreshContacts();
    await flush();
    expect(upsertNode).not.toHaveBeenCalled();
  });

  it('ignores a corrupt NewAdvert push rather than overwriting a known name', async () => {
    const m = companion([]);
    dispatch(m, 'contact_advertised', { public_key: GOOD_KEY, adv_name: 'Good Repeater', adv_type: 2 });
    await flush();
    upsertNode.mockClear();

    dispatch(m, 'contact_added', {
      public_key: GOOD_KEY,
      adv_name: readCString('521c2d23efbfbdefbfbd78'),
      adv_type: 115,
    });
    await flush();

    expect(upsertNode).not.toHaveBeenCalled();
    expect((m as any).contacts.get(GOOD_KEY).advName).toBe('Good Repeater');
  });

  it('keeps a real node whose trailing emoji the sender truncated, minus the U+FFFD', async () => {
    const name = readCString(Buffer.from('Dvynsoul GAT562 Base ').toString('hex') + 'f09f8f');
    const m = companion([{ public_key: GOOD_KEY, adv_name: name, name, adv_type: 2 }]);
    await m.refreshContacts();
    await flush();

    expect(upsertNode).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: GOOD_KEY, name: 'Dvynsoul GAT562 Base' }),
      'src-a',
    );
  });
});
