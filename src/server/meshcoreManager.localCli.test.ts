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

    it('triggers a flood advert on `advert`', async () => {
      const { manager, bridgeCalls } = makeCompanionManager({
        send_advert: { success: true, data: { sent: true } },
      });
      const result = await manager.sendLocalCliCommand('advert');
      expect(bridgeCalls[0].cmd).toBe('send_advert');
      expect(result.reply).toMatch(/sent/i);
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
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
