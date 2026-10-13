import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactionChip } from './meshcoreReactionGroups';
import styles from './MeshCoreReactionChips.module.css';

interface MeshCoreReactionChipsProps {
  chips: ReactionChip[];
  /** React with the same emoji. When given, chips we did not send are buttons. */
  onAdd?: (emoji: string) => void;
}

/** Reactions to one message, one chip per emoji (#5759). */
export const MeshCoreReactionChips: React.FC<MeshCoreReactionChipsProps> = ({ chips, onAdd }) => {
  const { t } = useTranslation();
  if (chips.length === 0) return null;
  return (
    <div className={styles.reactions}>
      {chips.map(chip => {
        const tooltip = t('meshcore.reactions.chip_tooltip', '{{emoji}} {{names}}', {
          emoji: chip.emoji,
          names: chip.reactors.join(', '),
        });
        const body = (
          <>
            {/* content emoji from the wire, #5759 */}
            {chip.emoji}
            {chip.count > 1 && <span className={styles.count}>{chip.count}</span>}
          </>
        );
        if (!chip.mine && onAdd) {
          const addTooltip = t('meshcore.reactions.chip_add_tooltip', 'React with {{emoji}}', { emoji: chip.emoji });
          return (
            <button
              key={chip.emoji}
              type="button"
              className={`${styles.chip} ${styles.chipButton}`}
              title={`${tooltip}\n${addTooltip}`}
              aria-label={addTooltip}
              data-testid="mc-reaction-chip"
              onClick={() => onAdd(chip.emoji)}
            >
              {body}
            </button>
          );
        }
        const cls = [styles.chip, chip.mine ? styles.mine : '', chip.pending ? styles.pending : '']
          .filter(Boolean)
          .join(' ');
        return (
          <span
            key={chip.emoji}
            className={cls}
            title={tooltip}
            aria-label={tooltip}
            data-testid="mc-reaction-chip"
            data-mine={chip.mine ? 'true' : undefined}
          >
            {body}
          </span>
        );
      })}
    </div>
  );
};

interface MeshCoreUnmatchedReactionProps {
  name: string;
  emoji: string;
  rawText?: string | null;
}

/**
 * A reaction whose target this source has not seen (#5759): one dim line in
 * place of a bubble. It becomes a chip if the target turns up later.
 */
export const MeshCoreUnmatchedReaction: React.FC<MeshCoreUnmatchedReactionProps> = ({ name, emoji, rawText }) => {
  const { t } = useTranslation();
  return (
    <div
      className={styles.unmatched}
      data-testid="mc-reaction-unmatched"
      title={rawText ? t('meshcore.reactions.raw_text', 'Original text: {{text}}', { text: rawText }) : undefined}
    >
      {/* content emoji from the wire, #5759 */}
      {t('meshcore.reactions.unmatched', '{{name}} reacted {{emoji}} to a message not seen here', { name, emoji })}
    </div>
  );
};
