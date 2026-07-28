/**
 * `showIf` conditional field visibility (#4340 WP3 §3.5) — the general
 * mechanism a `FieldDef` uses to hide itself based on a sibling param, plus
 * the `action.tapback` catalog entry that is its first consumer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fieldVisible, ACTIONS, TRIGGERS, type FieldDef } from './catalog';
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

  // #4340 Phase 2: truthy — covers "a number field that is unset, blank, or 0"
  // in one operator, since equals/notEquals cannot distinguish those three.
  describe('truthy', () => {
    const truthyField: FieldDef = { name: 'x', label: 'X', kind: 'select', showIf: { field: 'cooldownSeconds', truthy: true } };
    const falsyField: FieldDef = { name: 'x', label: 'X', kind: 'select', showIf: { field: 'cooldownSeconds', truthy: false } };

    it('truthy: true hides on undefined / "" / 0 / false', () => {
      expect(fieldVisible(truthyField, {})).toBe(false); // undefined — never touched
      expect(fieldVisible(truthyField, { cooldownSeconds: '' })).toBe(false); // cleared via the number renderer
      expect(fieldVisible(truthyField, { cooldownSeconds: 0 })).toBe(false);
      expect(fieldVisible(truthyField, { cooldownSeconds: false })).toBe(false);
    });

    it('truthy: true shows on 1 / 60 / a non-empty string', () => {
      expect(fieldVisible(truthyField, { cooldownSeconds: 1 })).toBe(true);
      expect(fieldVisible(truthyField, { cooldownSeconds: 60 })).toBe(true);
      expect(fieldVisible(truthyField, { cooldownSeconds: 'x' })).toBe(true);
    });

    it('truthy: false inverts — visible only when the sibling is falsy', () => {
      expect(fieldVisible(falsyField, {})).toBe(true);
      expect(fieldVisible(falsyField, { cooldownSeconds: '' })).toBe(true);
      expect(fieldVisible(falsyField, { cooldownSeconds: 0 })).toBe(true);
      expect(fieldVisible(falsyField, { cooldownSeconds: 1 })).toBe(false);
      expect(fieldVisible(falsyField, { cooldownSeconds: 60 })).toBe(false);
    });

    it('truthy combined with equals: both conditions must pass', () => {
      const field: FieldDef = { name: 'x', label: 'X', kind: 'select', showIf: { field: 'cooldownSeconds', truthy: true } };
      // Independently re-verify with a different sibling to confirm the two showIf
      // operators (equals vs truthy) don't leak state between fields.
      const other: FieldDef = { name: 'y', label: 'Y', kind: 'text', showIf: { field: 'mode', equals: 'a' } };
      expect(fieldVisible(field, { cooldownSeconds: 60 })).toBe(true);
      expect(fieldVisible(other, { mode: 'a', cooldownSeconds: 0 })).toBe(true);
    });
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

// #4340 Phase 2 §4.2/§6 — the cooldownScope field, spliced into exactly the
// five trigger blocks that already carry cooldownSeconds (SUBJECT_NODE_TRIGGERS
// in catalog.ts, verified as the same five in §1 finding #8).
describe('trigger.* cooldownScope catalog entries (#4340 Phase 2)', () => {
  const COOLDOWN_BEARING_TYPES = ['trigger.message', 'trigger.nodeDiscovered', 'trigger.nodeUpdated', 'trigger.telemetry', 'trigger.geofence'];
  const NO_COOLDOWN_TYPES = ['trigger.schedule', 'trigger.system'];

  it.each(COOLDOWN_BEARING_TYPES)('%s lists cooldownScope immediately after cooldownSeconds', (type) => {
    const block = TRIGGERS.find((t) => t.type === type);
    expect(block).toBeDefined();
    const names = (block?.fields ?? []).map((f) => f.name);
    const cooldownIdx = names.indexOf('cooldownSeconds');
    const scopeIdx = names.indexOf('cooldownScope');
    expect(cooldownIdx).toBeGreaterThanOrEqual(0);
    expect(scopeIdx).toBe(cooldownIdx + 1);
  });

  it.each(NO_COOLDOWN_TYPES)('%s has neither cooldownSeconds nor cooldownScope', (type) => {
    const block = TRIGGERS.find((t) => t.type === type);
    expect(block).toBeDefined();
    const names = (block?.fields ?? []).map((f) => f.name);
    expect(names).not.toContain('cooldownSeconds');
    expect(names).not.toContain('cooldownScope');
  });

  it('cooldownScope options are exactly automation/node/sourceNode, automation first', () => {
    const block = TRIGGERS.find((t) => t.type === 'trigger.message');
    const field = block?.fields.find((f) => f.name === 'cooldownScope');
    expect(field?.kind).toBe('select');
    expect(field?.options?.map((o) => o.value)).toEqual(['automation', 'node', 'sourceNode']);
  });

  it('cooldownScope carries showIf hiding it until cooldownSeconds is truthy', () => {
    const block = TRIGGERS.find((t) => t.type === 'trigger.message');
    const field = block?.fields.find((f) => f.name === 'cooldownScope');
    expect(field?.showIf).toEqual({ field: 'cooldownSeconds', truthy: true });
  });

  it('every cooldown-bearing block shares the identical cooldownScope FieldDef object', () => {
    // COOLDOWN_SCOPE is a single shared const spliced into all five blocks —
    // not five separately-authored copies that could drift apart.
    const fields = COOLDOWN_BEARING_TYPES.map((type) => TRIGGERS.find((t) => t.type === type)?.fields.find((f) => f.name === 'cooldownScope'));
    for (const f of fields) expect(f).toBe(fields[0]);
  });
});
