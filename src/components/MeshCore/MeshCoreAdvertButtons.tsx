import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { MeshCoreAdvertMode } from '../../types/meshcoreAdvert';
import Modal from '../common/Modal';
import styles from './MeshCoreAdvertButtons.module.css';

interface MeshCoreAdvertButtonsProps {
  onSend: (mode: MeshCoreAdvertMode) => unknown;
  disabled?: boolean;
  /** Tooltip for both buttons while disabled (e.g. the receive-only reason). */
  disabledTitle?: string;
}

/**
 * Manual advert controls. Zero-hop (nearby only) is the primary action; a
 * flood advert is the secondary choice and asks for confirmation first,
 * because every repeater within 8 hops re-broadcasts it.
 *
 * The confirmation is an in-app Modal, not window.confirm(): embedded
 * webviews (the Tauri desktop app) can suppress native dialogs, and a
 * suppressed confirm would send the flood unasked. The Modal is portalled to
 * <body> so the host bar's `button` styles do not leak into it.
 */
export const MeshCoreAdvertButtons: React.FC<MeshCoreAdvertButtonsProps> = ({ onSend, disabled = false, disabledTitle }) => {
  const { t } = useTranslation();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const closeConfirm = () => setConfirmOpen(false);
  const confirmFlood = () => {
    setConfirmOpen(false);
    void onSend('flood');
  };

  return (
    <span className={styles.group}>
      <button
        type="button"
        onClick={() => void onSend('zero_hop')}
        disabled={disabled}
        title={disabled && disabledTitle ? disabledTitle : t('meshcore.advert.zero_hop_title', 'Announce this node to nodes in direct radio range. Repeaters do not forward it.')}
      >
        {t('meshcore.advert.zero_hop_button', 'Advert (nearby, zero-hop)')}
      </button>
      <button
        type="button"
        className={styles.flood}
        onClick={() => setConfirmOpen(true)}
        disabled={disabled}
        title={disabled && disabledTitle ? disabledTitle : t('meshcore.advert.flood_title', 'Announce this node across the whole mesh. Every repeater within 8 hops forwards it.')}
      >
        {t('meshcore.advert.flood_button', 'Flood advert')}
      </button>
      {confirmOpen && createPortal(
        <Modal
          isOpen
          onClose={closeConfirm}
          title={t('meshcore.advert.flood_confirm_title', 'Send a flood advert?')}
          maxWidth="480px"
        >
          <p className={styles.confirmText}>
            {t(
              'meshcore.advert.flood_confirm',
              'A flood advert is repeated by every repeater within 8 hops. With 20 repeaters in reach that is about 9 s (US) / 25 s (EU) of channel time. A zero-hop advert reaches nearby nodes for a fraction of that.',
            )}
          </p>
          <div className={styles.confirmActions}>
            <button type="button" className={styles.cancelButton} onClick={closeConfirm}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button type="button" className={styles.confirmButton} onClick={confirmFlood}>
              {t('meshcore.advert.flood_confirm_button', 'Send flood advert')}
            </button>
          </div>
        </Modal>,
        document.body,
      )}
    </span>
  );
};
