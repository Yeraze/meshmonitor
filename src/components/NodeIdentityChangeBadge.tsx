import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import type { IdentityChangeDetection } from '../types/nodeIdentityChange';

/**
 * The "this node's number changed on the Meshtastic 2.8 upgrade" badge, shown
 * in the node list's indicator group (issue #5032).
 *
 * 2.8 derives a node's number from its public key rather than its MAC address,
 * so an upgrading node reappears as a brand-new node while its telemetry,
 * positions and packet history stay under the old number. Two rows with the
 * same long name then sit in the list looking like a bug.
 *
 * **Non-alarming by design.** This is not a warning: nothing is broken and no
 * action is required. It sits with the location / MQTT / telemetry indicators
 * and states a fact, in the same inert `<span>` form as
 * `NodeIncompleteBadge` — deliberately not a button, because the detector must
 * never be one click away from merging two nodes' histories. A `name`-basis
 * match in particular is a guess: two genuinely different nodes can share a
 * name, so the copy says "likely", never "is".
 *
 * Rendered on both halves of a pair, with the wording flipped: the new node
 * says where it came from, the silent old node says where its traffic went.
 */
export interface NodeIdentityChangeBadgeProps {
  detection: IdentityChangeDetection;
  /**
   * Which half of the pair this row is. `successor` = the new number,
   * `predecessor` = the old one that fell silent.
   */
  role: 'successor' | 'predecessor';
}

export function NodeIdentityChangeBadge({ detection, role }: NodeIdentityChangeBadgeProps) {
  const { t } = useTranslation();

  const other = role === 'successor' ? detection.predecessor : detection.successor;
  const otherName = other.longName || other.shortName || other.nodeId;

  // A CRC-verified match is the firmware's own rule applied to the stored key,
  // so it can be stated plainly. A name match is a guess and must read like one.
  const certainty =
    detection.confidence === 'high'
      ? t('nodes.identity_change_certain', 'Confirmed by the node\'s public key.')
      : t('nodes.identity_change_likely', 'Matched on name only — please verify before relying on it.');

  const label =
    role === 'successor'
      ? t(
          'nodes.identity_change_successor',
          'Node number changed: this is likely the node previously known as {{name}} ({{nodeId}}). Meshtastic 2.8 derives node numbers from the public key, so history before the upgrade stays under the old number. {{certainty}}',
          { name: otherName, nodeId: other.nodeId, certainty },
        )
      : t(
          'nodes.identity_change_predecessor',
          'Node number changed: this node has likely continued as {{name}} ({{nodeId}}) since upgrading to Meshtastic 2.8. Its history stays here, under the old number. {{certainty}}',
          { name: otherName, nodeId: other.nodeId, certainty },
        );

  return (
    <span
      className="node-indicator-icon"
      data-testid="node-identity-change-badge"
      data-role={role}
      title={label}
      aria-label={label}
    >
      <UiIcon name="identity" size={15} />
    </span>
  );
}

export default NodeIdentityChangeBadge;
