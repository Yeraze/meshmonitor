/**
 * MeshCoreMessageRouteModal — shown when the relay-hash chain on a received
 * MeshCore message is clicked. Presents the message's reception details and
 * expands each relay hash to the matching repeater / room-server name from
 * the contact list (mirroring the {ROUTE_NAMES} automation token): only
 * relay infrastructure ever appears in a path, unknown hashes stay raw, and
 * hash collisions resolve to the candidate nearest the neighbouring hops.
 * When every hop resolves to a positioned contact, a small map traces the
 * packet's geospatial flow (sender → relays → local node, where known) with
 * numbered, labeled hop markers. Reuses the packet-monitor modal styling
 * (mcpm-*).
 *
 * #5909: a hop no own contact matches may be named from another MeshCore
 * source the viewer can read (opt-in global setting; the server decides what
 * is returned). Those names read "Name (via Source)". When several nodes share
 * the hash, the nearest is shown as a guess with "?" and the full list sits in
 * an expandable list; a guess never carries a position onto the flow map.
 */
import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import { CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet';
import type { MeshCoreMessage } from './hooks/useMeshCore';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { parsePathHops } from '../../utils/meshcorePath';
import { useDialogA11y } from '../../hooks/useDialogA11y';
import { BaseMap } from '../map/BaseMap';
import { useResolvedRouteHops, contactPosition } from './useResolvedRouteHops';
import { RouteHopRows } from './MeshCoreRouteHops';
import './MeshCorePacketMonitor.css';
import { uniquePrefixMatch } from '../../utils/meshcoreKeyMatch';
import { meshcoreDisplayTimeMs } from '../../utils/meshcoreMessageTime';

interface Props {
  message: MeshCoreMessage;
  /** Sender label already resolved by the stream (name or key prefix). */
  fromLabel: string;
  contacts: MeshCoreContact[];
  /**
   * The source the message arrived on. With it, hops no contact matches are
   * looked up on other sources (#5909) when the server-side toggle is on.
   */
  sourceId?: string;
  onClose: () => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode; mono?: boolean; wrap?: boolean }> = ({ label, children, mono, wrap }) => (
  <div className="mcpm-dl-row">
    <span className="mcpm-dl-label">{label}</span>
    <span className={`mcpm-dl-value${mono ? ' mcpm-mono' : ''}${wrap ? ' mcpm-dl-wrap' : ''}`}>{children}</span>
  </div>
);

/** A labeled point on the flow map. */
interface FlowPoint {
  label: string;
  lat: number;
  lon: number;
  /** 'endpoint' = sender / local node, 'hop' = relay. */
  kind: 'endpoint' | 'hop';
}

/** Fit the map view to the flow line once per point set. */
const FitFlowBounds: React.FC<{ points: FlowPoint[] }> = ({ points }) => {
  const map = useMap();
  useEffect(() => {
    const latLngs = points.map((p) => [p.lat, p.lon] as [number, number]);
    if (latLngs.length === 1) {
      map.setView(latLngs[0], 13);
      return;
    }
    const bounds = L.latLngBounds(latLngs);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  }, [map, points]);
  return null;
};

const MeshCoreMessageRouteModal: React.FC<Props> = ({ message, fromLabel, contacts, sourceId, onClose }) => {
  const { t } = useTranslation();
  const { contentRef, onKeyDown } = useDialogA11y(onClose);

  const hops = useMemo(() => parsePathHops(message.routePath), [message.routePath]);
  const { rows, width } = useResolvedRouteHops(hops, sourceId, contacts);

  // Geospatial flow line: shown only when EVERY relay hop resolved to a
  // positioned contact (a partial line would misrepresent the path). The
  // sender (matched by pubkey prefix — channel senders have synthetic
  // 'channel-*' keys and never match) and the local node (matched via
  // `isLocal`, #4438) are prepended/appended opportunistically when
  // positioned.
  const flowPoints = useMemo((): FlowPoint[] | null => {
    if (rows.length === 0) return null;
    const hopPoints: FlowPoint[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.position || !r.name) return null;
      const viaLabel = r.via ? ` (${r.via.sourceName})` : '';
      hopPoints.push({ label: `#${i + 1} ${r.name}${viaLabel}`, lat: r.position.lat, lon: r.position.lon, kind: 'hop' });
    }
    const points: FlowPoint[] = [];
    // Guard the prefix match: startsWith('') is true for EVERY key, so an
    // empty fromPublicKey must not adopt an arbitrary contact as the sender.
    // uniquePrefixMatch also refuses an ambiguous prefix (#5349).
    const senderContact = uniquePrefixMatch(contacts, message.fromPublicKey);
    const senderPos = contactPosition(senderContact);
    if (senderPos) points.push({ label: fromLabel, lat: senderPos.lat, lon: senderPos.lon, kind: 'endpoint' });
    points.push(...hopPoints);
    const localContact = contacts.find((c) => c.isLocal === true);
    const localPos = contactPosition(localContact);
    if (localPos) {
      points.push({
        label: t('meshcore.route_detail_you', 'You'),
        lat: localPos.lat,
        lon: localPos.lon,
        kind: 'endpoint',
      });
    }
    return points;
  }, [rows, contacts, message.fromPublicKey, fromLabel, t]);

  const scopeStr = message.scopeName
    ? message.scopeName
    : typeof message.scopeCode === 'number' && message.scopeCode !== 0
      ? `#${message.scopeCode.toString(16).padStart(4, '0')}`
      : '—';

  return (
    <div className="mcpm-modal" onClick={onClose} role="presentation">
      <div
        className="mcpm-modal-content"
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mc-route-detail-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcpm-modal-header">
          <h4 id="mc-route-detail-title">{t('meshcore.route_detail_title', 'Message Route')}</h4>
          <button className="mcpm-modal-close" onClick={onClose} aria-label={t('common.close', 'Close')}>×</button>
        </div>

        <div className="mcpm-modal-body">
          <section className="mcpm-dl-section">
            <h5>{t('meshcore.route_detail_message', 'Message')}</h5>
            <Row label={t('meshcore.route_detail_from', 'From')}>{fromLabel}</Row>
            <Row label={t('meshcore.route_detail_time', 'Time')} mono>{new Date(meshcoreDisplayTimeMs(message)).toLocaleString()}</Row>
            <Row label={t('meshcore.route_detail_hops', 'Hops')} mono>{typeof message.hopCount === 'number' ? message.hopCount : '—'}</Row>
            <Row label={t('meshcore.route_detail_scope', 'Scope')}>{scopeStr}</Row>
            {message.text && (
              <Row label={t('meshcore.route_detail_text', 'Text')} wrap>{message.text}</Row>
            )}
          </section>

          <section className="mcpm-dl-section">
            <h5>{t('meshcore.route_detail_route', 'Route')}</h5>
            <Row label={t('meshcore.packets.hashWidth', 'Hash width')} mono>{width} B</Row>
            <RouteHopRows rows={rows} />
          </section>

          {flowPoints && flowPoints.length > 0 && (
            <section className="mcpm-dl-section">
              <h5>{t('meshcore.route_detail_flow', 'Packet flow')}</h5>
              <div className="mc-route-flow-map">
                <BaseMap
                  center={[flowPoints[0].lat, flowPoints[0].lon]}
                  zoom={11}
                  zoomControl={false}
                  attributionControl={false}
                  scrollWheelZoom={false}
                >
                  <FitFlowBounds points={flowPoints} />
                  {flowPoints.length > 1 && (
                    <Polyline
                      positions={flowPoints.map((p) => [p.lat, p.lon] as [number, number])}
                      pathOptions={{ color: '#89b4fa', weight: 3, opacity: 0.85, dashArray: '6 6' }}
                    />
                  )}
                  {flowPoints.map((p, i) => (
                    <CircleMarker
                      key={`${p.label}-${i}`}
                      center={[p.lat, p.lon]}
                      radius={p.kind === 'hop' ? 7 : 5}
                      pathOptions={{
                        color: p.kind === 'hop' ? '#89b4fa' : '#7f849c',
                        fillColor: p.kind === 'hop' ? '#89b4fa' : '#7f849c',
                        fillOpacity: 0.85,
                      }}
                    >
                      <Tooltip permanent direction="top" offset={[0, -8]} className="mc-route-flow-label">
                        {p.label}
                      </Tooltip>
                    </CircleMarker>
                  ))}
                </BaseMap>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
};

export default MeshCoreMessageRouteModal;
