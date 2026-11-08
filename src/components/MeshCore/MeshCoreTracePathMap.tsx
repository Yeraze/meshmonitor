/**
 * MeshCoreTracePathMap — the "Trace Path map" card on the contact panel.
 *
 * Draws local node -> resolved relay hops -> contact on the shared
 * `RouteFlowMap`, one SNR-colored segment per traced hop. It shows the live
 * Trace Path result when there is one, else the newest trace this source sent
 * to the contact (so the map survives a reload). Like the message-route modal,
 * it draws only when EVERY hop resolved to a positioned contact: a partial
 * line would misrepresent the path. The result table stays on the panel.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { useSettings } from '../../contexts/SettingsContext';
import { darkOverlayColors } from '../../config/overlayColors';
import { RouteFlowMap, type RouteFlowPoint } from '../map/RouteFlowMap';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import type { TracerouteRenderSegment } from '../../utils/tracerouteSegments';
import { useResolvedRouteHops, contactPosition } from './useResolvedRouteHops';
import type { TracePathResult } from './hooks/useMeshCore';

interface LatestTraceResponse {
  data?: {
    trace?: {
      hops?: { hopIndex: number; receiverHash: string | null; snr: number }[];
    } | null;
  };
}

interface Props {
  sourceId: string | null | undefined;
  contact: MeshCoreContact | null;
  /** Full contact list: the relay names and the local node come from it. */
  contacts: MeshCoreContact[];
  /** Live result of the Trace Path button; wins over the stored trace. */
  traceResult: TracePathResult | null;
  /** The contact's out-path, the hash source for a live result with no `path`. */
  outPath?: string | null;
}

interface TraceView {
  hashes: string[];
  snrs: number[];
}

export const MeshCoreTracePathMap: React.FC<Props> = ({ sourceId, contact, contacts, traceResult, outPath }) => {
  const { t } = useTranslation();
  const settings = useSettings();
  const snrColors = settings.overlayColors?.snrColors ?? darkOverlayColors.snrColors;
  const publicKey = contact?.publicKey;

  const [stored, setStored] = useState<TraceView | null>(null);
  useEffect(() => {
    setStored(null);
    if (!sourceId || !publicKey) return;
    let cancelled = false;
    api
      .get<LatestTraceResponse>(
        `/api/sources/${encodeURIComponent(sourceId)}/meshcore/hop-snr/latest-trace?publicKey=${encodeURIComponent(publicKey)}`,
      )
      .then((res) => {
        if (cancelled) return;
        // Rows without a receiver hash are the link into our own radio.
        const hops = (res?.data?.trace?.hops ?? []).filter((h) => h.receiverHash);
        if (hops.length === 0) return;
        setStored({ hashes: hops.map((h) => h.receiverHash as string), snrs: hops.map((h) => h.snr) });
      })
      .catch(() => {
        // No traceroute:read, or a read error: no stored map.
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId, publicKey]);

  const view = useMemo((): TraceView | null => {
    if (traceResult) {
      const hashes = traceResult.path ?? outPath?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) ?? [];
      return { hashes: hashes.slice(0, traceResult.hops.length), snrs: traceResult.hops.map((h) => h.snr) };
    }
    return stored;
  }, [traceResult, outPath, stored]);

  const hashes = useMemo(() => view?.hashes ?? [], [view]);
  const { rows } = useResolvedRouteHops(hashes, sourceId ?? undefined, contacts);

  const flow = useMemo((): { points: RouteFlowPoint[]; segments: TracerouteRenderSegment[] } | null => {
    if (!view || rows.length === 0 || rows.length !== view.hashes.length) return null;
    const nodes: { point: RouteFlowPoint; snr: number | null; key?: string }[] = [];
    const localContact = contacts.find((c) => c.isLocal === true);
    const localPos = contactPosition(localContact);
    if (localPos) {
      nodes.push({
        point: { key: 'local', label: t('meshcore.route_detail_you', 'You'), lat: localPos.lat, lon: localPos.lon, kind: 'endpoint' },
        snr: null,
        key: localContact?.publicKey?.toLowerCase(),
      });
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.position || !r.name) return null;
      const viaLabel = r.via ? ` (${r.via.sourceName})` : '';
      nodes.push({
        point: { key: `hop-${i}`, label: `#${i + 1} ${r.name}${viaLabel}`, lat: r.position.lat, lon: r.position.lon, kind: 'hop' },
        snr: view.snrs[i] ?? null,
      });
    }
    const contactPos = contactPosition(contact ?? undefined);
    const lastRow = rows[rows.length - 1];
    const targetIsLastHop = !!contact && lastRow.position && contactPos
      && lastRow.position.lat === contactPos.lat && lastRow.position.lon === contactPos.lon;
    if (contact && contactPos && !targetIsLastHop) {
      nodes.push({
        point: {
          key: 'contact',
          label: contact.advName || contact.name || contact.publicKey.slice(0, 8),
          lat: contactPos.lat,
          lon: contactPos.lon,
          kind: 'endpoint',
        },
        snr: null,
        key: contact.publicKey.toLowerCase(),
      });
    }
    const segments: TracerouteRenderSegment[] = [];
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1];
      const b = nodes[i];
      segments.push({
        key: `trace-${i}`,
        from: [a.point.lat, a.point.lon],
        to: [b.point.lat, b.point.lon],
        fromKey: a.key,
        toKey: b.key,
        leg: 'forward',
        avgSnr: b.snr,
        isMqtt: false,
      });
    }
    return { points: nodes.map((n) => n.point), segments };
  }, [view, rows, contacts, contact, t]);

  if (!flow || flow.points.length === 0) return null;
  return (
    <div className="node-detail-card node-detail-card-2col">
      <div className="node-detail-label">{t('meshcore.contact_details.trace_path_map', 'Trace Path map')}</div>
      <div className="node-detail-value">
        <RouteFlowMap points={flow.points} segments={flow.segments} snrColors={snrColors} />
      </div>
    </div>
  );
};
