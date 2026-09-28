import type React from 'react';
import { useDialogA11y } from '../../hooks/useDialogA11y';

interface EmbedDialogContentProps {
  /** Closes the dialog. Called on Escape. */
  onClose: () => void;
  /** Id of the element that titles the dialog (its <h2>). */
  labelledBy: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Dialog box for the Embed settings modals (create/edit profile, embed code).
 *
 * Those modals render only while open, inside a plain `.modal-overlay`, so they
 * get the dialog contract from `useDialogA11y`: Escape closes, focus moves into
 * the dialog on open and back to the trigger on close, and Tab stays inside.
 * Before this, Escape did nothing and screen readers saw a bare div.
 *
 * Clicks inside the box stop here so they never reach the overlay's
 * click-to-close handler.
 */
export function EmbedDialogContent({ onClose, labelledBy, className, children }: EmbedDialogContentProps) {
  const { contentRef, onKeyDown } = useDialogA11y(onClose);
  return (
    <div
      ref={contentRef}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
