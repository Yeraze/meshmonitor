import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  planAutomatedTextParts,
  sendAutomatedTextParts,
  SplitSequenceLock,
  SPLIT_SEQUENCE_MAX_WAIT_MS,
} from './automatedTextSplit.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('planAutomatedTextParts (#6330)', () => {
  it('passes a text that fits through unchanged', () => {
    expect(planAutomatedTextParts('hi', { maxBytes: 200, split: true })).toEqual({ parts: ['hi'], truncated: false, maxBytes: 200 });
  });

  it('truncates to one part ending in "..." with split off', () => {
    const text = 'word '.repeat(100);
    const dots = planAutomatedTextParts(text, { maxBytes: 200, split: false });
    expect(dots.truncated).toBe(true);
    expect(dots.parts[0].endsWith('...')).toBe(true);
    expect(bytes(dots.parts[0])).toBeLessThanOrEqual(200);
  });

  it('caps a split at 3 marked parts and ends the cut one in "..."', () => {
    const plan = planAutomatedTextParts('word '.repeat(300), { maxBytes: 200, split: true });
    expect(plan.parts).toHaveLength(3);
    expect(plan.truncated).toBe(true);
    expect(plan.parts[2].startsWith('(3/3) ')).toBe(true);
    expect(plan.parts[2].endsWith('...')).toBe(true);
    for (const p of plan.parts) expect(bytes(p)).toBeLessThanOrEqual(200);
  });

  it('never halves a multi-byte character when adding "..."', () => {
    const plan = planAutomatedTextParts('\u{1F600}'.repeat(100), { maxBytes: 200, split: false });
    expect(bytes(plan.parts[0])).toBeLessThanOrEqual(200);
    expect(Array.from(plan.parts[0].slice(0, -3)).every((c) => c === '\u{1F600}')).toBe(true);
  });
});

describe('SplitSequenceLock queue bounds (4.17.3 review M4)', () => {
  afterEach(() => vi.useRealTimers());

  /** A sequence that holds the lock until `release()` is called. */
  function held() {
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    return { fn: vi.fn(() => done.then(() => 'ran')), release };
  }

  it('drops a new sequence when one with the same key is already waiting', async () => {
    const lock = new SplitSequenceLock();
    const running = held();
    const p1 = lock.run(running.fn, { key: 'a' });
    const p2 = lock.run(async () => 'second', { key: 'a' });
    const third = vi.fn(async () => 'third');
    await expect(lock.run(third, { key: 'a' })).resolves.toEqual({ ran: false, reason: 'duplicate' });
    // A different key still queues.
    const p4 = lock.run(async () => 'other', { key: 'b' });
    running.release();
    await expect(p1).resolves.toEqual({ ran: true, value: 'ran' });
    await expect(p2).resolves.toEqual({ ran: true, value: 'second' });
    await expect(p4).resolves.toEqual({ ran: true, value: 'other' });
    expect(third).not.toHaveBeenCalled();
  });

  it('a running sequence is not "waiting": the same key may queue one behind it', async () => {
    const lock = new SplitSequenceLock();
    const running = held();
    const p1 = lock.run(running.fn, { key: 'a' });
    await Promise.resolve();
    const p2 = lock.run(async () => 'next', { key: 'a' });
    running.release();
    await p1;
    await expect(p2).resolves.toEqual({ ran: true, value: 'next' });
    // Once drained, the key queues again.
    await expect(lock.run(async () => 'again', { key: 'a' })).resolves.toEqual({ ran: true, value: 'again' });
  });

  it('drops a sequence that waited more than 2 minutes for its turn', async () => {
    vi.useFakeTimers();
    const lock = new SplitSequenceLock();
    expect(SPLIT_SEQUENCE_MAX_WAIT_MS).toBe(120_000);
    const running = held();
    const p1 = lock.run(running.fn, { key: 'a' });
    const late = vi.fn(async () => 'late');
    const p2 = lock.run(late, { key: 'b' });
    await vi.advanceTimersByTimeAsync(SPLIT_SEQUENCE_MAX_WAIT_MS + 1);
    running.release();
    await p1;
    await expect(p2).resolves.toEqual({ ran: false, reason: 'stale' });
    expect(late).not.toHaveBeenCalled();
  });

  it('a sequence that waited under 2 minutes still runs', async () => {
    vi.useFakeTimers();
    const lock = new SplitSequenceLock();
    const running = held();
    const p1 = lock.run(running.fn);
    const p2 = lock.run(async () => 'ok');
    await vi.advanceTimersByTimeAsync(SPLIT_SEQUENCE_MAX_WAIT_MS - 1000);
    running.release();
    await p1;
    await expect(p2).resolves.toEqual({ ran: true, value: 'ok' });
  });

  it('a throwing sequence still frees the lock and propagates', async () => {
    const lock = new SplitSequenceLock();
    await expect(lock.run(async () => { throw new Error('boom'); }, { key: 'a' })).rejects.toThrow('boom');
    await expect(lock.run(async () => 'after', { key: 'a' })).resolves.toEqual({ ran: true, value: 'after' });
  });

  it('sendAutomatedTextParts reports a dropped duplicate and sends nothing for it', async () => {
    vi.useFakeTimers();
    const lock = new SplitSequenceLock();
    const plan = planAutomatedTextParts('word '.repeat(60), { maxBytes: 100, split: true });
    expect(plan.parts.length).toBeGreaterThan(1);
    const sendPart = vi.fn(async () => true);
    const deps = { lock, gapMs: 10_000, canTransmit: () => true, sendPart, logPrefix: '[t]', label: 'Auto-responder 1', sequenceKey: 'r1|ch:0' };
    const first = sendAutomatedTextParts('x', plan, [{ name: 'channel 0' }], deps);
    const second = sendAutomatedTextParts('x', plan, [{ name: 'channel 0' }], deps);
    const third = sendAutomatedTextParts('x', plan, [{ name: 'channel 0' }], deps);
    await expect(third).resolves.toMatchObject({ ok: false, sentParts: 0, dropped: 'duplicate' });
    await vi.runAllTimersAsync();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(sendPart).toHaveBeenCalledTimes(plan.parts.length * 2);
  });
});

describe('sendAutomatedTextParts target gap (4.17.3 review M5)', () => {
  afterEach(() => vi.useRealTimers());

  it('waits targetGapMs between targets within a part, not before the first', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const sentAt: Array<[string, number]> = [];
    const sendPart = vi.fn(async (t: { name: string }) => { sentAt.push([t.name, Date.now() - start]); return true; });
    const plan = planAutomatedTextParts('hello', { maxBytes: 100, split: false });
    const p = sendAutomatedTextParts('hello', plan, [{ name: 'channel 0' }, { name: 'channel 1' }, { name: 'channel 2' }], {
      lock: new SplitSequenceLock(), gapMs: 10_000, targetGapMs: 10_000, canTransmit: () => true, sendPart, logPrefix: '[t]', label: 'Timer x',
    });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ ok: true });
    expect(sentAt).toEqual([['channel 0', 0], ['channel 1', 10_000], ['channel 2', 20_000]]);
  });

  it('without targetGapMs targets go back to back', async () => {
    const sendPart = vi.fn(async () => true);
    const plan = planAutomatedTextParts('hello', { maxBytes: 100, split: false });
    await sendAutomatedTextParts('hello', plan, [{ name: 'a' }, { name: 'b' }], {
      lock: new SplitSequenceLock(), gapMs: 10_000, canTransmit: () => true, sendPart, logPrefix: '[t]', label: 'x',
    });
    expect(sendPart).toHaveBeenCalledTimes(2);
  });
});
