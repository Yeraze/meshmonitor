import { useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from './icons';
import { useNodeIdentityChanges } from '../hooks/useNodeIdentityChanges';
import { AuthContext } from '../contexts/AuthContext';
import { NodeIdentityMergeDialog } from './NodeIdentityMergeDialog';
import styles from './NodeIdentityChangeNotice.module.css';
import mergeStyles from './NodeIdentityMergeDialog.module.css';

/**
 * The Node Details explanation of a Meshtastic 2.8 node-number change
 * (issue #5032).
 *
 * Where `NodeIdentityChangeBadge` puts one glyph on a list row, this is the
 * long form: which node this one used to be (or became), what the pairing was
 * based on, and where the missing history actually lives.
 *
 * Three deliberate choices:
 *
 * - **It informs; acting takes several more clicks.** Detection never merges
 *   anything. An admin gets a "Merge history" button here, and that button
 *   opens a dry-run preview — the merge itself is behind an explicit
 *   confirmation in `NodeIdentityMergeDialog`. Non-admins see no button at all,
 *   matching the server's admin-only gate.
 * - **It shows its working.** The evidence list states which signals fired, so
 *   a reader can see what the pairing actually rests on rather than trusting a
 *   confidence word.
 * - **It is not a warning.** Renumbering on upgrade is correct firmware
 *   behaviour. The styling is informational, not the red used by the
 *   security blocks elsewhere in Node Details.
 *
 * Self-contained: give it a node number and a source and it renders nothing
 * unless that node is one half of a detected pair. Fetching is shared with the
 * node list through the same TanStack query key, so this costs no extra
 * request.
 */
export interface NodeIdentityChangeNoticeProps {
  nodeNum: number | null | undefined;
  /** The source the node belongs to. Detection never crosses sources. */
  sourceId: string | null | undefined;
}

function formatDuration(seconds: number, t: ReturnType<typeof useTranslation>['t']): string {
  const days = Math.floor(seconds / 86400);
  if (days >= 1) return t('nodes.identity_change_days', '{{count}} days', { count: days });
  const hours = Math.max(1, Math.round(seconds / 3600));
  return t('nodes.identity_change_hours', '{{count}} hours', { count: hours });
}

export function NodeIdentityChangeNotice({ nodeNum, sourceId }: NodeIdentityChangeNoticeProps) {
  const { t } = useTranslation();
  const { bySuccessorNodeNum, byPredecessorNodeNum } = useNodeIdentityChanges(sourceId);
  // The raw context, not `useAuth()`: that hook throws outside an AuthProvider,
  // and this notice renders in places (and tests) that have no auth tree. No
  // provider means no admin, which is the safe default for a merge button.
  const authStatus = useContext(AuthContext)?.authStatus ?? null;
  const [mergeOpen, setMergeOpen] = useState(false);

  if (nodeNum == null) return null;

  // A node can only sensibly be one half of one pair; the successor reading
  // wins when both indexes somehow claim it.
  const asSuccessor = bySuccessorNodeNum.get(nodeNum);
  const detection = asSuccessor ?? byPredecessorNodeNum.get(nodeNum);
  if (!detection) return null;

  // Merging is admin-only on the server. Rendering the button to anyone else
  // would only produce a 403 they cannot act on.
  const canMerge = Boolean(sourceId) && authStatus?.authenticated === true && authStatus.user?.isAdmin === true;

  const role: 'successor' | 'predecessor' = asSuccessor ? 'successor' : 'predecessor';
  const other = role === 'successor' ? detection.predecessor : detection.successor;
  const otherName = other.longName || other.shortName || other.nodeId;

  // Only the two key-verified bases reach the client — the server does not
  // report name-only guesses (see `includeNameBasis`), so there is no
  // "the names matched" copy to write here.
  const basisText =
    detection.basis === 'derivedNodeNum'
      ? t(
          'nodes.identity_change_basis_derived',
          "The old node's public key produces exactly this node's number, which is how Meshtastic 2.8 assigns them. This pairing is verified, not guessed.",
        )
      : t(
          'nodes.identity_change_basis_key',
          'Both nodes present the same public key, and a node keeps its key across the 2.8 upgrade.',
        );

  return (
    <div className={styles.notice} data-testid="node-identity-change-notice" data-role={role}>
      <div className={styles.header}>
        <UiIcon name="identity" size={16} />
        {t('nodes.identity_change_title', 'Node number changed (Meshtastic 2.8)')}
      </div>
      <div className={styles.body}>
        <p>
          {role === 'successor'
            ? t(
                'nodes.identity_change_detail_successor',
                'This node is likely the same physical node as {{name}} ({{nodeId}}), which fell silent {{quiet}} ago. Meshtastic 2.8 derives node numbers from the public key instead of the hardware MAC address, so an upgraded node reappears under a new number.',
                { name: otherName, nodeId: other.nodeId, quiet: formatDuration(detection.predecessorQuietForSeconds, t) },
              )
            : t(
                'nodes.identity_change_detail_predecessor',
                'This node has likely continued as {{name}} ({{nodeId}}) since upgrading to Meshtastic 2.8, which derives node numbers from the public key instead of the hardware MAC address. That is why this entry stopped reporting {{quiet}} ago.',
                { name: otherName, nodeId: other.nodeId, quiet: formatDuration(detection.predecessorQuietForSeconds, t) },
              )}
        </p>
        <p>
          {canMerge
            ? t(
                'nodes.identity_change_history_admin',
                'Telemetry, positions and packet history recorded before the change stay under {{oldNodeId}}. Nothing moves on its own — an admin can merge the two entries below, after reviewing exactly what would change.',
                { oldNodeId: detection.predecessor.nodeId },
              )
            : t(
                'nodes.identity_change_history',
                'Telemetry, positions and packet history recorded before the change stay under {{oldNodeId}}. MeshMonitor does not move them: the two entries remain separate.',
                { oldNodeId: detection.predecessor.nodeId },
              )}
        </p>
        <ul className={styles.facts}>
          <li>{basisText}</li>
          {detection.successorFirmwareIs28OrLater && detection.successor.firmwareVersion && (
            <li>
              {t('nodes.identity_change_fact_firmware', 'The new entry reports firmware {{version}}.', {
                version: detection.successor.firmwareVersion,
              })}
            </li>
          )}
          {detection.hwModelMatches && (
            <li>{t('nodes.identity_change_fact_hw', 'Both entries report the same hardware model.')}</li>
          )}
          {detection.nameMatches && (
            <li>{t('nodes.identity_change_fact_name', 'Both entries carry the same long and short name.')}</li>
          )}
          {detection.otherCandidateCount > 0 && (
            <li>
              {t(
                'nodes.identity_change_fact_ambiguous',
                '{{count}} other node also matched, so this pairing is not the only possibility.',
                { count: detection.otherCandidateCount },
              )}
            </li>
          )}
        </ul>
        <div className={styles.caveat}>
          {t(
            'nodes.identity_change_caveat',
            'Nothing has been merged, moved or deleted. This is an observation.',
          )}
        </div>
        {canMerge && (
          <button
            type="button"
            className={mergeStyles.launchButton}
            onClick={() => setMergeOpen(true)}
            data-testid="node-identity-merge-open"
          >
            <UiIcon name="link" size={14} />
            {t('nodes.identity_change_merge_button', 'Merge history…')}
          </button>
        )}
      </div>
      {mergeOpen && sourceId && (
        <NodeIdentityMergeDialog
          sourceId={sourceId}
          fromNodeNum={detection.predecessor.nodeNum}
          toNodeNum={detection.successor.nodeNum}
          fromLabel={
            detection.predecessor.longName || detection.predecessor.shortName || detection.predecessor.nodeId
          }
          toLabel={detection.successor.longName || detection.successor.shortName || detection.successor.nodeId}
          onClose={() => setMergeOpen(false)}
        />
      )}
    </div>
  );
}

export default NodeIdentityChangeNotice;
