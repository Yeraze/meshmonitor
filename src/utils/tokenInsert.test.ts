/**
 * insertTokenAtSelection — the token insert shared by the Auto Announce
 * (Meshtastic + MeshCore) and Auto Welcome editors. Replaces the old
 * src/components/tokenInsert.test.tsx, which tested a copy of this logic (#6379).
 */
import { describe, it, expect } from 'vitest';
import { insertTokenAtSelection } from './tokenInsert';

describe('insertTokenAtSelection', () => {
  describe('caret (start === end)', () => {
    it('inserts in the middle of the text', () => {
      expect(insertTokenAtSelection('Hello world', '{VERSION} ', { start: 6, end: 6 }))
        .toEqual({ text: 'Hello {VERSION} world', caret: 16 });
    });

    it('inserts at the start', () => {
      expect(insertTokenAtSelection('world', '{NODECOUNT}', { start: 0, end: 0 }))
        .toEqual({ text: '{NODECOUNT}world', caret: 11 });
    });

    it('inserts at the end', () => {
      expect(insertTokenAtSelection('Up for ', '{DURATION}', { start: 7, end: 7 }))
        .toEqual({ text: 'Up for {DURATION}', caret: 17 });
    });

    it('inserts into empty text', () => {
      expect(insertTokenAtSelection('', '{VERSION}', { start: 0, end: 0 }))
        .toEqual({ text: '{VERSION}', caret: 9 });
    });
  });

  describe('selection (start < end)', () => {
    it('replaces the selected text and puts the caret after the token', () => {
      expect(insertTokenAtSelection('Version: XXX here', '{VERSION}', { start: 9, end: 12 }))
        .toEqual({ text: 'Version: {VERSION} here', caret: 18 });
    });

    it('replaces the whole text when all of it is selected', () => {
      expect(insertTokenAtSelection('old message', '{FEATURES}', { start: 0, end: 11 }))
        .toEqual({ text: '{FEATURES}', caret: 10 });
    });
  });

  describe('no selection (textarea not mounted)', () => {
    it('appends to the end', () => {
      expect(insertTokenAtSelection('Hello ', '{VERSION}', null))
        .toEqual({ text: 'Hello {VERSION}', caret: 15 });
    });

    it('appends repeatedly', () => {
      const first = insertTokenAtSelection('', '{A}', null);
      const second = insertTokenAtSelection(first.text, '{B}', null);
      expect(second).toEqual({ text: '{A}{B}', caret: 6 });
    });
  });

  it('keeps existing tokens and the token text verbatim', () => {
    expect(insertTokenAtSelection('{VERSION} up', '{DURATION}', { start: 12, end: 12 }).text)
      .toBe('{VERSION} up{DURATION}');
  });

  it('counts the caret in UTF-16 units, matching textarea selection offsets', () => {
    // U+1F4E1 is two UTF-16 code units, as textarea.selectionStart counts them.
    const text = '\u{1F4E1} hi';
    expect(insertTokenAtSelection(text, '{V}', { start: 2, end: 2 }))
      .toEqual({ text: '\u{1F4E1}{V} hi', caret: 5 });
  });
});
