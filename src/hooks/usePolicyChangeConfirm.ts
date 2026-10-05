import { useCallback, useEffect, useRef, useState } from 'react';
import { policyChangeConfirmKind } from '../utils/packetSignaturePolicy';
import type { PendingPolicyChange } from '../components/configuration/PacketSignaturePolicyConfirmDialog';

/** Typed when a node has neither a short name nor a fallback to offer. */
export const LAST_RESORT_CONFIRM_WORD = 'STRICT';

export interface PolicyChangeNode {
  /** How the node is named in the dialog. */
  label: string;
  /** The node's short name: the word to type before Strict goes out. */
  shortName: string;
  /** Typed instead when the node has no short name. */
  fallbackWord: string;
}

/**
 * Ask the user before a packet signature policy change goes out (#5612).
 *
 * `confirmPolicyChange(from, to, node)` resolves true when the save may go
 * ahead: at once when the change needs no confirm, otherwise when the user
 * confirms in the dialog. Render `PacketSignaturePolicyConfirmDialog` with the
 * returned `dialogProps`.
 */
export function usePolicyChangeConfirm() {
  const [pending, setPending] = useState<PendingPolicyChange | null>(null);
  const settleRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = settleRef.current;
    settleRef.current = null;
    setPending(null);
    resolve?.(confirmed);
  }, []);

  // An unmount while the dialog is open counts as a cancel.
  useEffect(() => () => {
    settleRef.current?.(false);
    settleRef.current = null;
  }, []);

  const confirmPolicyChange = useCallback(
    (from: number | null, to: number | null, node: PolicyChangeNode): Promise<boolean> => {
      if (to === null || policyChangeConfirmKind(from, to) === 'none') return Promise.resolve(true);
      // A second request replaces the first, which reads as cancelled.
      settleRef.current?.(false);
      return new Promise<boolean>((resolve) => {
        settleRef.current = resolve;
        setPending({
          to,
          nodeLabel: node.label,
          // Never an empty word: that would turn the typed confirm into a
          // plain one.
          confirmWord: node.shortName.trim() || node.fallbackWord.trim() || LAST_RESORT_CONFIRM_WORD,
        });
      });
    },
    [],
  );

  const onConfirm = useCallback(() => settle(true), [settle]);
  const onCancel = useCallback(() => settle(false), [settle]);

  return { confirmPolicyChange, dialogProps: { pending, onConfirm, onCancel } };
}
