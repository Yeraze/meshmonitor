/**
 * MeshCore Repeater source over the serial CLI (#5500):
 *  - the serial CLI mutex (concurrent callers never swap replies),
 *  - streaming log lines (RAW / RX / TX / DEBUG) kept out of command replies,
 *  - RAW + RX pairing into the Packet Monitor path (handleOtaPacket),
 *  - the idle-gap end of a multi-line `neighbors` reply,
 *  - `get public.key` in refreshLocalNode,
 *  - neighbours ingest (prefix resolution, upsert, graph rows),
 *  - the 5-minute poll (cadence, in-flight skip, reconnect, disconnect).
 *
 * No real serial port is opened: a fake port answers each written command by
 * feeding lines into handleSerialData, the way the ReadlineParser would.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import meshcorePacketLogService from './services/meshcorePacketLogService.js';
import { dataEventEmitter } from './services/dataEventEmitter.js';
import {
  REPEATER_NEIGHBORS_INITIAL_DELAY_MS,
  REPEATER_NEIGHBORS_POLL_INTERVAL_MS,
} from './utils/meshcoreRepeaterSerial.js';

// Real GRP_TXT flood frame (69 bytes), CoreScope capture.
const GRP_TXT =
  '1540D9AEFFB8183F8F47F919E136150469109973F7C3E2C2932DCA02542008F06F72F2A75639827A40C96F08A544D1BC568BAD9F100D29DACA0B3E8098F75476195E43E9F5';
const RAW_LINE = `14:02:07 - 30/9/2026 U RAW: ${GRP_TXT}`;
const RX_LINE =
  '14:02:07 - 30/9/2026 U: RX, len=69 (type=5, route=F, payload_len=66) SNR=7 RSSI=-92 score=1000 time=1234 hash=931D5DA9D6054F49';
const TX_LINE = '14:02:08 - 30/9/2026 U: TX, len=69 (type=5, route=F, payload_len=66)';
const SELF_KEY = 'fe'.repeat(32);

type Internals = {
  deviceType: MeshCoreDeviceType;
  connected: boolean;
  serialPort: { isOpen: boolean; write: (d: string) => void } | null;
  repeaterPublicKey: string | null;
  repeaterCliPending: number;
  repeaterNeighborsTimer: unknown;
  handleSerialData: (line: string) => void;
  sendRepeaterCommand: (cmd: string, timeout?: number, opts?: { idleGapMs?: number }) => Promise<string>;
  startRepeaterNeighborsPoll: () => void;
  stopRepeaterNeighborsPoll: () => void;
  ingestRepeaterNeighborsReply: MeshCoreManager['ingestRepeaterNeighborsReply'];
};
const internals = (m: MeshCoreManager) => m as unknown as Internals;

/**
 * A fake serial port. `script` maps a command to the lines the "device"
 * prints after it (echo included automatically). Lines are delivered on
 * later macrotasks, one per `gapMs`, like a slow UART.
 */
function repeaterWithFakePort(script: Record<string, string[]>, gapMs = 2) {
  const m = new MeshCoreManager('src-rep');
  const i = internals(m);
  i.deviceType = MeshCoreDeviceType.REPEATER;
  i.connected = true;
  const writes: string[] = [];
  i.serialPort = {
    isOpen: true,
    write: (data: string) => {
      const cmd = data.replace(/\r$/, '');
      writes.push(cmd);
      const lines = [cmd, ...(script[cmd] ?? ['  -> Unknown command'])];
      lines.forEach((line, n) => setTimeout(() => i.handleSerialData(line), gapMs * (n + 1)));
    },
  };
  return { m, i, writes };
}

describe('serial CLI mutex (#5500)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serializes concurrent commands so replies never swap', async () => {
    const { i, writes } = repeaterWithFakePort({
      'get name': ['  -> > Hilltop'],
      'get tx': ['  -> > 22'],
      'get lat': ['  -> > 45.8'],
    });
    const [name, tx, lat] = await Promise.all([
      i.sendRepeaterCommand('get name'),
      i.sendRepeaterCommand('get tx'),
      i.sendRepeaterCommand('get lat'),
    ]);
    expect(name).toBe('-> > Hilltop');
    expect(tx).toBe('-> > 22');
    expect(lat).toBe('-> > 45.8');
    expect(writes).toEqual(['get name', 'get tx', 'get lat']);
    expect(i.repeaterCliPending).toBe(0);
  });

  it('does not write the next command until the previous one finished', async () => {
    const { i, writes } = repeaterWithFakePort({ 'get name': ['  -> > A'], 'get tx': ['  -> > 1'] }, 10);
    const first = i.sendRepeaterCommand('get name');
    const second = i.sendRepeaterCommand('get tx');
    await new Promise((r) => setTimeout(r, 5));
    expect(writes).toEqual(['get name']);
    expect(m_busy(i)).toBe(true);
    await first;
    await second;
    expect(writes).toEqual(['get name', 'get tx']);
    expect(m_busy(i)).toBe(false);
  });

  it('a failed command does not wedge the queue', async () => {
    const { i } = repeaterWithFakePort({ 'get tx': ['  -> > 5'] });
    const port = i.serialPort!;
    i.serialPort = null;
    await expect(i.sendRepeaterCommand('get name')).rejects.toThrow(/Serial port not open/);
    i.serialPort = port;
    await expect(i.sendRepeaterCommand('get tx')).resolves.toBe('-> > 5');
  });
});

function m_busy(i: Internals): boolean {
  return i.repeaterCliPending > 0;
}

describe('streaming lines vs command replies (#5500)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(true);
    logSpy = vi.spyOn(meshcorePacketLogService, 'logPacket').mockResolvedValue(undefined as never);
    vi.spyOn(dataEventEmitter, 'emitMeshCoreOtaPacket').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps RAW / RX / TX / DEBUG lines out of a reply and routes RAW+RX to the packet log', async () => {
    const { i } = repeaterWithFakePort({
      'get name': [RAW_LINE, 'DEBUG: Login, sender not in ACL', RX_LINE, TX_LINE, '  -> > Hilltop'],
    });
    const reply = await i.sendRepeaterCommand('get name');
    expect(reply).toBe('-> > Hilltop');

    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1));
    expect(logSpy.mock.calls[0][0]).toMatchObject({
      sourceId: 'src-rep',
      payloadType: 5,
      routeType: 1,
      hopCount: 0,
      snr: 7,
      rssi: -92,
      payloadSize: 69,
      rawHex: GRP_TXT.toLowerCase(),
    });
  });

  it('an "OK" inside a DEBUG line cannot end a reply early', async () => {
    const { i } = repeaterWithFakePort({
      'get tx': ['DEBUG: radio OK', '  -> > 22'],
    });
    await expect(i.sendRepeaterCommand('get tx')).resolves.toBe('-> > 22');
  });

  it('logs a lone RAW line without signal once the pairing window passes', async () => {
    const { m, i } = repeaterWithFakePort({});
    i.handleSerialData(`09:00:00 - 1/1/2026 U RAW: 0642359A9CC9782930704E86F9D77715A516E5B1F7DC14F3CC75`);
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1));
    expect(logSpy.mock.calls[0][0]).toMatchObject({
      payloadType: 1,
      routeType: 2,
      hopCount: 2,
      pathHops: '359a,9cc9',
      snr: null,
      rssi: null,
    });
    expect(m.isRepeaterPacketStreamActive()).toBe(true);
  });

  it('respects the packet-log enable gate', async () => {
    vi.spyOn(meshcorePacketLogService, 'isEnabled').mockResolvedValue(false);
    const { i } = repeaterWithFakePort({});
    i.handleSerialData(RAW_LINE);
    i.handleSerialData(RX_LINE);
    await new Promise((r) => setTimeout(r, 20));
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('skips a RAW frame parseObserverFrame rejects (non-zero payload version)', async () => {
    const { i } = repeaterWithFakePort({});
    i.handleSerialData('09:00:00 - 1/1/2026 U RAW: D500DEADBEEF');
    i.handleSerialData('09:00:00 - 1/1/2026 U: RX, len=6 (type=5, route=F, payload_len=4) SNR=1 RSSI=-90 score=1 time=1 hash=00');
    await new Promise((r) => setTimeout(r, 20));
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('neighbors idle gap (#5500)', () => {
  it('returns a multi-line reply well before the command timeout', async () => {
    const { i } = repeaterWithFakePort({
      neighbors: ['  -> ABCD1234:12:40', 'EF015678:300:-8', '0A0B0C0D:4000:22'],
    });
    const started = Date.now();
    const reply = await i.sendRepeaterCommand('neighbors', 5000, { idleGapMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(reply.split('\n')).toEqual(['-> ABCD1234:12:40', 'EF015678:300:-8', '0A0B0C0D:4000:22']);
  });

  it('does not end before the first -> line arrives', async () => {
    const { i } = repeaterWithFakePort({ neighbors: ['  -> -none-'] }, 150);
    const reply = await i.sendRepeaterCommand('neighbors', 5000, { idleGapMs: 50 });
    expect(reply).toBe('-> -none-');
  });
});

describe('refreshLocalNode reads get public.key (#5500)', () => {
  it('stores the real key apart from the placeholder', async () => {
    const m = new MeshCoreManager('src-rep');
    const i = internals(m);
    i.deviceType = MeshCoreDeviceType.REPEATER;
    const replies: Record<string, string> = {
      'get name': '  -> > Hilltop',
      'get radio': '  -> > 869.618,62.5,8,8',
      'get public.key': `  -> > ${SELF_KEY.toUpperCase()}`,
    };
    i.sendRepeaterCommand = async (cmd: string) => replies[cmd] ?? '  -> Error: unknown config';
    const node = await m.refreshLocalNode();
    expect(node?.publicKey).toBe('repeater');
    expect(m.getRepeaterPublicKey()).toBe(SELF_KEY);
  });
});

describe('ingestRepeaterNeighborsReply (#5500)', () => {
  const NOW = new Date('2026-09-30T12:00:00Z').getTime();
  const K_HILL = 'abcd1234' + '1'.repeat(56);
  const K_AMB1 = 'ef015678' + '2'.repeat(56);
  const K_AMB2 = 'ef015678' + '3'.repeat(56);
  let upsertSpy: ReturnType<typeof vi.spyOn>;
  let insertSpy: ReturnType<typeof vi.spyOn>;
  let storedSpy: ReturnType<typeof vi.spyOn>;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(databaseService.meshcore, 'findNodesByPublicKeyPrefix').mockImplementation(async (prefix: string) => {
      const rows: Record<string, unknown[]> = {
        abcd1234: [
          { publicKey: K_HILL, sourceId: 'src-companion', name: 'Hilltop', advType: 2, latitude: 45.8, longitude: 15.9, lastHeard: 1 },
        ],
        ef015678: [
          { publicKey: K_AMB1, sourceId: 'src-companion', name: 'A' },
          { publicKey: K_AMB2, sourceId: 'src-companion', name: 'B' },
        ],
        fefefefe: [{ publicKey: SELF_KEY, sourceId: 'src-companion', name: 'Me' }],
      };
      return (rows[prefix] ?? []) as never;
    });
    upsertSpy = vi.spyOn(databaseService.meshcore, 'upsertNode').mockResolvedValue(undefined);
    insertSpy = vi.spyOn(databaseService.meshcore, 'insertNeighborsBatch').mockResolvedValue(undefined);
    storedSpy = vi.spyOn(databaseService.meshcore, 'getNeighborsForReporter').mockResolvedValue([]);
    emitSpy = vi.spyOn(dataEventEmitter, 'emitMeshCoreContactUpdated').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function manager(selfKey: string | null = SELF_KEY) {
    const m = new MeshCoreManager('src-rep');
    internals(m).deviceType = MeshCoreDeviceType.REPEATER;
    internals(m).repeaterPublicKey = selfKey;
    return m;
  }

  it('upserts only the uniquely-resolved neighbour, copying identity and scaling SNR', async () => {
    const m = manager();
    const result = await m.ingestRepeaterNeighborsReply(
      '-> ABCD1234:12:40\nEF015678:300:-8\n99999999:5:4\nFEFEFEFE:1:1',
    );
    expect(result).toEqual([{ publicKey: K_HILL, name: 'Hilltop', snr: 10, lastHeardSecs: 12 }]);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledWith(
      {
        publicKey: K_HILL,
        name: 'Hilltop',
        advType: 2,
        latitude: 45.8,
        longitude: 15.9,
        snr: 10,
        lastHeard: NOW - 12_000,
        // #5553: only this poll marks a node as a zero-hop neighbour.
        repeaterNeighborAt: NOW,
      },
      'src-rep',
    );
    expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({ publicKey: K_HILL, lastSeen: NOW - 12_000 }), 'src-rep');
    // Graph rows keyed by the repeater's REAL key; a short reply replaces.
    expect(insertSpy).toHaveBeenCalledWith('src-rep', SELF_KEY, [
      { neighborPublicKey: K_HILL, snr: 10, lastHeardSecs: 12 },
    ]);
    expect(storedSpy).not.toHaveBeenCalled();
  });

  it('defaults advType to REPEATER and clamps a negative secs_ago', async () => {
    vi.mocked(databaseService.meshcore.findNodesByPublicKeyPrefix).mockResolvedValue([
      { publicKey: K_HILL, sourceId: 'src-x', name: null, advType: null } as never,
    ]);
    const m = manager();
    await m.ingestRepeaterNeighborsReply('-> ABCD1234:-5:-8');
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ publicKey: K_HILL, advType: MeshCoreDeviceType.REPEATER, snr: -2, lastHeard: NOW }),
      'src-rep',
    );
    const call = upsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.latitude).toBeUndefined();
    expect(call.name).toBeUndefined();
  });

  it('keeps this source’s own key spelling when it already has a row', async () => {
    vi.mocked(databaseService.meshcore.findNodesByPublicKeyPrefix).mockResolvedValue([
      { publicKey: K_HILL.toUpperCase(), sourceId: 'src-rep', name: 'Hilltop' } as never,
    ]);
    const m = manager();
    await m.ingestRepeaterNeighborsReply('-> ABCD1234:1:4');
    expect(upsertSpy.mock.calls[0][0]).toMatchObject({ publicKey: K_HILL.toUpperCase() });
  });

  it('-none- clears the stored graph rows for the repeater', async () => {
    const m = manager();
    expect(await m.ingestRepeaterNeighborsReply('-> -none-')).toEqual([]);
    expect(upsertSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalledWith('src-rep', SELF_KEY, []);
  });

  it('merges instead of replacing when the reply may be truncated', async () => {
    const lines = Array.from({ length: 8 }, (_, n) => `${(0xa0000000 + n).toString(16).toUpperCase()}:${100 + n}:-40`);
    const m = manager();
    await m.ingestRepeaterNeighborsReply(`-> ${lines.join('\n')}`);
    expect(storedSpy).toHaveBeenCalledWith('src-rep', SELF_KEY);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it('skips graph rows when the repeater key is unknown, but still fills the Nodes list', async () => {
    const m = manager(null);
    await m.ingestRepeaterNeighborsReply('-> ABCD1234:12:40');
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns null when the device says not supported', async () => {
    const m = manager();
    expect(await m.ingestRepeaterNeighborsReply('-> not supported')).toBeNull();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('local requestNeighbors on a Repeater goes through the same ingest', async () => {
    const m = manager();
    internals(m).connected = true;
    const sent: Array<[string, unknown]> = [];
    internals(m).sendRepeaterCommand = async (cmd: string, _t?: number, opts?: unknown) => {
      sent.push([cmd, opts]);
      return '-> ABCD1234:12:40';
    };
    const result = await m.requestNeighbors();
    expect(sent).toEqual([['neighbors', { idleGapMs: expect.any(Number) }]]);
    expect(result?.neighbors).toEqual([{ publicKey: K_HILL, name: 'Hilltop', snr: 10, lastHeardSecs: 12 }]);
    expect(insertSpy).toHaveBeenCalledWith('src-rep', SELF_KEY, expect.any(Array));
  });
});

describe('Repeater neighbours poll scheduler (#5500)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function pollingManager(deviceType = MeshCoreDeviceType.REPEATER) {
    const m = new MeshCoreManager('src-rep');
    const i = internals(m);
    i.deviceType = deviceType;
    i.connected = true;
    i.serialPort = { isOpen: true, write: () => undefined };
    const sent: string[] = [];
    i.sendRepeaterCommand = async (cmd: string) => {
      sent.push(cmd);
      return '-> -none-';
    };
    const ingest = vi.fn().mockResolvedValue([]);
    i.ingestRepeaterNeighborsReply = ingest;
    return { m, i, sent, ingest };
  }

  it('polls after the initial delay, then every 5 minutes, sending only `neighbors`', async () => {
    const { i, sent } = pollingManager();
    i.startRepeaterNeighborsPoll();
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_INITIAL_DELAY_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['neighbors']);
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_POLL_INTERVAL_MS);
    expect(sent).toEqual(['neighbors', 'neighbors']);
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_POLL_INTERVAL_MS * 2);
    expect(sent).toHaveLength(4);
    // Never an RF command.
    expect(sent.every((c) => c === 'neighbors')).toBe(true);
    i.stopRepeaterNeighborsPoll();
  });

  it('skips a tick while a CLI command is in flight instead of queueing', async () => {
    const { m, i, sent } = pollingManager();
    i.repeaterCliPending = 1;
    await expect(m.runRepeaterNeighborsPollTick()).resolves.toBe('skipped-busy');
    expect(sent).toEqual([]);
    i.repeaterCliPending = 0;
    await expect(m.runRepeaterNeighborsPollTick()).resolves.toBe('polled');
    expect(sent).toEqual(['neighbors']);
  });

  it('a reconnect right after a poll waits out the interval (no burst)', async () => {
    const { i, sent } = pollingManager();
    i.startRepeaterNeighborsPoll();
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_INITIAL_DELAY_MS);
    expect(sent).toHaveLength(1);
    // Flap: stop + start three times in quick succession.
    for (let n = 0; n < 3; n++) {
      i.stopRepeaterNeighborsPoll();
      i.startRepeaterNeighborsPoll();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_POLL_INTERVAL_MS);
    expect(sent).toHaveLength(2);
    i.stopRepeaterNeighborsPoll();
  });

  it('stops re-arming once disconnected', async () => {
    const { i, sent } = pollingManager();
    i.startRepeaterNeighborsPoll();
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_INITIAL_DELAY_MS);
    expect(sent).toHaveLength(1);
    i.connected = false;
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_POLL_INTERVAL_MS * 3);
    expect(sent).toHaveLength(1);
    expect(i.repeaterNeighborsTimer).toBeNull();
  });

  it('disconnect() clears the timer', async () => {
    const { m, i, sent } = pollingManager();
    i.serialPort = { isOpen: true, write: () => undefined, close: (cb: () => void) => cb() } as never;
    i.startRepeaterNeighborsPoll();
    await m.disconnect();
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_POLL_INTERVAL_MS * 2);
    expect(sent).toEqual([]);
  });

  it('never arms for a Companion source', async () => {
    const { i, sent } = pollingManager(MeshCoreDeviceType.COMPANION);
    i.startRepeaterNeighborsPoll();
    expect(i.repeaterNeighborsTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(REPEATER_NEIGHBORS_POLL_INTERVAL_MS * 2);
    expect(sent).toEqual([]);
  });

  it('a tick without an open port does nothing', async () => {
    const { m, i, sent } = pollingManager();
    i.serialPort = null;
    await expect(m.runRepeaterNeighborsPollTick()).resolves.toBe('skipped-disconnected');
    expect(sent).toEqual([]);
  });
});
