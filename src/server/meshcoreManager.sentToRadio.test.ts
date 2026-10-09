/**
 * What MeshMonitor knows about one of our MeshCore channel sends (#5682).
 *
 * The companion protocol gives exactly one signal for a channel send: the
 * `Ok` / `Err` answer to the command. `Ok` means the firmware built the packet
 * and queued it. Nothing reports the transmission itself (`LogRxData` is a
 * receive feed; the firmware's `logTx` hook does not reach the host).
 *
 * So the states the UI can back are:
 *   - no row            the radio refused, errored, or receive-only blocked it
 *   - row, no heardBy   "Sent to radio"
 *   - row + heardBy     relayed (a repeater's re-flood was heard, #3700)
 *
 * These tests pin the facts that mark relies on, against the real `:memory:`
 * SQLite singleton so "survives a restart" means the stored rows. Only the
 * radio (`sendBridgeCommand`), the channel lookup and settings are stubbed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { encodeGroupTextPayload } from './utils/meshcoreGroupEcho.js';
import { isTxDisabledError } from './errors/txDisabledError.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }
type BridgeAnswer = { success: boolean; data?: unknown; error?: string } | Error;

const SELF_KEY = 'c'.repeat(64);
const SELF_NAME = 'MyNode';
const CHANNEL = 1;
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const TS = Math.floor(T0 / 1000);

const SECRET = new Uint8Array(16).map((_, i) => (i * 7 + 5) & 0xff);
const SECRET_B64 = Buffer.from(SECRET).toString('base64');

let sourceCounter = 0;

function makeManager(
  sourceId: string,
  sendAnswer: BridgeAnswer = { success: true, data: {} },
): { manager: MeshCoreManager; calls: BridgeCall[] } {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF_KEY, name: SELF_NAME };
  const calls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    if (cmd !== 'send_message') return { id: '1', success: true, data: {} };
    if (sendAnswer instanceof Error) throw sendAnswer;
    return { id: '1', ...sendAnswer };
  };
  return { manager: m, calls };
}

/** Let fire-and-forget DB writes settle. Not faked by `toFake: ['Date']`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
}

/** The OTA frame for `"<sender>: <text>"` on our channel, with a relay chain. */
function frameOf(text: string, hops: string[], sender = SELF_NAME): Record<string, unknown> {
  const payloadHex = encodeGroupTextPayload(SECRET, sender, text, TS);
  const header = 0x01 | (0x05 << 2);
  const bytes = [header, hops.length & 0x3f, ...hops.map(h => parseInt(h, 16) & 0xff)];
  return {
    payload_type: 0x05,
    path_hops: hops,
    snr: 5,
    raw_hex: Buffer.concat([Buffer.from(bytes), Buffer.from(payloadHex, 'hex')]).toString('hex'),
  };
}

const heardHashes = async (id: string, sourceId: string) =>
  (await databaseService.meshcore.getHeardRepeatersForMessage(id, sourceId)).map(h => h.repeaterHash);

describe('MeshCore channel send: what the row proves (#5682)', () => {
  let sourceId: string;

  beforeAll(async () => {
    await databaseService.waitForReady();
  });

  beforeEach(() => {
    sourceId = `sent-to-radio-src-${++sourceCounter}`;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.spyOn(databaseService, 'channels', 'get').mockReturnValue({
      getChannelById: vi.fn(async (idx: number) => (idx === CHANNEL ? { id: CHANNEL, psk: SECRET_B64 } : null)),
    } as any);
    vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
      getSettingForSource: vi.fn(async () => null),
      setSourceSetting: vi.fn(async () => {}),
      getSettingAsBoolean: vi.fn(async (_key: string, def: boolean) => def),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function sendOne(m: MeshCoreManager, text = 'hello mesh'): Promise<string> {
    expect(await m.sendMessage(text, undefined, CHANNEL)).toBe(true);
    await settle();
    const msgs = (m as any).messages as Array<{ id: string }>;
    return msgs[msgs.length - 1].id;
  }

  it('an accepted send stores one own channel row with no relay: "Sent to radio"', async () => {
    const { manager, calls } = makeManager(sourceId);
    const bus = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');
    const id = await sendOne(manager);

    const [live] = manager.getRecentMessages(10);
    expect(live).toMatchObject({ id, fromPublicKey: SELF_KEY, toPublicKey: `channel-${CHANNEL}` });
    expect(live.heardBy).toBeUndefined();
    expect(bus).toHaveBeenCalledTimes(1);

    // The stored row carries the same facts, so a reload or a restart shows
    // the same mark.
    const rows = await databaseService.meshcore.getRecentMessages(50, sourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, fromPublicKey: SELF_KEY, toPublicKey: `channel-${CHANNEL}` });
    expect(await heardHashes(id, sourceId)).toEqual([]);

    // Mesh impact: one send command, nothing else asked of the radio for it.
    expect(calls.filter(c => c.cmd === 'send_message')).toHaveLength(1);
    expect(calls.filter(c => c.cmd !== 'send_message' && c.cmd !== 'set_flood_scope')).toEqual([]);
  });

  it.each([
    ['the radio answers Err', { success: false, error: 'not found' } as BridgeAnswer],
    ['the command throws (timeout, link down)', new Error('Native command timeout: send_message') as BridgeAnswer],
  ])('stores no row and emits nothing when %s', async (_name, answer) => {
    const { manager } = makeManager(sourceId, answer);
    const bus = vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage');

    expect(await manager.sendMessage('hello mesh', undefined, CHANNEL)).toBe(false);
    await settle();

    expect(manager.getRecentMessages(10)).toEqual([]);
    expect(await databaseService.meshcore.getRecentMessages(50, sourceId)).toEqual([]);
    expect(bus).not.toHaveBeenCalled();
    expect((manager as any).pendingChannelSends.size).toBe(0);
  });

  it('stores no row when receive-only blocks the send before it reaches the radio', async () => {
    const { manager, calls } = makeManager(sourceId);
    manager.setReceiveOnly(true);

    const err = await manager.sendMessage('hello mesh', undefined, CHANNEL).catch(e => e);
    await settle();

    expect(isTxDisabledError(err)).toBe(true);
    expect(calls).toEqual([]);
    expect(await databaseService.meshcore.getRecentMessages(50, sourceId)).toEqual([]);
  });

  it('a zero-hop frame with our exact name and text never counts as a relay', async () => {
    // The firmware does not hand our own transmission back, so a zero-hop
    // GRP_TXT that decrypts to "<ourName>: <ourText>" can only be another
    // radio using our name. It names no repeater and must confirm nothing.
    const { manager } = makeManager(sourceId);
    const heard = vi.spyOn(dataEventEmitter, 'emitMeshCoreChannelHeard');
    const id = await sendOne(manager);

    await (manager as any).correlateChannelEcho(frameOf('hello mesh', []));
    await (manager as any).correlateChannelEcho({ ...frameOf('hello mesh', []), path_hops: undefined });

    expect(await heardHashes(id, sourceId)).toEqual([]);
    expect(manager.getRecentMessages(10)[0].heardBy).toBeUndefined();
    expect(heard).not.toHaveBeenCalled();
  });

  it('a relayed frame from another sender with the same text confirms nothing', async () => {
    const { manager } = makeManager(sourceId);
    const id = await sendOne(manager);

    await (manager as any).correlateChannelEcho(frameOf('hello mesh', ['7f'], 'SomeoneElse'));

    expect(await heardHashes(id, sourceId)).toEqual([]);
  });

  it('a relay echo upgrades the message, and the upgrade is stored', async () => {
    const { manager } = makeManager(sourceId);
    const heard = vi.spyOn(dataEventEmitter, 'emitMeshCoreChannelHeard');
    const id = await sendOne(manager);

    await (manager as any).correlateChannelEcho(frameOf('hello mesh', ['7f']));

    expect(await heardHashes(id, sourceId)).toEqual(['7f']);
    expect(manager.getRecentMessages(10)[0].heardBy).toEqual([{ hash: '7f', name: null, snr: 5 }]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith({ id, heardBy: [{ hash: '7f', name: null, snr: 5 }] }, sourceId);
    // What a restart reloads (connect() enriches rows from this same query).
    const reloaded = await databaseService.meshcore.getHeardRepeatersForMessages([id], sourceId);
    expect(reloaded[id].map(r => r.repeaterHash)).toEqual(['7f']);
  });

  it('nothing after a relay echo takes the relay away again', async () => {
    const { manager } = makeManager(sourceId);
    const heard = vi.spyOn(dataEventEmitter, 'emitMeshCoreChannelHeard');
    const id = await sendOne(manager);
    await (manager as any).correlateChannelEcho(frameOf('hello mesh', ['7f']));

    // A late zero-hop copy, then the same echo heard a second time.
    await (manager as any).correlateChannelEcho(frameOf('hello mesh', []));
    await (manager as any).correlateChannelEcho(frameOf('hello mesh', ['7f']));

    expect(await heardHashes(id, sourceId)).toEqual(['7f']);
    expect(manager.getRecentMessages(10)[0].heardBy).toEqual([{ hash: '7f', name: null, snr: 5 }]);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
