/**
 * sendAutomatedText (#6316): part order across channels, gap, receive-only
 * mid-sequence, dropped target, truncation, per-source split mutex.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const GAP = 10_000;
const LONG = 'word '.repeat(70); // needs 3 parts on a channel

interface Send { text: string; dest?: string; channel?: number; autoRetry?: boolean; }

function make(sendResult: (s: Send, n: number) => boolean = () => true) {
  const m = new MeshCoreManager('t');
  (m as any).deviceType = MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { name: 'abcdefghijkl' };
  const sends: Send[] = [];
  (m as any).sendMessage = vi.fn(async (text: string, dest?: string, channel?: number, _scope?: any, autoRetry?: boolean) => {
    const s = { text, dest, channel, autoRetry };
    sends.push(s);
    return sendResult(s, sends.length);
  });
  return { m, sends };
}

describe('MeshCoreManager.sendAutomatedText', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('split off: one truncated send per channel, no gap', async () => {
    const { m, sends } = make();
    const r = await m.sendAutomatedText(LONG, { channelIdxs: [1, 2], split: false, label: 't' });
    expect(sends.map((s) => s.channel)).toEqual([1, 2]);
    expect(Buffer.byteLength(sends[0].text)).toBeLessThanOrEqual(146);
    expect(r).toMatchObject({ ok: true, totalParts: 1, truncated: true });
    expect(sends.every((s) => s.autoRetry === true)).toBe(true);
  });

  it('split on: sends by part across channels with a gap between parts', async () => {
    const { m, sends } = make();
    const p = m.sendAutomatedText(LONG, { channelIdxs: [1, 2], split: true, label: 't' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((s) => s.channel)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(sends).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends.map((s) => s.channel)).toEqual([1, 2, 1, 2]);
    await vi.advanceTimersByTimeAsync(GAP);
    const r = await p;
    expect(sends).toHaveLength(6);
    expect(sends[0].text.startsWith('(1/3)')).toBe(true);
    expect(r).toMatchObject({ ok: true, sentParts: 3, totalParts: 3 });
  });

  it('DM uses the dest key and no auto-retry flag', async () => {
    const { m, sends } = make();
    await m.sendAutomatedText('hi', { toPublicKey: 'aa', split: true, label: 't' });
    expect(sends).toEqual([{ text: 'hi', dest: 'aa', channel: undefined, autoRetry: undefined }]);
  });

  it('drops a failed target from later parts', async () => {
    const { m, sends } = make((s) => s.channel !== 1);
    const p = m.sendAutomatedText(LONG, { channelIdxs: [1, 2], split: true, label: 't' });
    await vi.advanceTimersByTimeAsync(GAP * 2);
    const r = await p;
    expect(sends.filter((s) => s.channel === 1)).toHaveLength(1);
    expect(sends.filter((s) => s.channel === 2)).toHaveLength(3);
    expect(r.ok).toBe(false);
    expect(r.perTarget).toEqual([{ target: 'channel 1', sentParts: 0 }, { target: 'channel 2', sentParts: 3 }]);
  });

  it('stops when receive-only is switched on mid-sequence', async () => {
    const { m, sends } = make();
    const p = m.sendAutomatedText(LONG, { channelIdxs: [1], split: true, label: 't' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    vi.spyOn(m as any, 'canTransmit').mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(GAP * 2);
    const r = await p;
    expect(sends).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it('serialises two split sequences so markers never interleave', async () => {
    const { m, sends } = make();
    const a = m.sendAutomatedText(LONG, { channelIdxs: [1], split: true, label: 'a' });
    const b = m.sendAutomatedText(LONG.replace(/word/g, 'item'), { channelIdxs: [2], split: true, label: 'b' });
    await vi.advanceTimersByTimeAsync(GAP * 10);
    await Promise.all([a, b]);
    expect(sends.map((s) => s.channel)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it('sent text equals the planned text', async () => {
    const { m, sends } = make();
    await m.sendAutomatedText('x'.repeat(300), { toPublicKey: 'aa', split: false, label: 't' });
    expect(sends[0].text).toBe(`${'x'.repeat(157)}...`); // cut ends in "..." (#6330)
  });
});
