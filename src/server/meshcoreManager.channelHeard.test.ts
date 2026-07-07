/**
 * Tests for MeshCoreManager's channel "heard repeaters" self-echo correlation
 * (#3700, exact-match hardening #3979).
 *
 * When a nearby repeater re-floods one of OUR outgoing channel messages, the
 * device hears it as an inbound GRP_TXT OTA packet whose relay-hash chain names
 * the relaying repeaters. We hold the channel PSK, so we DECRYPT the echoed
 * payload and attribute it to the SPECIFIC send whose plaintext is exactly
 * `"<ourNodeName>: <textWeSent>"`. This rejects unrelated third-party chatter on
 * the same channel and cross-attribution between two of our own near-
 * simultaneous sends. Each echoed packet is attributed at most once.
 *
 * Fixtures are built by encrypting known plaintext with a known channel secret
 * (AES-128-ECB) via `encodeGroupTextPayload` — the real inverse of the decrypt
 * path — so the crypto is exercised end-to-end.
 *
 * Two layers are covered:
 *  - `findEchoMatch` (pure): exact match, oldest-wins tie-break, window expiry,
 *    third-party / wrong-channel / garbage rejection, dedup, type/path gating.
 *  - `handleBridgeEvent('ota_packet')` (integration): records repeaters and
 *    emits `meshcore:channel-heard`, independent of the packet-monitor gate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encodeGroupTextPayload } from './utils/meshcoreGroupEcho.js';

const recordHeardRepeater = vi.fn();
const getHeardRepeatersForMessage = vi.fn();
const isEnabled = vi.fn().mockResolvedValue(false);
const emitMeshCoreChannelHeard = vi.fn();
const getChannelById = vi.fn();

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      recordHeardRepeater: (...args: unknown[]) => recordHeardRepeater(...args),
      getHeardRepeatersForMessage: (...args: unknown[]) => getHeardRepeatersForMessage(...args),
    },
    channels: {
      getChannelById: (...args: unknown[]) => getChannelById(...args),
    },
  },
}));

vi.mock('./services/dataEventEmitter.js', () => ({
  dataEventEmitter: {
    emitMeshCoreChannelHeard: (...args: unknown[]) => emitMeshCoreChannelHeard(...args),
    emitMeshCoreOtaPacket: vi.fn(),
    emitMeshCoreMessage: vi.fn(),
    emitMeshCoreContactUpdated: vi.fn(),
  },
}));

vi.mock('./services/meshcorePacketLogService.js', () => ({
  default: {
    isEnabled: (...args: unknown[]) => isEnabled(...args),
    logPacket: vi.fn().mockResolvedValue(undefined),
  },
}));

import { MeshCoreManager } from './meshcoreManager.js';

const GRP_TXT = 0x05;
const SELF_NAME = 'MyNode';

/** Deterministic 16-byte AES-128 channel secret keyed by a seed. */
function secretBytes(seed: number): Uint8Array {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = (seed + i * 7) & 0xff;
  return s;
}
function secretBase64(seed: number): string {
  return Buffer.from(secretBytes(seed)).toString('base64');
}

/**
 * Build a raw MeshCore OTA frame (hex) that `decodeMeshCorePacket` can parse:
 * header (FLOOD + GRP_TXT) + packed path-len + 1-byte relay hashes + payload.
 */
function buildOtaFrame(payloadHex: string, hopHashes: string[] = []): string {
  const header = 0x01 | (GRP_TXT << 2); // FLOOD (0x01) + payload type 0x05 => 0x15
  const hopCount = hopHashes.length & 0x3f; // hashSize=1 => top 2 bits zero
  const bytes = [header, hopCount];
  for (const h of hopHashes) bytes.push(parseInt(h, 16) & 0xff);
  return Buffer.concat([Buffer.from(bytes), Buffer.from(payloadHex, 'hex')]).toString('hex');
}

/**
 * Build an `ota_packet` bridge payload for a GRP_TXT echo of `text` sent by
 * `senderName` on the channel with `secret`, carried by `hops`.
 */
function makeEcho(opts: {
  secret: Uint8Array;
  senderName?: string;
  text: string;
  hops: string[];
  snr?: number;
  timestamp?: number;
}): Record<string, unknown> {
  const payloadHex = encodeGroupTextPayload(
    opts.secret,
    opts.senderName ?? SELF_NAME,
    opts.text,
    opts.timestamp ?? 1_700_000_000,
  );
  return {
    payload_type: GRP_TXT,
    path_hops: opts.hops,
    snr: opts.snr,
    raw_hex: buildOtaFrame(payloadHex, opts.hops),
  };
}

function dispatch(m: MeshCoreManager, data: Record<string, unknown>): void {
  // @ts-expect-error - exercising private method
  m.handleBridgeEvent({ event_type: 'ota_packet', data });
}

/** Seed a pending channel send on a manager (mirrors performScopedSend). */
function registerSend(m: MeshCoreManager, messageId: string, channelIdx: number, text: string): void {
  // @ts-expect-error - exercising private method
  m.registerPendingChannelSend(messageId, channelIdx, text);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('MeshCoreManager.findEchoMatch (pure, exact decrypt-match)', () => {
  const WINDOW = 30_000;
  const secret0 = secretBytes(0);
  const secret1 = secretBytes(1);

  function opts(secretByIdx: Record<number, Uint8Array>, selfName: string | null = SELF_NAME) {
    return {
      selfName,
      resolveChannelSecret: (idx: number) => secretByIdx[idx] ?? null,
    };
  }

  it('attributes an own-message echo to the correct pending send', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['msg-a', { channelIdx: 0, sentAt: now - 2_000, text: 'hello world' }],
    ]);
    const data = makeEcho({ secret: secret0, text: 'hello world', hops: ['a3', '7f'] });
    const match = MeshCoreManager.findEchoMatch(data, pending, now, WINDOW, opts({ 0: secret0 }));
    expect(match).not.toBeNull();
    expect(match!.messageId).toBe('msg-a');
    expect(match!.channelIdx).toBe(0);
    expect(match!.pathHops).toEqual(['a3', '7f']);
    expect(typeof match!.echoKey).toBe('string');
  });

  it('attributes two own-sends-in-window each to the RIGHT message (not most-recent)', () => {
    const now = 1_000_000;
    // Two sends within the window on the same channel, different text.
    const pending = new Map([
      ['msg-old', { channelIdx: 0, sentAt: now - 8_000, text: 'first message' }],
      ['msg-new', { channelIdx: 0, sentAt: now - 1_000, text: 'second message' }],
    ]);

    // Echo of the OLDER message must attribute to msg-old, NOT the most recent.
    const echoOld = makeEcho({ secret: secret0, text: 'first message', hops: ['a3'] });
    const matchOld = MeshCoreManager.findEchoMatch(echoOld, pending, now, WINDOW, opts({ 0: secret0 }));
    expect(matchOld!.messageId).toBe('msg-old');

    // Echo of the NEWER message attributes to msg-new.
    const echoNew = makeEcho({ secret: secret0, text: 'second message', hops: ['7f'] });
    const matchNew = MeshCoreManager.findEchoMatch(echoNew, pending, now, WINDOW, opts({ 0: secret0 }));
    expect(matchNew!.messageId).toBe('msg-new');
  });

  it('does NOT attribute a third-party message with the same text on the same channel', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['msg-a', { channelIdx: 0, sentAt: now - 1_000, text: 'hello world' }],
    ]);
    // Same channel secret + same text, but a DIFFERENT sender name.
    const data = makeEcho({ secret: secret0, senderName: 'SomeoneElse', text: 'hello world', hops: ['a3'] });
    const match = MeshCoreManager.findEchoMatch(data, pending, now, WINDOW, opts({ 0: secret0 }));
    expect(match).toBeNull();
  });

  it('ignores an echo on a different channel (wrong secret / channel hash)', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['msg-a', { channelIdx: 0, sentAt: now - 1_000, text: 'hello world' }],
    ]);
    // Echo was encrypted with channel 1's secret, but the pending send is on
    // channel 0 (resolver returns channel 0's secret) → hash/MAC reject.
    const data = makeEcho({ secret: secret1, text: 'hello world', hops: ['a3'] });
    const match = MeshCoreManager.findEchoMatch(data, pending, now, WINDOW, opts({ 0: secret0 }));
    expect(match).toBeNull();
  });

  it('ignores a MAC-failing / garbage frame without throwing', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['msg-a', { channelIdx: 0, sentAt: now - 1_000, text: 'hello world' }],
    ]);
    // Tamper the payload after the header+path so MAC verification fails.
    const good = makeEcho({ secret: secret0, text: 'hello world', hops: ['a3'] });
    const bytes = Buffer.from(good.raw_hex as string, 'hex');
    bytes[bytes.length - 1] ^= 0xff; // corrupt ciphertext tail
    const tampered = { ...good, raw_hex: bytes.toString('hex') };
    expect(() =>
      MeshCoreManager.findEchoMatch(tampered, pending, now, WINDOW, opts({ 0: secret0 })),
    ).not.toThrow();
    expect(MeshCoreManager.findEchoMatch(tampered, pending, now, WINDOW, opts({ 0: secret0 }))).toBeNull();

    // Structurally broken raw_hex.
    expect(
      MeshCoreManager.findEchoMatch(
        { payload_type: GRP_TXT, path_hops: ['a3'], raw_hex: 'zzzz' },
        pending,
        now,
        WINDOW,
        opts({ 0: secret0 }),
      ),
    ).toBeNull();
  });

  it('returns null when no pending send is within the window', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['msg-stale', { channelIdx: 0, sentAt: now - (WINDOW + 1), text: 'hello world' }],
    ]);
    const data = makeEcho({ secret: secret0, text: 'hello world', hops: ['a3'] });
    expect(MeshCoreManager.findEchoMatch(data, pending, now, WINDOW, opts({ 0: secret0 }))).toBeNull();
  });

  it('ignores non-GRP_TXT payload types', () => {
    const now = 1_000_000;
    const pending = new Map([['msg', { channelIdx: 0, sentAt: now, text: 'hi' }]]);
    const data = makeEcho({ secret: secret0, text: 'hi', hops: ['a3'] });
    expect(
      MeshCoreManager.findEchoMatch({ ...data, payload_type: 0x02 }, pending, now, WINDOW, opts({ 0: secret0 })),
    ).toBeNull();
  });

  it('ignores direct/zero-hop packets with no relay chain', () => {
    const now = 1_000_000;
    const pending = new Map([['msg', { channelIdx: 0, sentAt: now, text: 'hi' }]]);
    const data = makeEcho({ secret: secret0, text: 'hi', hops: [] });
    expect(MeshCoreManager.findEchoMatch(data, pending, now, WINDOW, opts({ 0: secret0 }))).toBeNull();
    expect(
      MeshCoreManager.findEchoMatch(
        { payload_type: GRP_TXT, raw_hex: data.raw_hex },
        pending,
        now,
        WINDOW,
        opts({ 0: secret0 }),
      ),
    ).toBeNull();
  });

  it('returns null when the local node name is unknown (can\'t confirm self-origin)', () => {
    const now = 1_000_000;
    const pending = new Map([['msg', { channelIdx: 0, sentAt: now, text: 'hi' }]]);
    const data = makeEcho({ secret: secret0, text: 'hi', hops: ['a3'] });
    expect(MeshCoreManager.findEchoMatch(data, pending, now, WINDOW, opts({ 0: secret0 }, null))).toBeNull();
  });

  it('returns null when there are no pending sends', () => {
    const data = makeEcho({ secret: secret0, text: 'hi', hops: ['a3'] });
    expect(MeshCoreManager.findEchoMatch(data, new Map(), 1_000_000, WINDOW, opts({ 0: secret0 }))).toBeNull();
  });

  it('dedups repeated relay hashes and normalises to lowercase', () => {
    const now = 1_000_000;
    const pending = new Map([['msg', { channelIdx: 0, sentAt: now, text: 'hi' }]]);
    const data = makeEcho({ secret: secret0, text: 'hi', hops: ['A3', 'a3', '7F', '7f', 'A3'] });
    const match = MeshCoreManager.findEchoMatch(data, pending, now, WINDOW, opts({ 0: secret0 }));
    expect(match!.pathHops).toEqual(['a3', '7f']);
  });
});

describe('MeshCoreManager — channel-heard correlation (integration)', () => {
  const secret0 = secretBytes(0);

  beforeEach(() => {
    recordHeardRepeater.mockReset();
    getHeardRepeatersForMessage.mockReset();
    emitMeshCoreChannelHeard.mockReset();
    getChannelById.mockReset();
    isEnabled.mockResolvedValue(false); // packet monitor OFF — correlation must still run
    getChannelById.mockResolvedValue({ id: 0, psk: secretBase64(0) });
    recordHeardRepeater.mockImplementation(async (r: any) => ({
      sourceId: r.sourceId,
      messageId: r.messageId,
      repeaterHash: r.repeaterHash,
      repeaterName: r.repeaterName ?? null,
      snr: r.snr ?? null,
      heardAt: r.heardAt,
      createdAt: r.heardAt,
    }));
  });

  /** Build a manager with a known local node name so self-origin resolves. */
  function makeManager(sourceId = 'src-a'): MeshCoreManager {
    const m = new MeshCoreManager(sourceId);
    (m as any).localNode = { publicKey: 'mypk', name: SELF_NAME };
    return m;
  }

  it('records repeaters and emits channel-heard for a decrypted self-echo (monitor off)', async () => {
    getHeardRepeatersForMessage.mockResolvedValue([
      { repeaterHash: 'a3', repeaterName: null, snr: 6 },
      { repeaterHash: '7f', repeaterName: null, snr: 4 },
    ]);

    const m = makeManager();
    registerSend(m, 'sent-123', 0, 'hello world');
    dispatch(m, makeEcho({ secret: secret0, text: 'hello world', hops: ['a3', '7f'], snr: 6 }));
    await flush();

    expect(recordHeardRepeater).toHaveBeenCalledTimes(2);
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-a', messageId: 'sent-123', repeaterHash: 'a3', snr: 6 }),
    );
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-a', messageId: 'sent-123', repeaterHash: '7f' }),
    );
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sent-123',
        heardBy: [
          { hash: 'a3', name: null, snr: 6 },
          { hash: '7f', name: null, snr: 4 },
        ],
      }),
      'src-a',
    );
  });

  it('attributes an echo at most once even if the same frame is heard twice', async () => {
    getHeardRepeatersForMessage.mockResolvedValue([{ repeaterHash: 'a3', repeaterName: null, snr: 5 }]);
    const m = makeManager();
    registerSend(m, 'sent-1', 0, 'once only');
    const echo = makeEcho({ secret: secret0, text: 'once only', hops: ['a3'], snr: 5 });

    dispatch(m, echo);
    await flush();
    dispatch(m, echo); // exact same frame again
    await flush();

    // Only the first dispatch attributes; the second is a no-op.
    expect(recordHeardRepeater).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledTimes(1);
  });

  it('does NOT record a third-party same-channel GRP_TXT echo', async () => {
    const m = makeManager();
    registerSend(m, 'sent-1', 0, 'hello world');
    dispatch(m, makeEcho({ secret: secret0, senderName: 'Stranger', text: 'hello world', hops: ['a3'], snr: 5 }));
    await flush();
    expect(recordHeardRepeater).not.toHaveBeenCalled();
    expect(emitMeshCoreChannelHeard).not.toHaveBeenCalled();
  });

  it('updates the in-memory message pool with heardBy (#3813)', async () => {
    getHeardRepeatersForMessage.mockResolvedValue([{ repeaterHash: 'a3', repeaterName: 'Relay1', snr: 7 }]);
    const m = makeManager();
    (m as any).messages = [{ id: 'sent-abc', fromPublicKey: 'mypk', text: 'hello', timestamp: 1000 }];
    registerSend(m, 'sent-abc', 0, 'hello');
    dispatch(m, makeEcho({ secret: secret0, text: 'hello', hops: ['a3'], snr: 7 }));
    await flush();

    const msgs = m.getRecentMessages(10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].heardBy).toEqual([{ hash: 'a3', name: 'Relay1', snr: 7 }]);
  });

  it('does not record anything when no pending channel send matches', async () => {
    const m = makeManager();
    dispatch(m, makeEcho({ secret: secret0, text: 'orphan', hops: ['a3'], snr: 5 }));
    await flush();
    expect(recordHeardRepeater).not.toHaveBeenCalled();
    expect(emitMeshCoreChannelHeard).not.toHaveBeenCalled();
  });

  it('ignores inbound DM (non-GRP_TXT) packets', async () => {
    const m = makeManager();
    registerSend(m, 'sent-123', 0, 'hi');
    dispatch(m, { payload_type: 0x02, path_hops: ['a3'], snr: 5 });
    await flush();
    expect(recordHeardRepeater).not.toHaveBeenCalled();
    expect(emitMeshCoreChannelHeard).not.toHaveBeenCalled();
  });
});
