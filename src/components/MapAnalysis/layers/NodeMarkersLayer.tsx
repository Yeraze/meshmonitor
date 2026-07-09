import { Marker, Popup } from 'react-leaflet';
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Marker as LeafletMarker } from 'leaflet';
import { useDashboardSources } from '../../../hooks/useDashboardData';
import { useHopCounts } from '../../../hooks/useMapAnalysisData';
import { useSettings } from '../../../contexts/SettingsContext';
import { useMapAnalysisCtx } from '../MapAnalysisContext';
import { useMarkerSpiderfier, SHARED_SPIDERFIER_OPTIONS } from '../../../hooks/useMarkerSpiderfier';
import { useAnalysisNodes, type NodeRecord } from '../useAnalysisNodes';
import { createNodeIcon } from '../../../utils/mapIcons';
import { getNodeTypeCategory } from '../../../utils/nodeTypeCategory';
import { markerAgeOpacity, MIN_MARKER_OPACITY } from '../../../utils/markerAgeOpacity';
import { isNodeEmphasized, selectionOpacity } from '../../../utils/nodeIdentity';
import DashboardNodePopup, { type NodeSourceRef } from '../../Dashboard/DashboardNodePopup';
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

  // Spiderfier fans out markers that share (rounded) coordinates so each node in
  // a cluster is individually selectable (issues #3399, #3612). Same bridge
  // pattern as NodesTab: stable per-key ref handlers feed the imperative Leaflet
  // markers in. Uses the SHARED tuning (50px nearbyDistance etc.) so every map
  // surface fans out identically — the prior default 20px radius missed
  // near-but-not-identical co-located nodes.
  const { addMarker, removeMarker, addListener, removeListener } = useMarkerSpiderfier(SHARED_SPIDERFIER_OPTIONS);
  const markerByKey = useRef<Map<string, LeafletMarker>>(new Map());
  const refHandlers = useRef<Map<string, (m: LeafletMarker | null) => void>>(new Map());
  // Stable position/icon refs keyed by the spiderfier key — fixes the fan
  // auto-collapsing after a refresh (issue #3685). react-leaflet only
  // moves/restyles a marker when the prop *reference* changes, and doing so on a
  // spiderfied marker snaps it back to its anchor, collapsing the fan. The
  // unified data refetches on every poll and rebuilds these objects even when
  // nothing moved, so cache them by value to keep refs stable across refreshes.
  const positionCacheRef = useRef<Map<string, [number, number]>>(new Map());
  const iconCacheRef = useRef<Map<string, { sig: string; icon: ReturnType<typeof createNodeIcon> }>>(new Map());
  const stablePosition = (key: string, lat: number, lng: number): [number, number] => {
    const cached = positionCacheRef.current.get(key);
    if (cached && cached[0] === lat && cached[1] === lng) return cached;
    const next: [number, number] = [lat, lng];
    positionCacheRef.current.set(key, next);
    return next;
  };
  const stableIcon = (
    key: string,
    sig: string,
    build: () => ReturnType<typeof createNodeIcon>,
  ): ReturnType<typeof createNodeIcon> => {
    const cached = iconCacheRef.current.get(key);
    if (cached && cached.sig === sig) return cached.icon;
    const icon = build();
    iconCacheRef.current.set(key, { sig, icon });
    return icon;
  };
  const getMarkerRef = (key: string) => {
    let h = refHandlers.current.get(key);
    if (!h) {
      h = (m: LeafletMarker | null) => {
        // NOTE: react-leaflet registers its forwarded ref via
        // `useImperativeHandle(ref, () => instance)` with NO dependency array,
        // so React bounces this callback `null → instance` on EVERY re-render —
        // not just on mount/unmount. Treating `null` as "removed" here would
        // call removeMarker on a still-present (often spiderfied) marker every
        // time the selection or polled data changes, and OMS auto-unspiderfies
        // when a spiderfied marker is removed → the fan collapses (issue #3685).
        // So we ONLY register on an instance (addMarker is idempotent) and
        // ignore the null bounce. Genuine removals are reconciled by the effect
        // below, driven by which keys are still rendered.
        if (m) {
          markerByKey.current.set(key, m);
          addMarker(m, key);
        }
      };
      refHandlers.current.set(key, h);
    }
    return h;
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

  // Genuine removals (a node aged out / filtered away) are reconciled here
  // rather than from the ref `null` bounce — drop any tracked marker whose key
  // is no longer rendered, and unregister it from the spiderfier. Keyed off the
  // rendered key SET so it only does work when membership actually changes.
  const renderedKeysSig = filteredNodes.map(({ node: n }) => keyOf(n)).join('|');
  useEffect(() => {
    const rendered = new Set(renderedKeysSig ? renderedKeysSig.split('|') : []);
    for (const key of [...markerByKey.current.keys()]) {
      if (rendered.has(key)) continue;
      const m = markerByKey.current.get(key);
      if (m) removeMarker(m);
      markerByKey.current.delete(key);
      refHandlers.current.delete(key);
      positionCacheRef.current.delete(key);
      iconCacheRef.current.delete(key);
    }
  }, [renderedKeysSig, removeMarker]);

  // #4015: open the popup ONLY via the OMS 'click' event, which fires solely for
  // a marker that is already spiderfied or standalone — never for the click that
  // fans out a pile. This runs after the hook's OMS-init effect (registered
  // earlier in this component), so the spiderfier is ready.
  useEffect(() => {
    const onOmsClick = (marker: LeafletMarker) => marker.openPopup();
    addListener('click', onOmsClick);
    return () => removeListener('click', onOmsClick);
  }, [addListener, removeListener]);

  // #4015: strip Leaflet's own auto-open-on-click handler that `bindPopup`
  // installs (via the declarative <Popup> child). Without this, a pile click
  // both fans out AND opens the popup on the pre-spread stacked marker, covering
  // the markers that just spread. This parent effect runs after the child
  // <Popup> bind effects; `off` is idempotent. Popup content stays bound, so the
  // OMS-driven openPopup() above still works.
  //
  // NOTE: `_openPopup` is Leaflet's private handler (verified against
  // leaflet@1.9.4 `Popup.js` bindPopup: `this.on({ click: this._openPopup })`).
  // It's undocumented; if a future Leaflet renames/removes it, the strip becomes
  // a no-op and we degrade to the old double-fire — annoying, not a crash — so
  // re-verify this when bumping Leaflet.
  useEffect(() => {
    for (const m of markerByKey.current.values()) {
      const mm = m as LeafletMarker & { _openPopup?: (e: unknown) => void };
      if (mm._openPopup) mm.off('click', mm._openPopup, mm);
    }
  }, [renderedKeysSig]);

  // #3886: when the time slider is on, fade markers by recency across its
  // window — fully opaque at the window's newest edge, fading toward a floor as
  // lastHeard approaches the oldest edge. Markers with no timestamp sit at the
  // floor. When the slider is off, every marker is fully opaque (unchanged).
  const ts = config.timeSlider;
  const fadeByAge =
    ts.enabled && ts.windowStartMs != null && ts.windowEndMs != null;
  const windowStartMs = ts.windowStartMs ?? 0;
  const windowEndMs = ts.windowEndMs ?? 0;

  return (
    <>
      {filteredNodes.map(({ node: n, latLng, key: unifiedKey }) => {
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
        const iconSig = `${hops}|${isSelected ? 1 : 0}|${isRouter ? 1 : 0}|${roleCategory}|${n.shortName ?? ''}|${mapPinStyle}`;
        const icon = stableIcon(markerKey, iconSig, () =>
          createNodeIcon({
            hops,
            isSelected,
            isRouter,
            roleCategory,
            shortName: n.shortName ?? undefined,
            showLabel: true,
            pinStyle: mapPinStyle,
          }),
        );
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
        return (
          <Marker
            key={markerKey}
            ref={getMarkerRef(markerKey)}
            position={stablePosition(markerKey, lat, lon)}
            icon={icon}
            opacity={finalOpacity}
            eventHandlers={{
              click: () =>
                setSelected({
                  type: 'node',
                  nodeNum: Number(n.nodeNum),
                  sourceId,
                }),
            }}
          >
            {/* Same rich card as the Unified/Dashboard map, incl. the "Seen by
                N sources" list for multi-source nodes. Rendered in the default
                popupPane (z-index 700): without this the Popup inherits the
                surrounding <Pane name="markers"> (z600) from MapAnalysisCanvas
                and the markers paint over it. Inject the hop count computed from
                /api/analysis/hopCounts so the popup shows it. */}
            <Popup pane="popupPane">
              <DashboardNodePopup
                node={hopVal !== undefined ? { ...n, hopsAway: hopVal } : n}
                pos={{ lat, lng: lon }}
                onSourceSelect={handleSourceSelect}
              />
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}
