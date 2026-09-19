import { useMemo, type ReactNode } from 'react';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'react-leaflet-cluster/dist/assets/MarkerCluster.css';
import { useTranslation } from 'react-i18next';
import { DEFAULT_ZOOM_GATE_THRESHOLD } from '../../../hooks/useMarkerSpiderfier';
import styles from './NodeMarkerCluster.module.css';

export interface NodeMarkerClusterProps {
  /** `<Marker>` elements to cluster — typically a `<NodeMarkersLayer>`. Layer
   *  context (react-leaflet's `LayerContainer`) flows through the React tree
   *  regardless of intervening components, so `NodeMarkersLayer` itself needs
   *  no changes: every `<Marker>` it renders is added to this cluster group
   *  instead of straight to the map. */
  children: ReactNode;
  /** Zoom level at/above which clustering turns off entirely and every
   *  marker renders individually — leaflet.markercluster's own semantics,
   *  not a radius cutoff. Defaults to `DEFAULT_ZOOM_GATE_THRESHOLD` (13), the
   *  same zoom `NodeMarkersLayer`'s spiderfier gate already treats as "piles
   *  are sparse enough to manage individually" (#4046 item 4), so the two
   *  systems hand off at a zoom the app already treats as the line between
   *  "overview" and "working the map". */
  disableClusteringAtZoom?: number;
}

/**
 * Groups node markers into count-bubble clusters at low zoom so panning with
 * thousands of nodes doesn't pay compositor cost for thousands of
 * individually-transformed marker `<div>`s (measured: 73ms/frame, 98.6%
 * dropped frames at ~2,600 markers; root cause was Layerize/UpdateLayer over
 * the DOM marker count, not icon construction). `leaflet.markercluster`
 * removes clustered members from the DOM entirely and renders one bubble per
 * cluster, so the on-screen (and on-layer) element count drops to roughly the
 * cluster count instead of the node count.
 *
 * Coexistence with the OMS spiderfier (`useMarkerSpiderfier`,
 * `NodeMarkersLayer`): the two systems solve different problems in
 * non-overlapping zoom ranges rather than fighting over the same one.
 * Clustering (`disableClusteringAtZoom`) turns off completely at/above the
 * threshold — no spatial grouping happens there at all, so every marker
 * above it is a real, individually-clickable Leaflet marker exactly like
 * before this change, and the spiderfier's own zoom-gated fan-out
 * (`zoomGateThreshold`, independently configurable, defaults to the same
 * constant) keeps doing its job of separating exactly-co-located markers
 * there. Below the threshold, markers with no nearby neighbor are left
 * un-clustered by leaflet.markercluster (its own `maxClusterRadius` behavior)
 * and still reach the spiderfier's existing "zoom in first" gated-click flow
 * unchanged. `spiderfyOnMaxZoom`/`showCoverageOnHover` are disabled below so
 * leaflet.markercluster never runs its own built-in spiderfy — a cluster
 * click just zooms to fit its bounds (`zoomToBoundsOnClick`, library
 * default), which is the only new interaction this introduces.
 */
export function NodeMarkerCluster({
  children,
  disableClusteringAtZoom = DEFAULT_ZOOM_GATE_THRESHOLD,
}: NodeMarkerClusterProps) {
  const { t } = useTranslation();

  const iconCreateFunction = useMemo(() => (cluster: L.MarkerCluster): L.DivIcon => {
    const count = cluster.getChildCount();
    const tier = count >= 100 ? 'bubbleLarge' : count >= 10 ? 'bubbleMedium' : 'bubbleSmall';
    const size = count >= 100 ? 52 : count >= 10 ? 42 : 34;
    const label = t('map.clusterNodeCount', { count });
    return L.divIcon({
      html: `<div class="${styles.bubble} ${styles[tier]}" title="${label}">${count}</div>`,
      className: 'node-cluster-icon',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }, [t]);

  return (
    <MarkerClusterGroup
      iconCreateFunction={iconCreateFunction}
      disableClusteringAtZoom={disableClusteringAtZoom}
      spiderfyOnMaxZoom={false}
      showCoverageOnHover={false}
      chunkedLoading
    >
      {children}
    </MarkerClusterGroup>
  );
}
