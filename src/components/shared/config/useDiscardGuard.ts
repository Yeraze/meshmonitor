/**
 * useDiscardGuard — ask before an action throws away unsaved edits (#5829).
 *
 * A list that opens one card at a time wraps "open another card" in `guard`.
 * With no unsaved edits the action runs now; otherwise it waits until the user
 * confirms (`confirmDiscard`) or backs out (`cancelDiscard`). Render
 * `DiscardChangesDialog` while `pending` is true.
 */
import { useCallback, useState } from 'react';

export interface DiscardGuard {
  guard: (action: () => void) => void;
  pending: boolean;
  confirmDiscard: () => void;
  cancelDiscard: () => void;
}

export function useDiscardGuard(dirty: boolean): DiscardGuard {
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const guard = useCallback((action: () => void) => {
    if (dirty) setPendingAction(() => action);
    else action();
  }, [dirty]);

  const confirmDiscard = useCallback(() => {
    const action = pendingAction;
    setPendingAction(null);
    action?.();
  }, [pendingAction]);

  const cancelDiscard = useCallback(() => setPendingAction(null), []);

  return { guard, pending: pendingAction !== null, confirmDiscard, cancelDiscard };
}
