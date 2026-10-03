import { useSettings } from '../../contexts/SettingsContext';
import type { CustomTileset, TilesetId } from '../../config/tilesets';

/** The tile-layer props every settings-driven `BaseMap` needs. */
export interface BaseMapSettings {
  tilesetId: TilesetId;
  customTilesets: CustomTileset[];
  cartoApiKey: string | null;
  styleJson: Record<string, unknown> | undefined;
}

/**
 * The user's basemap settings, shaped as `BaseMap` props (#5555).
 *
 * Spread the result onto `BaseMap` (`<BaseMap {...baseMapSettings} …>`) so a
 * surface can never pass the tileset but forget the CARTO key — that is how
 * the Traceroute Explorer and Coverage Report maps ended up with watermark
 * tiles while the main map rendered clean.
 *
 * `BaseMap` itself stays settings-agnostic because `EmbedMap` renders it
 * outside a `SettingsProvider` and feeds these props from its embed config.
 */
export function useBaseMapSettings(): BaseMapSettings {
  const { mapTileset, customTilesets, cartoApiKey, activeStyleJson } = useSettings();
  return {
    tilesetId: mapTileset,
    customTilesets,
    cartoApiKey,
    styleJson: activeStyleJson ?? undefined,
  };
}
