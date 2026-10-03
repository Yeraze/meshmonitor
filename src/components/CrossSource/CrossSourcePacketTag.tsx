/**
 * Cross-source tags for one Unified Packet Monitor row (#5559): "sent by our
 * source A" (proven, from_node is A's own node) and "likely relayed by our
 * source A" (inferred from an 8-bit relay hash, so always labelled as such).
 * Renders nothing for an untagged row.
 */
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { PacketLog } from '../../types/packet';
import { crossSourceTransportLabel } from '../../utils/crossSourceLabels';
import styles from './CrossSourcePacketTag.module.css';

export interface CrossSourcePacketTagProps {
  packet: PacketLog;
}

export function CrossSourcePacketTag({ packet }: CrossSourcePacketTagProps) {
  const { t } = useTranslation();
  if (!packet.originSourceId && !packet.likelyRelaySourceId) return null;
  const via = crossSourceTransportLabel(t, packet.crossSourceTransport);
  const heardBy = packet.sourceName ?? packet.sourceId ?? '';

  return (
    <span className={styles.tags} data-testid="cross-source-tags">
      {packet.originSourceId && (
        <span
          className={`${styles.tag} ${styles.origin}`}
          title={t('cross_source.origin_title', 'Sent by our source {{origin}}, heard by {{receiver}} over {{via}}', {
            origin: packet.originSourceName ?? packet.originSourceId,
            receiver: heardBy,
            via,
          })}
        >
          <UiIcon name="send" size={10} />
          {packet.originSourceName ?? packet.originSourceId}
        </span>
      )}
      {packet.likelyRelaySourceId && (
        <span
          className={`${styles.tag} ${styles.relay}`}
          title={
            (packet.likelyRelayCandidateCount ?? 1) > 1
              ? t(
                  'cross_source.relay_title_ambiguous',
                  'Likely relayed by our source {{relay}} (inferred: {{count}} of our sources share this relay byte), heard by {{receiver}} over {{via}}',
                  {
                    relay: packet.likelyRelaySourceName ?? packet.likelyRelaySourceId,
                    count: packet.likelyRelayCandidateCount,
                    receiver: heardBy,
                    via,
                  },
                )
              : t('cross_source.relay_title', 'Likely relayed by our source {{relay}} (inferred from the relay byte), heard by {{receiver}} over {{via}}', {
                  relay: packet.likelyRelaySourceName ?? packet.likelyRelaySourceId,
                  receiver: heardBy,
                  via,
                })
          }
        >
          <UiIcon name="resend" size={10} />
          {t('cross_source.relay_short', '{{relay}}?', {
            relay: packet.likelyRelaySourceName ?? packet.likelyRelaySourceId,
          })}
        </span>
      )}
    </span>
  );
}

export default CrossSourcePacketTag;
