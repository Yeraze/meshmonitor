import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DIRECT_SEND_LABEL_FALLBACKS, directSendLabel, directSendLabelKey } from './meshcoreSendLabel';
import type { MeshCoreDirectSend } from '../../utils/deliveryDiagnostics/status';

const en = JSON.parse(readFileSync('public/locales/en.json', 'utf8')) as Record<string, string>;
// Stand-in for i18next: the en.json string, else the fallback, with {{vars}}.
const t = ((key: string, fallback: string, vars: Record<string, unknown> = {}) =>
  (en[key] ?? fallback).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars[k]))) as never;

const KINDS: MeshCoreDirectSend['kind'][] = ['dm', 'room_post'];
const STATES: MeshCoreDirectSend['state'][] = ['sent_to_radio', 'awaiting_ack', 'delivered', 'not_confirmed'];

describe('directSendLabel (#5682)', () => {
  it('has a line for every kind and state, and en.json matches the fallback', () => {
    for (const kind of KINDS) {
      for (const state of STATES) {
        for (const rtt of [undefined, 640]) {
          const key = directSendLabelKey({ kind, state }, rtt);
          expect(DIRECT_SEND_LABEL_FALLBACKS[key], key).toBeTruthy();
          expect(en[`meshcore.send_state.${key}`], key).toBe(DIRECT_SEND_LABEL_FALLBACKS[key]);
        }
      }
    }
  });

  it('prints the round trip only when the radio reported one', () => {
    expect(directSendLabel(t, { kind: 'dm', state: 'delivered' }, 640)).toContain('(640 ms)');
    expect(directSendLabel(t, { kind: 'dm', state: 'delivered' })).not.toMatch(/ms|undefined/);
    expect(directSendLabel(t, { kind: 'room_post', state: 'not_confirmed' }, 640)).not.toContain('640');
  });

  it('claims no more than each state backs', () => {
    for (const kind of KINDS) {
      // Accepted by the radio is not "transmitted", "sent out" or "delivered".
      for (const state of ['sent_to_radio', 'awaiting_ack'] as const) {
        const text = directSendLabel(t, { kind, state });
        expect(text).toMatch(/^Your radio accepted/);
        expect(text).not.toMatch(/delivered|transmitted|was sent/i);
      }
      // No ack is not proof of loss.
      expect(directSendLabel(t, { kind, state: 'not_confirmed' })).toMatch(/may still have arrived/);
      expect(directSendLabel(t, { kind, state: 'not_confirmed' })).not.toMatch(/failed|lost/i);
    }
    // A room server's ack says nothing about readers.
    expect(directSendLabel(t, { kind: 'room_post', state: 'delivered' })).not.toMatch(/read|member|delivered/i);
  });
});
