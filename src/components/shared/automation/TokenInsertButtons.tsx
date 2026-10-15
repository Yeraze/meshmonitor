/**
 * TokenInsertButtons — a row of "+ {TOKEN}" buttons under a message
 * template (#5816). Shared by the Meshtastic and MeshCore Auto Announce
 * sections. The caller owns the textarea and the insert (caret position,
 * state update); this component only lists the tokens.
 */
import React from 'react';
import styles from './TokenInsertButtons.module.css';

export interface TokenInsertButtonsProps {
  tokens: readonly string[];
  onInsert: (token: string) => void;
  disabled?: boolean;
  className?: string;
}

export const TokenInsertButtons: React.FC<TokenInsertButtonsProps> = ({
  tokens,
  onInsert,
  disabled = false,
  className,
}) => (
  <div className={className ? `${styles.row} ${className}` : styles.row}>
    {tokens.map((token) => (
      <button
        key={token}
        type="button"
        className={styles.button}
        onClick={() => onInsert(token)}
        disabled={disabled}
      >
        {`+ ${token}`}
      </button>
    ))}
  </div>
);

export default TokenInsertButtons;
