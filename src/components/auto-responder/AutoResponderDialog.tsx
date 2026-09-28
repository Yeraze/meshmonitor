import React from 'react';
import { useDialogA11y } from '../../hooks/useDialogA11y';

interface AutoResponderDialogProps {
  /** Runs on Escape, the × button and Cancel alike, so all three clean up the same way. */
  onClose: () => void;
  /** Id of the heading that names the dialog. */
  labelledBy?: string;
  /** Overlay colour; the section's dialogs used 0.7, the trigger row's 0.5. */
  backdrop?: string;
  children: React.ReactNode;
}

/**
 * Overlay + panel for the Auto Responder's small confirm/import dialogs
 * (Import Script, Export Scripts, Delete Script, Remove Trigger).
 *
 * They were inline `{show && (<div style={{ position: 'fixed' … }}>)}` blocks
 * that only closed from their buttons, so Escape did nothing. Render this only
 * while open; it takes Escape, focus handling and the focus trap from the
 * shared useDialogA11y hook.
 */
const AutoResponderDialog: React.FC<AutoResponderDialogProps> = ({ onClose, labelledBy, backdrop = 'rgba(0, 0, 0, 0.7)', children }) => {
  const { contentRef, onKeyDown } = useDialogA11y(onClose);

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: backdrop,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000
      }}
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          background: 'var(--color-bg)',
          borderRadius: '8px',
          padding: '1.5rem',
          maxWidth: '500px',
          width: '90%',
          border: '1px solid var(--color-border-subtle)'
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default AutoResponderDialog;
