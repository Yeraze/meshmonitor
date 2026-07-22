/**
 * Tests for auto-responder token expansion (#3892).
 *
 * Before #3892 the MeshCore auto-responder only ran responses through the
 * narrow announce-token set, so reply-context tokens like {HOPS} and {ROUTE}
 * were left as literal text. `renderReplyTemplate` (shared by Auto-Ack and
 * Auto-Responder) now runs the per-message reply tokens first and the global
 * announce tokens second, so both surfaces accept the same placeholders and
 * {NODE_NAME}/{NODE_ID} resolve to the sender on both.
 *
 * `renderReplyTemplate` is private; we reach it via `(m as any)` rather than
 * spinning up a real backend/DB, mirroring meshcoreManager.autoAckRoute.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';

function render(
  template: string,
  opts: {
    snr?: number;
    hops?: number | null;
    route?: string | null;
    senderName?: string;
    scopeName?: string | null;
    contacts?: Array<{ publicKey: string; advType: number; advName: string }>;
  } = {},
): Promise<string> {
  const m = new MeshCoreManager('test-source');
  for (const c of opts.contacts ?? []) {
    (m as any).contacts.set(c.publicKey, c);
  }
  return (m as any).renderReplyTemplate(
    template,
    'deadbeefcafebabe0011223344556677',
    opts.senderName,
    opts.snr,
    Date.now(),
    opts.hops ?? null,
    opts.route ?? null,
    opts.scopeName ?? null,
    null,
  );
}

describe('renderResponderText — reply tokens (#3892)', () => {
  it('expands {HOPS} from the triggering message', async () => {
    expect(await render('Got it, {HOPS} hops', { hops: 3 })).toBe('Got it, 3 hops');
  });

  it('expands {ROUTE} with the compact arrow chain', async () => {
    expect(await render('via {ROUTE}', { route: 'a3,7f,02', hops: 3 })).toBe('via a3→7f→02');
  });

  it('expands {ROUTE_NAMES} resolving relay hashes to repeater names, raw hex when unknown', async () => {
    const contacts = [
      { publicKey: 'a3' + 'b'.repeat(62), advType: 2, advName: 'Hilltop' },
      { publicKey: '7f' + 'c'.repeat(62), advType: 3, advName: 'Downtown Room' },
      { publicKey: '02' + 'd'.repeat(62), advType: 1, advName: 'Chat Node' }, // companion — excluded
    ];
    expect(await render('via {ROUTE_NAMES}', { route: 'a3,7f,02', hops: 3, contacts }))
      .toBe('via Hilltop→Downtown Room→02');
  });

  it('{ROUTE_NAMES} falls back like {ROUTE} for direct / unknown routes', async () => {
    expect(await render('via {ROUTE_NAMES}', { hops: 0 })).toBe('via direct');
    expect(await render('via {ROUTE_NAMES}', { hops: 2 })).toBe('via —');
  });

  it('expands {HASH_SIZE} from the hop hex width the sender stamped', async () => {
    expect(await render('{HASH_SIZE}B hashes', { route: 'a3,7f', hops: 2 })).toBe('1B hashes');
    expect(await render('{HASH_SIZE}B hashes', { route: 'a3f2,7f01', hops: 2 })).toBe('2B hashes');
    expect(await render('{HASH_SIZE}', { hops: 0 })).toBe('—');
  });

  it('expands {SNR} and {LONG_NAME}', async () => {
    expect(await render('{LONG_NAME} @ {SNR}dB', { snr: 5.5, senderName: 'Tester' })).toBe('Tester @ 5.5dB');
  });

  it('still expands the global {VERSION} token (real version, not the old 4.8.0 hardcode)', async () => {
    const out = await render('v{VERSION}');
    expect(out).toMatch(/^v\d+\.\d+\.\d+/);
    expect(out).not.toContain('{VERSION}');
  });

  it('resolves {NODE_NAME} to the sender (parity with Auto-Ack)', async () => {
    expect(await render('Hi {NODE_NAME}', { senderName: 'Tester' })).toBe('Hi Tester');
  });

  it('resolves {NODE_ID} to the sender’s prefixed ID, not the local node', async () => {
    // nodeId = '!' + first 8 hex chars of the sender pubkey (deadbeef…).
    expect(await render('from {NODE_ID}', { senderName: 'Tester' })).toBe('from !deadbeef');
  });

  it('leaves unknown tokens untouched', async () => {
    expect(await render('{NOPE}')).toBe('{NOPE}');
  });
});
