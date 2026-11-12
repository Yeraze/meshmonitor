/**
 * Meshtastic "Connection Error" banner shown above every tab while the source
 * cannot reach its node.
 *
 * Extracted from App.tsx for #4173 review N10: at 844x390 the desktop layout
 * (heading, two-line message, button row, 1.5rem padding) took ~200 of the
 * 390px height. The module compacts it on short landscape screens. The global
 * `.error-panel` classes stay on the elements for their base look.
 */
import React from 'react';
import styles from './ConnectionErrorPanel.module.css';

interface ConnectionErrorPanelProps {
  error: string;
  onRetry: () => void;
  onDismiss: () => void;
}

const ConnectionErrorPanel: React.FC<ConnectionErrorPanelProps> = ({ error, onRetry, onDismiss }) => (
  <div className={`error-panel ${styles.panel}`}>
    <h3 className={styles.title}>Connection Error</h3>
    <p className={styles.message}>{error}</p>
    <div className={`error-actions ${styles.actions}`}>
      <button onClick={onRetry} className="retry-btn">
        Retry Connection
      </button>
      <button onClick={onDismiss} className="dismiss-error">
        Dismiss
      </button>
    </div>
  </div>
);

export default ConnectionErrorPanel;
