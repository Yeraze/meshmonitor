/**
 * Companion OTA GRP_TXT decrypt against virtual-channel keys (#6159).
 *
 * A Companion hears the raw OTA frame of every packet in range via
 * `ota_packet` (LogRxData 0x88), including channels NOT set on its radio. This
 * path decrypts those GRP_TXT frames with MeshCore virtual channels (#5552)
 * and any other source's channel key, and files the result under a keyed
 * channel index — exactly like the Repeater RAW path (#5551).
 *
 * Runs against the real `:memory:` database with wire-accurate frames, so the
 * decode, key lookup, decrypt, insert-or-ignore, decrypt-count increment and
 * event gating all run for real. Receive-only: nothing here transmits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { channelKeyFingerprint, keyedChannelIndex } from './services/meshcoreFrameIngest.js';
import { buildGrpTxtFrame } from './test-helpers/meshcoreFrames.js';

const COMPANION = 'src-companion-ota';
const OTHER = 'src-companion-other';
// A virtual-channel key the radio does NOT hold.
const VSECRET = '00112233445566778899aabbccddeeff';
const VSECRET_B64 = Buffer.from(VSECRET, 'hex').toString('base64');
// A key the radio DOES hold (a device channel slot).
const DSECRET = 'ffeedd0123456789ffeeddcc00112233';
// A key nobody holds.
const UNKNOWN_SECRET = 'abababababababababababababababab';

interface Internals {
  deviceType: MeshCoreDeviceType;
  connected: boolean;
  channelSecrets: Map<number, Uint8Array>;
  handleBridgeEvent: (evt: { event_type: string; data: unknown }) => void;
}

/** The auto-reply probes a receive-only ingest path must never invoke. */
type ReplyProbes = {
  checkAutoAcknowledge: (...a: unknown[]) => unknown;
  checkForwarding: (...a: unknown[]) => unknown;
  checkAutoPingThenResponder: (...a: unknown[]) => unknown;
};

function companion(sourceId = COMPANION): MeshCoreManager {
  const m = new MeshCoreManager(sourceId);
  const i = m as unknown as Internals;
  i.deviceType = MeshCoreDeviceType.COMPANION;
  i.connected = true;
  return m;
}

function feedOta(m: MeshCoreManager, rawHex: string): void {
  (m as unknown as Internals).handleBridgeEvent({
    event_type: 'ota_packet',
    data: { raw_hex: rawHex, payload_type: 0x05, snr: 7, rssi: -92, hop_count: 1, path_hops: ['aa'] },
  });
}

const stored = (src = COMPANION) => databaseService.meshcore.getRecentMessages(50, src);

describe('Companion OTA GRP_TXT virtual-channel decrypt (#6159)', () => {
  let messageSpy: ReturnType<typeof vi.spyOn>;
  let incrementSpy: ReturnType<typeof vi.spyOn>;
  let virtualId: number;

  beforeEach(async () => {
    // Packet-monitor opt-in OFF: virtual-channel decrypt must not depend on it.
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    vi.spyOn(meshcorePacketLogService, 'logPacket').mockResolvedValue(undefined as never);
    messageSpy = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage').mockImplementation(() => undefined);
    incrementSpy = vi.spyOn(databaseService.channelDatabase, 'incrementDecryptedCountAsync');
    await databaseService.meshcore.deleteAllMessagesForSource(COMPANION);
    await databaseService.meshcore.deleteAllMessagesForSource(OTHER);
    virtualId = await databaseService.channelDatabase.createAsync({
      name: 'Secret Room',
      psk: VSECRET_B64,
      pskLength: 16,
      protocol: 'meshcore',
      isEnabled: true,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.channelDatabase.deleteAsync(virtualId);
    await databaseService.meshcore.deleteAllMessagesForSource(COMPANION);
    await databaseService.meshcore.deleteAllMessagesForSource(OTHER);
  });

  it('decrypts a GRP_TXT heard OTA with a virtual-channel key and stores it keyed', async () => {
    const m = companion();
    feedOta(m, buildGrpTxtFrame(1_700_000_000, 'Alice: hi from a virtual channel', VSECRET));
    await vi.waitFor(() => expect(messageSpy).toHaveBeenCalledTimes(1));

    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromPublicKey: `channel-${keyedChannelIndex(VSECRET)}`,
      fromName: 'Alice',
      text: 'hi from a virtual channel',
      sourceId: COMPANION,
      // A virtual channel's key: both null, only the fingerprint is kept.
      keySourceId: null,
      keyChannelIdx: null,
      keyFingerprint: channelKeyFingerprint(VSECRET),
    });
    // The secret is never copied onto the row (the read gate uses the fingerprint).
    expect(JSON.stringify(rows[0])).not.toContain(VSECRET);
    expect(JSON.stringify(rows[0])).not.toContain(VSECRET_B64);
  });

  it('increments the virtual channel decrypt count only for a message a virtual key opened', async () => {
    const m = companion();
    feedOta(m, buildGrpTxtFrame(1_700_000_010, 'Bob: counted', VSECRET));
    await vi.waitFor(() => expect(messageSpy).toHaveBeenCalledTimes(1));
    expect(incrementSpy).toHaveBeenCalledWith(virtualId);

    const row = await databaseService.channelDatabase.getByIdAsync(virtualId);
    expect(row?.decryptedPacketCount).toBe(1);
  });

  it('stores nothing and counts nothing when no key matches', async () => {
    const m = companion();
    feedOta(m, buildGrpTxtFrame(1_700_000_020, 'Eve: nobody can read this', UNKNOWN_SECRET));
    await new Promise((r) => setTimeout(r, 200));
    expect(messageSpy).not.toHaveBeenCalled();
    expect(await stored()).toHaveLength(0);
    expect(incrementSpy).not.toHaveBeenCalled();
  });

  it('does NOT double-store a channel the radio already holds (firmware delivers it normally)', async () => {
    const m = companion();
    // The companion holds this channel's key, so the firmware already delivers
    // the plaintext via the normal channel-message event. The OTA path must skip.
    (m as unknown as Internals).channelSecrets = new Map([[1, new Uint8Array(Buffer.from(DSECRET, 'hex'))]]);
    feedOta(m, buildGrpTxtFrame(1_700_000_030, 'Carol: on the device', DSECRET));
    await new Promise((r) => setTimeout(r, 200));
    expect(messageSpy).not.toHaveBeenCalled();
    expect(await stored()).toHaveLength(0);
    expect(incrementSpy).not.toHaveBeenCalled();
  });

  it('is receive-only: no auto-ack, forwarding or auto-ping is triggered by an ingested frame', async () => {
    const m = companion();
    const probes = m as unknown as ReplyProbes;
    const ack = vi.spyOn(probes, 'checkAutoAcknowledge');
    const fwd = vi.spyOn(probes, 'checkForwarding');
    const ping = vi.spyOn(probes, 'checkAutoPingThenResponder');
    feedOta(m, buildGrpTxtFrame(1_700_000_040, 'Dan: quiet please', VSECRET));
    await vi.waitFor(() => expect(messageSpy).toHaveBeenCalledTimes(1));
    expect(ack).not.toHaveBeenCalled();
    expect(fwd).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it('surfaces the virtual channel in this source keyed-channel summaries', async () => {
    const m = companion();
    feedOta(m, buildGrpTxtFrame(1_700_000_050, 'Erin: listed', VSECRET));
    await vi.waitFor(() => expect(messageSpy).toHaveBeenCalledTimes(1));
    const summaries = await databaseService.meshcore.getKeyedChannelSummaries(COMPANION);
    expect(summaries).toEqual([
      expect.objectContaining({
        channelKey: `channel-${keyedChannelIndex(VSECRET)}`,
        keyFingerprint: channelKeyFingerprint(VSECRET),
        keySourceId: null,
        keyChannelIdx: null,
      }),
    ]);
  });

  it("per-source isolation: another Companion's decrypt does not leak into this source", async () => {
    const other = companion(OTHER);
    feedOta(other, buildGrpTxtFrame(1_700_000_060, 'Frank: on the other source', VSECRET));
    await vi.waitFor(() => expect(messageSpy).toHaveBeenCalledTimes(1));

    // The message landed on OTHER, not on COMPANION.
    expect((await stored(OTHER)).map((r) => r.text)).toContain('on the other source');
    expect(await stored(COMPANION)).toHaveLength(0);
    expect(await databaseService.meshcore.getKeyedChannelSummaries(COMPANION)).toEqual([]);
  });
});
