import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';

/**
 * The "we haven't received this node's NODEINFO yet" badge, shown in the node
 * list's indicator group (issue #4720, feature-parity tracker #4718 item H).
 *
 * MeshMonitor already *knew* which nodes were incomplete — `isNodeComplete()`
 * has long driven the `showIncompleteNodes` filter — but when such a node was
 * on screen nothing marked it as partial. The only visible difference was a
 * "Copy NodeInfo" action gated on `nodes:write`, so a read-only user saw a node
 * that looked fully synced and simply had a blank-ish name.
 *
 * Inert by design, like the location / MQTT / telemetry icons beside it: it
 * states a fact. The remedy (copying NodeInfo from another source) stays in the
 * action group, still permission-gated — see `NodeUnmessageableBadge` for the
 * same facts-left / actions-right split introduced by #4379.
 */
export function NodeIncompleteBadge() {
  const { t } = useTranslation();

  const label = t(
    'nodes.incomplete_badge',
    'Incomplete — no NodeInfo received yet, so this node is missing its name or hardware info'
  );

  return (
    <span
      className="node-indicator-icon"
      data-testid="node-incomplete-badge"
      title={label}
      aria-label={label}
    >
      <UiIcon name="help" size={15} />
    </span>
  );
}

export default NodeIncompleteBadge;
