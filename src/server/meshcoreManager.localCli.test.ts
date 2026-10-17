/**
 * Tests for MeshCoreManager.sendLocalCliCommand — the local-CLI dispatcher
 * that routes commands to either the Repeater's native serial CLI or
 * Companion's synthetic CLI interpreter based on `deviceType`.
 *
 * Pattern follows meshcoreManager.channels.test.ts: construct a manager,
 * stub deviceType + the relevant private transport, then exercise the
 * public method.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

interface BridgeCall {
  cmd: string;
  params: Record<string, unknown>;
}

function makeCompanionManager(bridgeResponses: Record<string, { success: boolean; data?: any; error?: string }>) {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;

  const bridgeCalls: BridgeCall[] = [];
  (m as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
    bridgeCalls.push({ cmd, params });
    const resp = bridgeResponses[cmd];
    if (!resp) return { id: '1', success: false, error: `no stub for ${cmd}` };
    return { id: '1', ...resp };
  };

  return { manager: m, bridgeCalls };
}

function makeRepeaterManager(repeaterReplies: Record<string, string>) {
  const m = new MeshCoreManager('test-source');
  (m as any).deviceType = MeshCoreDeviceType.REPEATER;
  (m as any).connected = true;

  const repeaterCalls: string[] = [];
  (m as any).sendRepeaterCommand = async (cmd: string) => {
    repeaterCalls.push(cmd);
    return repeaterReplies[cmd] ?? `(no stub for ${cmd})`;
  };

  return { manager: m, repeaterCalls };
}

describe('sendLocalCliCommand', () => {
  describe('common validation', () => {
    it('rejects an empty command', async () => {
      const { manager } = makeCompanionManager({});
      await expect(manager.sendLocalCliCommand('  ')).rejects.toThrow(/non-empty/i);
    });

    it('rejects when not connected', async () => {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.COMPANION;
      (m as any).connected = false;
      await expect(m.sendLocalCliCommand('ver')).rejects.toThrow(/not connected/i);
    });

    it('rejects when the device type is Unknown', async () => {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.UNKNOWN;
      (m as any).connected = true;
      await expect(m.sendLocalCliCommand('ver')).rejects.toThrow(/not available/i);
    });
  });

  describe('Repeater dispatch', () => {
    it.each([
      ['advert', '  -> OK - Advert sent', true],
      ['advert.zerohop', '  -> OK - Advert sent', true], // old firmware floods on it
      ['advert.zerohop', '  -> OK - zerohop advert sent', false],
    ])('`%s` answered %j records a flood: %s', async (cmd, reply, flooded) => {
      const { manager } = makeRepeaterManager({ [cmd]: reply });
      const record = vi.spyOn(manager as any, 'recordFloodAdvert').mockResolvedValue(undefined);
      await manager.sendLocalCliCommand(cmd);
      expect(record).toHaveBeenCalledTimes(flooded ? 1 : 0);
    });

    it('forwards the command to sendRepeaterCommand verbatim', async () => {
      const { manager, repeaterCalls } = makeRepeaterManager({
        'stats': '  -> packets_sent: 42\n  -> packets_recv: 91',
      });
      const result = await manager.sendLocalCliCommand('stats');
      expect(repeaterCalls).toEqual(['stats']);
      expect(result.reply).toContain('packets_sent: 42');
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('also forwards for Room Server (same firmware family)', async () => {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.ROOM_SERVER;
      (m as any).connected = true;
      const calls: string[] = [];
      (m as any).sendRepeaterCommand = async (cmd: string) => { calls.push(cmd); return 'ok'; };
      await m.sendLocalCliCommand('neighbors');
      expect(calls).toEqual(['neighbors']);
    });
  });

  describe('Companion synthetic CLI', () => {
    it('renders `ver` from device_query response', async () => {
      const { manager, bridgeCalls } = makeCompanionManager({
        device_query: { success: true, data: { 'fw ver': 7, ver: 'v1.7.0', fw_build: '2026-01-15', model: 'Heltec Tracker' } },
      });
      const result = await manager.sendLocalCliCommand('ver');
      expect(bridgeCalls).toEqual([{ cmd: 'device_query', params: {} }]);
      expect(result.reply).toContain('Firmware: 7');
      expect(result.reply).toContain('Version: v1.7.0');
      expect(result.reply).toContain('Model: Heltec Tracker');
    });

    it('renders `stats` (default core)', async () => {
      const { manager, bridgeCalls } = makeCompanionManager({
        get_stats: { success: true, data: { battery_mv: 4123, uptime_secs: 9876 } },
      });
      const result = await manager.sendLocalCliCommand('stats');
      expect(bridgeCalls[0].cmd).toBe('get_stats');
      expect(bridgeCalls[0].params).toEqual({ type: 'core' });
      expect(result.reply).toContain('[core]');
      expect(result.reply).toContain('battery_mv: 4123');
    });

    it('passes the stats sub-type through', async () => {
      const { manager, bridgeCalls } = makeCompanionManager({
        get_stats: { success: true, data: { last_rssi: -94, last_snr: 7.5 } },
      });
      await manager.sendLocalCliCommand('stats radio');
      expect(bridgeCalls[0].params).toEqual({ type: 'radio' });
    });

    it('returns the device clock as epoch + ISO when available', async () => {
      const { manager } = makeCompanionManager({
        get_device_time: { success: true, data: { time: 1700000000 } },
      });
      const result = await manager.sendLocalCliCommand('clock');
      expect(result.reply).toMatch(/^1700000000\n/);
      expect(result.reply).toContain('T'); // ISO format includes the T separator
    });

    it('reports "unavailable" when the device returns no clock', async () => {
      const { manager } = makeCompanionManager({
        get_device_time: { success: true, data: {} },
      });
      const result = await manager.sendLocalCliCommand('clock');
      expect(result.reply).toContain('unavailable');
    });

    it('triggers a flood advert on `advert` (same verb as the repeater CLI)', async () => {
      const { manager, bridgeCalls } = makeCompanionManager({
        set_flood_scope: { success: true, data: {} },
        send_advert: { success: true, data: { sent: true } },
      });
      const result = await manager.sendLocalCliCommand('advert');
      const advert = bridgeCalls.find(c => c.cmd === 'send_advert');
      expect(advert?.params).toEqual({ mode: 'flood' });
      expect(result.reply).toMatch(/sent \(flood\)/i);
    });

    it('triggers a zero-hop advert on `advert.zerohop`', async () => {
      const { manager, bridgeCalls } = makeCompanionManager({
        send_advert: { success: true, data: { sent: true } },
      });
      const result = await manager.sendLocalCliCommand('advert.zerohop');
      expect(bridgeCalls.map(c => c.cmd)).toEqual(['send_advert']);
      expect(bridgeCalls[0].params).toEqual({ mode: 'zero_hop' });
      expect(result.reply).toMatch(/zero-hop/i);
    });

    it('returns a help string on `help`', async () => {
      const { manager } = makeCompanionManager({});
      const result = await manager.sendLocalCliCommand('help');
      expect(result.reply).toContain('ver');
      expect(result.reply).toContain('stats');
      expect(result.reply).toContain('clock');
      expect(result.reply).toContain('advert');
    });

    it('returns an "Unknown command" hint for unrecognized verbs', async () => {
      const { manager } = makeCompanionManager({});
      const result = await manager.sendLocalCliCommand('flux capacitor');
      expect(result.reply).toContain('Unknown command');
      expect(result.reply).toContain('help');
    });

    it('propagates a bridge-command failure as a thrown error', async () => {
      const { manager } = makeCompanionManager({
        device_query: { success: false, error: 'transport closed' },
      });
      await expect(manager.sendLocalCliCommand('ver')).rejects.toThrow(/transport closed/);
    });

    it('stays on the shim for protocol 13 (fw 1.17) and never sends run_cli', async () => {
      const { manager, bridgeCalls } = makeCompanionManager({});
      (manager as any).localNode = { publicKey: 'ab'.repeat(32), name: 'C', firmwareVer: 13 };
      const result = await manager.sendLocalCliCommand('get radio');
      expect(bridgeCalls.map(c => c.cmd)).not.toContain('run_cli');
      expect(result.reply).toContain('Unknown command');
    });
  });

  describe('Companion native CLI (fw 1.18.0+, #5866)', () => {
    function makeNative(runCli: (command: string) => { success: boolean; data?: any; error?: string }) {
      const made = makeCompanionManager({});
      (made.manager as any).localNode = { publicKey: 'ab'.repeat(32), name: 'C', firmwareVer: 14 };
      const base = (made.manager as any).sendBridgeCommand;
      (made.manager as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>, timeout?: number) => {
        if (cmd === 'run_cli') {
          made.bridgeCalls.push({ cmd, params: { ...params, timeout } });
          return { id: '1', ...runCli(String(params.command)) };
        }
        return base(cmd, params);
      };
      return made;
    }

    it('sends a config verb to the firmware and strips the "> " value marker', async () => {
      const { manager, bridgeCalls } = makeNative(() => ({ success: true, data: { reply: '> 915.0,250,11,5' } }));
      const result = await manager.sendLocalCliCommand('get radio');
      expect(bridgeCalls).toHaveLength(1);
      expect(bridgeCalls[0].cmd).toBe('run_cli');
      expect(bridgeCalls[0].params.command).toBe('get radio');
      expect(result.reply).toBe('915.0,250,11,5');
    });

    it('sends `ver` to the firmware too', async () => {
      const { manager, bridgeCalls } = makeNative(() => ({ success: true, data: { reply: 'v1.18.0 (Build: 15-Oct-2026)' } }));
      const result = await manager.sendLocalCliCommand('ver');
      expect(bridgeCalls.map(c => c.cmd)).toEqual(['run_cli']);
      expect(result.reply).toBe('v1.18.0 (Build: 15-Oct-2026)');
    });

    it.each(['stats', 'clock', 'advert.zerohop', 'help'])('keeps `%s` on the shim (the firmware CLI has no such verb)', async (cmd) => {
      const { manager, bridgeCalls } = makeNative(() => ({ success: true, data: { reply: 'Unknown command' } }));
      (manager as any).sendAdvert = vi.fn().mockResolvedValue(true);
      await manager.sendLocalCliCommand(cmd).catch(() => undefined);
      expect(bridgeCalls.map(c => c.cmd)).not.toContain('run_cli');
    });

    it('lists the firmware verbs in `help`', async () => {
      const { manager } = makeNative(() => ({ success: true, data: { reply: '' } }));
      const result = await manager.sendLocalCliCommand('help');
      expect(result.reply).toContain('Firmware CLI');
      expect(result.reply).toContain('get radio');
    });

    it('reads the protocol byte once when the poller has not stamped it', async () => {
      const { manager, bridgeCalls } = makeCompanionManager({
        device_query: { success: true, data: { 'fw ver': 14, ver: 'v1.18.0' } },
        run_cli: { success: true, data: { reply: '> 22' } },
      });
      (manager as any).localNode = { publicKey: 'ab'.repeat(32), name: 'C' };
      const result = await manager.sendLocalCliCommand('get tx');
      expect(bridgeCalls.map(c => c.cmd)).toEqual(['device_query', 'run_cli']);
      expect(result.reply).toBe('22');
      expect((manager as any).localNode.firmwareVer).toBe(14);
    });

    it('treats a timeout on `reboot` as sent', async () => {
      const { manager, bridgeCalls } = makeNative(() => ({ success: false, error: 'CLI command timed out after 3000ms' }));
      const result = await manager.sendLocalCliCommand('reboot');
      expect(result.reply).toMatch(/restarting/i);
      expect(bridgeCalls[0].params.timeout_ms).toBe(3000);
    });

    it('still throws a timeout on an ordinary verb', async () => {
      const { manager } = makeNative(() => ({ success: false, error: 'CLI command timed out after 10000ms' }));
      await expect(manager.sendLocalCliCommand('get name')).rejects.toThrow(/timed out/);
    });

    it('rejects a line longer than the firmware frame', async () => {
      const { manager, bridgeCalls } = makeNative(() => ({ success: true, data: { reply: 'OK' } }));
      await expect(manager.sendLocalCliCommand(`set name ${'x'.repeat(200)}`)).rejects.toThrow(/too long/);
      expect(bridgeCalls).toHaveLength(0);
    });

    it('runs in receive-only mode (no firmware CLI verb transmits)', async () => {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.COMPANION;
      (m as any).connected = true;
      (m as any).receiveOnly = true;
      (m as any).localNode = { publicKey: 'ab'.repeat(32), name: 'C', firmwareVer: 14 };
      const sendCommand = vi.fn().mockResolvedValue({ id: '1', success: true, data: { reply: '> 22' } });
      (m as any).nativeBackend = { sendCommand };
      await expect(m.sendLocalCliCommand('get tx')).resolves.toMatchObject({ reply: '22' });
      expect(sendCommand).toHaveBeenCalledWith('run_cli', expect.objectContaining({ command: 'get tx' }), expect.any(Number));
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
