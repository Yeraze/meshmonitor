/**
 * What MeshMonitor knows about one of our MeshCore DMs or room posts (#5682).
 *
 * A room post is a DM to the room server, so both kinds get the same two
 * signals from the companion and no others:
 *   - the answer to the send command: `Sent` (with an ack CRC and a timeout
 *     estimate) or `Err`. `Sent` means the firmware built the packet and
 *     queued it. Nothing reports the transmission itself.
 *   - a later `SendConfirmed` push carrying that CRC, when the far end's ack
 *     is heard: the recipient's radio for a DM, the room server for a post.
 *
 * So the states the UI can back are:
 *   - no row              the radio refused, errored, or receive-only blocked it
 *   - row, `sent`         accepted, ack awaited
 *   - row, `delivered`    ack heard
 *   - row, `failed`       no ack in time (DM: after all retries; post: one try)
 *   - row, no state       accepted, ack tracking lost (restart / disconnect)
 *
 * Real `:memory:` SQLite, so "survives a restart" means the stored rows: a
 * second manager on the same source reloads them through `connect()`. Only the
 * radio (`sendBridgeCommand`) and settings are stubbed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, ConnectionType, type MeshCoreMessage } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import { isTxDisabledError } from './errors/txDisabledError.js';

interface BridgeCall { cmd: string; params: Record<string, unknown>; }
type BridgeAnswer = { success: boolean; data?: unknown; error?: string } | Error;

const SELF_KEY = 'c'.repeat(64);
const PEER = 'b'.repeat(64);
const ROOM = 'd'.repeat(64);
const EST = 8000;
/** Past est * DM_ACK_TIMEOUT_MARGIN (1.2). */
const PAST_TIMEOUT = EST * 1.2 + 50;

let sourceCounter = 0;

function makeManager(
  sourceId: string,
  answers: BridgeAnswer[] = [],
): { manager: MeshCoreManager; calls: BridgeCall[] } {
  const m = new MeshCoreManager(sourceId);
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { publicKey: SELF_KEY, name: 'MyNode' };
  const calls: BridgeCall[] = [];
  let n = 0;
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    calls.push({ cmd, params });
    if (cmd !== 'send_message') return { id: '1', success: true, data: {} };
    // Default: a fresh CRC per attempt, as the firmware gives.
    const answer = answers[n] ?? { success: true, data: { expectedAckCrc: 1000 + n, estTimeout: EST } };
    n += 1;
    if (answer instanceof Error) throw answer;
    return { id: '1', ...answer };
  };
  return { manager: m, calls };
}

/** Let fire-and-forget DB writes settle. `setImmediate` is left real. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
}

function ack(m: MeshCoreManager, ackCode: number, roundTripMs = 640): void {
  (m as any).handleBridgeEvent({ event_type: 'send_confirmed', data: { ack_code: ackCode, round_trip_ms: roundTripMs } });
}

const pool = (m: MeshCoreManager) => (m as any).messages as MeshCoreMessage[];
const sendsOf = (calls: BridgeCall[]) => calls.filter(c => c.cmd === 'send_message');

/** A fresh process on the same source: reloads the pool from the database. */
async function restart(sourceId: string): Promise<MeshCoreManager> {
  const m = new MeshCoreManager(sourceId);
  // Stop connect() right after the history load: no radio in a test.
  (m as any).startNativeBackend = vi.fn().mockRejectedValue(new Error('no radio in tests'));
  (m as any).disconnect = vi.fn().mockResolvedValue(undefined);
  (m as any).scheduleNextReconnect = vi.fn();
  await m.connect({ connectionType: ConnectionType.SERIAL, firmwareType: 'companion', serialPort: '/dev/ttyTEST' });
  return m;
}

const eventTypes = async (sourceId: string, id: string) =>
  (await databaseService.messageEvents.getEventsForMessage(sourceId, id)).map(e => e.eventType);

describe('MeshCore DM and room post: what the row proves (#5682)', () => {
  let sourceId: string;
  let updates: Array<Record<string, unknown>>;

  beforeAll(async () => {
    await databaseService.waitForReady();
  });

  beforeEach(() => {
    sourceId = `direct-send-src-${++sourceCounter}`;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(databaseService, 'settings', 'get').mockReturnValue({
      getSettingForSource: vi.fn(async () => null),
      setSourceSetting: vi.fn(async () => {}),
      getSettingAsBoolean: vi.fn(async (_key: string, def: boolean) => def),
    } as any);
    updates = [];
    vi.spyOn(dataEventEmitter, 'emitMeshCoreMessageUpdated').mockImplementation((data) => {
      updates.push(data as Record<string, unknown>);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('direct message', () => {
    async function sendDm(m: MeshCoreManager): Promise<MeshCoreMessage> {
      expect(await m.sendMessage('hello bob', PEER)).toBe(true);
      await settle();
      return pool(m)[pool(m).length - 1];
    }

    it('accepted by the radio: one row, awaiting its ack', async () => {
      const { manager } = makeManager(sourceId);
      const msg = await sendDm(manager);
      expect(msg).toMatchObject({ fromPublicKey: SELF_KEY, toPublicKey: PEER, deliveryStatus: 'sent', expectedAckCrc: 1000 });
      // The state is on the row the API serves, not only in a socket event.
      expect(manager.getRecentMessages(10).find(r => r.id === msg.id)?.deliveryStatus).toBe('sent');
      expect(await eventTypes(sourceId, msg.id)).toEqual(['submitted']);
    });

    it('ack heard: delivered, with the round trip the radio reported, and it survives a restart', async () => {
      const { manager } = makeManager(sourceId);
      const msg = await sendDm(manager);
      ack(manager, 1000, 640);
      await settle();
      expect(pool(manager).find(r => r.id === msg.id)).toMatchObject({ deliveryStatus: 'delivered', roundTripMs: 640 });

      const reloaded = pool(await restart(sourceId)).find(r => r.id === msg.id);
      expect(reloaded).toMatchObject({ deliveryStatus: 'delivered', roundTripMs: 640 });
    });

    it('no ack after every retry: not confirmed, and it survives a restart', async () => {
      const { manager, calls } = makeManager(sourceId);
      const msg = await sendDm(manager);
      // Initial send + 2 same-path + 1 flood (#3977): four waits.
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(PAST_TIMEOUT);
        await settle();
      }
      expect(sendsOf(calls)).toHaveLength(4);
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBe('failed');
      expect(updates.at(-1)).toMatchObject({ id: msg.id, deliveryStatus: 'failed' });
      // A retry in between kept the row "awaiting", never a false terminal.
      expect(updates.slice(0, -1).every(u => u.deliveryStatus === 'sent')).toBe(true);

      expect(pool(await restart(sourceId)).find(r => r.id === msg.id)?.deliveryStatus).toBe('failed');
    });

    it('an ack that arrives after the give-up still counts, live and after a restart', async () => {
      const { manager } = makeManager(sourceId);
      const msg = await sendDm(manager);
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(PAST_TIMEOUT);
        await settle();
      }
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBe('failed');
      // The last attempt's CRC (the row tracks the newest attempt).
      ack(manager, 1003, 31000);
      await settle();
      expect(pool(manager).find(r => r.id === msg.id)).toMatchObject({ deliveryStatus: 'delivered', roundTripMs: 31000 });
      // Both events are on record; the ack wins on reload.
      expect(await eventTypes(sourceId, msg.id)).toEqual(expect.arrayContaining(['timeout', 'delivered']));
      expect(pool(await restart(sourceId)).find(r => r.id === msg.id)?.deliveryStatus).toBe('delivered');
    });

    it('a restart mid-wait leaves no ack state: accepted by the radio is all that is known', async () => {
      const { manager } = makeManager(sourceId);
      const msg = await sendDm(manager);
      expect(msg.deliveryStatus).toBe('sent');
      const reloaded = pool(await restart(sourceId)).find(r => r.id === msg.id);
      expect(reloaded).toBeDefined();
      // Not "awaiting" (nobody is waiting any more) and not "failed" (never concluded).
      expect(reloaded!.deliveryStatus).toBeUndefined();
      expect(await eventTypes(sourceId, msg.id)).toEqual(['submitted']);
    });

    it('a disconnect mid-wait drops "awaiting" and arms nothing more', async () => {
      const { manager, calls } = makeManager(sourceId);
      const msg = await sendDm(manager);
      await manager.disconnect();
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBeUndefined();
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT * 5);
      await settle();
      expect(sendsOf(calls)).toHaveLength(1);
      expect(await eventTypes(sourceId, msg.id)).toEqual(['submitted']);
    });

    it.each([
      ['Err', { success: false, error: 'ERR_CODE_TABLE_FULL' } as BridgeAnswer],
      ['a thrown timeout', new Error('timed out') as BridgeAnswer],
    ])('refused by the radio (%s): no row, so nothing to mark', async (_name, answer) => {
      const { manager } = makeManager(sourceId, [answer]);
      expect(await manager.sendMessage('hello bob', PEER)).toBe(false);
      await settle();
      expect(pool(manager)).toHaveLength(0);
      expect(await databaseService.meshcore.getRecentMessages(10, sourceId)).toHaveLength(0);
    });

    it('receive-only: throws before the radio is asked, no row', async () => {
      const { manager, calls } = makeManager(sourceId);
      (manager as any).receiveOnly = true;
      await expect(manager.sendMessage('hello bob', PEER)).rejects.toSatisfy(isTxDisabledError);
      expect(sendsOf(calls)).toHaveLength(0);
      expect(pool(manager)).toHaveLength(0);
    });

    it('an ack for an unknown CRC, or CRC 0, settles nothing', async () => {
      const { manager } = makeManager(sourceId);
      const msg = await sendDm(manager);
      ack(manager, 4242);
      ack(manager, 0);
      await settle();
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBe('sent');
      expect(await eventTypes(sourceId, msg.id)).toEqual(['submitted']);
    });
  });

  describe('room post', () => {
    async function post(m: MeshCoreManager): Promise<MeshCoreMessage> {
      expect(await m.sendRoomPost('hello room', ROOM)).toBe(true);
      await settle();
      return pool(m)[pool(m).length - 1];
    }

    it('accepted by the radio: one tagged row, awaiting the room server', async () => {
      const { manager, calls } = makeManager(sourceId);
      const msg = await post(manager);
      expect(msg).toMatchObject({
        fromPublicKey: SELF_KEY,
        toPublicKey: ROOM,
        messageType: 'room_post',
        deliveryStatus: 'sent',
        expectedAckCrc: 1000,
        estTimeout: EST,
      });
      expect(sendsOf(calls)).toHaveLength(1);
      expect(await eventTypes(sourceId, msg.id)).toEqual(['submitted']);
    });

    it('room server ack: delivered, and it survives a restart still tagged as a room post', async () => {
      const { manager } = makeManager(sourceId);
      const msg = await post(manager);
      ack(manager, 1000, 1200);
      await settle();
      expect(pool(manager).find(r => r.id === msg.id)).toMatchObject({ deliveryStatus: 'delivered', roundTripMs: 1200 });
      expect(await eventTypes(sourceId, msg.id)).toEqual(['submitted', 'delivered']);

      const reloaded = pool(await restart(sourceId)).find(r => r.id === msg.id);
      expect(reloaded).toMatchObject({ messageType: 'room_post', deliveryStatus: 'delivered', roundTripMs: 1200 });
    });

    it('no ack in time: not confirmed after ONE attempt, never resent', async () => {
      const { manager, calls } = makeManager(sourceId);
      const msg = await post(manager);
      // Not before the radio's estimate (plus margin) has passed.
      await vi.advanceTimersByTimeAsync(EST);
      await settle();
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBe('sent');

      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT);
      await settle();
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBe('failed');
      expect(updates).toEqual([{ id: msg.id, previousAckCrc: 1000, deliveryStatus: 'failed' }]);
      expect(await eventTypes(sourceId, msg.id)).toEqual(['submitted', 'timeout']);

      // Mesh impact: the wait costs no airtime. One packet, ever.
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT * 10);
      await settle();
      expect(sendsOf(calls)).toHaveLength(1);
      expect(calls.some(c => c.cmd === 'reset_path')).toBe(false);

      expect(pool(await restart(sourceId)).find(r => r.id === msg.id))
        .toMatchObject({ messageType: 'room_post', deliveryStatus: 'failed' });
    });

    it('a late ack still counts', async () => {
      const { manager } = makeManager(sourceId);
      const msg = await post(manager);
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT);
      await settle();
      ack(manager, 1000, 15000);
      await settle();
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBe('delivered');
      expect(pool(await restart(sourceId)).find(r => r.id === msg.id)?.deliveryStatus).toBe('delivered');
    });

    it('an ack in time cancels the wait: no later "not confirmed"', async () => {
      const { manager } = makeManager(sourceId);
      const msg = await post(manager);
      ack(manager, 1000);
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT * 3);
      await settle();
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBe('delivered');
      expect(updates).toEqual([]);
      // Exactly one `delivered` row, and no `timeout`.
      expect(await eventTypes(sourceId, msg.id)).toEqual(['submitted', 'delivered']);
    });

    it('a restart or disconnect mid-wait leaves no ack state', async () => {
      const { manager, calls } = makeManager(sourceId);
      const msg = await post(manager);
      const reloaded = pool(await restart(sourceId)).find(r => r.id === msg.id);
      expect(reloaded).toMatchObject({ messageType: 'room_post' });
      expect(reloaded!.deliveryStatus).toBeUndefined();

      await manager.disconnect();
      expect(pool(manager).find(r => r.id === msg.id)?.deliveryStatus).toBeUndefined();
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT * 3);
      await settle();
      expect(updates).toEqual([]);
      expect(sendsOf(calls)).toHaveLength(1);
    });

    it('the radio gave no ack CRC: the row claims no wait and arms no timer', async () => {
      const { manager } = makeManager(sourceId, [{ success: true, data: { sent: true } }]);
      const msg = await post(manager);
      expect(msg.deliveryStatus).toBeUndefined();
      expect(msg.expectedAckCrc).toBeUndefined();
      await vi.advanceTimersByTimeAsync(PAST_TIMEOUT * 3);
      await settle();
      expect(updates).toEqual([]);
    });

    it.each([
      ['Err', { success: false, error: 'ERR_CODE_NOT_FOUND' } as BridgeAnswer],
      ['a thrown timeout', new Error('timed out') as BridgeAnswer],
    ])('refused by the radio (%s): no row', async (_name, answer) => {
      const { manager } = makeManager(sourceId, [answer]);
      expect(await manager.sendRoomPost('hello room', ROOM)).toBe(false);
      await settle();
      expect(pool(manager)).toHaveLength(0);
      expect(await databaseService.meshcore.getRecentMessages(10, sourceId)).toHaveLength(0);
    });
  });

  it('a DM ack never settles a room post, nor the reverse', async () => {
    const { manager } = makeManager(sourceId);
    expect(await manager.sendMessage('hello bob', PEER)).toBe(true);
    expect(await manager.sendRoomPost('hello room', ROOM)).toBe(true);
    await settle();
    const [dm, roomPost] = pool(manager);
    expect([dm.expectedAckCrc, roomPost.expectedAckCrc]).toEqual([1000, 1001]);
    ack(manager, 1001);
    await settle();
    expect(pool(manager).map(r => r.deliveryStatus)).toEqual(['sent', 'delivered']);
  });

  it('received DMs, received room posts and channel rows get no delivery state on reload', async () => {
    const { manager } = makeManager(sourceId);
    (manager as any).addMessage({ id: 'rx-dm', fromPublicKey: PEER, toPublicKey: SELF_KEY, text: 'hi', timestamp: Date.now() });
    (manager as any).addMessage({ id: 'rx-post', fromPublicKey: PEER, toPublicKey: ROOM, text: 'hi', timestamp: Date.now(), messageType: 'room_post' });
    (manager as any).addMessage({ id: 'own-ch', fromPublicKey: SELF_KEY, toPublicKey: 'channel-1', text: 'hi', timestamp: Date.now() });
    await settle();
    const rows = pool(await restart(sourceId));
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.deliveryStatus === undefined)).toBe(true);
    expect(rows.find(r => r.id === 'rx-post')?.messageType).toBe('room_post');
  });
});
