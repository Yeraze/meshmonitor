import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import styles from './NodeDetailsButton.module.css';

export interface NodeDetailsButtonProps {
  /** Opens the node's details (the Messages tab's Node Details block). */
  onOpenDetails: (e: React.MouseEvent) => void;
}

/**
 * The node list's "go to this node's details" control (issue #4379).
 *
 * #4326/#4333 made the unmessageable indicator itself clickable to reach Node
 * Details. That fixed the dead end but created a UX problem: the only
 * interactive element in that strip looked exactly like the inert status icons
 * around it, and hanging navigation off a *messaging* icon misdescribed where
 * it goes — Node Details covers far more than messaging. So the affordance
 * moves here, to a distinct button that every node row gets, sitting in the
 * row's action group rather than among the feature indicators.
 *
 * This mirrors MeshCore's `mc-node-row-details-btn` (`MeshCoreNodesView.tsx`),
 * down to the `forward` arrow, so the two node lists behave the same way.
 *
 * Note it renders as an icon button with a tooltip rather than a text-labeled
 * one — a node row is too narrow for a word. The chrome (border + surface fill
 * + hover) is what carries the "this is a control" signal that the bare glyph
 * in #4333 lacked.
 */
export function NodeDetailsButton({ onOpenDetails }: NodeDetailsButtonProps) {
  const { t } = useTranslation();

  const label = t('nodes.open_details', 'Node details');

  return (
    <button
      type="button"
      className={styles.button}
      data-testid="node-details-button"
      title={label}
      aria-label={label}
      onClick={onOpenDetails}
    >
      <UiIcon name="forward" size={16} />
    </button>
  );
}

export default NodeDetailsButton;
