/**
 * The ok_to_mqtt violations report printed the raw `!hex` id as each row's only
 * label, so for most rows the reader saw nothing but an id. formatNodeDisplay
 * decides what the two-line node cell shows.
 */
import { describe, it, expect } from 'vitest';
import { formatNodeDisplay, formatNodeRef } from './mqttViolationTypes';

describe('formatNodeDisplay', () => {
  describe('with a name known', () => {
    it('puts the long name on top and the id beneath', () => {
      const d = formatNodeDisplay('Yeraze Station', 'YRZE', '!433e0f28', 0x433e0f28);
      expect(d.primary).toBe('Yeraze Station');
      expect(d.secondary).toBe('!433e0f28');
    });

    it('falls back to the short name when there is no long name', () => {
      const d = formatNodeDisplay(null, 'YRZE', '!433e0f28', 0x433e0f28);
      expect(d.primary).toBe('YRZE');
      expect(d.secondary).toBe('!433e0f28');
    });

    it('treats a whitespace-only name as absent', () => {
      // A node whose NodeInfo carried an empty/blank longName must not render a
      // blank primary line — that would look like a rendering bug.
      const d = formatNodeDisplay('   ', '  ', '!433e0f28', 0x433e0f28);
      expect(d.primary).toBe('!433e0f28');
    });

    it('prefers a present long name over a short one', () => {
      expect(formatNodeDisplay('Long', 'SHRT', '!1', 1).primary).toBe('Long');
    });

    it('derives the id from the nodeNum when no id string is stored', () => {
      const d = formatNodeDisplay('Gateway One', null, null, 0x433e0f28);
      expect(d.primary).toBe('Gateway One');
      expect(d.secondary).toBe('!433e0f28');
    });

    it('keeps the nodeNum in the tooltip alongside the name and id', () => {
      const d = formatNodeDisplay('Gateway One', null, '!433e0f28', 0x433e0f28);
      expect(d.title).toContain('Gateway One');
      expect(d.title).toContain('!433e0f28');
      expect(d.title).toContain(String(0x433e0f28));
    });
  });

  describe('with no name known (unchanged from before)', () => {
    it('renders exactly the old id-over-nodeNum pairing', () => {
      const d = formatNodeDisplay(null, null, '!433e0f28', 0x433e0f28);
      expect(d.primary).toBe(formatNodeRef('!433e0f28', 0x433e0f28));
      expect(d.secondary).toBe(String(0x433e0f28));
    });

    it('hex-formats the nodeNum when there is no id, as formatNodeRef does', () => {
      const d = formatNodeDisplay(null, null, null, 0x433e0f28);
      expect(d.primary).toBe('!433e0f28');
    });

    it('shows an em dash rather than an empty cell when nothing is known', () => {
      const d = formatNodeDisplay(null, null, null, null);
      expect(d.primary).toBe('—');
      expect(d.secondary).toBeNull();
      expect(d.title).toBe('—');
    });

    it('omits the second line when only an id is known', () => {
      const d = formatNodeDisplay(null, null, '!433e0f28', null);
      expect(d.primary).toBe('!433e0f28');
      expect(d.secondary).toBeNull();
    });
  });

  it('never returns an empty primary — the cell always renders something', () => {
    const cases: Array<Parameters<typeof formatNodeDisplay>> = [
      ['A', 'B', '!1', 1],
      [null, null, '!1', 1],
      [null, null, null, 1],
      [null, null, null, null],
      ['', '', '', null],
    ];
    for (const args of cases) {
      expect(formatNodeDisplay(...args).primary.length).toBeGreaterThan(0);
    }
  });
});
