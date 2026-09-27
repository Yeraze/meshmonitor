/**
 * MeshCoreLoginProgressRegistry (#5400): in-memory progress for tracked
 * logins, private to the user + source that started them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MeshCoreLoginProgressRegistry,
  LOGIN_PROGRESS_RETAIN_MS,
  isValidLoginRequestId,
} from './meshcoreLoginProgress.js';

describe('MeshCoreLoginProgressRegistry', () => {
  let now = 1_000_000;
  let reg: MeshCoreLoginProgressRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    reg = new MeshCoreLoginProgressRegistry({ now: () => now });
  });
  afterEach(() => {
    reg.clear();
    vi.useRealTimers();
  });

  it('validates request ids', () => {
    expect(isValidLoginRequestId('0f8e3a4c-1b2d-4e5f-9a8b-7c6d5e4f3a2b')).toBe(true);
    expect(isValidLoginRequestId('short')).toBe(false);
    expect(isValidLoginRequestId('../../etc/passwd')).toBe(false);
    expect(isValidLoginRequestId(42)).toBe(false);
  });

  it('tracks phases and counts the current wait down', () => {
    const h = reg.start('req-aaaaaaaa', 1, 'src', 3)!;
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toMatchObject({ phase: 'starting', attempt: 0, maxAttempts: 3 });

    h.onProgress({ phase: 'sending', attempt: 1, maxAttempts: 3 });
    h.onProgress({ phase: 'waiting', attempt: 1, maxAttempts: 3, waitMs: 12_000 });
    now += 5_000;
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toMatchObject({ phase: 'waiting', waitMs: 12_000, waitRemainingMs: 7_000 });

    h.onProgress({ phase: 'retrying', attempt: 1, maxAttempts: 3, pauseMs: 2000 });
    now += 500;
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toMatchObject({ phase: 'retrying', attempt: 1, waitRemainingMs: 1_500 });

    h.finish('no_reply');
    expect(reg.get('req-aaaaaaaa', 1, 'src')).toMatchObject({ phase: 'done', outcome: 'no_reply', waitMs: null });
  });

  it('is private to the owner and the source', () => {
    reg.start('req-bbbbbbbb', 1, 'src', 3);
    expect(reg.get('req-bbbbbbbb', 2, 'src')).toBeNull();
    expect(reg.get('req-bbbbbbbb', 1, 'other')).toBeNull();
    expect(reg.cancel('req-bbbbbbbb', 2, 'src')).toBe(false);
    expect(reg.get('req-bbbbbbbb', 1, 'src')?.cancelRequested).toBe(false);
  });

  it('cancel aborts only that login', () => {
    const a = reg.start('req-aaaaaaaa', 1, 'src', 3)!;
    const b = reg.start('req-bbbbbbbb', 1, 'src', 3)!;
    expect(reg.cancel('req-aaaaaaaa', 1, 'src')).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(reg.get('req-aaaaaaaa', 1, 'src')?.cancelRequested).toBe(true);
  });

  it('refuses a duplicate live id', () => {
    expect(reg.start('req-cccccccc', 1, 'src', 3)).not.toBeNull();
    expect(reg.start('req-cccccccc', 1, 'src', 3)).toBeNull();
  });

  it('forgets a finished login after the retention window', () => {
    const h = reg.start('req-dddddddd', 1, 'src', 3)!;
    h.finish('ok');
    vi.advanceTimersByTime(LOGIN_PROGRESS_RETAIN_MS - 1);
    expect(reg.get('req-dddddddd', 1, 'src')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(reg.get('req-dddddddd', 1, 'src')).toBeNull();
    expect(reg.size).toBe(0);
  });

  it('ignores progress after finish, and cancel after finish is a harmless no-op', () => {
    const h = reg.start('req-eeeeeeee', 1, 'src', 3)!;
    h.finish('ok');
    h.onProgress({ phase: 'sending', attempt: 2, maxAttempts: 3 });
    expect(reg.cancel('req-eeeeeeee', 1, 'src')).toBe(true);
    expect(h.signal.aborted).toBe(false);
    expect(reg.get('req-eeeeeeee', 1, 'src')).toMatchObject({ phase: 'done', outcome: 'ok' });
  });
});
