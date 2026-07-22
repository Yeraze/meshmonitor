import { useCallback, useEffect, useRef } from 'react';
import type React from 'react';

/**
 * Accessibility behaviors for mount-rendered dialogs (the `mcpm-*`/`mqpm-*`
 * styled packet/route modals, which render only while open and therefore
 * can't use `common/Modal`'s isOpen-driven variant without restyling).
 *
 * Provides the same contract as `common/Modal.tsx`:
 *   - Escape closes the dialog (document-level listener)
 *   - the content element is focused on mount, and focus is restored to the
 *     previously-focused element on unmount
 *   - Tab / Shift+Tab cycle within the dialog (focus trap)
 *
 * Usage — spread onto the modal *content* element and mark it up as a dialog:
 *   const { contentRef, onKeyDown } = useDialogA11y(onClose);
 *   <div className="mcpm-modal" onClick={onClose} role="presentation">
 *     <div className="mcpm-modal-content" ref={contentRef} role="dialog"
 *          aria-modal="true" tabIndex={-1} onKeyDown={onKeyDown} ...>
 */
export function useDialogA11y(onClose: () => void): {
  contentRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
} {
  const contentRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Focus the dialog on mount; restore the trigger element's focus on unmount.
  // Also lock body scroll while open (same contract as common/Modal).
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    contentRef.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Escape dismisses.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Focus trap — same focusable query as common/Modal.tsx.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !contentRef.current) return;
    const focusable = contentRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  return { contentRef, onKeyDown };
}
