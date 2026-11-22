/**
 * sendAutomatedText with a sender name (#6341 P4): raw path, fallback with one
 * warning, mid-sequence refusal, TX-disabled propagation, min-cap planning.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const policy = vi.hoisted(() => ({ value: { enabled: true, allowedNames: ['Bob', 'A very long override nm'] } as { enabled: boolean; allowedNames: string[] } }));
vi.mock('./utils/meshcoreSenderNamePolicy.js', async (orig) => ({
  ...(await orig<typeof import('./utils/meshcoreSenderNamePolicy.js')>()),
  readSenderNamePolicy: vi.fn(async () => policy.value),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import { MeshCoreSenderNameError } from './errors/meshcoreSenderNameError.js';
import { TxDisabledError } from './errors/txDisabledError.js';
import { logger } from '../utils/logger.js';

const GAP = 10_000;
const LONG = 'word '.repeat(70);
let seq = 0;

function make(opts: { localName?: string; fw?: number; repeat?: boolean; deviceType?: MeshCoreDeviceType; raw?: (n: number, text: string) => unknown } = {}) {
  const m = new MeshCoreManager(`sn-${seq++}`);
  (m as any).deviceType = opts.deviceType ?? MeshCoreDeviceType.COMPANION;
  (m as any).connected = true;
  (m as any).localNode = { name: opts.localName ?? 'abcdefghijkl', firmwareVer: opts.fw ?? 13 };
  (m as any).deviceQuery = vi.fn(async () => ({ repeat: opts.repeat === true }));
  const normal: Array<{ text: string; channel?: number }> = [];
  const raw: Array<{ text: string; channel: number; name: string }> = [];
  (m as any).sendMessage = vi.fn(async (text: string, _d?: string, channel?: number) => { normal.push({ text, channel }); return true; });
  (m as any).sendChannelMessageAs = vi.fn(async (text: string, channel: number, name: string) => {
    raw.push({ text, channel, name });
    const r = opts.raw?.(raw.length, text);
    if (r instanceof Error) throw r;
    return { ok: r !== false };
  });
  return { m, normal, raw };
}

describe('sendAutomatedText senderName', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    policy.value = { enabled: true, allowedNames: ['Bob', 'A very long override nm'] };
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const fallbackWarns = () => warn.mock.calls.filter((c) => String(c[0]).includes('cannot send as'));

  it('override path sends raw under the name', async () => {
    const { m, normal, raw } = make();
    const r = await m.sendAutomatedText('hi', { channelIdxs: [1, 2], split: false, label: 't', senderName: 'Bob' });
    expect(raw).toEqual([{ text: 'hi', channel: 1, name: 'Bob' }, { text: 'hi', channel: 2, name: 'Bob' }]);
    expect(normal).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it('a DM ignores the name', async () => {
    const { m, normal, raw } = make();
    await m.sendAutomatedText('hi', { toPublicKey: 'aa', split: false, label: 't', senderName: 'Bob' });
    expect(raw).toHaveLength(0);
    expect(normal).toHaveLength(1);
  });

  it('a name equal to the node name takes the normal path with no warning', async () => {
    const { m, normal, raw } = make();
    await m.sendAutomatedText('hi', { channelIdxs: [1], split: false, label: 't', senderName: 'abcdefghijkl' });
    expect(raw).toHaveLength(0);
    expect(normal).toHaveLength(1);
    expect(fallbackWarns()).toHaveLength(0);
  });

  const cases: Array<[string, () => ReturnType<typeof make>, string?]> = [
    ['disabled', () => { policy.value = { enabled: false, allowedNames: ['Bob'] }; return make(); }],
    ['name not on the list', () => make(), 'Mallory'],
    ['client repeat on', () => make({ repeat: true })],
    ['firmware below 13', () => make({ fw: 12 })],
    ['firmware unknown', () => { const x = make(); (x.m as any).localNode.firmwareVer = undefined; return x; }],
    ['repeater', () => make({ deviceType: MeshCoreDeviceType.REPEATER })],
  ];
  for (const [label, build, nm] of cases) {
    it(`falls back to the node name with one warning: ${label}`, async () => {
      const { m, normal, raw } = build();
      for (let i = 0; i < 3; i++) {
        await m.sendAutomatedText('hi', { channelIdxs: [1], split: false, label: 'fb', senderName: nm ?? 'Bob' });
      }
      expect(raw).toHaveLength(0);
      expect(normal).toHaveLength(3);
      expect(fallbackWarns()).toHaveLength(1);
    });
  }

  it('a mid-sequence refusal drops that target only', async () => {
    const { m, raw } = make({ raw: (n) => (n === 2 ? new MeshCoreSenderNameError('SEND_FAILED', 'nope') : true) });
    // Part 1 to channels 1 and 2; channel 1 is raw call 1, channel 2 is call 2 (refused).
    const p = m.sendAutomatedText(LONG, { channelIdxs: [1, 2], split: true, label: 't', senderName: 'Bob' });
    await vi.advanceTimersByTimeAsync(GAP * 3);
    const r = await p;
    expect(raw.filter((x) => x.channel === 2)).toHaveLength(1);
    expect(raw.filter((x) => x.channel === 1).length).toBeGreaterThan(1);
    expect(r.ok).toBe(false);
    expect(new Set(raw.map((x) => x.name))).toEqual(new Set(['Bob']));
  });

  it('TxDisabledError propagates', async () => {
    const { m } = make({ raw: () => new TxDisabledError('receive only') });
    await expect(m.sendAutomatedText('hi', { channelIdxs: [1], split: false, label: 't', senderName: 'Bob' }))
      .rejects.toBeInstanceOf(TxDisabledError);
  });

  it('plans with the smaller cap: long node name, short override', async () => {
    const { m, raw } = make({ localName: 'n'.repeat(30) }); // normal 128, raw(Bob) 150
    await m.sendAutomatedText('x'.repeat(300), { channelIdxs: [1], split: false, label: 't', senderName: 'Bob' });
    expect(Buffer.byteLength(raw[0].text)).toBe(128);
  });

  it('plans with the smaller cap: short node name, long override', async () => {
    const { m, raw } = make({ localName: 'x' }); // normal 157, raw(23-byte name) 130
    await m.sendAutomatedText('y'.repeat(300), { channelIdxs: [1], split: false, label: 't', senderName: 'A very long override nm' });
    expect(Buffer.byteLength(raw[0].text)).toBe(130);
  });

  it('the duplicate key includes the name', async () => {
    const { m, raw } = make();
    const a = m.sendAutomatedText(LONG, { channelIdxs: [1], split: true, label: 'k', senderName: 'Bob' });
    const b = m.sendAutomatedText(LONG, { channelIdxs: [1], split: true, label: 'k', senderName: 'A very long override nm' });
    await vi.advanceTimersByTimeAsync(GAP * 10);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.dropped).toBeUndefined();
    expect(rb.dropped).toBeUndefined();
    expect(raw.length).toBeGreaterThan(2);
  });
});
