/**
 * `showIf` conditional field visibility (#4340 WP3 §3.5) — the general
 * mechanism a `FieldDef` uses to hide itself based on a sibling param, plus
 * the `action.tapback` catalog entry that is its first consumer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fieldVisible, fieldPlaceholder, ACTIONS, CONDITIONS, TRIGGERS, numericFields, stringFields, STRING_OP_OPTIONS, type FieldDef } from './catalog';
import { HOP_COUNT_EMOJIS, MQTT_SOURCE_EMOJI } from '../../utils/hopEmoji';

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
    // #4594 folded the MQTT-source glyph into the same rule.
    for (const glyph of [...HOP_COUNT_EMOJIS, MQTT_SOURCE_EMOJI]) {
      expect(source.includes(glyph)).toBe(false);
    }
  });

  it('emojiMode help documents the MQTT-source glyph, interpolated (#4594)', () => {
    const field = tapback?.fields.find((f) => f.name === 'emojiMode');
    expect(field?.help).toContain(MQTT_SOURCE_EMOJI);
  });
});

// #4340 Phase 2 §4.2/§6 — the cooldownScope field, spliced into exactly the
// five trigger blocks that already carry cooldownSeconds (SUBJECT_NODE_TRIGGERS
// in catalog.ts, verified as the same five in §1 finding #8).
describe('trigger.* cooldownScope catalog entries (#4340 Phase 2)', () => {
  const COOLDOWN_BEARING_TYPES = ['trigger.message', 'trigger.nodeDiscovered', 'trigger.nodeUpdated', 'trigger.telemetry', 'trigger.geofence', 'trigger.becameMobile', 'trigger.leftHome'];
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

// #4340 Phase 3 §5/§6 WP4 — Auto-Ack parity catalog additions: the isDM/viaMqtt
// numeric fields, the node.completeness string field, the in/notIn string
// operators, and the maxAttempts field on action.sendMessage.
describe('Auto-Ack parity catalog additions (#4340 Phase 3)', () => {
  const flatten = (groups: ReturnType<typeof numericFields>) => groups.flatMap((g) => g.options);

  it('EVENT_NUMERIC for trigger.message includes isDM and viaMqtt', () => {
    const values = flatten(numericFields('trigger.message')).map((o) => o.value);
    expect(values).toContain('isDM');
    expect(values).toContain('viaMqtt');
    // #4594 — transport, distinct from the packet's own relay flag above.
    expect(values).toContain('viaMqttSource');
  });

  it('NODE_STRING includes node.completeness', () => {
    const values = flatten(stringFields('trigger.message')).map((o) => o.value);
    expect(values).toContain('node.completeness');
  });

  it('STRING_OP_OPTIONS is exported and includes in / notIn', () => {
    const values = STRING_OP_OPTIONS.map((o) => o.value);
    expect(values).toContain('in');
    expect(values).toContain('notIn');
  });

  describe('action.sendMessage maxAttempts field', () => {
    const sendMessage = ACTIONS.find((a) => a.type === 'action.sendMessage');
    const maxAttemptsField = sendMessage?.fields.find((f) => f.name === 'maxAttempts');

    it('exists as an advanced number field', () => {
      expect(maxAttemptsField).toBeDefined();
      expect(maxAttemptsField?.kind).toBe('number');
      expect(maxAttemptsField?.advanced).toBe(true);
    });

    it('carries showIf exactly { field: "to", truthy: true } — reuses Phase 2\'s operator, no new one', () => {
      expect(maxAttemptsField?.showIf).toEqual({ field: 'to', truthy: true });
    });

    it('is hidden until "to" is set (unset / blank / 0)', () => {
      expect(maxAttemptsField).toBeDefined();
      expect(fieldVisible(maxAttemptsField as FieldDef, {})).toBe(false);
      expect(fieldVisible(maxAttemptsField as FieldDef, { to: '' })).toBe(false);
      expect(fieldVisible(maxAttemptsField as FieldDef, { to: 0 })).toBe(false);
    });

    it('is visible once "to" is set to a token or a node number', () => {
      expect(maxAttemptsField).toBeDefined();
      expect(fieldVisible(maxAttemptsField as FieldDef, { to: '{{ trigger.from }}' })).toBe(true);
      expect(fieldVisible(maxAttemptsField as FieldDef, { to: 123 })).toBe(true);
    });
  });
});

describe("condition.string regex case-sensitivity hint (#4507)", () => {
  const def = CONDITIONS.find((c) => c.type === 'condition.string');
  const valueFields = (def?.fields ?? []).filter((f) => f.name === 'value');

  it('warns on the operator select that casing differs between operators', () => {
    const op = def?.fields.find((f) => f.name === 'op');
    // The evaluator lower-cases both sides for contains/startsWith/endsWith/in
    // but not for eq/neq/regex. Only `help` is rendered for a condition block —
    // its `description` is not — so the note has to live here.
    expect(op?.help).toMatch(/ignore case/i);
    expect(op?.help).toMatch(/case-sensitive/i);
  });

  it('offers the (?i) workaround only on the regex operator', () => {
    const regexValue = valueFields.find((f) => f.showIf?.equals === 'regex');
    expect(regexValue?.help).toMatch(/\(\?i\)/);
    expect(regexValue?.placeholder).toMatch(/\(\?i\)/);
  });

  it('shows exactly one Value input for every operator', () => {
    // Both variants share the param name `value` so a typed value survives an
    // operator switch. That makes overlap a real hazard: two visible fields
    // would render duplicate inputs on a duplicate React key.
    expect(valueFields.length).toBe(2);
    for (const { value: op } of STRING_OP_OPTIONS) {
      const visible = valueFields.filter((f) => fieldVisible(f, { op }));
      expect(visible, `op=${op} should show exactly one Value field`).toHaveLength(1);
    }
    // Freshly-added block, before an operator has been chosen.
    expect(valueFields.filter((f) => fieldVisible(f, {}))).toHaveLength(1);
  });
});

describe("trigger.message regex case-sensitivity hint (#4507 follow-up)", () => {
  const trigger = TRIGGERS.find((t) => t.type === 'trigger.message');
  const field = (n: string) => trigger?.fields.find((f) => f.name === n);

  it('warns that the trigger regex is case-sensitive', () => {
    // The original #4507 fix only covered the `condition.string` block. The
    // trigger's own regex field is the surface most users reach first, and it
    // sits directly under "Text contains", which advertises itself as
    // case-INsensitive — so saying nothing here reads as "same rules".
    expect(field('regex')?.help).toMatch(/case-sensitive/i);
    expect(field('regex')?.help).toMatch(/\(\?i\)/);
    expect(field('regex')?.placeholder).toMatch(/\(\?i\)/);
  });

  it('still describes "Text contains" as case-insensitive', () => {
    // Pins the contrast the new copy draws. If this ever becomes
    // case-sensitive, the regex field's help becomes a lie.
    expect(field('textContains')?.help).toMatch(/case-insensitive/i);
  });
});

describe('movement trigger message hints', () => {
  it('sendMessage and notify use Tolkien placeholders for leftHome / becameMobile', () => {
    const send = ACTIONS.find((a) => a.type === 'action.sendMessage')?.fields.find((f) => f.name === 'text');
    const notify = ACTIONS.find((a) => a.type === 'action.notify')?.fields.find((f) => f.name === 'body');
    expect(send).toBeTruthy();
    expect(notify).toBeTruthy();
    expect(fieldPlaceholder(send!, 'trigger.leftHome')).toBe(
      'A quiet little node {{ node.longName }} has left the Shire and gone off on an unexpected adventure.',
    );
    expect(fieldPlaceholder(send!, 'trigger.becameMobile')).toBe(
      'A wild stationary node {{ node.longName }} just uprooted itself and headed towards Isengard!',
    );
    expect(fieldPlaceholder(notify!, 'trigger.leftHome')).toBe(fieldPlaceholder(send!, 'trigger.leftHome'));
    expect(fieldPlaceholder(notify!, 'trigger.becameMobile')).toBe(fieldPlaceholder(send!, 'trigger.becameMobile'));
    // Other triggers keep the generic default.
    expect(fieldPlaceholder(send!, 'trigger.message')).toBe('Hello {{ trigger.senderLabel }}!');
  });
});
