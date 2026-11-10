/**
 * MeshCore sender-name override sends (#6282): raw CMD_SEND_RAW_PACKET path.
 *
 * Real `:memory:` SQLite singleton for rows; the radio (`sendBridgeCommand`),
 * channel lookup and settings are stubbed. No test talks to a real radio.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  MeshCoreManager,
  MeshCoreDeviceType,
  __resetSenderNameOverridesForTests,
} from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { encodeGroupTextPayload, tryDecodeGroupTextPayload } from './utils/meshcoreGroupEcho.js';
import { computeTransportCodeWithKey, scopeTransportKey } from './meshcoreScopeResolve.js';
import { isMeshCoreResendError } from './errors/meshcoreResendError.js';
import { isMeshCoreSenderNameError } from './errors/meshcoreSenderNameError.js';
import { isTxDisabledError } from './errors/txDisabledError.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }

const SELF_KEY = 'a'.repeat(64);
const SELF_NAME = 'MyNode';
const CHANNEL = 1;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const SECRET = new Uint8Array(16).map((_, i) => (i * 11 + 3) & 0xff);
const SECRET_B64 = Buffer.from(SECRET).toString('base64');
const DEFAULT_KEY_HEX = '0102030405060708090a0b0c0d0e0f10';

let sourceCounter = 0;
let deviceInfo: Record<string, unknown> = {};
let defaultScope: { name: string; key_hex: string } | null = null;
let rawResult: { success: boolean; error?: string; data?: unknown } = { success: true };
let policyJson: string | null = null;
let channelScope: string | null = null;

function makeManager(sourceId: string): { manager: MeshCoreManager; calls: BridgeCall[] } {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF_KEY, name: SELF_NAME };
  const calls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    if (cmd === 'device_query') return { id: '1', success: true, data: { 'fw ver': 14, ...deviceInfo } };
    if (cmd === 'get_default_flood_scope') return { id: '1', success: true, data: { default: defaultScope } };
    if (cmd === 'send_raw_packet') return { id: '1', ...rawResult };
    return { id: '1', success: true, data: {} };
  };
  return { manager: m, calls };
}

const rawFrames = (calls: BridgeCall[]) =>
  calls.filter(c => c.cmd === 'send_raw_packet').map(c => Buffer.from(String(c.params.frame_hex), 'hex'));

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
}

/** Channel message event the companion would deliver for a packet on the air. */
function channelEvent(wireText: string, ts: number): Record<string, unknown> {
  return { channel_idx: CHANNEL, text: wireText, sender_timestamp: ts, snr: 4, path_len: 1 };
}

describe('MeshCoreManager sender-name override sends (#6282)', () => {
  let sourceId: string;

  beforeAll(async () => {
    await databaseService.waitForReady();
  });

  beforeEach(() => {
    sourceId = `sno-src-${++sourceCounter}`;
    deviceInfo = { repeat: false, path_hash_mode: 1 };
    defaultScope = null;
    rawResult = { success: true };
    policyJson = JSON.stringify({ enabled: true, allowedNames: ['Alice Bot'] });
    channelScope = null;
    __resetSenderNameOverridesForTests();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
      getChannelById: vi.fn(async (idx: number) =>
        idx === CHANNEL ? { id: CHANNEL, psk: SECRET_B64, scope: channelScope } : null),
    } as any);
    vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
      getSettingForSource: vi.fn(async (_src: string, key: string) => {
        if (key === 'meshcoreSenderNameOverride') return policyJson;
        return null;
      }),
      setSourceSetting: vi.fn(async () => {}),
      getSettingAsBoolean: vi.fn(async (_key: string, def: boolean) => def),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('scope', () => {
    it('named region: transport flood, code from the region key, no set_flood_scope, no send_message', async () => {
      const { manager, calls } = makeManager(sourceId);
      const res = await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', 'muenchen');
      expect(res.ok).toBe(true);
      const [frame] = rawFrames(calls);
      expect(frame[2]).toBe(0x14);
      const payloadHex = frame.subarray(8).toString('hex');
      expect(frame.readUInt16LE(3)).toBe(computeTransportCodeWithKey(scopeTransportKey('muenchen'), 0x05, payloadHex));
      expect(frame[7]).toBe(0x40); // path hash mode 1
      expect(calls.some(c => c.cmd === 'set_flood_scope')).toBe(false);
      expect(calls.some(c => c.cmd === 'send_message')).toBe(false);
      expect(calls.some(c => c.cmd === 'get_default_flood_scope')).toBe(false);
    });

    it("'' means unscoped even when the channel has a scope", async () => {
      channelScope = 'chan-scope';
      const { manager, calls } = makeManager(sourceId);
      await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', '');
      expect(rawFrames(calls)[0][2]).toBe(0x15);
      expect(calls.some(c => c.cmd === 'get_default_flood_scope')).toBe(false);
    });

    it('inherit with no node default: asks the radio, sends unscoped', async () => {
      const { manager, calls } = makeManager(sourceId);
      await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot');
      expect(calls.some(c => c.cmd === 'get_default_flood_scope')).toBe(true);
      expect(rawFrames(calls)[0][2]).toBe(0x15);
    });

    it("inherit with a node default: uses the default key's transport code", async () => {
      defaultScope = { name: 'dflt', key_hex: DEFAULT_KEY_HEX };
      const { manager, calls } = makeManager(sourceId);
      await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot');
      const [frame] = rawFrames(calls);
      expect(frame[2]).toBe(0x14);
      expect(frame.readUInt16LE(3)).toBe(
        computeTransportCodeWithKey(Buffer.from(DEFAULT_KEY_HEX, 'hex'), 0x05, frame.subarray(8).toString('hex')),
      );
    });

    it('uses the channel scope when set', async () => {
      channelScope = 'chan-scope';
      const { manager, calls } = makeManager(sourceId);
      await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot');
      const [frame] = rawFrames(calls);
      expect(frame.readUInt16LE(3)).toBe(
        computeTransportCodeWithKey(scopeTransportKey('chan-scope'), 0x05, frame.subarray(8).toString('hex')),
      );
    });
  });

  describe('stored row', () => {
    it('stores the override name, wire timestamp and scope', async () => {
      const { manager, calls } = makeManager(sourceId);
      const res = await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', 'muenchen');
      await settle();
      const row = await databaseService.meshcore.getMessageForSource(res.message!.id, sourceId);
      expect(row?.fromName).toBe('Alice Bot');
      expect(row?.senderNameOverride).toBe('Alice Bot');
      expect(row?.senderTimestamp).toBe(Math.floor(T0 / 1000));
      expect(row?.scopeName).toBe('muenchen');
      expect(row?.text).toBe('hello');
      expect(row?.toPublicKey).toBe('channel-1');
      expect(row?.mc1Hash).toBeTruthy();
      const decoded = tryDecodeGroupTextPayload(rawFrames(calls)[0].subarray(8).toString('hex'), SECRET);
      expect(decoded?.body).toBe('Alice Bot: hello');
    });

    it('registers the packet for heard-by matching with the exact payload', async () => {
      const { manager, calls } = makeManager(sourceId);
      const res = await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', '');
      const entry = (manager as any).pendingChannelSends.get(res.message!.id);
      expect(entry.senderName).toBe('Alice Bot');
      expect(entry.payloadHex).toBe(rawFrames(calls)[0].subarray(4).toString('hex'));
    });
  });

  describe('refusals', () => {
    it('refuses with CLIENT_REPEAT_ON and sends nothing', async () => {
      deviceInfo = { repeat: true, path_hash_mode: 0 };
      const { manager, calls } = makeManager(sourceId);
      await expect(manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot')).rejects.toSatisfy(
        (e: unknown) => isMeshCoreSenderNameError(e) && e.code === 'CLIENT_REPEAT_ON',
      );
      expect(rawFrames(calls)).toEqual([]);
    });

    it('refuses with CHANNEL_KEY_UNAVAILABLE when the channel has no key', async () => {
      const { manager, calls } = makeManager(sourceId);
      await expect(manager.sendChannelMessageAs('hello', 5, 'Alice Bot')).rejects.toSatisfy(
        (e: unknown) => isMeshCoreSenderNameError(e) && e.code === 'CHANNEL_KEY_UNAVAILABLE',
      );
      expect(calls.some(c => c.cmd === 'send_raw_packet')).toBe(false);
    });

    it('maps FIRMWARE_UNSUPPORTED from the backend', async () => {
      rawResult = { success: false, error: 'nope', data: { error_code: 'FIRMWARE_UNSUPPORTED' } };
      const { manager } = makeManager(sourceId);
      await expect(manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot')).rejects.toSatisfy(
        (e: unknown) => isMeshCoreSenderNameError(e) && e.code === 'FIRMWARE_UNSUPPORTED',
      );
    });

    it('refuses text over the raw cap with TEXT_TOO_LONG, before any radio send', async () => {
      const { manager, calls } = makeManager(sourceId);
      await expect(manager.sendChannelMessageAs('x'.repeat(200), CHANNEL, 'Alice Bot')).rejects.toSatisfy(
        (e: unknown) => isMeshCoreSenderNameError(e) && e.code === 'TEXT_TOO_LONG',
      );
      expect(rawFrames(calls)).toEqual([]);
    });

    it('receive-only: throws TxDisabledError and sends nothing', async () => {
      const { manager, calls } = makeManager(sourceId);
      (manager as any).receiveOnly = true;
      await expect(manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot')).rejects.toSatisfy(isTxDisabledError);
      expect(calls).toEqual([]);
    });

    it('leaves nothing stored or registered after a failed send', async () => {
      rawResult = { success: false, error: 'queue full', data: { error_code: 'TABLE_FULL' } };
      const { manager } = makeManager(sourceId);
      await expect(manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot')).rejects.toBeTruthy();
      expect((manager as any).pendingChannelSends.size).toBe(0);
      expect((manager as any).ownRawEchoes.size).toBe(0);
    });
  });

  describe('echo handling', () => {
    function spyAutomations(m: MeshCoreManager) {
      return {
        ack: vi.spyOn(m as any, 'checkAutoAcknowledge').mockResolvedValue(undefined),
        responder: vi.spyOn(m as any, 'checkAutoPingThenResponder').mockResolvedValue(undefined),
        forward: vi.spyOn(m as any, 'checkForwarding').mockResolvedValue(undefined),
      };
    }

    it("drops the radio's copy of our own raw send: no row, no event, no automation", async () => {
      const { manager } = makeManager(sourceId);
      const spies = spyAutomations(manager);
      const res = await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', '');
      await settle();
      const emitted = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');
      const added = vi.spyOn(manager as any, 'addMessage');
      (manager as any).handleBridgeEvent({
        event_type: 'channel_message',
        data: channelEvent('Alice Bot: hello', res.senderTimestamp!),
      });
      await settle();
      expect(added).not.toHaveBeenCalled();
      expect(emitted).not.toHaveBeenCalled();
      expect(spies.ack).not.toHaveBeenCalled();
      expect(spies.responder).not.toHaveBeenCalled();
      expect(spies.forward).not.toHaveBeenCalled();
    });

    it('still delivers a different message that uses the same name', async () => {
      const { manager } = makeManager(sourceId);
      const spies = spyAutomations(manager);
      const res = await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', '');
      await settle();
      const added = vi.spyOn(manager as any, 'addMessage');
      (manager as any).handleBridgeEvent({
        event_type: 'channel_message',
        data: channelEvent('Alice Bot: something else', res.senderTimestamp!),
      });
      (manager as any).handleBridgeEvent({
        event_type: 'channel_message',
        data: channelEvent('Alice Bot: hello', res.senderTimestamp! + 1),
      });
      await settle();
      expect(added).toHaveBeenCalledTimes(2);
      // Same name as a recent override: treated as ours, so no auto reply either.
      expect(spies.ack).not.toHaveBeenCalled();
    });

    it('delivers an unrelated stranger message with auto replies', async () => {
      const { manager } = makeManager(sourceId);
      const spies = spyAutomations(manager);
      const added = vi.spyOn(manager as any, 'addMessage');
      (manager as any).handleBridgeEvent({
        event_type: 'channel_message',
        data: channelEvent('Bob: hi', Math.floor(T0 / 1000)),
      });
      await settle();
      expect(added).toHaveBeenCalledTimes(1);
      expect(spies.ack).toHaveBeenCalledTimes(1);
    });

    it('a sibling source flags the override name selfOrigin and runs no auto reply', async () => {
      const { manager: a } = makeManager(sourceId);
      await a.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', '');
      const { manager: b } = makeManager(`${sourceId}-sibling`);
      const spies = spyAutomations(b);
      const emitted = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');
      (b as any).handleBridgeEvent({
        event_type: 'channel_message',
        data: channelEvent('Alice Bot: hello', Math.floor(T0 / 1000)),
      });
      await settle();
      expect((emitted.mock.calls[0][0] as any).selfOrigin).toBe(true);
      expect(spies.ack).not.toHaveBeenCalled();
      expect(spies.responder).not.toHaveBeenCalled();
      expect(spies.forward).not.toHaveBeenCalled();
    });

    it('after the registry window the name no longer reads as ours', async () => {
      const { manager: a } = makeManager(sourceId);
      await a.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', '');
      vi.setSystemTime(T0 + 31 * 60 * 1000);
      const { manager: b } = makeManager(`${sourceId}-sibling`);
      const emitted = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');
      (b as any).handleBridgeEvent({
        event_type: 'channel_message',
        data: channelEvent('Alice Bot: late', Math.floor(Date.now() / 1000)),
      });
      await settle();
      expect((emitted.mock.calls[0][0] as any).selfOrigin).toBeUndefined();
    });
  });

  describe('findEchoMatch with payloadHex', () => {
    const rawHexFor = (payloadHex: string) =>
      Buffer.concat([Buffer.from([0x15, 0x01, 0xab]), Buffer.from(payloadHex, 'hex')]).toString('hex');

    it('matches the exact payload with no node name needed', () => {
      const payloadHex = encodeGroupTextPayload(SECRET, 'Alice Bot', 'hello', 1000);
      const pending = new Map([['m1', { channelIdx: CHANNEL, sentAt: 1000, text: 'hello', payloadHex, senderName: 'Alice Bot' }]]);
      const match = MeshCoreManager.findEchoMatch(
        { payload_type: 0x05, path_hops: ['ab'], raw_hex: rawHexFor(payloadHex) },
        pending, 1500, 60_000,
        { selfName: null, resolveChannelSecret: () => null },
      );
      expect(match?.messageId).toBe('m1');
    });

    it('does not match a different payload', () => {
      const sent = encodeGroupTextPayload(SECRET, 'Alice Bot', 'hello', 1000);
      const other = encodeGroupTextPayload(SECRET, 'Alice Bot', 'hello', 1001);
      const pending = new Map([['m1', { channelIdx: CHANNEL, sentAt: 1000, text: 'hello', payloadHex: sent, senderName: 'Alice Bot' }]]);
      const match = MeshCoreManager.findEchoMatch(
        { payload_type: 0x05, path_hops: ['ab'], raw_hex: rawHexFor(other) },
        pending, 1500, 60_000,
        { selfName: 'MyNode', resolveChannelSecret: () => SECRET },
      );
      expect(match).toBeNull();
    });

    it('a normal send entry still matches on the node name', () => {
      const payloadHex = encodeGroupTextPayload(SECRET, SELF_NAME, 'hello', 1000);
      const pending = new Map([['m1', { channelIdx: CHANNEL, sentAt: 1000, text: 'hello' }]]);
      const match = MeshCoreManager.findEchoMatch(
        { payload_type: 0x05, path_hops: ['ab'], raw_hex: rawHexFor(payloadHex) },
        pending, 1500, 60_000,
        { selfName: SELF_NAME, resolveChannelSecret: () => SECRET },
      );
      expect(match?.messageId).toBe('m1');
    });
  });

  describe('resend', () => {
    it('re-sends an override row raw with identical bytes and never via send_message', async () => {
      const { manager, calls } = makeManager(sourceId);
      const res = await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', 'muenchen');
      await settle();
      vi.setSystemTime(T0 + 60_000);
      const out = await manager.resendChannelMessage(res.message!.id);
      expect(out.resendCount).toBe(1);
      const frames = rawFrames(calls);
      expect(frames).toHaveLength(2);
      expect(frames[1].equals(frames[0])).toBe(true);
      expect(calls.some(c => c.cmd === 'send_message')).toBe(false);
      expect(calls.some(c => c.cmd === 'set_flood_scope')).toBe(false);
    });

    it('refuses (never falls back to the real name) when the name is no longer allowed', async () => {
      const { manager, calls } = makeManager(sourceId);
      const res = await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', '');
      await settle();
      policyJson = JSON.stringify({ enabled: true, allowedNames: ['Someone Else'] });
      vi.setSystemTime(T0 + 60_000);
      await expect(manager.resendChannelMessage(res.message!.id)).rejects.toSatisfy(
        (e: unknown) => isMeshCoreResendError(e) && e.code === 'RESEND_UNAVAILABLE',
      );
      expect(rawFrames(calls)).toHaveLength(1);
      expect(calls.some(c => c.cmd === 'send_message')).toBe(false);
    });

    it('refuses when the override is switched off', async () => {
      const { manager, calls } = makeManager(sourceId);
      const res = await manager.sendChannelMessageAs('hello', CHANNEL, 'Alice Bot', '');
      await settle();
      policyJson = JSON.stringify({ enabled: false, allowedNames: ['Alice Bot'] });
      vi.setSystemTime(T0 + 60_000);
      await expect(manager.resendChannelMessage(res.message!.id)).rejects.toSatisfy(isMeshCoreResendError);
      expect(calls.some(c => c.cmd === 'send_message')).toBe(false);
    });
  });
});
