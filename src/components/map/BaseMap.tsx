import type { CSSProperties, ReactNode, Ref } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { MapContainer, TileLayer } from 'react-leaflet';
import { getTilesetById, DEFAULT_TILESET_ID, type TilesetId, type CustomTileset } from '../../config/tilesets';
import { withCartoKey } from '../../config/cartoKey';
import { VectorTileLayer } from '../VectorTileLayer';
import { TilesetSelector } from '../TilesetSelector';
import MapResizeHandler from '../MapResizeHandler';
import { MapSidebar } from './MapSidebar';
import './leafletDefaultIcon';
import './BaseMap.css';

export interface BaseMapProps {
  /** Initial center. Like react-leaflet, this is applied once at mount and is
   *  NOT reactive — view changes after mount are the caller's job (child
   *  controllers / fitBounds). */
  center: [number, number];
  /** Initial zoom (mount-only, same non-reactivity as `center`). */
  zoom: number;

  // ---- Tile layer selection ----------------------------------------------
  /** Tileset id. Omitted ⇒ DEFAULT_TILESET_ID ('osm', raster). The 4 Phase-1
   *  editors omit it. */
  tilesetId?: TilesetId;
  /** Needed only to resolve `custom-*` ids. Default []. */
  customTilesets?: CustomTileset[];
  /** MapLibre style JSON passthrough for vector tilesets (ignored for raster). */
  styleJson?: Record<string, unknown>;
  /** Deployment-wide Carto basemap API key (#4934). When set, it is appended as
   *  `?key=` to Carto CDN tile URLs (no-op for every other host). Omit/null ⇒
   *  keyless (Carto tiles show the "API key required" watermark). */
  cartoApiKey?: string | null;

  // ---- Optional tileset selector overlay ---------------------------------
  /** Render the TilesetSelector overlay. Default false. */
  showTilesetSelector?: boolean;
  /** Required to be useful when showTilesetSelector is true. */
  onTilesetChange?: (id: TilesetId) => void;

  // ---- MapContainer passthroughs (explicit, type-safe) -------------------
  scrollWheelZoom?: boolean;      // default: leaflet default (true) unless caller overrides
  doubleClickZoom?: boolean;
  zoomControl?: boolean;
  attributionControl?: boolean;
  /** Merged into MapContainer style; default { height: '100%', width: '100%' }. */
  mapStyle?: CSSProperties;
  /** className on the MapContainer element. */
  className?: string;

  // ---- Resize handling ----------------------------------------------------
  /** When this value changes, BaseMap calls map.invalidateSize() (via
   *  MapResizeHandler). For *internal* layout state (list collapse, drawer
   *  height) whose CSS transition an observer only sees late.
   *
   *  Viewport changes (rotation, browser chrome, split view) need no trigger:
   *  MapResizeHandler is mounted unconditionally since #5054 and watches the
   *  map container itself. Omitting this prop leaves only that path active. */
  resizeTrigger?: unknown;

  // ---- Map instance access ------------------------------------------------
  /** Forwarded to MapContainer's ref → resolves to the Leaflet map. */
  mapRef?: Ref<LeafletMap>;

  // ---- Composition --------------------------------------------------------
  /** Markers, draw handlers, overlays, useMap-based controllers. Rendered
   *  inside MapContainer, after the tile layer. */
  children?: ReactNode;

  // ---- Unified controls sidebar (#4909) ----------------------------------
  /** Map control panels (legend, feature toggles, tileset picker) to stack in
   *  a single collapsible right-edge sidebar. Rendered as a sibling overlay
   *  after MapContainer. Omit ⇒ no sidebar. */
  sidebar?: ReactNode;
  /** localStorage key for the sidebar's collapsed state (per surface). */
  sidebarStorageKey?: string;
  /** Sidebar header/accessible label. */
  sidebarTitle?: string;
}

/**
 * Shared map shell (Map Consolidation epic #4047, Phase 1).
 *
 * Owns: the MapContainer element, the raster-vs-vector tile layer branch, an
 * optional TilesetSelector overlay (rendered as a sibling AFTER MapContainer
 * — never inside it, see docs/internal/dev-notes/MAP_CONSOLIDATION_P1_SPEC.md
 * §2.2/§6.10), and the MapResizeHandler that keeps Leaflet's cached container
 * size honest.
 *
 * Tile-layer keys differ by branch on purpose:
 *
 * - **Raster `TileLayer`** is keyed by `maxZoom`, NOT the tileset id. In
 *   react-leaflet 5's `updateTileLayer`, a `url` change already calls
 *   `layer.setUrl(url)` for a graceful in-place tile refresh (old tiles stay
 *   until the new ones load). Keying on the id instead force-remounted the
 *   layer on every tileset change — including the once-per-load global→user
 *   `mapTileset` flip — which tore the layer down and left the in-flight tile
 *   batch `net::ERR_ABORTED`, i.e. a blank/flickering map while loading
 *   (regression vs NodesTab's pre-BaseMap keyless `TileLayer`). The only
 *   options `updateGridLayer`/`setUrl` do NOT patch are `maxZoom` and
 *   `maxNativeZoom`, so we remount only when a zoom ceiling genuinely
 *   changes; same-ceiling swaps (the common case, e.g. osm↔carto↔osmHot, all
 *   19 with no native cap) refresh in place. `maxNativeZoom` is part of the
 *   key because esriDarkGray shares maxZoom 19 with the rest but caps native
 *   tiles at 16 (#5015) — keying on maxZoom alone would leave a stale
 *   uncapped layer requesting blank z17+ tiles after switching to it.
 * - **Vector `VectorTileLayer`** is keyed by the resolved tileset id: a
 *   MapLibre style/url change needs a clean remount, and raster↔vector swaps
 *   remount anyway (different component type).
 *
 * For the 4 Phase-1 editors, which omit `tilesetId`, the resolved id is the
 * constant `DEFAULT_TILESET_ID` (raster, maxZoom 19), so neither key ever
 * changes and there is no remount/behavior change.
 *
 * Everything else (markers, draw handlers, view controllers) is the caller's
 * `children`. BaseMap is persistence-agnostic: it takes a controlled
 * `tilesetId`/`onTilesetChange` pair and never reads `useSettings()` itself.
 */
export function BaseMap({
  center,
  zoom,
  tilesetId,
  customTilesets,
  styleJson,
  cartoApiKey,
  showTilesetSelector = false,
  onTilesetChange,
  scrollWheelZoom,
  doubleClickZoom,
  zoomControl,
  attributionControl,
  mapStyle,
  className,
  resizeTrigger,
  mapRef,
  children,
  sidebar,
  sidebarStorageKey,
  sidebarTitle,
}: BaseMapProps) {
  const resolvedId = tilesetId ?? DEFAULT_TILESET_ID;
  const tileset = getTilesetById(resolvedId, customTilesets ?? []);

  // Leaflet's setOptions copies EVERY own key of the options object, so an
  // explicit `scrollWheelZoom: undefined` OVERRIDES the prototype default
  // (true) and disables the handler — react-leaflet does no undefined
  // filtering before `new LeafletMap(node, options)`. Omitted props must
  // therefore not appear in the options object at all (#4047 regression:
  // wheel zoom / double-click zoom died on every consumer that relied on
  // Leaflet defaults).
  const interactionOptions: {
    scrollWheelZoom?: boolean;
    doubleClickZoom?: boolean;
    zoomControl?: boolean;
    attributionControl?: boolean;
  } = {};
  if (scrollWheelZoom !== undefined) interactionOptions.scrollWheelZoom = scrollWheelZoom;
  if (doubleClickZoom !== undefined) interactionOptions.doubleClickZoom = doubleClickZoom;
  if (zoomControl !== undefined) interactionOptions.zoomControl = zoomControl;
  if (attributionControl !== undefined) interactionOptions.attributionControl = attributionControl;

  return (
    <>
      <MapContainer
        center={center}
        zoom={zoom}
        ref={mapRef}
        className={className}
        style={{ height: '100%', width: '100%', ...mapStyle }}
        {...interactionOptions}
      >
        {tileset.isVector
          ? (
            <VectorTileLayer
              key={resolvedId}
              url={tileset.url}
              attribution={tileset.attribution}
              maxZoom={tileset.maxZoom}
              styleJson={styleJson}
            />
          )
          : (
            <>
              <TileLayer
                key={`raster-${tileset.maxZoom}-${tileset.maxNativeZoom ?? ''}`}
                url={withCartoKey(tileset.url, cartoApiKey)}
                attribution={tileset.attribution}
                maxZoom={tileset.maxZoom}
                maxNativeZoom={tileset.maxNativeZoom}
                // Damp ESRI World_Imagery's over-saturated synthetic water blue
                // on our provided satellite tilesets (#4860). Base tiles only —
                // the hybrid label overlay below is left untouched.
                // Per-tileset base-layer tone adjustments. Both are BASE-only:
                // each tileset's label overlay is a separate TileLayer below
                // and must stay unfiltered to remain legible.
                //   - satellite: damp ESRI World_Imagery's synthetic water blue (#4860)
                //   - dark gray: darken ESRI's mid-gray "Dark Gray" canvas so it
                //     actually reads as dark in a dark-themed UI (#5015)
                className={
                  tileset.id === 'esriSatellite' || tileset.id === 'esriHybrid'
                    ? 'mm-satellite-base-tile'
                    : tileset.id === 'esriDarkGray'
                      ? 'mm-dark-gray-base-tile'
                      : undefined
                }
              />
              {/* Optional transparent label/road overlay drawn on top of the
                  base raster (e.g. the satellite+labels hybrid). Keyed like the
                  base by maxZoom so same-ceiling swaps refresh in place; a
                  higher zIndex keeps it above the base tiles. Absent when the
                  tileset defines no overlayUrl. */}
              {tileset.overlayUrl && (
                <TileLayer
                  key={`raster-overlay-${tileset.maxZoom}-${tileset.maxNativeZoom ?? ''}`}
                  url={withCartoKey(tileset.overlayUrl, cartoApiKey)}
                  attribution={tileset.overlayAttribution ?? tileset.attribution}
                  maxZoom={tileset.maxZoom}
                  maxNativeZoom={tileset.maxNativeZoom}
                  zIndex={10}
                />
              )}
            </>
          )}
        {/* Always mounted (#5054). It used to be gated on `resizeTrigger !==
            undefined`, which meant only the three surfaces that pass internal
            layout state ever invalidated — nothing in the app watched the
            viewport, so a phone rotation left every map drawing tiles for the
            pre-rotation box and rotating back did not recover it. The handler
            now owns a ResizeObserver on the map container; the prop remains the
            caller-driven path for layout changes an observer sees only after a
            CSS transition, and stays dormant when omitted. */}
        <MapResizeHandler trigger={resizeTrigger} />
        {children}
      </MapContainer>
      {showTilesetSelector && (
        <TilesetSelector
          selectedTilesetId={resolvedId}
          onTilesetChange={onTilesetChange ?? (() => {})}
        />
      )}
      {sidebar && (
        <MapSidebar storageKey={sidebarStorageKey} title={sidebarTitle}>
          {sidebar}
        </MapSidebar>
      )}
    </>
  );
}
