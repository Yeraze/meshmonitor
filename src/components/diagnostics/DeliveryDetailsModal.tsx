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
import { useMessageEvents } from '../../hooks/useMessageEvents';
import { useMeshtasticHeardBy } from '../../hooks/useMeshtasticHeardBy';
import { describeMeshtasticDelivery } from '../../utils/deliveryDiagnostics/meshtasticDelivery';
import { describeMeshCoreDelivery } from '../../utils/deliveryDiagnostics/meshcoreDelivery';
import { getRoutingErrorName } from '../../utils/routingErrors';
import type { DeliveryTone, DiagField, Provenance } from '../../utils/deliveryDiagnostics/types';
import type { MeshMessage, MeshtasticHeardByEntry, MessageEvent, MessageEventType } from '../../types/message';
import type { MeshCoreMessage } from '../MeshCore/hooks/useMeshCore';
import styles from './DeliveryDetailsModal.module.css';

export type DeliveryDetailsProtocol = 'meshtastic' | 'meshcore';

interface Props {
  protocol: DeliveryDetailsProtocol;
  /** Owning source id — required to fetch the persisted event timeline. */
  sourceId: string;
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

const EVENT_LABEL: Record<MessageEventType, { key: string; fallback: string }> = {
  submitted: { key: 'delivery_details.timeline.event.submitted', fallback: 'Submitted' },
  sent_to_radio: { key: 'delivery_details.timeline.event.sent_to_radio', fallback: 'Sent to radio' },
  delivered: { key: 'delivery_details.timeline.event.delivered', fallback: 'Delivered to mesh' },
  confirmed: { key: 'delivery_details.timeline.event.confirmed', fallback: 'Confirmed by destination' },
  routing_error: { key: 'delivery_details.timeline.event.routing_error', fallback: 'Routing error' },
  timeout: { key: 'delivery_details.timeline.event.timeout', fallback: 'Timed out' },
  retry: { key: 'delivery_details.timeline.event.retry', fallback: 'Retry' },
};

/**
 * Parse the short JSON `detail` blob defensively — it is persisted as a string
 * and may be null, empty, or malformed. Returns an empty object on any failure
 * rather than throwing, so a bad row can never break the timeline render.
 */
function parseEventDetail(detail?: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const TimelineRow: React.FC<{ event: MessageEvent }> = ({ event }) => {
  const { t } = useTranslation();
  const label = EVENT_LABEL[event.eventType] ?? { key: '', fallback: event.eventType };
  const detail = parseEventDetail(event.detail);

  // Only routing_error surfaces a human-readable extra this phase: the numeric
  // RoutingError code named via the shared frontend map (#4816 Phase 2).
  let extra: string | null = null;
  if (event.eventType === 'routing_error' && typeof detail.routingErrorCode === 'number') {
    extra = `${getRoutingErrorName(detail.routingErrorCode)} (${detail.routingErrorCode})`;
  } else if (event.eventType === 'retry' && typeof detail.attempt === 'number') {
    extra = t('delivery_details.timeline.attempt', 'Attempt {{n}}', { n: detail.attempt });
  }

  return (
    <li className={styles.timelineItem}>
      <span className={styles.timelineTime}>{new Date(event.timestamp).toLocaleTimeString()}</span>
      <span className={styles.timelineBody}>
        <span className={styles.timelineLabel}>
          {label.key ? t(label.key, label.fallback) : label.fallback}
        </span>
        <ProvenanceBadge provenance={event.provenance} />
        {extra && <span className={styles.timelineDetail}>{extra}</span>}
      </span>
    </li>
  );
};

/**
 * One row for a Meshtastic re-flood observation.
 *
 * `relayByte` is only the last byte of the relaying node's nodeNum, so
 * identity is inherently ambiguous (#4816 Phase 4 WP3/WP4). This row is the
 * honesty boundary: it must NEVER collapse an ambiguous set of candidates
 * down to a single asserted name.
 *
 *   - 1 candidate  -> show that node's name (longName, falling back to
 *     shortName) alongside the raw hex.
 *   - >1 candidates -> show "{{count}} possible relays" plus the raw hex,
 *     with the candidate names listed on a secondary line.
 *   - 0 candidates -> show "Unknown relay" plus the raw hex; the hex is the
 *     only fact we actually have.
 *
 * The raw `relayByteHex` is always rendered, in every branch.
 */
const MeshtasticHeardByRow: React.FC<{ entry: MeshtasticHeardByEntry }> = ({ entry }) => {
  const { t } = useTranslation();
  const candidates = entry.candidates;

  let nameLabel: string;
  if (candidates.length === 1) {
    nameLabel = candidates[0].longName || candidates[0].shortName || entry.relayByteHex;
  } else if (candidates.length > 1) {
    nameLabel = t('delivery_details.heard_by.possible_relays', '{{count}} possible relays', {
      count: candidates.length,
    });
  } else {
    nameLabel = t('delivery_details.heard_by.unknown_relay', 'Unknown relay');
  }

  return (
    <li className={styles.heardByItem}>
      <span className={styles.heardByName}>{nameLabel}</span>
      <span className={styles.heardByHex}>{entry.relayByteHex}</span>
      {typeof entry.snr === 'number' && (
        <span className={styles.heardBySnr}>({entry.snr} dB)</span>
      )}
      <ProvenanceBadge provenance="observed" />
      {candidates.length > 1 && (
        <span className={styles.note}>
          {candidates
            .map((c) => c.longName || c.shortName || `!${c.nodeNum.toString(16).padStart(8, '0')}`)
            .join(', ')}
        </span>
      )}
    </li>
  );
};

const DeliveryDetailsModal: React.FC<Props> = ({ protocol, sourceId, message, onClose }) => {
  const { t } = useTranslation();
  const { contentRef, onKeyDown } = useDialogA11y(onClose);
  const { events, isLoading, isError } = useMessageEvents(sourceId, message.id);

  const description =
    protocol === 'meshtastic'
      ? describeMeshtasticDelivery(message as MeshMessage)
      : describeMeshCoreDelivery(message as MeshCoreMessage);

  const protocolLabel = PROTOCOL_LABEL[protocol];

  // Propagation (heard-by) is only meaningful for channel sends — an
  // outgoing DM has no self-echo re-flood to correlate against (Meshtastic:
  // an ACK proves delivery instead; MeshCore: same reasoning), so the
  // section is omitted entirely rather than showing a misleading "none".
  const mcMessage = protocol === 'meshcore' ? (message as MeshCoreMessage) : null;
  const isMeshCoreDirectMessage = mcMessage ? Boolean(mcMessage.toPublicKey) : false;
  const mtMessage = protocol === 'meshtastic' ? (message as MeshMessage) : null;
  // A Meshtastic channel message has a numeric channel >= 0; a DM is -1. Guard
  // an undefined channel so "unknown" is not treated as a channel message.
  const isMeshtasticChannelMessage =
    mtMessage !== null && typeof mtMessage.channel === 'number' && mtMessage.channel !== -1;
  const showMeshCorePropagation = protocol === 'meshcore' && !isMeshCoreDirectMessage;
  const showPropagation = showMeshCorePropagation || isMeshtasticChannelMessage;
  const heardBy = description.heardBy ?? [];
  // Query stays disabled (see useMeshtasticHeardBy's own `enabled` gate)
  // unless this is actually a Meshtastic channel message.
  const {
    heardBy: mtHeardBy,
    isLoading: mtHeardByLoading,
    isError: mtHeardByError,
  } = useMeshtasticHeardBy(sourceId, isMeshtasticChannelMessage ? message.id : '');

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
              {isMeshtasticChannelMessage ? (
                mtHeardByLoading ? (
                  <p className={styles.propagationEmpty}>
                    {t('delivery_details.heard_by.loading', 'Checking observed propagation…')}
                  </p>
                ) : mtHeardByError ? (
                  <p className={styles.propagationEmpty}>
                    {t('delivery_details.heard_by.error', 'Heard-by data unavailable')}
                  </p>
                ) : mtHeardBy.length === 0 ? (
                  <p className={styles.propagationEmpty}>
                    {t('delivery_details.heard_by.none', 'No re-flood observed')}
                  </p>
                ) : (
                  <ul className={styles.heardByList}>
                    {mtHeardBy.map((entry) => (
                      <MeshtasticHeardByRow key={`${entry.relayByte}-${entry.heardAt}`} entry={entry} />
                    ))}
                  </ul>
                )
              ) : heardBy.length === 0 ? (
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

          <section className={styles.section}>
            <h5>{t('delivery_details.timeline.title', 'Timeline')}</h5>
            {isLoading ? (
              <p className={styles.timelineState}>
                {t('delivery_details.timeline.loading', 'Loading timeline…')}
              </p>
            ) : isError ? (
              <p className={styles.timelineState}>
                {t('delivery_details.timeline.error', 'Timeline unavailable')}
              </p>
            ) : events.length === 0 ? (
              <p className={styles.timelineState}>
                {t('delivery_details.timeline.empty', 'No timeline recorded')}
              </p>
            ) : (
              <ol className={styles.timelineList}>
                {events.map((event) => (
                  <TimelineRow key={event.id} event={event} />
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default DeliveryDetailsModal;
