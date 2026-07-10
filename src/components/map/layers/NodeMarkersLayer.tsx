import { useEffect, useRef, type ReactNode } from 'react';
import { Marker } from 'react-leaflet';
import type L from 'leaflet';
import type { Marker as LeafletMarker, LeafletEventHandlerFnMap } from 'leaflet';
import {
  useMarkerSpiderfier,
  SHARED_SPIDERFIER_OPTIONS,
  type SpiderfierOptions,
} from '../../../hooks/useMarkerSpiderfier';

/**
 * One node marker's render inputs, resolved consumer-side. `key` doubles as
 * the spiderfier tracking key, so it MUST be stable and unique across the
 * whole `markers` array (matches every bridge's existing `keyOf`/marker-key
 * recipe — e.g. MapAnalysis's `mc:${nodeId}` / `${sourceId}:${nodeNum}`,
 * Dashboard's `${sourceId}:${nodeNum}`, MeshCore's `publicKey`, NodesTab's
 * `String(node.user?.id ?? nodeNum)`).
 */
export interface NodeMarkerDescriptor {
  /** Stable, UNIQUE spiderfier key (consumer-derived). */
  key: string;
  /** [lat, lng] — effective position resolved consumer-side. */
  position: [number, number];
  /** Cache signature; `buildIcon` is only invoked when this string changes
   *  for a given `key`. Selection/age-opacity must NEVER be folded in here —
   *  route those through `opacity` instead (issue #3685: keeps the icon
   *  cache, and therefore the spiderfy fan, from churning on every poll). */
  iconSig: string;
  /** Called only when `iconSig` changes for this `key`. */
  buildIcon: () => L.DivIcon;
  /** Leaflet marker opacity (age fade / selection dim). NOT part of `iconSig`. */
  opacity?: number;
  zIndexOffset?: number;
  /** Plain leaflet handlers (e.g. MapAnalysis `click`→setSelected, NodesTab
   *  `mouseover`/`mouseout` polyline dimming). */
  eventHandlers?: LeafletEventHandlerFnMap;
  /** `<Popup>`/`<Tooltip>` — consumer owns content (Phase 5, unchanged). */
  children?: ReactNode;
}

export interface NodeMarkersLayerProps {
  markers: NodeMarkerDescriptor[];
  /** Defaults to `SHARED_SPIDERFIER_OPTIONS` — every existing map surface
   *  fans out identically (issue #3612). Only override for a surface that
   *  deliberately needs different tuning. */
  spiderfierOptions?: SpiderfierOptions;
  /** Fired for the spiderfier's `click` event — i.e. only for a marker that
   *  is already spiderfied or standalone, never for the click that fans out
   *  a pile (#4015). Default: `marker.openPopup()`. */
  onOmsClick?: (marker: LeafletMarker, key: string) => void;
  /** Strip Leaflet's own auto-open-on-click handler (installed by the
   *  declarative `<Popup>` child's `bindPopup`) so a pile click doesn't also
   *  plant a popup on the pre-spread stacked marker (#4015). Default true. */
  stripLeafletAutoPopup?: boolean;
}

/**
 * Shared node-marker render layer (Map Consolidation epic #4047, Phase 4,
 * WP2). Generalized from `MapAnalysis/layers/NodeMarkersLayer.tsx` — the
 * closest of the four prior bridges to this shape, since it already called
 * `useMarkerSpiderfier` directly rather than through a `SpiderfierController`
 * ref (D4). A child of `MapContainer`. Owns, for every consumer:
 *
 * - Direct `useMarkerSpiderfier(spiderfierOptions)` wiring (no
 *   `SpiderfierController` needed — MapAnalysis's variant).
 * - Stable position/icon caches keyed by `descriptor.key` (+ `iconSig` for
 *   icons), so a poll that returns identical data doesn't rebuild markers
 *   and collapse an active spiderfy fan (issue #3685 — all four bridges).
 * - Marker→spiderfier registration: register on instance, ignore the `null`
 *   bounce (react-leaflet's forwarded ref fires `null → instance` on every
 *   re-render, not just mount/unmount — all four bridges).
 * - First-mount buffering: `<Marker ref>` fires in the commit BEFORE this
 *   component's effects (including the spiderfier hook's init effect)
 *   — handled by `useMarkerSpiderfier`'s own `pendingRef` flush; this layer
 *   relies on that and does not reintroduce a per-host retry loop (the
 *   Dashboard/MeshCore bridges needed a retry loop only because their
 *   `SpiderfierController` lived behind a ref boundary; calling the hook
 *   directly here removes that boundary, matching MapAnalysis).
 * - Removal reconciliation: a `renderedKeysSig` effect drops any tracked
 *   marker whose key is no longer present, evicting it from the spiderfier
 *   and both caches (all four bridges).
 * - OMS `click` listener → default `marker.openPopup()`, or `onOmsClick`
 *   when supplied (NodesTab's rich selection+center+conditional-popup
 *   handler moves to WP6's `onOmsClick`).
 * - The `_openPopup` strip (#4015): the every-render variant (NodesTab's
 *   documented pattern, `NodesTab.tsx:1386`; duplicated at
 *   `MeshCoreMap.tsx:371`) — NOT a `renderedKeysSig`-keyed effect (that
 *   variant runs once before any marker mounts and never re-fires, per the
 *   MeshCore/Dashboard bridges' own comments), gated by
 *   `stripLeafletAutoPopup`.
 */
export function NodeMarkersLayer({
  markers,
  spiderfierOptions = SHARED_SPIDERFIER_OPTIONS,
  onOmsClick,
  stripLeafletAutoPopup = true,
}: NodeMarkersLayerProps) {
  const { addMarker, removeMarker, addListener, removeListener } = useMarkerSpiderfier(spiderfierOptions);

  const markerByKey = useRef<Map<string, LeafletMarker>>(new Map());
  const keyByMarker = useRef<WeakMap<LeafletMarker, string>>(new WeakMap());
  const refHandlers = useRef<Map<string, (m: LeafletMarker | null) => void>>(new Map());
  // Stable position/icon refs keyed by the spiderfier key — fixes the fan
  // auto-collapsing after a refresh (issue #3685). react-leaflet only
  // moves/restyles a marker when the prop *reference* changes, and doing so
  // on a spiderfied marker snaps it back to its anchor, collapsing the fan.
  const positionCacheRef = useRef<Map<string, [number, number]>>(new Map());
  const iconCacheRef = useRef<Map<string, { sig: string; icon: L.DivIcon }>>(new Map());

  const stablePosition = (key: string, lat: number, lng: number): [number, number] => {
    const cached = positionCacheRef.current.get(key);
    if (cached && cached[0] === lat && cached[1] === lng) return cached;
    const next: [number, number] = [lat, lng];
    positionCacheRef.current.set(key, next);
    return next;
  };
  const stableIcon = (key: string, sig: string, build: () => L.DivIcon): L.DivIcon => {
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
        // `useImperativeHandle(ref, () => instance)` with NO dependency
        // array, so React bounces this callback `null → instance` on EVERY
        // re-render — not just on mount/unmount. Treating `null` as
        // "removed" here would call removeMarker on a still-present (often
        // spiderfied) marker every time the data or selection changes, and
        // OMS auto-unspiderfies when a spiderfied marker is removed → the
        // fan collapses (issue #3685). So we ONLY register on an instance
        // (addMarker is idempotent) and ignore the null bounce. Genuine
        // removals are reconciled by the effect below, driven by which keys
        // are still rendered.
        if (m) {
          markerByKey.current.set(key, m);
          keyByMarker.current.set(m, key);
          addMarker(m, key);
        }
      };
      refHandlers.current.set(key, h);
    }
    return h;
  };

  // Genuine removals (a node aged out / filtered away) are reconciled here
  // rather than from the ref `null` bounce — drop any tracked marker whose
  // key is no longer rendered, and unregister it from the spiderfier. Keyed
  // off the rendered key SET so it only does work when membership actually
  // changes.
  const renderedKeysSig = markers.map((d) => d.key).join('|');
  useEffect(() => {
    const rendered = new Set(renderedKeysSig ? renderedKeysSig.split('|') : []);
    for (const key of [...markerByKey.current.keys()]) {
      if (rendered.has(key)) continue;
      const m = markerByKey.current.get(key);
      if (m) {
        removeMarker(m);
        keyByMarker.current.delete(m);
      }
      markerByKey.current.delete(key);
      refHandlers.current.delete(key);
      positionCacheRef.current.delete(key);
      iconCacheRef.current.delete(key);
    }
  }, [renderedKeysSig, removeMarker]);

  // #4015: open the popup ONLY via the OMS 'click' event, which fires solely
  // for a marker that is already spiderfied or standalone — never for the
  // click that fans out a pile. Registered here, after the hook's own
  // OMS-init effect (the hook is called directly in this component, so —
  // unlike the Dashboard/MeshCore `SpiderfierController`-ref bridges — there
  // is no ref boundary and therefore no retry dance needed; matches
  // MapAnalysis's existing (reference) variant).
  useEffect(() => {
    const onClick = (marker: LeafletMarker) => {
      if (onOmsClick) {
        onOmsClick(marker, keyByMarker.current.get(marker) ?? '');
        return;
      }
      marker.openPopup();
    };
    addListener('click', onClick);
    return () => removeListener('click', onClick);
  }, [addListener, removeListener, onOmsClick]);

  // #4015: strip Leaflet's own auto-open-on-click handler that `bindPopup`
  // installs (via the declarative <Popup> child). Without this, a pile click
  // both fans out AND opens the popup on the pre-spread stacked marker,
  // covering the markers that just spread. Popup content stays bound, so the
  // OMS-driven openPopup() above still works.
  //
  // Runs on EVERY render (no dep array) on purpose, per the every-render
  // variant NodesTab documents (NodesTab.tsx:1386): react-leaflet mounts
  // markers in a later commit than this component's first effect, so keying
  // this on a rendered-keys signature can strip before any marker exists and
  // then never re-run (a keyed effect only re-fires if the key changed — and
  // the node set is often unchanged between the mount commit and the
  // marker-mount commit). This was verified against the MeshCore map, where
  // it left popups un-stripped (duplicated at MeshCoreMap.tsx:371). Cost is
  // bounded: the per-marker `_meshPopupStripped` tag means the actual
  // `off()` runs once per marker; steady-state renders just skip.
  //
  // NOTE: `_openPopup` is Leaflet's private handler (verified against
  // leaflet@1.9.4 `Popup.js` bindPopup: `this.on({ click: this._openPopup })`).
  // It's undocumented; if a future Leaflet renames/removes it, the strip
  // becomes a no-op and we degrade to the old double-fire — annoying, not a
  // crash — so re-verify this when bumping Leaflet.
  useEffect(() => {
    if (!stripLeafletAutoPopup) return;
    for (const m of markerByKey.current.values()) {
      const mm = m as LeafletMarker & { _openPopup?: (e: unknown) => void; _meshPopupStripped?: boolean };
      if (mm._meshPopupStripped) continue;
      if (mm._openPopup) {
        mm.off('click', mm._openPopup, mm);
        mm._meshPopupStripped = true;
      }
    }
  });

  return (
    <>
      {markers.map((d) => (
        <Marker
          key={d.key}
          ref={getMarkerRef(d.key)}
          position={stablePosition(d.key, d.position[0], d.position[1])}
          icon={stableIcon(d.key, d.iconSig, d.buildIcon)}
          opacity={d.opacity}
          zIndexOffset={d.zIndexOffset}
          eventHandlers={d.eventHandlers}
        >
          {d.children}
        </Marker>
      ))}
    </>
  );
}
