/**
 * Form-level validity for `NumberInput` fields (#5649).
 *
 * A `NumberInput` never hands its parent a blank or out-of-range value: while
 * the text is invalid the parent keeps the last valid number. So a form cannot
 * tell from its own state that a field is red. The scope closes that gap:
 *
 *   const numbers = useNumberInputScope();
 *   ...
 *   <NumberInputScope scope={numbers}>
 *     <NumberInput ... />
 *     <button disabled={numbers.invalid} onClick={save}>Save</button>
 *   </NumberInputScope>
 *
 * Every enabled field under the scope reports to it. `invalid` is true while
 * any of them holds invalid text. `reset()` makes every field drop its text
 * and show the parent's value again: call it from Reset / Dismiss / Cancel,
 * because the parent's value did not change and the field cannot see the reset.
 *
 * Scopes nest: an inner scope also reports to the outer one, and an outer
 * `reset()` reaches the inner fields.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface NumberInputScopeContextValue {
  /** Record one field's (or one inner scope's) validity. */
  report: (id: string, invalid: boolean) => void;
  /** Changes each time the fields must drop their drafts. */
  resetSignal: number;
}

export const NumberInputScopeContext = createContext<NumberInputScopeContextValue | null>(null);

export interface NumberInputScopeHandle {
  /** True while any enabled field under the scope holds invalid text. */
  invalid: boolean;
  /** Make every field under the scope show its parent's value again. */
  reset: () => void;
  /** For `<NumberInputScope>` only. */
  context: NumberInputScopeContextValue;
}

const NO_FIELDS: ReadonlySet<string> = new Set();

export function useNumberInputScope(): NumberInputScopeHandle {
  const [invalidIds, setInvalidIds] = useState<ReadonlySet<string>>(NO_FIELDS);
  const [resetSignal, setResetSignal] = useState(0);

  const report = useCallback((id: string, invalid: boolean) => {
    setInvalidIds(prev => {
      if (prev.has(id) === invalid) return prev;
      const next = new Set(prev);
      if (invalid) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const reset = useCallback(() => setResetSignal(n => n + 1), []);

  const context = useMemo(() => ({ report, resetSignal }), [report, resetSignal]);
  const invalid = invalidIds.size > 0;

  return useMemo(() => ({ invalid, reset, context }), [invalid, reset, context]);
}

/** The scope a field reports to, or null when no form wraps it. */
export function useEnclosingNumberInputScope(): NumberInputScopeContextValue | null {
  return useContext(NumberInputScopeContext);
}
