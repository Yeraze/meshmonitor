/**
 * Device backups hold only the backed-up radio's channels (#6257 finding 1).
 * Reading every source leaked other sources' channel secrets — MeshCore ones
 * included — into the file, and a restore wrote them to the radio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getAllChannels: vi.fn(),
  encodeUrl: vi.fn(),
}));

vi.mock('../../services/database.js', () => ({
  default: {
    channels: { getAllChannels: h.getAllChannels },
    nodes: { getNode: vi.fn().mockResolvedValue(null) },
    settings: { getSetting: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('./channelUrlService.js', () => ({ default: { encodeUrl: h.encodeUrl } }));

import { deviceBackupService } from './deviceBackupService.js';

const manager = (sourceId?: string) => ({
  sourceId,
  getLocalNodeInfo: () => ({ nodeNum: 1, nodeId: '!00000001', longName: 'Test', shortName: 'TN' }),
  getActualDeviceConfig: () => ({ lora: { region: 1 } }),
  getActualModuleConfig: () => ({}),
});

describe('deviceBackupService — channel scope', () => {
  beforeEach(() => {
    h.getAllChannels.mockReset().mockResolvedValue([
      { id: 0, name: 'Primary', psk: 'AQ==', role: 1, sourceId: 'mt-1' },
    ]);
    h.encodeUrl.mockReset().mockReturnValue('https://meshtastic.org/e/#x');
  });

  it("reads only the backed-up source's channels", async () => {
    await deviceBackupService.generateBackup(manager('mt-1'));
    expect(h.getAllChannels).toHaveBeenCalledTimes(1);
    expect(h.getAllChannels).toHaveBeenCalledWith('mt-1');
  });

  it('exports no channels when the manager has no source', async () => {
    await deviceBackupService.generateBackup(manager(undefined));
    expect(h.getAllChannels).not.toHaveBeenCalled();
  });
});
