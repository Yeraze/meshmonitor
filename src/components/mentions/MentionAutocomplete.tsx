import React from 'react';
import type { MentionCandidate } from '../../utils/mentions';
import styles from './MentionAutocomplete.module.css';

interface MentionAutocompleteProps {
  /** Rows to show. An empty list renders nothing. */
  candidates: readonly MentionCandidate[];
  /** Index of the highlighted row, moved by the arrow keys. */
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (candidate: MentionCandidate) => void;
  /** Ties the composer's textarea to this listbox for screen readers. */
  id: string;
}

/**
 * The `@` suggestion list shown above a composer (#5276).
 *
 * Keyboard handling lives with the textarea that owns the caret, not here: this
 * renders the list and reports clicks. It is presentation only, so the
 * Meshtastic and MeshCore composers can share it while keeping their own
 * mention formats.
 */
const MentionAutocomplete: React.FC<MentionAutocompleteProps> = ({
  candidates,
  activeIndex,
  onHover,
  onSelect,
  id,
}) => {
  if (candidates.length === 0) return null;

  return (
    <div className={styles.popup} id={id} role="listbox" aria-label="Mention suggestions">
      {candidates.map((candidate, index) => (
        // No <li> wrapper: ARIA wants each option to be a direct child of the
        // listbox, and a presentational wrapper between the two leaves screen
        // readers unable to enumerate the list.
        <button
          key={candidate.id}
          type="button"
          role="option"
          id={`${id}-option-${index}`}
          aria-selected={index === activeIndex}
          className={`${styles.option} ${index === activeIndex ? styles.active : ''}`}
          // Mouse down would blur the textarea before the click landed, which
          // loses the caret the insertion needs.
          onMouseDown={e => e.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(candidate)}
        >
          <span className={styles.longName}>{candidate.longName || candidate.id}</span>
          {candidate.shortName && <span className={styles.shortName}>{candidate.shortName}</span>}
          <span className={styles.nodeId}>{candidate.id}</span>
        </button>
      ))}
    </div>
  );
};

export default MentionAutocomplete;
