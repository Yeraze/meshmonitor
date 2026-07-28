/**
 * `showIf` conditional field visibility (#4340 WP3 §3.5) — the general
 * mechanism a `FieldDef` uses to hide itself based on a sibling param, plus
 * the `action.tapback` catalog entry that is its first consumer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fieldVisible, ACTIONS, type FieldDef } from './catalog';
import { HOP_COUNT_EMOJIS } from '../../utils/hopEmoji';

describe('fieldVisible', () => {
  it('is visible when the field has no showIf', () => {
    const field: FieldDef = { name: 'x', label: 'X', kind: 'text' };
    expect(fieldVisible(field, {})).toBe(true);
    expect(fieldVisible(field, { x: 'anything' })).toBe(true);
  });

  it('equals: visible only when the sibling param matches', () => {
    const field: FieldDef = { name: 'x', label: 'X', kind: 'text', showIf: { field: 'mode', equals: 'a' } };
    expect(fieldVisible(field, { mode: 'a' })).toBe(true);
    expect(fieldVisible(field, { mode: 'b' })).toBe(false);
    expect(fieldVisible(field, {})).toBe(false); // undefined !== 'a'
  });

  it('notEquals: visible except when the sibling param matches', () => {
    const field: FieldDef = { name: 'x', label: 'X', kind: 'text', showIf: { field: 'mode', notEquals: 'hopCount' } };
    expect(fieldVisible(field, { mode: 'fixed' })).toBe(true);
    expect(fieldVisible(field, { mode: 'hopCount' })).toBe(false);
  });

  it('notEquals: an undefined sibling param (legacy graph, field never written) is visible', () => {
    // A stored automation created before emojiMode existed has no key at all —
    // params.emojiMode is undefined, which !== 'hopCount', so the field shows.
    const field: FieldDef = { name: 'emoji', label: 'Emoji', kind: 'emoji', showIf: { field: 'emojiMode', notEquals: 'hopCount' } };
    expect(fieldVisible(field, {})).toBe(true);
  });

  it('both equals and notEquals set: both conditions must pass', () => {
    const field: FieldDef = { name: 'x', label: 'X', kind: 'text', showIf: { field: 'mode', equals: 'a', notEquals: 'b' } };
    expect(fieldVisible(field, { mode: 'a' })).toBe(true);
    // 'b' fails both equals (b !== a -> hidden) — equals check alone already hides it.
    expect(fieldVisible(field, { mode: 'b' })).toBe(false);
    expect(fieldVisible(field, { mode: 'c' })).toBe(false); // fails equals
  });
});

describe('action.tapback catalog entry', () => {
  const tapback = ACTIONS.find((a) => a.type === 'action.tapback');

  it('exists and lists emojiMode before emoji', () => {
    expect(tapback).toBeDefined();
    const names = (tapback?.fields ?? []).map((f) => f.name);
    const modeIdx = names.indexOf('emojiMode');
    const emojiIdx = names.indexOf('emoji');
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(emojiIdx).toBeGreaterThan(modeIdx);
  });

  it('emojiMode is a select with fixed/hopCount options, fixed first', () => {
    const field = tapback?.fields.find((f) => f.name === 'emojiMode');
    expect(field?.kind).toBe('select');
    expect(field?.options?.map((o) => o.value)).toEqual(['fixed', 'hopCount']);
  });

  it('emoji carries showIf hiding it when emojiMode is hopCount', () => {
    const field = tapback?.fields.find((f) => f.name === 'emoji');
    expect(field?.showIf).toEqual({ field: 'emojiMode', notEquals: 'hopCount' });
  });

  it('emojiMode option label and help resolve to the real hop-emoji glyphs (interpolation ran)', () => {
    const field = tapback?.fields.find((f) => f.name === 'emojiMode');
    const hopOption = field?.options?.find((o) => o.value === 'hopCount');
    expect(hopOption?.label).toContain(HOP_COUNT_EMOJIS[0]);
    expect(field?.help).toContain(HOP_COUNT_EMOJIS[0]);
  });

  it('no emoji glyph is hardcoded as a literal in catalog.ts source (C1) — every glyph is interpolated from HOP_COUNT_EMOJIS', () => {
    // Read the actual source file (not the evaluated module) so a literal
    // keycap glyph typed into a label/help string is caught even though the
    // *interpolated* HOP_COUNT_EMOJIS[...] result would look identical at runtime.
    const here = fileURLToPath(import.meta.url);
    const catalogPath = here.replace(/catalog\.showIf\.test\.ts$/, 'catalog.ts');
    const source = readFileSync(catalogPath, 'utf8');
    for (const glyph of HOP_COUNT_EMOJIS) {
      expect(source.includes(glyph)).toBe(false);
    }
  });
});
