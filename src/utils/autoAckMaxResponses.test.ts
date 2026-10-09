import { describe, it, expect } from 'vitest';
import { resolveAutoAckMaxResponses } from './autoAckMaxResponses';

describe('resolveAutoAckMaxResponses (settings load path)', () => {
  it('a stored "0" stays 0 — the `|| default` trap', () => {
    expect(resolveAutoAckMaxResponses('0')).toBe(0);
  });
  it('unset reads as 2, so switching to a source with no value never shows the last one', () => {
    expect(resolveAutoAckMaxResponses(undefined)).toBe(2);
    expect(resolveAutoAckMaxResponses(null)).toBe(2);
  });
});
