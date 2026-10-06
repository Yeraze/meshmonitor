import React, { useEffect, useId, useMemo } from 'react';
import {
  NumberInputScopeContext,
  useEnclosingNumberInputScope,
  type NumberInputScopeHandle,
} from './numberInputScope';

interface NumberInputScopeProps {
  scope: NumberInputScopeHandle;
  children: React.ReactNode;
}

/**
 * Binds the `NumberInput` fields below it to a `useNumberInputScope()` handle.
 * See `numberInputScope.ts` for the contract.
 */
export const NumberInputScope: React.FC<NumberInputScopeProps> = ({ scope, children }) => {
  const outer = useEnclosingNumberInputScope();
  const id = useId();
  const outerReport = outer?.report;
  const outerReset = outer?.resetSignal ?? 0;

  // An invalid field in an inner scope also blocks the outer form.
  useEffect(() => {
    if (!outerReport) return;
    outerReport(id, scope.invalid);
    return () => outerReport(id, false);
  }, [outerReport, id, scope.invalid]);

  const { report, resetSignal } = scope.context;
  const value = useMemo(
    () => ({ report, resetSignal: resetSignal + outerReset }),
    [report, resetSignal, outerReset],
  );

  return <NumberInputScopeContext.Provider value={value}>{children}</NumberInputScopeContext.Provider>;
};

export default NumberInputScope;
