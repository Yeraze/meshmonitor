/**
 * Cross-template hard guarantee (Automation Template Gallery, Phase 3): every
 * template in TEMPLATES must produce a `validateAutomationGraph`-valid graph
 * for EVERY reachable combination of its own param values — not just the
 * defaults. Generic over `AutomationTemplate.params` (declarative FieldDef[])
 * so a future template is covered automatically without editing this file.
 */
import { describe, it, expect } from 'vitest';
import { TEMPLATES } from './index';
import { validateAutomationGraph } from '../../../types/automation';
import type { BuiltAutomation } from './types';
import type { FieldDef } from '../catalog';

// A representative value per FieldKind — the shapes AutomationBuilder.tsx's
// FieldInput actually stores (see AutomationBuilder.tsx's onChange calls per
// `case` in the field-kind switch). Each list always includes the "blank"
// value first so "nothing configured" is always part of the matrix.
const SAMPLE_SOURCE_IDS: unknown[] = [[], ['source-a'], ['source-a', 'source-b']];
const SAMPLE_CHANNEL_SELECTIONS: unknown[] = [
  [],
  [{ name: 'general' }],
  [{ name: 'gauntlet', protocol: 'meshtastic' }, { name: 'gauntlet', protocol: 'meshcore' }],
];
const SAMPLE_NODE_MULTI: unknown[] = [[], [1234567890]];
const SAMPLE_TEXT: unknown[] = ['', 'sample'];
const SAMPLE_NUMBER: unknown[] = ['', '5'];
const SAMPLE_CHECKBOX: unknown[] = [false, true];

function candidatesFor(field: FieldDef): unknown[] {
  switch (field.kind) {
    case 'select':
    case 'fieldselect':
      // Every declared option, so each branch a template keys off of is exercised.
      return (field.options ?? field.groups?.flatMap((g) => g.options) ?? ['']).map((o) => o.value);
    case 'checkbox':
      return SAMPLE_CHECKBOX;
    case 'sourceMulti':
    case 'sendSourceMulti':
      return SAMPLE_SOURCE_IDS;
    case 'channelMulti':
      return SAMPLE_CHANNEL_SELECTIONS;
    case 'nodeMulti':
      return SAMPLE_NODE_MULTI;
    case 'number':
      return SAMPLE_NUMBER;
    // text / textarea / variable / emoji / geofence / scriptselect / regionSelect:
    // free-form strings are the common denominator every one of these can accept.
    default:
      return SAMPLE_TEXT;
  }
}

/**
 * Cartesian product of every param's candidate values, one settings object per
 * row. Capped so a future template with many multi-valued fields can't make
 * the suite explode — still thorough for the handful of params any one
 * template declares today.
 */
function paramMatrix(params: FieldDef[], cap = 500): Array<Record<string, unknown>> {
  let rows: Array<Record<string, unknown>> = [{}];
  for (const field of params) {
    const values = candidatesFor(field);
    const next: Array<Record<string, unknown>> = [];
    outer: for (const row of rows) {
      for (const v of values) {
        next.push({ ...row, [field.name]: v });
        if (next.length >= cap) break outer;
      }
    }
    rows = next;
  }
  return rows;
}

function toArray(built: BuiltAutomation | BuiltAutomation[]): BuiltAutomation[] {
  return Array.isArray(built) ? built : [built];
}

describe('template catalog integrity', () => {
  it('TEMPLATES is non-empty', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
  });

  for (const template of TEMPLATES) {
    describe(`template "${template.id}"`, () => {
      it('has well-formed metadata', () => {
        expect(template.id).toBeTruthy();
        expect(template.name).toBeTruthy();
        expect(template.description).toBeTruthy();
        expect(template.icon).toBeTruthy();
        expect(Array.isArray(template.tags)).toBe(true);
        expect(Array.isArray(template.params)).toBe(true);
      });

      const matrix = paramMatrix(template.params);

      it('the param permutation matrix is non-empty', () => {
        expect(matrix.length).toBeGreaterThan(0);
      });

      matrix.forEach((values, i) => {
        it(`build() output validates for permutation #${i} (${JSON.stringify(values)})`, () => {
          const built = toArray(template.build(values));
          expect(built.length).toBeGreaterThan(0);
          for (const automation of built) {
            expect(automation.name, 'BuiltAutomation.name must be non-empty').toBeTruthy();
            expect(automation.description, 'BuiltAutomation.description must be non-empty').toBeTruthy();
            const result = validateAutomationGraph(automation.config);
            expect(result.valid, `values=${JSON.stringify(values)} errors=${JSON.stringify(result.errors)}`).toBe(true);
          }
        });
      });
    });
  }
});
