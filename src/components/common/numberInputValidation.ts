/**
 * Pure validation for `NumberInput` (#5649).
 *
 * Kept apart from the component so it can be tested without a DOM: jsdom
 * sanitises a `type="number"` value, so half-typed text such as "-" or "1."
 * never reaches a change handler there.
 */

export type NumberDraftReason = 'required' | 'notANumber' | 'integer' | 'min' | 'max' | 'range';

export interface NumberDraftRules {
  min?: number;
  max?: number;
  /** Only whole numbers are valid. */
  integer?: boolean;
  /** Blank is a legal value: it evaluates to `null`, not to an error. */
  allowEmpty?: boolean;
}

export type NumberDraftResult =
  | { valid: true; value: number | null }
  | { valid: false; reason: NumberDraftReason };

/** Text shown for a value from the parent. A missing or non-finite value shows blank. */
export function formatNumberDraft(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/**
 * Judge the text in the field.
 *
 * `badInput` is the browser's `validity.badInput`: a number input reports an
 * empty string for text it cannot parse ("-", "1e"), so the flag is the only
 * way to tell "half-typed" from "blank".
 */
export function evaluateNumberDraft(
  text: string,
  rules: NumberDraftRules = {},
  badInput = false,
): NumberDraftResult {
  const trimmed = text.trim();
  if (badInput) return { valid: false, reason: 'notANumber' };
  if (trimmed === '') {
    return rules.allowEmpty ? { valid: true, value: null } : { valid: false, reason: 'required' };
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { valid: false, reason: 'notANumber' };
  if (rules.integer && !Number.isInteger(value)) return { valid: false, reason: 'integer' };

  const { min, max } = rules;
  const belowMin = typeof min === 'number' && value < min;
  const aboveMax = typeof max === 'number' && value > max;
  if (belowMin || aboveMax) {
    if (typeof min === 'number' && typeof max === 'number') return { valid: false, reason: 'range' };
    return { valid: false, reason: belowMin ? 'min' : 'max' };
  }

  return { valid: true, value };
}
