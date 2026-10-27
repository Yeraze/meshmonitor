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
  // Drain microtasks across the attribution queue's extra hops (#6000).
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
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
    // lastHop comes from the raw chain, not the de-duplicated one.
    expect(match!.lastHop).toBe('a3');
  });

  it('gives copies of one payload over different paths different echoKeys (#6000)', () => {
    const now = 1_000_000;
    const pending = new Map([['msg', { channelIdx: 0, sentAt: now, text: 'hi' }]]);
    const viaA = makeEcho({ secret: secret0, text: 'hi', hops: ['aa'] });
    const viaB = makeEcho({ secret: secret0, text: 'hi', hops: ['bb'] });
    const a = MeshCoreManager.findEchoMatch(viaA, pending, now, WINDOW, opts({ 0: secret0 }));
    const b = MeshCoreManager.findEchoMatch(viaB, pending, now, WINDOW, opts({ 0: secret0 }));
    const a2 = MeshCoreManager.findEchoMatch(viaA, pending, now, WINDOW, opts({ 0: secret0 }));
    expect(a!.echoKey).not.toBe(b!.echoKey);
    expect(a2!.echoKey).toBe(a!.echoKey);
    expect(a!.lastHop).toBe('aa');
    expect(b!.lastHop).toBe('bb');
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
    // The copy's SNR belongs to the last hop only (#6000); 'a3' was an
    // earlier hop we did not hear directly.
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-a', messageId: 'sent-123', repeaterHash: 'a3', snr: null }),
    );
    expect(recordHeardRepeater).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'src-a', messageId: 'sent-123', repeaterHash: '7f', snr: 6 }),
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

  /**
   * Back the recordHeardRepeater / getHeardRepeatersForMessage mocks with a
   * tiny in-memory table that merges like the real repository: one row per
   * (messageId, repeaterHash), max non-null SNR.
   */
  function useInMemoryHeardTable(): Map<string, { repeaterHash: string; repeaterName: string | null; snr: number | null }> {
    const rows = new Map<string, { repeaterHash: string; repeaterName: string | null; snr: number | null }>();
    recordHeardRepeater.mockImplementation(async (r: any) => {
      const key = `${r.messageId}|${r.repeaterHash}`;
      const prev = rows.get(key);
      const incoming = r.snr ?? null;
      const snr = prev
        ? prev.snr === null ? incoming : incoming === null ? prev.snr : Math.max(prev.snr, incoming)
        : incoming;
      const row = { repeaterHash: r.repeaterHash, repeaterName: r.repeaterName ?? null, snr };
      rows.set(key, row);
      return { ...row, sourceId: r.sourceId, messageId: r.messageId, heardAt: r.heardAt, createdAt: r.heardAt };
    });
    getHeardRepeatersForMessage.mockImplementation(async (messageId: string) =>
      Array.from(rows.entries())
        .filter(([k]) => k.startsWith(`${messageId}|`))
        .map(([, v]) => v),
    );
    return rows;
  }

  it('records BOTH repeaters when one message is echoed by two repeaters (#6000)', async () => {
    useInMemoryHeardTable();
    const m = makeManager();
    registerSend(m, 'sent-2r', 0, 'two repeaters');

    dispatch(m, makeEcho({ secret: secret0, text: 'two repeaters', hops: ['aa'], snr: 5 }));
    await flush();
    dispatch(m, makeEcho({ secret: secret0, text: 'two repeaters', hops: ['bb'], snr: 3 }));
    await flush();

    expect(recordHeardRepeater).toHaveBeenCalledTimes(2);
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledTimes(2);
    const last = emitMeshCoreChannelHeard.mock.calls.at(-1)![0];
    expect(last.id).toBe('sent-2r');
    expect(last.heardBy).toHaveLength(2);
    expect(last.heardBy).toEqual([
      { hash: 'aa', name: null, snr: 5 },
      { hash: 'bb', name: null, snr: 3 },
    ]);
  });

  it('attributes the same copy (same payload + same path) only once (#6000)', async () => {
    useInMemoryHeardTable();
    const m = makeManager();
    registerSend(m, 'sent-dup', 0, 'dup copy');
    const viaA = makeEcho({ secret: secret0, text: 'dup copy', hops: ['aa'], snr: 5 });

    dispatch(m, viaA);
    dispatch(m, viaA); // same copy again before the first finished
    await flush();

    expect(recordHeardRepeater).toHaveBeenCalledTimes(1);
    expect(emitMeshCoreChannelHeard).toHaveBeenCalledTimes(1);
  });

  it('merges overlapping paths: [aa] then [aa,bb] keeps aa once and adds bb (#6000)', async () => {
    const rows = useInMemoryHeardTable();
    const m = makeManager();
    registerSend(m, 'sent-ov', 0, 'overlap');

    // Both copies dispatched back to back so their DB writes would overlap
    // without the attribution queue.
    dispatch(m, makeEcho({ secret: secret0, text: 'overlap', hops: ['aa'], snr: 7 }));
    dispatch(m, makeEcho({ secret: secret0, text: 'overlap', hops: ['aa', 'bb'], snr: 2 }));
    await flush();

    expect(rows.size).toBe(2);
    // 'aa' was heard directly (SNR 7) on the first copy; the second copy
    // carries it as an earlier hop with no SNR, which must not wipe the 7.
    expect(rows.get('sent-ov|aa')).toEqual({ repeaterHash: 'aa', repeaterName: null, snr: 7 });
    expect(rows.get('sent-ov|bb')).toEqual({ repeaterHash: 'bb', repeaterName: null, snr: 2 });
    const last = emitMeshCoreChannelHeard.mock.calls.at(-1)![0];
    expect(last.heardBy.map((h: { hash: string }) => h.hash)).toEqual(['aa', 'bb']);
  });

  it('records the SNR against the last hop only (#6000)', async () => {
    useInMemoryHeardTable();
    const m = makeManager();
    registerSend(m, 'sent-snr', 0, 'snr hop');
    dispatch(m, makeEcho({ secret: secret0, text: 'snr hop', hops: ['11', '22', '33'], snr: -4.5 }));
    await flush();

    const calls = recordHeardRepeater.mock.calls.map((c) => [c[0].repeaterHash, c[0].snr]);
    expect(calls).toEqual([
      ['11', null],
      ['22', null],
      ['33', -4.5],
    ]);
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
