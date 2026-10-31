/**
 * MeshCoreNodePurgeSection — danger-zone action on the Device Configuration
 * tab that deletes every non-favourite MeshCore node from MeshMonitor's
 * database for this source (#6041).
 *
 * This touches MeshMonitor's stored node rows only — NOT the radio's own
 * contact table (that is the separate "Remove non-favourite contacts" action
 * on the Radio contact list). A favourite is the device-starred contact
 * (`isFavorite`, synced to the radio's flags & 0x01): favourites are kept,
 * everything else for this source is deleted.
 *
 * The confirm dialog shows the count it will delete, fetched the moment the
 * button is pressed, so the user commits to a real number. Gated on
 * `nodes:write` for this source (the server enforces the same); a viewer
 * without it gets the button disabled, with the reason as its tooltip.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService, { ApiError } from '../../services/api';
import { useToast } from '../ToastContainer';
import { DangerZone, DangerZoneActions, DangerZoneButton } from '../shared/config/DangerZone';
import { ConfirmDialog } from '../shared/automation/ConfirmDialog';

export interface MeshCoreNodePurgeSectionProps {
  /** Source UUID — scopes every request. */
  sourceId: string;
  /** `nodes:write` on this source: without it the button is disabled. */
  canWriteNodes: boolean;
  /** Called after a successful purge so a parent can refresh its node list. */
  onPurged?: () => void;
}

interface PreviewResponse {
  success: boolean;
  data: { count: number };
}

interface PurgeResponse {
  success: boolean;
  data: { deleted: number };
}

export const MeshCoreNodePurgeSection: React.FC<MeshCoreNodePurgeSectionProps> = ({
  sourceId,
  canWriteNodes,
  onPurged,
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const prefix = `/api/sources/${encodeURIComponent(sourceId)}/meshcore`;

  const [count, setCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [purging, setPurging] = useState(false);

  const needsNodesWrite = t(
    'meshcore.node_purge.needs_nodes_write',
    'This needs the Nodes write permission on this source.',
  );

  const describeError = (error: unknown): string =>
    error instanceof ApiError && error.message
      ? error.message
      : t('meshcore.node_purge.failed', 'Failed to purge nodes');

  const handleOpen = async () => {
    if (loadingCount || purging) return;
    setLoadingCount(true);
    try {
      const res = await apiService.get<PreviewResponse>(`${prefix}/nodes/purge-non-favourites/preview`);
      const n = res.data.count;
      if (n <= 0) {
        showToast(
          t('meshcore.node_purge.none', 'No non-favourite nodes to delete.'),
          'info',
        );
        return;
      }
      setCount(n);
      setConfirmOpen(true);
    } catch (error) {
      showToast(describeError(error), 'error');
    } finally {
      setLoadingCount(false);
    }
  };

  const handleCancel = () => {
    setConfirmOpen(false);
    setCount(null);
  };

  const handleConfirm = async () => {
    if (purging) return;
    setPurging(true);
    try {
      const res = await apiService.post<PurgeResponse>(`${prefix}/nodes/purge-non-favourites`);
      const deleted = res.data.deleted;
      showToast(
        t('meshcore.node_purge.done', 'Deleted {{count}} non-favourite nodes.', { count: deleted }),
        'success',
      );
      setConfirmOpen(false);
      setCount(null);
      onPurged?.();
    } catch (error) {
      showToast(describeError(error), 'error');
    } finally {
      setPurging(false);
    }
  };

  return (
    <div id="meshcore-node-purge">
      <DangerZone
        title={t('meshcore.node_purge.title', 'Node database')}
        description={t(
          'meshcore.node_purge.description',
          'Remove stored nodes from MeshMonitor for this source. The radio and its contact list are not touched.',
        )}
        canWrite={canWriteNodes}
      >
        <DangerZoneActions>
          <DangerZoneButton
            onClick={() => void handleOpen()}
            disabled={!canWriteNodes || loadingCount || purging}
            title={!canWriteNodes ? needsNodesWrite : undefined}
            data-testid="meshcore-purge-non-favourites-button"
          >
            {loadingCount
              ? t('meshcore.node_purge.checking', 'Checking…')
              : t('meshcore.node_purge.button', 'Purge non-favourite nodes')}
          </DangerZoneButton>
        </DangerZoneActions>

        {confirmOpen && count !== null && (
          <ConfirmDialog
            title={t('meshcore.node_purge.dialog_title', 'Purge non-favourite nodes?')}
            message={t(
              'meshcore.node_purge.dialog_message',
              'This permanently deletes {{count}} non-favourite nodes from MeshMonitor for this source. Favourites are kept, and the radio is not changed.',
              { count },
            )}
            confirmLabel={
              purging
                ? t('meshcore.node_purge.purging', 'Purging…')
                : t('meshcore.node_purge.confirm', 'Delete {{count}} nodes', { count })
            }
            cancelLabel={t('common.cancel', 'Cancel')}
            onConfirm={() => { void handleConfirm(); }}
            onCancel={handleCancel}
          />
        )}
      </DangerZone>
    </div>
  );
};

export default MeshCoreNodePurgeSection;
