/**
 * Node Details card: did our last PKI-encrypted DM or request to this node get
 * an answer (#5691, Reliable PKI)? Read-only. Renders nothing until the server
 * has a record for the node on this source.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import apiService from '../services/api';
import type { PkiExchangeState, PkiExchangeFailureReason } from '../types/pkiExchange';
import { formatRelativeTime } from '../utils/datetime';
import type { TimeFormat, DateFormat } from '../contexts/SettingsContext';
import { UiIcon } from './icons';
import styles from './PkiExchangeStatusCard.module.css';

export interface PkiExchangeStatusCardProps {
  sourceId: string | null | undefined;
  nodeNum: number | null | undefined;
  timeFormat?: TimeFormat;
  dateFormat?: DateFormat;
}

export const PkiExchangeStatusCard: React.FC<PkiExchangeStatusCardProps> = ({
  sourceId, nodeNum, timeFormat = '24', dateFormat = 'MM/DD/YYYY',
}) => {
  const { t } = useTranslation();
  const [data, setData] = useState<PkiExchangeState | null>(null);

  useEffect(() => {
    if (!sourceId || nodeNum == null) {
      setData(null);
      return;
    }
    let cancelled = false;
    setData(null);
    apiService.getPkiExchangeState(sourceId, nodeNum)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [sourceId, nodeNum]);

  if (!data) return null;

  const when = (ms: number) => formatRelativeTime(ms, timeFormat, dateFormat, false);

  const reasonText = (r: PkiExchangeFailureReason | null): string | null => {
    switch (r) {
      case 'pki_unknown_pubkey':
        return t('node_details.pki_exchange.reason_unknown_pubkey', 'The node said it does not have your public key.');
      case 'no_channel':
        return t('node_details.pki_exchange.reason_no_channel', 'The node could not decrypt the packet.');
      case 'max_retransmit':
        return t('node_details.pki_exchange.reason_max_retransmit', 'Your radio got no acknowledgement after its retries.');
      case 'radio_refused':
        return t('node_details.pki_exchange.reason_radio_refused', "Your radio could not encrypt to this node's key.");
      case 'timeout':
        return t('node_details.pki_exchange.reason_timeout', 'No answer within 3 minutes.');
      default:
        return null;
    }
  };

  let status: string;
  let tone: string;
  switch (data.state) {
    case 'successful':
      status = t('node_details.pki_exchange.successful', {
        when: when(data.lastSuccessAt ?? data.stateChangedAt), defaultValue: 'Last answered {{when}}',
      });
      tone = styles.ok;
      break;
    case 'failed':
      status = t('node_details.pki_exchange.failing', {
        when: when(data.failingSince ?? data.stateChangedAt), defaultValue: 'Failing since {{when}}',
      });
      tone = styles.failed;
      break;
    case 'pending':
      status = t('node_details.pki_exchange.pending', {
        when: when(data.stateChangedAt), defaultValue: 'Waiting for an answer (sent {{when}})',
      });
      tone = styles.neutral;
      break;
    default:
      status = t('node_details.pki_exchange.unknown', 'No answer recorded');
      tone = styles.neutral;
  }

  const reason = data.state === 'failed' ? reasonText(data.lastFailureReason) : null;

  return (
    <div className="node-detail-card node-detail-card-2col" data-testid="pki-exchange-status">
      <div className={`node-detail-label ${styles.label}`}>
        <UiIcon name="key" size={14} /> {t('node_details.pki_exchange.label', 'Encrypted requests')}
      </div>
      <div className="node-detail-value">
        <span className={tone} data-testid="pki-exchange-state">{status}</span>
        {reason && <div className={styles.sub}>{reason}</div>}
        {data.lastPrimedAt != null && (
          <div className={styles.sub} data-testid="pki-exchange-primed">
            {t('node_details.pki_exchange.primed', {
              when: when(data.lastPrimedAt), defaultValue: 'Your node info was last sent to it {{when}}',
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default PkiExchangeStatusCard;
