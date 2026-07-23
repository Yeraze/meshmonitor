import { useMemo } from 'react';
import { Popup } from 'react-leaflet';
import { useNavigate } from 'react-router-dom';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { useHopCounts } from '../../../hooks/useMapAnalysisData';
import { useSettings } from '../../../contexts/SettingsContext';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { useAnalysisNodes, type NodeRecord } from '../useAnalysisNodes';
import { createNodeIcon } from '../../../utils/mapIcons';
import { getNodeTypeCategory } from '../../../utils/nodeTypeCategory';
import { markerAgeOpacity, MIN_MARKER_OPACITY } from '../../../utils/markerAgeOpacity';
import { isNodeEmphasized, selectionOpacity } from '../../../utils/nodeIdentity';
import DashboardNodePopup, { type NodeSourceRef } from '../../Dashboard/DashboardNodePopup';
import { NodeMarkersLayer as SharedNodeMarkersLayer, type NodeMarkerDescriptor } from '../../map/layers/NodeMarkersLayer';
import '../../../styles/nodes.css'; // `.node-popup-*` classes used by DashboardNodePopup

interface HopEntry {
  sourceId: string;
  nodeNum: number;
  hops: number;
}

/**
 * Renders one Marker per node that has a position. When `config.sources` is
 * non-empty, only nodes whose sourceId is in the allow-list are shown; an
 * empty list means "all sources" (Unified semantics).
 *
 * When `config.layers.hopShading.enabled` is true, markers are rendered as a
 * colored divIcon tinted by the node's hop count from `/api/analysis/hopCounts`.
 *
 * Clicking a marker writes the selection into MapAnalysisContext so the
 * inspector panel can react.
 *
 * Thin adapter (#4047 Phase 4 WP3): maps `useAnalysisNodes()` output onto
 * `NodeMarkerDescriptor[]` and delegates spiderfy wiring, stable position/icon
 * caches, removal reconciliation, OMS-click, and the `_openPopup` strip to the
 * shared `src/components/map/layers/NodeMarkersLayer`. This file keeps only
 * consumer-specific concerns: keyOf, hop lookup, time-slider age fade,
 * selection-dim opacity, the click→setSelected handler, source-select
 * navigation, and the popup content.
 */
export default function NodeMarkersLayer() {
  const { config, selected, setSelected } = useMapAnalysisCtx();
  const { mapPinStyle } = useSettings();
  const navigate = useNavigate();

  // Clicking a "Seen by" source row in the popup jumps to that source's view —
  // mirrors the Unified/Dashboard map (DashboardPage.handleNodeSourceSelect).
  const handleSourceSelect = (source: NodeSourceRef, nodeId: string | undefined) => {
    if (source.protocol === 'MeshCore') {
      void navigate(`/source/${source.sourceId}/`);
      return;
    }
    void navigate(`/source/${source.sourceId}/#messages`, {
      state: nodeId ? { focusDmNodeId: nodeId } : undefined,
    });
  };

  // Stable, UNIQUE spiderfier key per node. MeshCore nodes carry no Meshtastic
  // nodeNum, so `${sourceId}:${nodeNum}` collapses every MeshCore node in a
  // source onto one key (`…:undefined`) — only one would register with the
  // spiderfier and MeshCore piles never fan out. Fall back to the (unique)
  // nodeId for MeshCore, matching DashboardMap. Meshtastic/MQTT keys are
  // unchanged. (issue: spiderfy not working for MeshCore markers on Map Analysis)
  const keyOf = (n: NodeRecord): string =>
    n.isMeshCore ? `mc:${n.nodeId ?? n.nodeNum}` : `${n.sourceId ?? ''}:${n.nodeNum}`;

  const { data: sources = [] } = useDashboardSources();
  const sourceList = sources as Array<{ id: string; name: string }>;
  const sourceIds = sourceList.map((s) => s.id);
  const hop = useHopCounts({
    enabled: config.layers.hopShading.enabled,
    sources: config.sources.length === 0 ? sourceIds : config.sources,
  });

  const hopByKey = useMemo(() => {
    const m = new Map<string, number>();
    const entries = (hop.data as { entries?: HopEntry[] } | undefined)?.entries ?? [];
    for (const e of entries) {
      m.set(`${e.sourceId}:${Number(e.nodeNum)}`, e.hops);
    }
    return m;
  }, [hop.data]);

  // Shared identity + visibility computation (issue #3788 WP-B) — the same
  // predicate the node picker (NodeMultiSelect) uses, so the two surfaces
  // never disagree about which nodes exist/are shown.
  const filteredNodes = useAnalysisNodes();

  // #3886: when the time slider is on, fade markers by recency across its
  // window — fully opaque at the window's newest edge, fading toward a floor as
  // lastHeard approaches the oldest edge. Markers with no timestamp sit at the
  // floor. When the slider is off, every marker is fully opaque (unchanged).
  const ts = config.timeSlider;
  const fadeByAge =
    ts.enabled && ts.windowStartMs != null && ts.windowEndMs != null;
  const windowStartMs = ts.windowStartMs ?? 0;
  const windowEndMs = ts.windowEndMs ?? 0;

  const markers: NodeMarkerDescriptor[] = filteredNodes.map(({ node: n, latLng, key: unifiedKey }) => {
    const [lat, lon] = latLng;
    const sourceId = n.sourceId ?? '';
    const hopVal = hopByKey.get(`${sourceId}:${Number(n.nodeNum)}`);
    const hops =
      config.layers.hopShading.enabled && hopVal !== undefined ? hopVal : 999;
    const isSelected =
      selected?.type === 'node' &&
      selected.nodeNum === Number(n.nodeNum) &&
      (selected.sourceId ?? '') === sourceId;
    const roleNum =
      typeof n.user?.role === 'string'
        ? parseInt(n.user.role, 10)
        : typeof n.user?.role === 'number'
          ? n.user.role
          : 0;
    const isRouter = roleNum === 2;
    const roleCategory = getNodeTypeCategory(n);
    const markerKey = keyOf(n);
    // Reuse cached icon/position unless an input changed, so a poll that
    // returns identical data doesn't churn the marker and collapse an active
    // spiderfy fan. Selection IS part of the signature, so highlighting the
    // chosen node still re-renders just that marker.
    const iconSig = `${hops}|${isSelected ? 1 : 0}|${isRouter ? 1 : 0}|${roleCategory}|${n.isUnmessagable ? 1 : 0}|${n.shortName ?? ''}|${mapPinStyle}`;
    // A missing lastHeard sits at the floor here (treated as "oldest
    // visible"), intentionally diverging from DashboardMap where a missing
    // timestamp stays fully opaque — that surface age-gates upstream, this
    // one fades every marker across the raw slider window instead.
    const markerOpacity = !fadeByAge
      ? 1
      : n.lastHeard != null
        ? markerAgeOpacity(windowEndMs, windowStartMs, n.lastHeard * 1000)
        : MIN_MARKER_OPACITY;
    // Selection dimming (issue #3788 WP-C): applied via the leaflet `opacity`
    // prop only — NOT folded into `iconSig`/the divIcon — so the spiderfy fan
    // and icon cache don't churn when the selection changes. Empty selection
    // ⇒ isNodeEmphasized always true ⇒ finalOpacity === markerOpacity (today's
    // behavior, unchanged).
    const emphasized = isNodeEmphasized(unifiedKey, config.selectedNodeIds);
    const finalOpacity = selectionOpacity(markerOpacity, emphasized);

    return {
      key: markerKey,
      position: [lat, lon],
      iconSig,
      buildIcon: () =>
        createNodeIcon({
          hops,
          isSelected,
          isRouter,
          roleCategory,
          isUnmessagable: !!n.isUnmessagable,
          shortName: n.shortName ?? undefined,
          showLabel: true,
          pinStyle: mapPinStyle,
        }),
      opacity: finalOpacity,
      eventHandlers: {
        click: () =>
          setSelected({
            type: 'node',
            nodeNum: Number(n.nodeNum),
            sourceId,
          }),
      },
      children: (
        // Same rich card as the Unified/Dashboard map, incl. the "Seen by
        // N sources" list for multi-source nodes. Rendered in the default
        // popupPane (z-index 700): without this the Popup inherits the
        // surrounding <Pane name="markers"> (z600) from MapAnalysisCanvas
        // and the markers paint over it. Inject the hop count computed from
        // /api/analysis/hopCounts so the popup shows it.
        <Popup pane="popupPane">
          <DashboardNodePopup
            node={hopVal !== undefined ? { ...n, hopsAway: hopVal } : n}
            pos={{ lat, lng: lon }}
            onSourceSelect={handleSourceSelect}
          />
        </Popup>
      ),
    };
  });

  return <SharedNodeMarkersLayer markers={markers} />;
}
