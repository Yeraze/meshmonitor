/**
 * Local stats for a directly-attached Repeater (#5533): getStatsCore /
 * getStatsRadio / getStatsPackets / getDeviceTime / deviceQuery branch to the
 * serial CLI on a Repeater and stay on the companion protocol on a Companion.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';
import { REPEATER_STATS_IDLE_GAP_MS } from './utils/meshcoreRepeaterStats.js';

const REPLIES: Record<string, string> = {
  'stats-core': '  -> {"battery_mv":4120,"uptime_secs":86400,"errors":0,"queue_len":3}',
  'stats-radio': '  -> {"noise_floor":-112,"last_rssi":-87,"last_snr":7.25,"tx_air_secs":312,"rx_air_secs":4521}',
  'stats-packets': '  -> {"recv":1520,"sent":340,"flood_tx":200,"direct_tx":140,"flood_rx":1100,"direct_rx":420,"recv_errors":12}',
  clock: '  -> 14:05 - 2/10/2026 UTC',
  ver: '  -> v1.17.1 (Build: 14 Aug 2026)',
  board: '  -> Heltec V3',
};

function makeRepeater(replies: Record<string, string> = REPLIES) {
  const m = new MeshCoreManager('src-rpt');
  (m as any).deviceType = MeshCoreDeviceType.REPEATER;
  (m as any).connected = true;
  const calls: Array<{ cmd: string; timeout?: number; opts?: { idleGapMs?: number } }> = [];
  const sendRepeaterCommand = vi.fn(async (cmd: string, timeout?: number, opts?: { idleGapMs?: number }) => {
    calls.push({ cmd, timeout, opts });
    return replies[cmd] ?? '  -> Unknown command';
  });
  (m as any).sendRepeaterCommand = sendRepeaterCommand;
  const sendBridgeCommand = vi.fn();
  (m as any).sendBridgeCommand = sendBridgeCommand;
  return { m, calls, sendRepeaterCommand, sendBridgeCommand };
}

function makeCompanion() {
  const m = new MeshCoreManager('src-cmp');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  const sendBridgeCommand = vi.fn(async (cmd: string, params: { type?: string }) => {
    if (cmd === 'get_stats' && params.type === 'core') {
      return { id: '1', success: true, data: { battery_mv: 3900, uptime_secs: 10, errors: 1, queue_len: 0 } };
    }
    if (cmd === 'get_device_time') return { id: '1', success: true, data: { time: 1_700_000_000 } };
    return { id: '1', success: false, error: 'nope' };
  });
  (m as any).sendBridgeCommand = sendBridgeCommand;
  const sendRepeaterCommand = vi.fn();
  (m as any).sendRepeaterCommand = sendRepeaterCommand;
  return { m, sendBridgeCommand, sendRepeaterCommand };
}

afterEach(() => vi.restoreAllMocks());

describe('Repeater local stats over the serial CLI (#5533)', () => {
  it('reads stats-core / stats-radio / stats-packets and maps them to the companion shapes', async () => {
    const { m, sendBridgeCommand } = makeRepeater();
    expect(await m.getStatsCore()).toEqual({ batteryMv: 4120, uptimeSecs: 86400, errors: 0, queueLen: 3 });
    expect(await m.getStatsRadio()).toEqual({ noiseFloor: -112, lastRssi: -87, lastSnr: 7.25, txAirSecs: 312, rxAirSecs: 4521 });
    expect(await m.getStatsPackets()).toEqual({
      recv: 1520, sent: 340, floodTx: 200, directTx: 140, floodRx: 1100, directRx: 420, recvErrors: 12,
    });
    expect(sendBridgeCommand).not.toHaveBeenCalled();
  });

  it('uses only the read-only verbs, with an idle gap so a reply does not wait the full timeout', async () => {
    const { m, calls } = makeRepeater();
    await m.getStatsCore();
    await m.getStatsRadio();
    await m.getStatsPackets();
    await m.getDeviceTime();
    await m.deviceQuery();
    expect(calls.map((c) => c.cmd)).toEqual(['stats-core', 'stats-radio', 'stats-packets', 'clock', 'ver', 'board']);
    expect(calls.every((c) => c.opts?.idleGapMs === REPEATER_STATS_IDLE_GAP_MS)).toBe(true);
  });

  it('reads the clock at minute resolution', async () => {
    const { m } = makeRepeater();
    expect(await m.getDeviceTime()).toBe(Date.UTC(2026, 9, 2, 14, 5, 0) / 1000);
    expect(m.getDeviceTimeResolutionSecs()).toBe(60);
  });

  it('deviceQuery returns ver / build / model and leaves companion-only fields undefined', async () => {
    const { m } = makeRepeater();
    const info = await m.deviceQuery();
    expect(info).toEqual({ ver: 'v1.17.1', firmwareBuild: '14 Aug 2026', model: 'Heltec V3' });
    expect(info?.firmwareVer).toBeUndefined();
    expect(info?.maxContacts).toBeUndefined();
  });

  it('returns null on firmware without the verbs', async () => {
    const { m } = makeRepeater({});
    expect(await m.getStatsCore()).toBeNull();
    expect(await m.getStatsRadio()).toBeNull();
    expect(await m.getStatsPackets()).toBeNull();
    expect(await m.getDeviceTime()).toBeNull();
    expect(await m.deviceQuery()).toBeNull();
  });

  it('fails soft on a dead link: null, debug only, no warning', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { m, sendRepeaterCommand } = makeRepeater();
    sendRepeaterCommand.mockRejectedValue(new Error('Serial port not open'));
    expect(await m.getStatsCore()).toBeNull();
    expect(await m.getStatsRadio()).toBeNull();
    expect(await m.getDeviceTime()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends nothing while disconnected', async () => {
    const { m, sendRepeaterCommand } = makeRepeater();
    (m as any).connected = false;
    expect(await m.getStatsCore()).toBeNull();
    expect(sendRepeaterCommand).not.toHaveBeenCalled();
  });

  it('files telemetry under the real key from get public.key, not the placeholder', () => {
    const { m } = makeRepeater();
    (m as any).localNode = { publicKey: 'repeater', name: 'R', advType: 2 };
    expect(m.getLocalTelemetryNodeId()).toBeNull();
    (m as any).repeaterPublicKey = 'ab'.repeat(32);
    expect(m.getLocalTelemetryNodeId()).toBe('ab'.repeat(32));
    expect(m.isRepeaterSource()).toBe(true);
  });
});

describe('Companion local stats are unchanged (#5533)', () => {
  it('still uses the companion protocol and never the serial CLI', async () => {
    const { m, sendBridgeCommand, sendRepeaterCommand } = makeCompanion();
    expect(await m.getStatsCore()).toEqual({ batteryMv: 3900, uptimeSecs: 10, errors: 1, queueLen: 0 });
    expect(await m.getDeviceTime()).toBe(1_700_000_000);
    expect(sendBridgeCommand).toHaveBeenCalledWith('get_stats', { type: 'core' });
    expect(sendRepeaterCommand).not.toHaveBeenCalled();
    expect(m.getDeviceTimeResolutionSecs()).toBe(1);
    expect(m.isRepeaterSource()).toBe(false);
  });

  it('keeps the companion key as the telemetry key', () => {
    const { m } = makeCompanion();
    (m as any).localNode = { publicKey: 'cd'.repeat(32), name: 'C', advType: 1 };
    expect(m.getLocalTelemetryNodeId()).toBe('cd'.repeat(32));
  });

  it('returns null for an Unknown device type without sending anything', async () => {
    const m = new MeshCoreManager('src-x');
    (m as any).connected = true;
    const sendBridgeCommand = vi.fn();
    const sendRepeaterCommand = vi.fn();
    (m as any).sendBridgeCommand = sendBridgeCommand;
    (m as any).sendRepeaterCommand = sendRepeaterCommand;
    expect(await m.getStatsCore()).toBeNull();
    expect(await m.getDeviceTime()).toBeNull();
    expect(sendBridgeCommand).not.toHaveBeenCalled();
    expect(sendRepeaterCommand).not.toHaveBeenCalled();
  });
});

describe('stats reads share the serial CLI mutex with console commands (#5533)', () => {
  it('a poll read and a user command in flight together each get their own reply', async () => {
    const m = new MeshCoreManager('src-rpt');
    const i = m as any;
    i.deviceType = MeshCoreDeviceType.REPEATER;
    i.connected = true;
    const script: Record<string, string[]> = {
      'stats-core': [REPLIES['stats-core']],
      'get name': ['  -> > Hilltop'],
    };
    const writes: string[] = [];
    i.serialPort = {
      isOpen: true,
      write: (data: string) => {
        const cmd = data.replace(/\r$/, '');
        writes.push(cmd);
        [cmd, ...(script[cmd] ?? ['  -> Unknown command'])].forEach((line, n) =>
          setTimeout(() => i.handleSerialData(line), 2 * (n + 1)),
        );
      },
    };

    const [core, console] = await Promise.all([m.getStatsCore(), m.sendLocalCliCommand('get name')]);

    expect(core?.batteryMv).toBe(4120);
    expect(console.reply).toContain('Hilltop');
    expect(writes).toEqual(['stats-core', 'get name']);
  });
});
