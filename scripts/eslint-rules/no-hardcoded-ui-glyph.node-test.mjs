import test from 'node:test';
import assert from 'node:assert/strict';
import { containsHardcodedUiGlyph } from './no-hardcoded-ui-glyph.mjs';

test('detects emoji and Unicode icon stand-ins', () => {
  for (const value of ['🗑️', 'GitHub 🐙', '✓ Saved', '▶']) {
    assert.equal(containsHardcodedUiGlyph(value), true, value);
  }
});

test('allows ordinary UI copy and protocol identifiers', () => {
  for (const value of ['Delete', 'AES-256', 'node_1234', '100%', 'Node A ↔ Node B', 'Map data © Organization']) {
    assert.equal(containsHardcodedUiGlyph(value), false, value);
  }
});

test('detects circle/slash status glyphs (#4240 follow-up)', () => {
  // These were missing from the leading-symbol list, so the #4217 migration
  // skipped four functional status indicators without CI noticing.
  for (const value of ['● live', '○ offline', '◐ partial', '⊘ Disabled', '●', '◯']) {
    assert.equal(containsHardcodedUiGlyph(value), true, value);
  }
});

test('still allows those characters mid-sentence', () => {
  for (const value of ['Signal ● strength', 'radius ⊘ limit']) {
    assert.equal(containsHardcodedUiGlyph(value), false, value);
  }
});
