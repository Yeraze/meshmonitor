/** Notification text for MeshCore traces and path discoveries (P11 S7). */
import { describe, it, expect } from 'vitest';
import { formatMeshCoreTraceRoute, formatMeshCorePathDiscovery } from './meshcoreTrace.js';

const contacts = [
  { publicKey: 'a3' + '11'.repeat(31), name: 'Hill' },
  { publicKey: '7f22' + '22'.repeat(30), advName: 'Ridge' },
  { publicKey: 'bb01' + '33'.repeat(30), name: 'Twin A' },
  { publicKey: 'bb02' + '44'.repeat(30), name: 'Twin B' },
];

describe('formatMeshCoreTraceRoute', () => {
  it('names 1-byte hops and gives per-hop SNR', () => {
    const text = formatMeshCoreTraceRoute(
      [{ index: 0, snr: 10 }, { index: 1, snr: 6.25 }], ['a3', '7f'], 7.5, contacts);
    expect(text).toBe('a3 Hill (10 dB) → 7f Ridge (6.25 dB); last hop 7.5 dB');
  });

  it('names 2-byte hops', () => {
    const text = formatMeshCoreTraceRoute([{ index: 0, snr: -3 }], ['7f22'], 1, contacts);
    expect(text).toBe('7f22 Ridge (-3 dB); last hop 1 dB');
  });

  it('keeps an unknown hop, and a hash two contacts share, as the bare hash', () => {
    const text = formatMeshCoreTraceRoute(
      [{ index: 0, snr: 2 }, { index: 1, snr: 3 }], ['EE', 'bb'], 4, contacts);
    expect(text).toBe('ee (2 dB) → bb (3 dB); last hop 4 dB');
  });

  it('reads a direct trace with no hops as the last SNR', () => {
    expect(formatMeshCoreTraceRoute([], [], 5.5, contacts)).toBe('Direct, last hop 5.5 dB');
  });

  it('splits an auto-return path into out and back', () => {
    const hops = [5, 6, 7].map((snr, index) => ({ index, snr }));
    const text = formatMeshCoreTraceRoute(hops, ['a3', '7f', 'a3'], 8, contacts, { autoReturn: true });
    expect(text).toBe('Out: a3 Hill (5 dB) → 7f Ridge (6 dB); Back: a3 Hill (7 dB); last hop 8 dB');
  });
});

describe('formatMeshCorePathDiscovery', () => {
  it('reads out and in hop counts', () => {
    expect(formatMeshCorePathDiscovery(2, 'a3,7f', 1)).toBe('Path discovered: out 2 hops [a3,7f], in 1 hop');
  });
  it('drops the brackets for a direct path', () => {
    expect(formatMeshCorePathDiscovery(0, '', 0)).toBe('Path discovered: out 0 hops, in 0 hops');
  });
});
