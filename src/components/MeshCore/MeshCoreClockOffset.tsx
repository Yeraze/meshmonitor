/**
 * The sender's clock offset beside a MeshCore message time (#5973): receipt
 * time minus sender time, as `(+15m30s)`. Renders nothing for a null offset,
 * which {@link meshcoreClockOffsetMs} returns when the offset is under 5 s,
 * the sender time is implausible, or none is stored.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatMeshCoreClockOffset } from '../../utils/meshcoreMessageTime';
import styles from './MeshCoreClockOffset.module.css';

interface MeshCoreClockOffsetProps {
  offsetMs: number | null;
}

export const MeshCoreClockOffset: React.FC<MeshCoreClockOffsetProps> = ({ offsetMs }) => {
  const { t } = useTranslation();
  if (offsetMs === null) return null;
  const offset = formatMeshCoreClockOffset(offsetMs);
  return (
    <span
      className={styles.clockOffset}
      data-testid="mc-clock-offset"
      title={t('meshcore.clock_offset_title', {
        offset,
        defaultValue: "Sender's clock differs from receipt time by {{offset}}. The time shown is when MeshMonitor received the message.",
      })}
    >
      ({offset})
    </span>
  );
};

export default MeshCoreClockOffset;
