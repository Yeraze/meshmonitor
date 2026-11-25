/**
 * Walkabout hook (#5891 P1): MeshCore handleOtaPacket hands every frame to
 * walkaboutService.maybeCaptureMeshCore first, before the packet-log gate, and
 * the repeater RAW path reaches it too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';
import { walkaboutService } from './services/walkaboutService.js';

const GRP_TXT =
  '1540D9AEFFB8183F8F47F919E136150469109973F7C3E2C2932DCA02542008F06F72F2A75639827A40C96F08A544D1BC568BAD9F100D29DACA0B3E8098F75476195E43E9F5';
const SELF = 'fe'.repeat(32);

describe('MeshCore Walkabout hook', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('handleOtaPacket calls the hook with the packet log disabled', async () => {
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    const logSpy = vi.spyOn(meshcorePacketLogService, 'logPacket').mockResolvedValue(undefined as never);
    const spy = vi.spyOn(walkaboutService, 'maybeCaptureMeshCore').mockImplementation(() => undefined);
    const m = new MeshCoreManager('src-mc');
    const data = { raw_hex: GRP_TXT, snr: 7, rssi: -92 };
    await (m as any).handleOtaPacket(data);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sourceId: 'src-mc', event: data });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('a repeater RAW line reaches the hook with the repeater key, not the placeholder', async () => {
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    const spy = vi.spyOn(walkaboutService, 'maybeCaptureMeshCore').mockImplementation(() => undefined);
    const m = new MeshCoreManager('src-rep');
    (m as any).deviceType = MeshCoreDeviceType.REPEATER;
    (m as any).repeaterPublicKey = SELF;
    await (m as any).handleRepeaterRawPacket({ rawHex: GRP_TXT, snr: 7, rssi: -92 }).catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sourceId: 'src-rep', localPubKey: SELF });
    expect(spy.mock.calls[0][0].event.raw_hex).toBe(GRP_TXT);
  });
});
