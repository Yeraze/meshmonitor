/**
 * Tests for the `clock sync` → `time <epoch>` rewrite and the periodic
 * local-node RTC sync (issue #3954).
 *
 * MeshCore firmware's `clock sync` verb sets the RTC to the *sender_timestamp*
 * of the incoming command frame, which is 0 over the local serial CLI (always
 * rejected) and the sending node's own drifted clock over remote-admin. We
 * rewrite it to the absolute `time <epoch>` verb stamped with the server clock
 * so the target's RTC is set to real current time on both transports.
 *
 * Pattern follows meshcoreManager.localCli.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const TIME_CMD = /^time (\d+)$/;

describe('clock sync rewrite (#3954)', () => {
  describe('rewriteClockSync helper', () => {
    it('rewrites `clock sync` to `time <server epoch>`', () => {
      const m = new MeshCoreManager('test-source');
      const before = Math.floor(Date.now() / 1000);
      const out = (m as any).rewriteClockSync('clock sync') as string;
      const after = Math.floor(Date.now() / 1000);

      const match = out.match(TIME_CMD);
      expect(match).not.toBeNull();
      const epoch = Number(match![1]);
      expect(epoch).toBeGreaterThanOrEqual(before);
      expect(epoch).toBeLessThanOrEqual(after);
    });

    it('is case-insensitive and tolerates surrounding whitespace', () => {
      const m = new MeshCoreManager('test-source');
      expect((m as any).rewriteClockSync('CLOCK SYNC')).toMatch(TIME_CMD);
      expect((m as any).rewriteClockSync('  clock sync  ')).toMatch(TIME_CMD);
    });

    it('leaves every other command untouched', () => {
      const m = new MeshCoreManager('test-source');
      for (const cmd of ['clock', 'stats', 'ver', 'clock synchronize', 'time 123', 'reboot']) {
        expect((m as any).rewriteClockSync(cmd)).toBe(cmd);
      }
    });
  });

  describe('sendLocalCliCommand (Repeater serial path)', () => {
    function makeRepeaterManager() {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.REPEATER;
      (m as any).connected = true;
      const repeaterCalls: string[] = [];
      (m as any).sendRepeaterCommand = async (cmd: string) => {
        repeaterCalls.push(cmd);
        return 'OK - clock set: 13:11 - 6/7/2026 UTC';
      };
      return { manager: m, repeaterCalls };
    }

    it('sends `time <epoch>` to the serial CLI instead of `clock sync`', async () => {
      const { manager, repeaterCalls } = makeRepeaterManager();
      const before = Math.floor(Date.now() / 1000);
      await manager.sendLocalCliCommand('clock sync');
      const after = Math.floor(Date.now() / 1000);

      expect(repeaterCalls).toHaveLength(1);
      const match = repeaterCalls[0].match(TIME_CMD);
      expect(match).not.toBeNull();
      const epoch = Number(match![1]);
      expect(epoch).toBeGreaterThanOrEqual(before);
      expect(epoch).toBeLessThanOrEqual(after);
    });

    it('forwards non-clock commands verbatim (regression)', async () => {
      const { manager, repeaterCalls } = makeRepeaterManager();
      await manager.sendLocalCliCommand('stats');
      expect(repeaterCalls).toEqual(['stats']);
    });
  });

  describe('sendCliCommand (remote-admin path)', () => {
    it('emits `time <epoch>` in the send_cli frame for `clock sync`', async () => {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.COMPANION;
      (m as any).connected = true;

      const pubkey = 'a'.repeat(64);
      const sentTexts: string[] = [];

      // sendWithDefaultScope just runs the thunk in these tests.
      (m as any).sendWithDefaultScope = (fn: () => Promise<unknown>) => fn();
      (m as any).sendBridgeCommand = async (cmd: string, params: any) => {
        if (cmd === 'send_cli') {
          sentTexts.push(params.text);
          // The firmware reply arrives asynchronously via cli_reply; simulate
          // it by resolving the pending entry the manager just registered.
          const prefixKey = pubkey.substring(0, 12);
          const pending = (m as any).pendingCliReplies.get(prefixKey);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve('OK - clock set: 13:11 - 6/7/2026 UTC');
          }
          return { id: '1', success: true };
        }
        return { id: '1', success: false, error: `no stub for ${cmd}` };
      };

      const before = Math.floor(Date.now() / 1000);
      const result = await m.sendCliCommand(pubkey, 'clock sync');
      const after = Math.floor(Date.now() / 1000);

      expect(sentTexts).toHaveLength(1);
      const match = sentTexts[0].match(TIME_CMD);
      expect(match).not.toBeNull();
      const epoch = Number(match![1]);
      expect(epoch).toBeGreaterThanOrEqual(before);
      expect(epoch).toBeLessThanOrEqual(after);
      expect(result.reply).toContain('clock set');
    });
  });

  describe('startDeviceTimeSync (periodic local RTC sync)', () => {
    it('syncs immediately on start for a Companion', () => {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.COMPANION;
      const syncSpy = vi.fn().mockResolvedValue({ ok: true });
      (m as any).syncDeviceTime = syncSpy;

      (m as any).startDeviceTimeSync();
      expect(syncSpy).toHaveBeenCalledTimes(1);

      (m as any).stopDeviceTimeSync();
      expect((m as any).deviceTimeSyncTimer).toBeNull();
    });

    it('is a no-op for non-Companion device types', () => {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.REPEATER;
      const syncSpy = vi.fn().mockResolvedValue({ ok: true });
      (m as any).syncDeviceTime = syncSpy;

      (m as any).startDeviceTimeSync();
      expect(syncSpy).not.toHaveBeenCalled();
      expect((m as any).deviceTimeSyncTimer).toBeNull();
    });

    it('re-arms the single timer rather than stacking on repeat calls', () => {
      const m = new MeshCoreManager('test-source');
      (m as any).deviceType = MeshCoreDeviceType.COMPANION;
      (m as any).syncDeviceTime = vi.fn().mockResolvedValue({ ok: true });

      (m as any).startDeviceTimeSync();
      const firstTimer = (m as any).deviceTimeSyncTimer;
      (m as any).startDeviceTimeSync();
      const secondTimer = (m as any).deviceTimeSyncTimer;

      expect(firstTimer).not.toBe(secondTimer);
      expect(secondTimer).not.toBeNull();
      (m as any).stopDeviceTimeSync();
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
