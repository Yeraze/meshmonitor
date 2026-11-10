import { describe, it, expect } from 'vitest';
import { validateMeshcoreSenderName } from './meshcoreSenderName.js';

describe('validateMeshcoreSenderName', () => {
  it.each([
    ['Bot', 'Bot'],
    ['  Bot  ', 'Bot'],
    ['Zoë', 'Zoë'],
    ['x'.repeat(31), 'x'.repeat(31)],
    ['é'.repeat(15), 'é'.repeat(15)],
  ])('accepts %j', (input, expected) => {
    expect(validateMeshcoreSenderName(input)).toEqual({ ok: true, name: expected });
  });

  it('normalises to NFC', () => {
    const r = validateMeshcoreSenderName('Zoë');
    expect(r).toEqual({ ok: true, name: 'Zoë' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['a:b', 'colon'],
    ['a\nb', 'control'],
    ['a\0b', 'control'],
    ['a\u007Fb', 'control'],
    ['a\u0085b', 'control'],
    ['a​b', 'bidi_or_zero_width'],
    ['a‮b', 'bidi_or_zero_width'],
    ['a⁦b', 'bidi_or_zero_width'],
    ['﻿ab', 'bidi_or_zero_width'],
    ['#region', 'leading_hash'],
    ['x'.repeat(32), 'too_long'],
    ['é'.repeat(16), 'too_long'],
  ])('rejects %j as %s', (input, reason) => {
    expect(validateMeshcoreSenderName(input)).toEqual({ ok: false, reason });
  });

  it('rejects non-strings', () => {
    expect(validateMeshcoreSenderName(5)).toEqual({ ok: false, reason: 'not_string' });
    expect(validateMeshcoreSenderName(undefined)).toEqual({ ok: false, reason: 'not_string' });
  });

  it('allows # that is not leading', () => {
    expect(validateMeshcoreSenderName('a#b').ok).toBe(true);
  });
});
