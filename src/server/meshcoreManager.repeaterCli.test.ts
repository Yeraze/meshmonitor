/**
 * Repeater serial CLI (#6255 WP1): public `runRepeaterCli`, the extra reply
 * terminators, and secret-aware RX / response logging. A fake serial port feeds
 * lines straight into `handleSerialData`; no hardware.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';

const PRV = 'cd'.repeat(64);

function makeManager(replies: (cmd: string) => string[]) {
  const m = new MeshCoreManager('src-cli');
  const a = m as any;
  a.deviceType = MeshCoreDeviceType.REPEATER;
  a.serialPort = {
    isOpen: true,
    write: (data: string) => {
      const cmd = data.replace(/\r$/, '');
      [cmd, ...replies(cmd)].forEach((line, n) => setTimeout(() => a.handleSerialData(line), n + 1));
    },
  };
  return m;
}

function spyLogs() {
  const calls: string[] = [];
  const grab = (...args: unknown[]) => void calls.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const spies = (['debug', 'info', 'warn', 'error', 'verbose', 'trace'] as const)
    .filter((l) => typeof (logger as any)[l] === 'function')
    .map((l) => vi.spyOn(logger as any, l).mockImplementation(grab as any));
  return { calls, restore: () => spies.forEach((s) => s.mockRestore()) };
}

describe('runRepeaterCli', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ['??:', '  -> ??: foo'],
    ['unknown config', '  -> unknown config: foo'],
    ['ERROR:', '  -> ERROR: af must be 0-9'],
    ['(ERR:', '  -> (ERR: clock cannot go backwards)'],
    ['lowercase ok', '  -> ok'],
    ['password echo', '  -> password now: x'],
  ])('%s ends the read within the idle gap, not the 5 s timeout', async (_n, reply) => {
    const m = makeManager(() => [reply]);
    let done = false;
    const p = m.runRepeaterCli('foo').then((r) => ((done = true), r));
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(true);
    expect(await p).toContain(reply.trim());
  });

  it('returns the reply for a value read', async () => {
    const m = makeManager(() => ['  -> > 120']);
    const p = m.runRepeaterCli('get advert.interval');
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toBe('-> > 120');
  });

  it('no secret reaches any log level', async () => {
    const logs = spyLogs();
    try {
      const m = makeManager((cmd) => {
        if (cmd.startsWith('get prv.key')) return [`  -> > ${PRV}`];
        if (cmd.startsWith('set prv.key')) return [`  -> OK, reboot to apply! New pubkey: ${'ab'.repeat(32)}`];
        if (cmd.startsWith('password ')) return [`  -> password now: ${cmd.slice(9)}`];
        if (cmd.startsWith('get guest.password')) return ['  -> > guestsecret'];
        if (cmd.startsWith('set guest.password')) return ['  -> OK'];
        return ['  -> OK'];
      });
      const run = async (cmd: string, opts?: { secret?: boolean }) => {
        const p = m.runRepeaterCli(cmd, opts);
        await vi.advanceTimersByTimeAsync(50);
        return p;
      };
      await run(`set prv.key ${PRV}`);
      await run('get prv.key');
      await run('password hunter2');
      await run('set guest.password guestsecret');
      await run('get guest.password');
      await run('set name Foo', { secret: true });
      await vi.advanceTimersByTimeAsync(2000);
      const all = logs.calls.join('\n');
      for (const s of [PRV, 'hunter2', 'guestsecret', 'password now: hunter2']) expect(all).not.toContain(s);
      expect(all).toContain('[redacted]');
      expect(all).toContain('TX: set prv.key');
    } finally {
      logs.restore();
    }
  });

  it('non-secret lines are still logged in full, and logging reopens after the window', async () => {
    const logs = spyLogs();
    try {
      const m = makeManager(() => ['  -> > Test Repeater']);
      const p = m.runRepeaterCli('get name');
      await vi.advanceTimersByTimeAsync(50);
      await p;
      expect(logs.calls.join('\n')).toContain('Test Repeater');
    } finally {
      logs.restore();
    }
  });
});
