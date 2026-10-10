/**
 * MapMarkersLayer — local map markers (#5686).
 *
 * A local marker is a planning note stored in MeshMonitor and never sent to
 * the mesh. It draws as an outline glyph in a dashed ring, on its own pane
 * just below the shared marker pane, so an on-air waypoint or a node at the
 * same spot always draws on top of a private note.
 *
 * `LocalMarkers` renders one or all sources (Nodes / Dashboard maps); the
 * default export reads Map Analysis's source filter.
 */
import { useMemo } from 'react';
import { Marker, Pane, Popup } from 'react-leaflet';
import L from 'leaflet';
import { useTranslation } from 'react-i18next';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { useMapAnalysisCtx } from '../../MapAnalysis/MapAnalysisContext';
import { useMapMarkers } from '../../../hooks/useMapMarkers';
import type { MapMarker } from '../../../types/mapMarker';
import { UiIcon } from '../../icons';
import { markerGlyphSvg } from './mapMarkerGlyphs';
import styles from './MapMarkersLayer.module.css';

/** Pane z-index: under Leaflet's markerPane (600), over overlays (400). */
export const LOCAL_MARKERS_PANE_Z = 590;

export interface MapMarkerPopupActions {
  canEdit: boolean;
  onEdit?: (marker: MapMarker) => void;
  onDelete?: (marker: MapMarker) => void;
}

interface SourceInfo { id: string; name?: string }

function markerIcon(m: MapMarker): L.DivIcon {
  const colorClass = styles[m.color] ?? styles.accent;
  return L.divIcon({
    html: `<div class="${styles.glyph} ${colorClass}" data-local-marker="${m.id}">${markerGlyphSvg(m.icon)}</div>`,
    className: styles.icon,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

export function PerSourceMapMarkers({ source, actions }: { source: SourceInfo; actions?: MapMarkerPopupActions }) {
  const { t } = useTranslation();
  const { markers } = useMapMarkers(source.id);
  if (markers.length === 0) return null;
  return (
    <>
      {markers.map((m) => (
        <Marker key={`${m.sourceId}:${m.id}`} position={[m.latitude, m.longitude]} icon={markerIcon(m)}
          title={m.label} alt={m.label}>
          <Popup>
            <div className={styles.popup}>
              <div className={styles.title}>{m.label}</div>
              <div className={styles.badge}>
                <UiIcon name="visibilityOff" size={13} />
                {t('localMarkers.notSent', 'Local marker — not sent to the mesh')}
              </div>
              {m.description && <div className={styles.description}>{m.description}</div>}
              <div className={styles.meta}>
                {source.name ?? source.id} · {m.latitude.toFixed(5)}, {m.longitude.toFixed(5)}
                {m.altitude != null ? ` · ${m.altitude} m` : ''}
              </div>
              {actions?.canEdit && (
                <div className={styles.actions}>
                  <button type="button" onClick={() => actions.onEdit?.(m)}>
                    <UiIcon name="edit" size={14} /> {t('common.edit', 'Edit')}
                  </button>
                  <button type="button" className={styles.danger} onClick={() => actions.onDelete?.(m)}>
                    <UiIcon name="delete" size={14} /> {t('common.delete', 'Delete')}
                  </button>
                </div>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
    </>
  );
}

/**
 * Markers for one source, or for every source when `sourceId` does not match
 * a real one (the unified view). Edit actions apply only to a single source.
 */
export function LocalMarkers({ sourceId, actions }: { sourceId: string | null; actions?: MapMarkerPopupActions }) {
  const { data: sources = [] } = useDashboardSources();
  const list = sources as SourceInfo[];
  const matched = sourceId ? list.find((s) => s.id === sourceId) : null;
  const visible = matched ? [matched] : list;
  return (
    <Pane name="localMarkers" style={{ zIndex: LOCAL_MARKERS_PANE_Z }}>
      {visible.map((s) => (
        <PerSourceMapMarkers key={s.id} source={s} actions={matched ? actions : undefined} />
      ))}
    </Pane>
  );
}

/** Map Analysis: markers for the sources in the analysis filter (all when empty). */
export default function MapMarkersLayer({ actionsFor }: {
  /** Popup actions for one source; undefined = read-only (#5685). */
  actionsFor?: (source: { id: string; name?: string }) => MapMarkerPopupActions | undefined;
} = {}) {
  const { config } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();
  const list = sources as SourceInfo[];
  const visible = useMemo(
    () => (config.sources.length === 0 ? list : list.filter((s) => config.sources.includes(s.id))),
    [list, config.sources],
  );
  return (
    <>
      {visible.map((s) => <PerSourceMapMarkers key={s.id} source={s} actions={actionsFor?.(s)} />)}
    </>
  );
}
