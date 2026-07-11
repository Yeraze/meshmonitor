import type { CSSProperties, ReactNode, Ref } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { MapContainer, TileLayer } from 'react-leaflet';
import { getTilesetById, DEFAULT_TILESET_ID, type TilesetId, type CustomTileset } from '../../config/tilesets';
import { VectorTileLayer } from '../VectorTileLayer';
import { TilesetSelector } from '../TilesetSelector';
import MapResizeHandler from '../MapResizeHandler';
import './leafletDefaultIcon';

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
   *  MapResizeHandler). Omit ⇒ handler NOT mounted (no behavior change). */
  resizeTrigger?: unknown;

  // ---- Map instance access ------------------------------------------------
  /** Forwarded to MapContainer's ref → resolves to the Leaflet map. */
  mapRef?: Ref<LeafletMap>;

  // ---- Composition --------------------------------------------------------
  /** Markers, draw handlers, overlays, useMap-based controllers. Rendered
   *  inside MapContainer, after the tile layer. */
  children?: ReactNode;
}

/**
 * Shared map shell (Map Consolidation epic #4047, Phase 1).
 *
 * Owns: the MapContainer element, the raster-vs-vector tile layer branch, an
 * optional TilesetSelector overlay (rendered as a sibling AFTER MapContainer
 * — never inside it, see docs/internal/dev-notes/MAP_CONSOLIDATION_P1_SPEC.md
 * §2.2/§6.10), and an optional gated MapResizeHandler.
 *
 * The tile layer (both the raster `TileLayer` and vector `VectorTileLayer`
 * branches) is keyed by the resolved tileset id (Phase 7, §2.1) so a tileset
 * swap force-remounts a clean layer instead of react-leaflet patching props
 * onto the old one in place — matches DashboardMap's pre-BaseMap
 * `key={tilesetId}` remount semantics. For the 4 Phase-1 editors, which omit
 * `tilesetId`, the resolved id is the constant `DEFAULT_TILESET_ID`, so the
 * key never changes and there is no remount/behavior change.
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
}: BaseMapProps) {
  const resolvedId = tilesetId ?? DEFAULT_TILESET_ID;
  const tileset = getTilesetById(resolvedId, customTilesets ?? []);

  return (
    <>
      <MapContainer
        center={center}
        zoom={zoom}
        ref={mapRef}
        className={className}
        style={{ height: '100%', width: '100%', ...mapStyle }}
        scrollWheelZoom={scrollWheelZoom}
        doubleClickZoom={doubleClickZoom}
        zoomControl={zoomControl}
        attributionControl={attributionControl}
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
            <TileLayer
              key={resolvedId}
              url={tileset.url}
              attribution={tileset.attribution}
              maxZoom={tileset.maxZoom}
            />
          )}
        {resizeTrigger !== undefined && <MapResizeHandler trigger={resizeTrigger} />}
        {children}
      </MapContainer>
      {showTilesetSelector && (
        <TilesetSelector
          selectedTilesetId={resolvedId}
          onTilesetChange={onTilesetChange ?? (() => {})}
        />
      )}
    </>
  );
}
