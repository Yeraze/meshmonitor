/**
 * @vitest-environment jsdom
 *
 * Sender-label formatting for the Unified Messages view (issue #4193): the
 * per-message label shows "Long Name (SHRT)" via the shared formatSenderLabel
 * rules from #4196, while the compact label (reply previews, reaction chips)
 * keeps its short-name-first single-value behavior.
 */
import { describe, it, expect } from 'vitest';
import { senderLabel, shortSenderLabel } from './UnifiedMessagesPage';

const base = { fromNodeNum: 0xa1b2c3d4, fromNodeId: '!a1b2c3d4' };

describe('UnifiedMessagesPage sender labels (#4193)', () => {
  it('shows short name alongside long name', () => {
    expect(senderLabel({ ...base, fromNodeLongName: 'Yeraze Base', fromNodeShortName: 'YRZE' }))
      .toBe('Yeraze Base (YRZE)');
  });

  it('shows long name alone when there is no short name', () => {
    expect(senderLabel({ ...base, fromNodeLongName: 'Yeraze Base' })).toBe('Yeraze Base');
  });

  it('does not duplicate the short name when it is the only name', () => {
    expect(senderLabel({ ...base, fromNodeShortName: 'YRZE' })).toBe('YRZE');
  });

  it('falls back to node id, then hex, when no names exist', () => {
    expect(senderLabel({ ...base })).toBe('!a1b2c3d4');
    expect(senderLabel({ fromNodeNum: 0xdeadbeef, fromNodeId: '' })).toBe('!deadbeef');
  });

  it('ignores whitespace-only names', () => {
    expect(senderLabel({ ...base, fromNodeLongName: '  ', fromNodeShortName: 'YRZE' })).toBe('YRZE');
  });

  it('shortSenderLabel stays compact (short-name-first, single value)', () => {
    expect(shortSenderLabel({ ...base, fromNodeLongName: 'Yeraze Base', fromNodeShortName: 'YRZE' })).toBe('YRZE');
    expect(shortSenderLabel({ ...base, fromNodeLongName: 'Yeraze Base' })).toBe('Yeraze Base');
    expect(shortSenderLabel({ ...base })).toBe('!a1b2c3d4');
  });
});
