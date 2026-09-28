import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { MeshCoreFilterMode } from '../../hooks/useMeshCoreFilters';
import styles from './MeshCoreFilters.module.css';

interface MeshCoreIgnoreBlockControlsProps {
  publicKey: string;
  /** The node's current entry mode, or null when it has none. */
  mode: MeshCoreFilterMode | null;
  canWrite: boolean;
  onSet: (mode: MeshCoreFilterMode) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}

/**
 * Node Details: Ignore / Block this node (#5408), or take it off the list.
 * MeshCore firmware has no block, so this only changes what MeshMonitor
 * stores and shows — the node still transmits.
 */
export const MeshCoreIgnoreBlockControls: React.FC<MeshCoreIgnoreBlockControlsProps> = ({
  publicKey,
  mode,
  canWrite,
  onSet,
  onRemove,
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('meshcore.ignore.save_failed', 'Could not save'));
    } finally {
      setBusy(false);
    }
  };

  const handleBlock = () => {
    const confirmText = t(
      'meshcore.ignore.block_confirm',
      'Block this node? Its messages will be dropped on receipt and never stored. You can undo this in MeshCore Settings.',
    );
    if (typeof window !== 'undefined' && !window.confirm(confirmText)) return;
    void run(() => onSet('block'));
  };

  if (!canWrite && !mode) return null;

  return (
    <div className="node-detail-card node-detail-card-2col" data-public-key={publicKey}>
      <div className="node-detail-label">{t('meshcore.ignore.card_label', 'Ignore / Block')}</div>
      <div className={`node-detail-value ${styles.controls}`}>
        {mode && (
          <span className={styles.status} role="status">
            <UiIcon name={mode === 'block' ? 'blocked' : 'muted'} size={14} />{' '}
            {mode === 'block'
              ? t('meshcore.ignore.status_blocked', 'Blocked')
              : t('meshcore.ignore.status_ignored', 'Ignored')}
          </span>
        )}
        {canWrite && !mode && (
          <>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(() => onSet('ignore'))}>
              <UiIcon name="muted" size={14} /> {t('meshcore.ignore.ignore_button', 'Ignore')}
            </button>
            <button type="button" className={`btn-secondary ${styles.danger}`} disabled={busy} onClick={handleBlock}>
              <UiIcon name="blocked" size={14} /> {t('meshcore.ignore.block_button', 'Block')}
            </button>
          </>
        )}
        {canWrite && mode && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(onRemove)}>
            {t('meshcore.ignore.remove_button', 'Remove from ignore/block list')}
          </button>
        )}
        {error && <span className={styles.error} role="alert">{error}</span>}
      </div>
    </div>
  );
};
