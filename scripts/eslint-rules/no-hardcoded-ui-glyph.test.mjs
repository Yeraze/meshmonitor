import test from 'node:test';
import assert from 'node:assert/strict';
import { containsHardcodedUiGlyph } from './no-hardcoded-ui-glyph.mjs';

test('detects emoji and Unicode icon stand-ins', () => {
  for (const value of ['🗑️', 'GitHub 🐙', '✓ Saved', '▶']) {
    assert.equal(containsHardcodedUiGlyph(value), true, value);
  }
});

test('allows ordinary UI copy and protocol identifiers', () => {
  for (const value of ['Delete', 'AES-256', 'node_1234', '100%']) {
    assert.equal(containsHardcodedUiGlyph(value), false, value);
  }
});

