/**
 * DeliveryDetailsModal — per-protocol "Delivery Details" diagnostics popup
 * (#4816 Phase 1, WP2).
 *
 * Renders ONLY data MeshMonitor already has, with every field carrying an
 * honest provenance label (Reported by protocol / Observed by MeshMonitor /
 * Inferred / Unknown). Never fabricates a value: an absent field always shows
 * the Unknown placeholder rather than a guess.
 *
 * Pure presentation over the WP1 diagnostics core — `describeMeshtasticDelivery`
 * / `describeMeshCoreDelivery` do all the branching; this component only
 * translates and lays the result out. Icon and modal therefore can never
 * disagree about a message's delivery state.
 *
 * Modal shell modeled on `MeshCorePacketDetailModal` + `useDialogA11y`, but
 * using its OWN `ddm-*` CSS module — the `mcpm-*` classes live in a frozen
 * global sheet and must not be extended or reused (CLAUDE.md CSS containment).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import { describeMeshtasticDelivery } from '../../utils/deliveryDiagnostics/meshtasticDelivery';
import { describeMeshCoreDelivery } from '../../utils/deliveryDiagnostics/meshcoreDelivery';
import type { DeliveryTone, DiagField, Provenance } from '../../utils/deliveryDiagnostics/types';
import type { MeshMessage } from '../../types/message';
import type { MeshCoreMessage } from '../MeshCore/hooks/useMeshCore';
import styles from './DeliveryDetailsModal.module.css';

export type DeliveryDetailsProtocol = 'meshtastic' | 'meshcore';

interface Props {
  protocol: DeliveryDetailsProtocol;
  message: MeshMessage | MeshCoreMessage;
  onClose: () => void;
}

const PROTOCOL_LABEL: Record<DeliveryDetailsProtocol, { key: string; fallback: string }> = {
  meshtastic: { key: 'delivery_details.protocol.meshtastic', fallback: 'Meshtastic' },
  meshcore: { key: 'delivery_details.protocol.meshcore', fallback: 'MeshCore' },
};

const TONE_CLASS: Record<DeliveryTone, string> = {
  success: styles.toneSuccess,
  error: styles.toneError,
  pending: styles.tonePending,
  warning: styles.toneWarning,
};

const PROVENANCE_LABEL: Record<Provenance, { key: string; fallback: string }> = {
  reported: { key: 'delivery_details.provenance.reported', fallback: 'Reported by protocol' },
  observed: { key: 'delivery_details.provenance.observed', fallback: 'Observed by MeshMonitor' },
  inferred: { key: 'delivery_details.provenance.inferred', fallback: 'Inferred' },
  unknown: { key: 'delivery_details.provenance.unknown', fallback: 'Unknown' },
};

const PROVENANCE_CLASS: Record<Provenance, string> = {
  reported: styles.provenanceReported,
  observed: styles.provenanceObserved,
  inferred: styles.provenanceInferred,
  unknown: styles.provenanceUnknown,
};

const ProvenanceBadge: React.FC<{ provenance: Provenance }> = ({ provenance }) => {
  const { t } = useTranslation();
  const { key, fallback } = PROVENANCE_LABEL[provenance];
  return (
    <span className={`${styles.badge} ${PROVENANCE_CLASS[provenance]}`}>
      {t(key, fallback)}
    </span>
  );
};

const FieldRow: React.FC<{ field: DiagField }> = ({ field }) => {
  const { t } = useTranslation();
  // Rendering rule (fixed by the WP1 field contract): a translatable enum
  // value wins via valueKey; otherwise the literal formatted value; otherwise
  // the honest Unknown placeholder — never a guess.
  const displayValue = field.valueKey
    ? t(field.valueKey)
    : field.value ?? t('delivery_details.value.unknown', 'Unknown');

  return (
    <div className={styles.row}>
      <span className={styles.label}>{t(field.labelKey)}</span>
      <span className={styles.valueGroup}>
        <span className={styles.value}>{displayValue}</span>
        <ProvenanceBadge provenance={field.provenance} />
        {field.noteKey && <span className={styles.note}>{t(field.noteKey)}</span>}
      </span>
    </div>
  );
};

const DeliveryDetailsModal: React.FC<Props> = ({ protocol, message, onClose }) => {
  const { t } = useTranslation();
  const { contentRef, onKeyDown } = useDialogA11y(onClose);

  const description =
    protocol === 'meshtastic'
      ? describeMeshtasticDelivery(message as MeshMessage)
      : describeMeshCoreDelivery(message as MeshCoreMessage);

  const protocolLabel = PROTOCOL_LABEL[protocol];

  // MeshCore Propagation (heard-by) is only meaningful for channel sends —
  // an outgoing DM has no self-echo re-flood to correlate against, so the
  // section is omitted entirely rather than showing a misleading "none".
  const mcMessage = protocol === 'meshcore' ? (message as MeshCoreMessage) : null;
  const isMeshCoreDirectMessage = mcMessage ? Boolean(mcMessage.toPublicKey) : false;
  const showPropagation = protocol === 'meshcore' && !isMeshCoreDirectMessage;
  const heardBy = description.heardBy ?? [];

  return (
    <div className={styles.overlay} onClick={onClose} role="presentation">
      <div
        className={styles.content}
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ddm-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h4 id="ddm-title">
            {t('delivery_details.title', 'Delivery Details')} —{' '}
            <span className={styles.protocolName}>{t(protocolLabel.key, protocolLabel.fallback)}</span>
          </h4>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label={t('delivery_details.close', 'Close')}
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.statusRow}>
            <span className={`${styles.statusPill} ${TONE_CLASS[description.tone]}`}>
              {t(description.statusKey)}
            </span>
          </div>

          <section className={styles.section}>
            <h5>{t('delivery_details.meaning_title', 'What this means')}</h5>
            <p className={styles.meaning}>{t(description.meaningKey)}</p>
          </section>

          {description.sections.map((section) => (
            <section key={section.titleKey} className={styles.section}>
              <h5>{t(section.titleKey)}</h5>
              {section.fields.map((field) => (
                <FieldRow key={field.labelKey} field={field} />
              ))}
            </section>
          ))}

          {showPropagation && (
            <section className={styles.section}>
              <h5>{t('delivery_details.section.propagation', 'Propagation (Heard By)')}</h5>
              <p className={styles.propagationSubtitle}>
                {t(
                  'delivery_details.heard_by.subtitle',
                  'Observed by MeshMonitor through repeater re-flood correlation. This confirms the packet propagated through parts of the mesh — it is NOT recipient-specific proof of delivery.',
                )}
              </p>
              {heardBy.length === 0 ? (
                <p className={styles.propagationEmpty}>
                  {t('delivery_details.heard_by.none', 'No re-flood observed')}
                </p>
              ) : (
                <ul className={styles.heardByList}>
                  {heardBy.map((entry) => (
                    <li key={entry.hash} className={styles.heardByItem}>
                      <span className={styles.heardByName}>{entry.name || entry.hash}</span>
                      {typeof entry.snr === 'number' && (
                        <span className={styles.heardBySnr}> ({entry.snr} dB)</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default DeliveryDetailsModal;
