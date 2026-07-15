export interface MapTilesetPayload {
  mapTileset?: string | null;
  mapTilesetLight?: string | null;
  mapTilesetDark?: string | null;
}

export function getMapTilesetValidationError(payload: MapTilesetPayload): string | null {
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `${key} must be a string or null`;
    }
  }
  return null;
}

export function normalizeMapTilesetPayload(payload: MapTilesetPayload): MapTilesetPayload {
  const { mapTileset, mapTilesetLight, mapTilesetDark } = payload;
  return {
    mapTileset,
    mapTilesetLight: mapTilesetLight ?? (mapTileset !== undefined ? mapTileset : undefined),
    mapTilesetDark: mapTilesetDark ?? (mapTileset !== undefined ? mapTileset : undefined),
  };
}
