/**
 * MqttPacketDetailModal — detail view for a grouped MQTT packet, shown when a
 * row in the MQTT Packet Monitor is clicked. Unlike the MeshCore packet
 * detail modal (which decodes raw OTA bytes client-side), MQTT packets are
 * already decoded server-side; this modal renders the stored fields plus a
 * per-gateway receptions table fetched on demand.
 *
 * See MQTT_PACKET_MONITOR_PHASE2_SPEC.md §3.3.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import type { MqttGroupedPacket, MqttReception } from './mqttPacketTypes';

interface Props {
  packet: MqttGroupedPacket;
  prefix: string; // `${baseUrl}/api/sources/:id/mqtt/packets`
  csrfFetch: ReturnType<typeof useCsrfFetch>;
  nodeName: (n: number | null) => string | null;
  onClose: () => void;
}

const BROADCAST_NODE_NUM = 0xffffffff;

const ENCRYPTED_OUTCOME_BADGES = new Set(['encrypted', 'ignored', 'geo-ignored', 'distance', 'unsupported-portnum', 'decode-error']);

function outcomeBadgeClass(outcome: string): string {
  switch (outcome) {
    case 'encrypted':
      return 'mqpm-badge mqpm-badge-encrypted';
    case 'ignored':
      return 'mqpm-badge mqpm-badge-ignored';
    case 'geo-ignored':
      return 'mqpm-badge mqpm-badge-geo-ignored';
    case 'distance':
      return 'mqpm-badge mqpm-badge-distance';
    case 'unsupported-portnum':
    case 'decode-error':
      return 'mqpm-badge mqpm-badge-error';
    default:
      return 'mqpm-badge';
  }
}

const Row: React.FC<{ label: string; children: React.ReactNode; mono?: boolean; wrap?: boolean }> = ({ label, children, mono, wrap }) => (
  <div className="mqpm-dl-row">
    <span className="mqpm-dl-label">{label}</span>
    <span className={`mqpm-dl-value${mono ? ' mqpm-mono' : ''}${wrap ? ' mqpm-dl-wrap' : ''}`}>{children}</span>
  </div>
);

function formatHeard(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString();
}

const MqttPacketDetailModal: React.FC<Props> = ({ packet, prefix, csrfFetch, nodeName, onClose }) => {
  const { t } = useTranslation();
  // Escape / focus-trap / focus-restore + dialog semantics (shared a11y hook).
  const { contentRef, onKeyDown } = useDialogA11y(onClose);

  const [receptions, setReceptions] = useState<MqttReception[]>([]);
  const [loadingReceptions, setLoadingReceptions] = useState(false);
  const [receptionsError, setReceptionsError] = useState<string | null>(null);

  // The receptions route parses packetId/fromNode as ints and queries
  // WHERE packetId = ?. A 0/null packetId would over-match every id-less
  // packet from that node, so we deliberately skip the fetch in that case.
  const canFetch = typeof packet.packetId === 'number' && packet.packetId !== 0
    && typeof packet.fromNode === 'number';

  useEffect(() => {
    if (!canFetch) return;
    let cancelled = false;
    setLoadingReceptions(true);
    setReceptionsError(null);
    void (async () => {
      try {
        const params = new URLSearchParams();
        params.set('packetId', String(packet.packetId));
        params.set('fromNode', String(packet.fromNode));
        const res = await csrfFetch(`${prefix}/receptions?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const payload = body.data ?? body;
        if (!cancelled) {
          setReceptions(Array.isArray(payload.receptions) ? payload.receptions : []);
        }
      } catch (err) {
        if (!cancelled) {
          setReceptionsError(err instanceof Error ? err.message : 'Failed to load receptions');
        }
      } finally {
        if (!cancelled) setLoadingReceptions(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canFetch, packet.packetId, packet.fromNode, csrfFetch, prefix]);

  const renderNodeRef = useCallback((n: number | null, id: string | null): string => {
    if (n === BROADCAST_NODE_NUM || id === '!ffffffff') return t('common.broadcast', 'Broadcast');
    const name = nodeName(n);
    if (name && n !== null) return `${name} (${id ?? `0x${n.toString(16)}`})`;
    return id ?? (n !== null ? `0x${n.toString(16)}` : '—');
  }, [nodeName, t]);

  const showOutcomeBadge = packet.encrypted && !packet.portnumName && ENCRYPTED_OUTCOME_BADGES.has(packet.ingestOutcome);

  return (
    <div className="mqpm-modal" onClick={onClose} role="presentation">
      <div
        className="mqpm-modal-content"
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mqpm-detail-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mqpm-modal-header">
          <h4 id="mqpm-detail-title">{t('mqtt.packets.detailTitle', 'Packet Detail')}</h4>
          <button className="mqpm-modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>×</button>
        </div>

        <div className="mqpm-modal-body">
          <section className="mqpm-dl-section">
            <h5>{t('mqtt.packets.packetSection', 'Packet')}</h5>
            <Row label={t('mqtt.packets.from', 'From')} mono>{renderNodeRef(packet.fromNode, packet.fromNodeId)}</Row>
            <Row label={t('mqtt.packets.to', 'To')} mono>{renderNodeRef(packet.toNode, packet.toNodeId)}</Row>
            <Row label={t('mqtt.packets.channel', 'Channel')} mono>
              {packet.channelId ?? '—'}{packet.channel != null ? ` (#${packet.channel})` : ''}
            </Row>
            <Row label={t('mqtt.packets.portnum', 'Port')} mono>
              {packet.portnumName ?? '—'}{packet.portnum != null ? ` (${packet.portnum})` : ''}
            </Row>
            <Row label={t('mqtt.packets.outcome', 'Outcome')}>
              {showOutcomeBadge
                ? <span className={outcomeBadgeClass(packet.ingestOutcome)}>{packet.ingestOutcome}</span>
                : <span className="mqpm-badge">{packet.ingestOutcome}</span>}
            </Row>
            <Row label={t('mqtt.packets.encrypted', 'Encrypted')}>{packet.encrypted ? t('common.yes', 'Yes') : t('common.no', 'No')}</Row>
            <Row label={t('mqtt.packets.size', 'Size')} mono>{packet.payloadSize != null ? `${packet.payloadSize} B` : '—'}</Row>
            <Row label={t('mqtt.packets.gatewayCount', 'Gateways')} mono>{packet.gatewayCount}</Row>
            <Row label={t('mqtt.packets.receptions', 'Receptions')} mono>{packet.receptionCount}</Row>
            <Row label={t('mqtt.packets.firstHeard', 'First heard')} mono>{formatHeard(packet.firstHeard)}</Row>
            <Row label={t('mqtt.packets.lastHeard', 'Last heard')} mono>{formatHeard(packet.lastHeard)}</Row>
            {packet.payloadPreview && (
              <Row label={t('mqtt.packets.preview', 'Preview')} mono wrap>{packet.payloadPreview}</Row>
            )}
          </section>

          <section className="mqpm-dl-section">
            <h5>{t('mqtt.packets.receptionsSection', 'Per-gateway receptions')}</h5>
            {!canFetch ? (
              <div className="mqpm-decode-note">
                {t('mqtt.packets.noReceptions', 'Per-gateway receptions are unavailable for packets without a packet ID.')}
              </div>
            ) : loadingReceptions ? (
              <div className="mqpm-empty">{t('common.loading', 'Loading…')}</div>
            ) : receptionsError ? (
              <div className="mqpm-error">{receptionsError}</div>
            ) : receptions.length === 0 ? (
              <div className="mqpm-empty">{t('mqtt.packets.empty', 'No packets captured yet. Waiting for MQTT traffic…')}</div>
            ) : (
              <table className="mqpm-recv-table">
                <thead>
                  <tr>
                    <th>{t('mqtt.packets.gateway', 'Gateway')}</th>
                    <th>{t('mqtt.packets.time', 'Time')}</th>
                    <th>{t('mqtt.packets.rxTime', 'Rx time')}</th>
                    <th>{t('mqtt.packets.rssi', 'RSSI')}</th>
                    <th>{t('mqtt.packets.snr', 'SNR')}</th>
                    <th>{t('mqtt.packets.hops', 'Hops')}</th>
                  </tr>
                </thead>
                <tbody>
                  {receptions.map((r, idx) => (
                    <tr key={`${r.gatewayId ?? 'unknown'}-${r.timestamp}-${idx}`}>
                      <td>{nodeName(r.gatewayNodeNum) ?? r.gatewayId ?? '—'}</td>
                      <td className="mqpm-mono">{formatHeard(r.timestamp)}</td>
                      <td className="mqpm-mono">{r.rxTime != null && r.rxTime > 0 ? formatHeard(r.rxTime) : '—'}</td>
                      <td className="mqpm-mono">{r.rxRssi ?? '—'}</td>
                      <td className="mqpm-mono">{r.rxSnr != null ? r.rxSnr.toFixed(2) : '—'}</td>
                      <td className="mqpm-mono">{r.hopStart != null && r.hopLimit != null ? r.hopStart - r.hopLimit : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default MqttPacketDetailModal;
