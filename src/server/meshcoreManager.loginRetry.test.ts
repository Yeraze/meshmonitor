/**
 * MeshCoreManager.loginToNodeWithRetry (#5400): the one retry loop every
 * login path shares (admin console, room server, saved-credential login,
 * room-sync scheduler).
 *
 *  - retries ONLY on no_reply, up to MESHCORE_LOGIN_MAX_ATTEMPTS, with
 *    MESHCORE_LOGIN_RETRY_PAUSE_MS between attempts;
 *  - stops at once on rejected / not_on_device, and throws on TX disabled;
 *  - reports progress (sending → waiting(waitMs) → retrying);
 *  - honours an AbortSignal: cancel before send, between attempts, or
 *    during a wait; a success that raced the cancel still reads cancelled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreLoginProgressEvent } from './meshcoreManager.js';
import { MESHCORE_LOGIN_REJECTED } from './meshcoreNativeBackend.js';
import { MESHCORE_CONTACT_NOT_ON_DEVICE } from './meshcoreDeviceContactErrors.js';
import {
  MESHCORE_LOGIN_BRIDGE_TIMEOUT_MS,
  MESHCORE_LOGIN_CANCELLED,
  MESHCORE_LOGIN_MAX_ATTEMPTS,
  MESHCORE_LOGIN_RETRY_PAUSE_MS,
} from './constants/meshcoreLogin.js';
import { TxDisabledError } from './errors/txDisabledError.js';

const KEY = 'b'.repeat(64);

type Reply = { success: boolean; error?: string; data?: Record<string, unknown> };

/** Manager whose `login` bridge command answers from `replies` in order. */
function makeManager(replies: Array<Reply | ((params: any) => Promise<Reply>)>) {
  const m = new MeshCoreManager('retry-source') as any;
  m.deviceType = MeshCoreDeviceType.COMPANION;
  m.connected = true;
  const logins: Array<{ params: any; timeout: number }> = [];
  m.sendBridgeCommand = vi.fn(async (cmd: string, params: any, timeout: number) => {
    if (cmd !== 'login') return { id: '1', success: true, data: {} };
    logins.push({ params, timeout });
    const next = replies[Math.min(logins.length - 1, replies.length - 1)];
    const reply = typeof next === 'function' ? await next(params) : next;
    return { id: String(logins.length), ...reply };
  });
  return { m: m as MeshCoreManager & Record<string, any>, logins };
}

const NO_REPLY: Reply = { success: false, error: 'Login timed out: no reply' };
const OK: Reply = { success: true, data: { ok: true, is_admin: 1 } };

describe('MeshCoreManager.loginToNodeWithRetry (#5400)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries silence up to 3 times, pausing between attempts, and succeeds on the 3rd', async () => {
    const { m, logins } = makeManager([NO_REPLY, NO_REPLY, OK]);
    const events: MeshCoreLoginProgressEvent[] = [];
    const p = m.loginToNodeWithRetry(KEY, 'pw', { onProgress: (e) => events.push(e) });

    await vi.advanceTimersByTimeAsync(0);
    expect(logins).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MESHCORE_LOGIN_RETRY_PAUSE_MS - 1);
    expect(logins).toHaveLength(1); // still pausing
    await vi.advanceTimersByTimeAsync(1);
    expect(logins).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(MESHCORE_LOGIN_RETRY_PAUSE_MS);

    const r = await p;
    expect(r.outcome).toBe('ok');
    expect(r.attempts).toBe(3);
    expect(r.result?.isAdmin).toBe(true);
    expect(logins).toHaveLength(3);
    expect(events.map((e) => `${e.phase}:${e.attempt}`)).toEqual([
      'sending:1', 'retrying:1', 'sending:2', 'retrying:2', 'sending:3',
    ]);
    // Every attempt uses the long bridge timeout so the backend's own
    // max(est x 2, 10 s) deadline fires first.
    for (const l of logins) expect(l.timeout).toBe(MESHCORE_LOGIN_BRIDGE_TIMEOUT_MS);
  });

  it('gives up after MESHCORE_LOGIN_MAX_ATTEMPTS silent attempts', async () => {
    const { m, logins } = makeManager([NO_REPLY]);
    const p = m.loginToNodeWithRetry(KEY, 'pw');
    await vi.advanceTimersByTimeAsync(MESHCORE_LOGIN_RETRY_PAUSE_MS * 5);
    expect(await p).toEqual({ result: null, outcome: 'no_reply', attempts: MESHCORE_LOGIN_MAX_ATTEMPTS });
    expect(logins).toHaveLength(MESHCORE_LOGIN_MAX_ATTEMPTS);
  });

  it('does not retry when the source is not a Companion (nothing was sent)', async () => {
    const { m, logins } = makeManager([NO_REPLY]);
    m.deviceType = MeshCoreDeviceType.REPEATER;
    const r = await m.loginToNodeWithRetry(KEY, 'pw');
    expect(r).toEqual({ result: null, outcome: 'no_reply', attempts: 1 });
    expect(logins).toHaveLength(0);
  });

  it('does not retry a refused password', async () => {
    const { m, logins } = makeManager([{ success: false, error: MESHCORE_LOGIN_REJECTED }, OK]);
    const r = await m.loginToNodeWithRetry(KEY, 'bad');
    expect(r).toEqual({ result: null, outcome: 'rejected', attempts: 1 });
    expect(logins).toHaveLength(1);
  });

  it('does not retry a login the radio cannot send', async () => {
    const { m, logins } = makeManager([{ success: false, error: MESHCORE_CONTACT_NOT_ON_DEVICE }, OK]);
    const r = await m.loginToNodeWithRetry(KEY, 'pw');
    expect(r.outcome).toBe('not_on_device');
    expect(logins).toHaveLength(1);
  });

  it('throws (no retry) when the source cannot transmit', async () => {
    const { m, logins } = makeManager([OK]);
    m.sendBridgeCommand = vi.fn(async () => {
      throw new TxDisabledError('receive-only');
    });
    await expect(m.loginToNodeWithRetry(KEY, 'pw')).rejects.toBeInstanceOf(TxDisabledError);
    expect(logins).toHaveLength(0);
  });

  it('reports the per-attempt wait the backend chose', async () => {
    const { m } = makeManager([
      async (params) => {
        params.onWait?.(16_000);
        return OK;
      },
    ]);
    const events: MeshCoreLoginProgressEvent[] = [];
    await m.loginToNodeWithRetry(KEY, 'pw', { onProgress: (e) => events.push(e) });
    expect(events).toContainEqual({ phase: 'waiting', attempt: 1, maxAttempts: 3, waitMs: 16_000 });
  });

  it('cancel before sending: nothing goes out', async () => {
    const { m, logins } = makeManager([OK]);
    const c = new AbortController();
    c.abort();
    expect((await m.loginToNodeWithRetry(KEY, 'pw', { signal: c.signal })).outcome).toBe('cancelled');
    expect(logins).toHaveLength(0);
  });

  it('cancel during the pause between attempts stops the next attempt', async () => {
    const { m, logins } = makeManager([NO_REPLY, OK]);
    const c = new AbortController();
    const p = m.loginToNodeWithRetry(KEY, 'pw', { signal: c.signal });
    await vi.advanceTimersByTimeAsync(500);
    expect(logins).toHaveLength(1);
    c.abort();
    const r = await p;
    expect(r.outcome).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(MESHCORE_LOGIN_RETRY_PAUSE_MS * 3);
    expect(logins).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel during a wait: the backend aborts and the outcome is cancelled', async () => {
    const { m, logins } = makeManager([
      (params) => new Promise<Reply>((resolve) => {
        params.signal.addEventListener('abort', () => resolve({ success: false, error: MESHCORE_LOGIN_CANCELLED }));
      }),
    ]);
    const c = new AbortController();
    const p = m.loginToNodeWithRetry(KEY, 'pw', { signal: c.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(logins[0].params.signal).toBe(c.signal);
    c.abort();
    expect((await p).outcome).toBe('cancelled');
    expect(logins).toHaveLength(1);
  });

  it('a late success that raced the cancel still reads cancelled', async () => {
    const c = new AbortController();
    const { m } = makeManager([
      async () => {
        c.abort(); // user pressed Cancel while the reply was in flight
        return OK;
      },
    ]);
    const r = await m.loginToNodeWithRetry(KEY, 'pw', { signal: c.signal });
    expect(r).toMatchObject({ outcome: 'cancelled', result: null });
  });

  it('loginToRoomWithOutcome marks the room logged in only on ok, not on cancel', async () => {
    const c = new AbortController();
    const { m } = makeManager([
      async () => {
        c.abort();
        return OK;
      },
    ]);
    expect(await m.loginToRoomWithOutcome(KEY, 'pw', { signal: c.signal })).toBe('cancelled');
    expect(m.isRoomLoggedIn(KEY)).toBe(false);

    const { m: m2 } = makeManager([OK]);
    expect(await m2.loginToRoomWithOutcome(KEY, 'pw')).toBe('ok');
    expect(m2.isRoomLoggedIn(KEY)).toBe(true);
  });
});
