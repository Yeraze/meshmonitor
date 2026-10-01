/**
 * Traceroute Explorer (#5511) — map pane.
 *
 * Composes `BaseMap` (CLAUDE.md: new map surfaces MUST). With nothing focused
 * it draws link usage: one line per node-to-node link the filtered runs used,
 * wider for more use, colored by accent or by median SNR. Focusing a run
 * (table hover or selection) draws that run's forward and return legs through
 * the shared `TraceroutePathsLayer` and dims everything else. Clicking a node
 * reports it to the shell, which turns it into a table filter.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import L from 'leaflet';
import { CircleMarker, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { BaseMap } from '../../map/BaseMap';
import { TraceroutePathsLayer } from '../../map/layers/TraceroutePathsLayer';
import { useSettings } from '../../../contexts/SettingsContext';
import { snrToColor } from '../../../utils/mapHelpers';
import { decomposeTraceroute, type TracerouteRenderSegment } from '../../../utils/tracerouteSegments';
import {
  aggregateLinks,
  formatSnr,
  nodeLabel,
  nodeLongLabel,
  runNodes,
  type ExplorerNodeWire,
  type ExplorerRun,
} from './explorerModel';
import styles from './TracerouteExplorer.module.css';

export type LineMode = 'usage' | 'snr';

/** Read a theme token at runtime; Leaflet pathOptions take literal colors. */
function useCssColor(name: string, fallback: string): string {
  const [color, setColor] = useState(fallback);
  useEffect(() => {
    const read = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (value) setColor(value);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, [name]);
  return color;
}

/** Fit the view to the positioned nodes when the data window changes — not on
 *  every filter or selection, so the user's pan/zoom survives clicking around. */
const FitToNodes: React.FC<{ points: Array<[number, number]>; fitKey: string }> = ({ points, fitKey }) => {
  const map = useMap();
  // Latest points, read when fitKey changes; points alone must not refit.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  useEffect(() => {
    const pts = pointsRef.current;
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView(pts[0], 12);
      return;
    }
    const bounds = L.latLngBounds(pts);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
  }, [map, fitKey]);
  return null;
};

/** Zoom to a run when the user pins it (not on hover), so a selected path
 *  is readable without hunting for it on a busy map. */
const FitToRun: React.FC<{ points: Array<[number, number]>; runKey: string | null }> = ({ points, runKey }) => {
  const map = useMap();
  const pointsRef = useRef(points);
  pointsRef.current = points;
  useEffect(() => {
    const pts = pointsRef.current;
    if (!runKey || pts.length === 0) return;
    if (pts.length === 1) {
      map.setView(pts[0], Math.max(map.getZoom(), 12));
      return;
    }
    const bounds = L.latLngBounds(pts);
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
  }, [map, runKey]);
  return null;
};

/** Leaflet keeps its own size; the pane resizes with the split divider, the
 *  collapse rail and full screen, so tell it whenever the container changes. */
const InvalidateOnResize: React.FC = () => {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
};

const BackgroundClick: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  useMapEvents({ click: onClick });
  return null;
};

export interface ExplorerMapProps {
  runs: ExplorerRun[];
  nodes: Map<number, ExplorerNodeWire>;
  focusRun: ExplorerRun | null;
  /** The pinned run (not the hover preview); the map zooms to it. */
  selectedRun: ExplorerRun | null;
  nodeFilter: number | null;
  lineMode: LineMode;
  fitKey: string;
  onNodeClick: (nodeNum: number) => void;
  onBackgroundClick: () => void;
}

export const ExplorerMap: React.FC<ExplorerMapProps> = ({
  runs,
  nodes,
  focusRun,
  selectedRun,
  nodeFilter,
  lineMode,
  fitKey,
  onNodeClick,
  onBackgroundClick,
}) => {
  const { t } = useTranslation();
  const { mapTileset, customTilesets, overlayColors, defaultMapCenterLat, defaultMapCenterLon, defaultMapCenterZoom } =
    useSettings();
  const accent = useCssColor('--color-accent', '#89b4fa');
  const accentAlt = useCssColor('--color-accent-alt', '#cba6f7');
  const errorColor = useCssColor('--color-error', '#f38ba8');
  const markerFill = useCssColor('--color-bg-raised', '#181825');
  const markerStroke = useCssColor('--color-text-subtle', '#a6adc8');

  const pos = useCallback(
    (n: number): [number, number] | null => {
      const node = nodes.get(n);
      return node && node.latitude != null && node.longitude != null ? [node.latitude, node.longitude] : null;
    },
    [nodes],
  );

  const links = useMemo(() => aggregateLinks(runs.filter(r => r.answered)), [runs]);

  const shownNodes = useMemo(() => {
    const set = new Set<number>();
    for (const run of runs) for (const n of runNodes(run)) set.add(n);
    if (focusRun) for (const n of runNodes(focusRun)) set.add(n);
    return [...set].filter(n => pos(n) !== null);
  }, [runs, focusRun, pos]);

  const allPoints = useMemo(
    () => [...nodes.values()].flatMap(n => (n.latitude != null && n.longitude != null ? [[n.latitude, n.longitude] as [number, number]] : [])),
    [nodes],
  );

  const focusSegments = useMemo<TracerouteRenderSegment[]>(() => {
    if (!focusRun?.answered) return [];
    return decomposeTraceroute(focusRun.wire, { resolvePosition: pos });
  }, [focusRun, pos]);

  const selectedPoints = useMemo(
    () => (selectedRun ? runNodes(selectedRun).flatMap(n => (pos(n) ? [pos(n)!] : [])) : []),
    [selectedRun, pos],
  );

  const focusNodes = useMemo(() => new Set(focusRun ? runNodes(focusRun) : []), [focusRun]);
  const unpositioned = shownNodes.length === 0 && runs.length > 0;

  const center: [number, number] =
    defaultMapCenterLat != null && defaultMapCenterLon != null ? [defaultMapCenterLat, defaultMapCenterLon] : [0, 0];

  return (
    <div className={styles.mapCanvas} data-testid="traceroute-explorer-map">
      <BaseMap
        center={center}
        zoom={defaultMapCenterZoom ?? 2}
        tilesetId={mapTileset}
        customTilesets={customTilesets}
        scrollWheelZoom
      >
        <FitToNodes points={allPoints} fitKey={fitKey} />
        <InvalidateOnResize />
        <FitToRun points={selectedPoints} runKey={selectedRun?.key ?? null} />
        <BackgroundClick onClick={onBackgroundClick} />

        {links.map(link => {
          const a = pos(link.a);
          const b = pos(link.b);
          if (!a || !b) return null;
          const color = lineMode === 'snr' ? snrToColor(link.medianSnr, overlayColors.snrColors) : accent;
          return (
            <Polyline
              key={link.key}
              positions={[a, b]}
              pathOptions={{
                color,
                weight: 2 + Math.log2(link.count + 1) * 2.2,
                opacity: focusRun ? 0.1 : lineMode === 'snr' ? 0.7 : 0.4,
                lineCap: 'round',
              }}
            >
              <Tooltip sticky>
                {t('analysis.traceroute_explorer.link_tooltip', '{{a}} – {{b}}: {{count}} hops, median SNR {{snr}} dB', {
                  a: nodeLabel(nodes, link.a),
                  b: nodeLabel(nodes, link.b),
                  count: link.count,
                  snr: formatSnr(link.medianSnr),
                })}
              </Tooltip>
            </Polyline>
          );
        })}

        {focusSegments.length > 0 && (
          <TraceroutePathsLayer
            segments={focusSegments}
            snrColors={overlayColors.snrColors}
            colorMode="fixed-leg"
            legColors={{ forward: accent, return: accentAlt }}
            curvature={0.12}
            weight={4}
            showArrows
            renderPopup={seg => (
              <Tooltip sticky>
                {t('analysis.traceroute_explorer.segment_tooltip', '{{from}} to {{to}}: {{snr}} dB', {
                  from: nodeLabel(nodes, seg.fromNodeNum),
                  to: nodeLabel(nodes, seg.toNodeNum),
                  snr: formatSnr(seg.avgSnr),
                })}
              </Tooltip>
            )}
          />
        )}

        {focusRun && !focusRun.answered && pos(focusRun.fromNodeNum) && pos(focusRun.toNodeNum) && (
          <Polyline
            positions={[pos(focusRun.fromNodeNum)!, pos(focusRun.toNodeNum)!]}
            pathOptions={{ color: errorColor, weight: 2, dashArray: '3 7' }}
          />
        )}

        {shownNodes.map(n => {
          const p = pos(n)!;
          const isEndpoint = focusRun ? n === focusRun.fromNodeNum || n === focusRun.toNodeNum : n === nodeFilter;
          const dimmed = !!focusRun && !focusNodes.has(n);
          return (
            <CircleMarker
              key={n}
              center={p}
              radius={isEndpoint ? 8 : 6}
              pathOptions={{
                color: isEndpoint ? accent : markerStroke,
                weight: isEndpoint ? 3 : 2,
                fillColor: markerFill,
                fillOpacity: dimmed ? 0.3 : 1,
                opacity: dimmed ? 0.3 : 1,
              }}
              eventHandlers={{
                click: e => {
                  L.DomEvent.stopPropagation(e);
                  onNodeClick(n);
                },
              }}
            >
              <Tooltip direction="top" offset={[0, -8]} permanent={isEndpoint || (!!focusRun && focusNodes.has(n))}>
                {focusRun || isEndpoint ? nodeLabel(nodes, n) : nodeLongLabel(nodes, n)}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </BaseMap>
      {unpositioned && (
        <div className={styles.mapNotice}>
          {t('analysis.traceroute_explorer.no_positions', 'None of these nodes has a position you can see, so the map is empty.')}
        </div>
      )}
    </div>
  );
};

export default ExplorerMap;
