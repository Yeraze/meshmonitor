import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MeshCoreAdvertMode } from '../../types/meshcoreAdvert';
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
 */
export const MeshCoreAdvertButtons: React.FC<MeshCoreAdvertButtonsProps> = ({ onSend, disabled = false, disabledTitle }) => {
  const { t } = useTranslation();

  const handleFlood = () => {
    const msg = t(
      'meshcore.advert.flood_confirm',
      'Send a flood advert? It is repeated by every repeater within 8 hops. With 20 repeaters in reach that is about 9 s (US) / 25 s (EU) of channel time. A zero-hop advert reaches nearby nodes for a fraction of that.',
    );
    if (typeof window !== 'undefined' && !window.confirm(msg)) return;
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
        onClick={handleFlood}
        disabled={disabled}
        title={disabled && disabledTitle ? disabledTitle : t('meshcore.advert.flood_title', 'Announce this node across the whole mesh. Every repeater within 8 hops forwards it.')}
      >
        {t('meshcore.advert.flood_button', 'Flood advert')}
      </button>
    </span>
  );
};
