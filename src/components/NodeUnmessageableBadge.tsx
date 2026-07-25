import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import styles from './NodeUnmessageableBadge.module.css';

export interface NodeUnmessageableBadgeProps {
  /** Opens the node's details (the Messages tab's Node Details block). */
  onOpenDetails: (e: React.MouseEvent) => void;
}

/**
 * The "this node can't receive DMs" badge shown in the node list in place of
 * the Send-DM button (issue #4326).
 *
 * It used to be an inert `<span>`, which made the node list a dead end for
 * unmessageable nodes: no DM button, no details link, nothing. It is now a
 * button that reaches Node Details, matching what the map popup's "More
 * Details" action has always done for these nodes — that popup has never
 * gated on messageability. Messaging itself stays unavailable: MessagesTab
 * hides the composer behind its `dmReadOnlyReason === 'unmessageable'`
 * banner, which also offers the explicit "message anyway" override.
 *
 * The long explanatory sentence reuses the pre-existing (already translated)
 * `nodes.unmessageable` string, with the new affordance appended as its own
 * short key.
 */
export function NodeUnmessageableBadge({ onOpenDetails }: NodeUnmessageableBadgeProps) {
  const { t } = useTranslation();

  const label = `${t(
    'nodes.unmessageable',
    'This node reports itself as unmessageable (router/repeater/sensor) — it cannot receive direct messages'
  )}. ${t('nodes.unmessageable_open_details', 'Click to open its details.')}`;

  return (
    <button
      type="button"
      className={styles.badge}
      data-testid="node-unmessageable-badge"
      title={label}
      aria-label={label}
      onClick={onOpenDetails}
    >
      <UiIcon name="blocked" size={16} />
    </button>
  );
}

export default NodeUnmessageableBadge;
