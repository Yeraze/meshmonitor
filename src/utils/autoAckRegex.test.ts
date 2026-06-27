/**
 * Unit tests for the client-side RE2-compatibility guard used by
 * AutoAcknowledgeSection's regex validator (#3806).
 *
 * The browser validates auto-ack patterns with native RegExp, which accepts
 * lookaround and backreferences. The server compiles the same pattern with RE2,
 * which rejects them. This guard mirrors the server's accept set so a pattern
 * that the server cannot compile can never be persisted from the UI.
 */
import { describe, it, expect } from 'vitest';
import { hasRE2IncompatibleConstructs } from './autoAckRegex';

describe('hasRE2IncompatibleConstructs', () => {
  it('rejects negative lookahead', () => {
    expect(hasRE2IncompatibleConstructs('^(?!bot)test')).toBe(true);
  });

  it('rejects positive lookahead', () => {
    expect(hasRE2IncompatibleConstructs('foo(?=bar)')).toBe(true);
  });

  it('rejects positive lookbehind', () => {
    expect(hasRE2IncompatibleConstructs('(?<=foo)bar')).toBe(true);
  });

  it('rejects negative lookbehind', () => {
    expect(hasRE2IncompatibleConstructs('(?<!foo)bar')).toBe(true);
  });

  it('rejects backreferences', () => {
    expect(hasRE2IncompatibleConstructs('(test)\\1')).toBe(true);
  });

  it('accepts plain alternation patterns', () => {
    expect(hasRE2IncompatibleConstructs('^(test|ping)')).toBe(false);
  });

  it('accepts non-capturing groups', () => {
    expect(hasRE2IncompatibleConstructs('^(?:test|ping)$')).toBe(false);
  });

  it('accepts named capture groups (supported by RE2)', () => {
    expect(hasRE2IncompatibleConstructs('(?<word>test)')).toBe(false);
  });

  it('accepts character classes and anchors', () => {
    expect(hasRE2IncompatibleConstructs('^[a-z0-9]+$')).toBe(false);
  });
});
