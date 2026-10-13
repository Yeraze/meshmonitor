import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactionChip } from './meshcoreReactionGroups';
import styles from './MeshCoreReactionChips.module.css';

interface MeshCoreReactionChipsProps {
  chips: ReactionChip[];
}

/** Reactions to one message, one chip per emoji (#5759). */
export const MeshCoreReactionChips: React.FC<MeshCoreReactionChipsProps> = ({ chips }) => {
  const { t } = useTranslation();
  if (chips.length === 0) return null;
  return (
    <div className={styles.reactions}>
      {chips.map(chip => {
        const tooltip = t('meshcore.reactions.chip_tooltip', '{{emoji}} {{names}}', {
          emoji: chip.emoji,
          names: chip.reactors.join(', '),
        });
        return (
          <span
            key={chip.emoji}
            className={styles.chip}
            title={tooltip}
            aria-label={tooltip}
            data-testid="mc-reaction-chip"
          >
            {/* content emoji from the wire, #5759 */}
            {chip.emoji}
            {chip.count > 1 && <span className={styles.count}>{chip.count}</span>}
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
