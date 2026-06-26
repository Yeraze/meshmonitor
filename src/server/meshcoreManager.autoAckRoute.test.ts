/**
 * Tests for the {ROUTE} auto-ack template variable expansion (#3776).
 *
 * MeshCore channel messages are length-limited (~120 chars with a scope) and
 * shorter messages transmit more reliably and cost less airtime. The {ROUTE}
 * variable therefore joins the relay-hash hop chain with a BARE arrow ("a→b→c")
 * — no surrounding spaces — to save 2 bytes per hop.
 *
 * `replaceAutoAckTokens` is private; we reach it via `(m as any)` rather than
 * spinning up a real backend/DB, mirroring the access pattern in
 * meshcoreManager.scope.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { MeshCoreManager } from './meshcoreManager.js';

function expand(template: string, route: string | null, hops: number | null): string {
  const m = new MeshCoreManager('test-source');
  // Args: template, senderPubKey, senderName, snr, timestamp, hops, route
  return (m as any).replaceAutoAckTokens(
    template,
    'deadbeefcafebabe0011223344556677',
    'Tester',
    5.5,
    Date.now(),
    hops,
    route,
  );
}

describe('replaceAutoAckTokens — {ROUTE} compaction (#3776)', () => {
  it('joins hops with a bare arrow and NO surrounding spaces', () => {
    const out = expand('Route: {ROUTE}', '43ad,b8bf,6abc,a5f2', 4);
    expect(out).toBe('Route: 43ad→b8bf→6abc→a5f2');
    // Guard against the previous spaced format ever returning.
    expect(out).not.toContain(' → ');
  });

  it('trims and drops empty hop tokens before joining', () => {
    const out = expand('{ROUTE}', ' a3 , 7f ,, 02 ', 3);
    expect(out).toBe('a3→7f→02');
  });

  it('renders a single hop without any arrow', () => {
    expect(expand('{ROUTE}', 'a3', 1)).toBe('a3');
  });

  it('falls back to "direct" when there is no route and hops === 0', () => {
    expect(expand('{ROUTE}', null, 0)).toBe('direct');
  });

  it('falls back to "—" when route and hop count are unknown', () => {
    expect(expand('{ROUTE}', null, null)).toBe('—');
  });
});
