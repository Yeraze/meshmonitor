import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';

/**
 * The "this node can't receive DMs" badge shown in the node list's indicator
 * group (issue #4326).
 *
 * It is an inert indicator, exactly like the location / MQTT / telemetry icons
 * beside it. #4333 briefly made it a button that opened Node Details — that
 * fixed a real dead end (unmessageable nodes had no route to their details at
 * all) but did it in the wrong place: it was the one clickable thing in a row
 * of look-alike status icons, and it described the destination as messaging
 * when Node Details covers far more than that. #4379 moved the affordance out
 * to `NodeDetailsButton`, which every node row now gets, so the badge is back
 * to stating a fact and nothing more — it looks inert because it is inert.
 *
 * Messaging itself stays unavailable regardless: MessagesTab hides the
 * composer behind its `dmReadOnlyReason === 'unmessageable'` banner, which
 * also offers the explicit "message anyway" override.
 */
export function NodeUnmessageableBadge() {
  const { t } = useTranslation();

  const label = t(
    'nodes.unmessageable',
    'This node reports itself as unmessageable (router/repeater/sensor) — it cannot receive direct messages'
  );

  return (
    <span
      className="node-indicator-icon"
      data-testid="node-unmessageable-badge"
      title={label}
    >
      <UiIcon name="blocked" size={15} />
    </span>
  );
}

export default NodeUnmessageableBadge;
