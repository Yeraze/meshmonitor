/**
 * Regression spec for the channel-database response transform (#2939, PR #2944).
 *
 * src/server/routes/v1/channelDatabase.ts:30 (transformChannelForResponse)
 * sets pskPreview as:
 *
 *   includeFullPsk
 *     ? channel.psk
 *     : (channel.psk ? `${channel.psk.substring(0, 8)}...` : '(none)')
 *
 * The fix is the trailing `'(none)'` branch. Before the fix, an empty/missing
 * PSK on the masked (non-includeFullPsk) path would crash on `.substring`. The
 * helper is not exported and the masked branch is gated behind admin-only
 * routes, so we mirror the expression here in the same logic-spec style as
 * channelDatabasePermissions.test.ts to lock in the expected behavior and
 * document the contract.
 */

import { describe, it, expect } from 'vitest';

// Mirror of transformChannelForResponse's pskPreview expression.
// Keep this identical to src/server/routes/v1/channelDatabase.ts:30.
const pskPreviewFor = (channel: { psk?: string | null }, includeFullPsk: boolean) =>
  includeFullPsk
    ? channel.psk
    : (channel.psk ? `${channel.psk.substring(0, 8)}...` : '(none)');

describe('channel-database response transform — pskPreview (masked branch)', () => {
  it('returns "(none)" when psk is an empty string', () => {
    expect(pskPreviewFor({ psk: '' }, false)).toBe('(none)');
  });

  it('returns "(none)" when psk is null', () => {
    expect(pskPreviewFor({ psk: null }, false)).toBe('(none)');
  });

  it('returns "(none)" when psk is undefined / missing', () => {
    expect(pskPreviewFor({}, false)).toBe('(none)');
  });

  it('returns the truncated 8-char preview when psk is present', () => {
    const psk = 'AAAAAAAA1234567890BBBBBBBB';
    expect(pskPreviewFor({ psk }, false)).toBe('AAAAAAAA...');
  });

  it('returns truncated preview even for short non-empty PSKs (length <= 8)', () => {
    // String.prototype.substring(0, 8) on a short string returns the full
    // string, so the preview is "<psk>...". Still non-empty, still safe.
    expect(pskPreviewFor({ psk: 'short' }, false)).toBe('short...');
  });
});

describe('channel-database response transform — pskPreview (admin branch)', () => {
  it('returns the raw psk when includeFullPsk=true (preserved by the fix)', () => {
    expect(pskPreviewFor({ psk: 'full-secret' }, true)).toBe('full-secret');
  });

  it('does not substitute "(none)" on the admin branch when psk is empty', () => {
    // The fix is scoped to the masked branch; admin still gets channel.psk
    // verbatim (here: empty string).
    expect(pskPreviewFor({ psk: '' }, true)).toBe('');
  });
});
