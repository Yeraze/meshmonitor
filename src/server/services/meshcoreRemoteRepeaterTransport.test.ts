import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createRemoteRepeaterTransport,
  RemoteTransportAbortedError,
  type RemoteCliManager,
} from './meshcoreRemoteRepeaterTransport.js';

const PK = 'ab'.repeat(32);

function fakeManager(replies: Array<string | Error> = []) {
  const queue = [...replies];
  const sendCliCommand = vi.fn(async () => {
    const next = queue.shift() ?? '> ok';
    if (next instanceof Error) throw next;
    return { reply: next, elapsedMs: 5 };
  });
  const recordMeshTx = vi.fn();
  const manager: RemoteCliManager = { sendCliCommand, recordMeshTx };
  return { manager, sendCliCommand, recordMeshTx };
}

describe('createRemoteRepeaterTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends through sendCliCommand with the timeout and returns the bare reply', async () => {
    const { manager, sendCliCommand, recordMeshTx } = fakeManager(['> 60']);
    const t = createRemoteRepeaterTransport(manager, PK, { timeoutMs: 15000 });
    expect(t.mode).toBe('remote');
    await expect(t.run('get advert.interval')).resolves.toBe('> 60');
    expect(sendCliCommand).toHaveBeenCalledWith(PK, 'get advert.interval', { timeoutMs: 15000 });
    expect(recordMeshTx).toHaveBeenCalledTimes(1);
  });

  it('waits the minimum gap between commands', async () => {
    const { manager, sendCliCommand } = fakeManager(['> 1', '> 2']);
    const t = createRemoteRepeaterTransport(manager, PK, { minGapMs: 1000 });
    await t.run('get af');
    const second = t.run('get flood.max');
    await vi.advanceTimersByTimeAsync(999);
    expect(sendCliCommand).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBe('> 2');
    expect(sendCliCommand).toHaveBeenCalledTimes(2);
  });

  it('records a mesh TX even when the command fails, and does not retry', async () => {
    const { manager, sendCliCommand, recordMeshTx } = fakeManager([new Error('CLI command timed out')]);
    const t = createRemoteRepeaterTransport(manager, PK);
    await expect(t.run('get af')).rejects.toThrow(/timed out/);
    expect(sendCliCommand).toHaveBeenCalledTimes(1);
    expect(recordMeshTx).toHaveBeenCalledTimes(1);
  });

  it('refuses destructive and oversized commands without sending', async () => {
    const { manager, sendCliCommand } = fakeManager();
    const t = createRemoteRepeaterTransport(manager, PK);
    await expect(t.run('reboot')).rejects.toThrow(/destructive/);
    await expect(t.run(`set prv.key ${'a'.repeat(128)}`)).rejects.toThrow(/destructive/);
    await expect(t.run(`set name ${'x'.repeat(240)}`)).rejects.toThrow(/too long/);
    expect(sendCliCommand).not.toHaveBeenCalled();
  });

  it('stops before sending once aborted, including during the gap', async () => {
    const { manager, sendCliCommand } = fakeManager();
    const ac = new AbortController();
    const t = createRemoteRepeaterTransport(manager, PK, { signal: ac.signal });
    await t.run('get af');
    const pending = t.run('get flood.max');
    const caught = pending.catch((e) => e);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await caught).toBeInstanceOf(RemoteTransportAbortedError);
    await expect(t.run('get repeat')).rejects.toBeInstanceOf(RemoteTransportAbortedError);
    expect(sendCliCommand).toHaveBeenCalledTimes(1);
  });

  it('calls beforeSend per command and lets it refuse the send', async () => {
    const { manager, sendCliCommand } = fakeManager();
    let n = 0;
    const t = createRemoteRepeaterTransport(manager, PK, {
      minGapMs: 0,
      beforeSend: () => {
        n += 1;
        if (n > 1) throw new Error('budget');
      },
    });
    await t.run('get af');
    await expect(t.run('get repeat')).rejects.toThrow('budget');
    expect(sendCliCommand).toHaveBeenCalledTimes(1);
  });
});
