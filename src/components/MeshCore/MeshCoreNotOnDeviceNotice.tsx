/**
 * MeshCoreNotOnDeviceNotice (#5349).
 *
 * MeshCore companion radios log in to, query, and message a node only if it
 * is in the radio's OWN contact list. MeshMonitor can know about nodes the
 * radio does not hold (heard via an advert the radio chose not to store, or
 * evicted when its list filled up). For those, this notice explains why
 * login / status / CLI are unavailable and offers "Add to radio" — a local
 * write over the serial/TCP link, nothing is transmitted.
 *
 * When the radio's list is full the server answers
 * CONTACT_TABLE_FULL_CONFIRM; we ask the user before retrying with
 * `confirmFull`. The server never lets a favourite be evicted.
 *
 * Mount with `key={publicKey}` so per-contact state resets on selection.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { AddContactToDeviceResponse } from './hooks/useMeshCore';
import styles from './MeshCoreNotOnDeviceNotice.module.css';

interface MeshCoreNotOnDeviceNoticeProps {
  publicKey: string;
  /** Adds the node to the radio. Unset hides the button (read-only views). */
  onAddToDevice?: (publicKey: string, confirmFull?: boolean) => Promise<AddContactToDeviceResponse>;
  /** User may edit this source's nodes AND the source is a Companion. */
  canAdd: boolean;
}

export const MeshCoreNotOnDeviceNotice: React.FC<MeshCoreNotOnDeviceNoticeProps> = ({
  publicKey,
  onAddToDevice,
  canAdd,
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const handleAdd = async () => {
    if (!onAddToDevice || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      let result = await onAddToDevice(publicKey, false);
      if (!result.success && result.code === 'CONTACT_TABLE_FULL_CONFIRM') {
        const question = `${result.error ?? t(
          'meshcore.not_on_device.full_confirm',
          "The radio's contact list is full. Adding may replace the oldest non-favourite contact.",
        )}\n\n${t('meshcore.not_on_device.full_confirm_question', 'Favourites are never replaced. Add anyway?')}`;
        if (typeof window === 'undefined' || !window.confirm(question)) return;
        result = await onAddToDevice(publicKey, true);
      }
      if (!result.success) {
        setError(result.error || t('meshcore.not_on_device.add_failed', 'Could not add the node to the radio.'));
        return;
      }
      const evicted = result.evicted?.length ?? 0;
      setDone(
        evicted > 0
          ? t('meshcore.not_on_device.added_with_eviction', {
              count: evicted,
              defaultValue: 'Added. The radio replaced {{count}} older non-favourite contact(s) to make room.',
            })
          : t('meshcore.not_on_device.added', 'Added to the radio.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.notice} role="status" data-testid="meshcore-not-on-device">
      <div className={styles.heading}>
        <UiIcon name="alert" size={16} />
        {t('meshcore.not_on_device.title', "Not in the radio's contact list")}
      </div>
      <p className={styles.body}>
        {t(
          'meshcore.not_on_device.body',
          "The radio can only log in to, query, or message nodes in its own contact list. Its list may be full, or it is set to add contacts manually.",
        )}
      </p>
      {canAdd && onAddToDevice && (
        <div className={styles.actions}>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void handleAdd()}
            disabled={busy}
            title={t('meshcore.not_on_device.add_tooltip', 'Store this node in the radio (no radio transmission)')}
          >
            <UiIcon name="plus" size={14} />{' '}
            {busy
              ? t('meshcore.not_on_device.adding', 'Adding…')
              : t('meshcore.not_on_device.add_button', 'Add to radio')}
          </button>
          {error && <span className={styles.error} role="alert">{error}</span>}
          {done && <span className={styles.success}>{done}</span>}
        </div>
      )}
    </div>
  );
};
