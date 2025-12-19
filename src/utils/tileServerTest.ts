/**
 * Tile Server Test Utility
 *
 * Tests tile server connectivity and validates vector tile schema compatibility
 * for the custom tileset manager.
 */

import Pbf from 'pbf';

/**
 * Expected source layers in OpenMapTiles schema
 * These are the layers that VectorTileLayer.tsx styles and renders
 */
export const EXPECTED_VECTOR_LAYERS = [
  'water',
  'landuse',
  'landcover',
  'park',
  'building',
  'transportation',
  'boundary',
  'place'
] as const;

export interface TileTestResult {
  success: boolean;
  status: 'success' | 'warning' | 'error';
  tileType: 'raster' | 'vector' | 'unknown';
  message: string;
  errors: string[];
  warnings: string[];
  details: {
    responseTime?: number;
    contentType?: string;
    tileSize?: number;
    httpStatus?: number;
    vectorLayers?: string[];
    matchedLayers?: string[];
    missingLayers?: string[];
  };
}

/**
 * Detect if URL is for vector tiles based on extension
 */
function isVectorTileUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('.pbf') || lowerUrl.includes('.mvt');
}

/**
 * Parse vector tile to extract layer names
 * Vector tiles use a custom protobuf format with layers
 */
function parseVectorTileLayers(data: ArrayBuffer): string[] {
  const layers: string[] = [];

  try {
    const pbf = new Pbf(new Uint8Array(data));

    // Vector tile format: repeated Layer layers = 3
    // Each layer has: required string name = 1
    while (pbf.pos < pbf.buf.length) {
      const tag = pbf.readVarint();
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;

      if (fieldNum === 3 && wireType === 2) {
        // Layer (length-delimited message)
        const layerEnd = pbf.readVarint() + pbf.pos;

        // Read layer name (field 1, string)
        while (pbf.pos < layerEnd) {
          const layerTag = pbf.readVarint();
          const layerFieldNum = layerTag >> 3;
          const layerWireType = layerTag & 0x7;

          if (layerFieldNum === 1 && layerWireType === 2) {
            const name = pbf.readString();
            if (name && !layers.includes(name)) {
              layers.push(name);
            }
          } else {
            // Skip other fields
            pbf.skip(layerWireType);
          }
        }

        pbf.pos = layerEnd;
      } else {
        // Skip unknown fields
        pbf.skip(wireType);
      }
    }
  } catch {
    // Failed to parse, return empty array
  }

  return layers;
}

/**
 * Check vector tile layer compatibility with expected OpenMapTiles schema
 */
function checkLayerCompatibility(foundLayers: string[]): {
  matched: string[];
  missing: string[];
  extra: string[];
} {
  const matched = EXPECTED_VECTOR_LAYERS.filter(layer =>
    foundLayers.includes(layer)
  );
  const missing = EXPECTED_VECTOR_LAYERS.filter(layer =>
    !foundLayers.includes(layer)
  );
  const extra = foundLayers.filter(layer =>
    !EXPECTED_VECTOR_LAYERS.includes(layer as typeof EXPECTED_VECTOR_LAYERS[number])
  );

  return { matched, missing, extra };
}

/**
 * Test a tile server URL for connectivity and compatibility
 *
 * @param url - Tile URL template with {z}, {x}, {y} placeholders
 * @param timeout - Request timeout in milliseconds (default 5000)
 * @returns TileTestResult with success status, warnings, and details
 */
export async function testTileServer(
  url: string,
  timeout: number = 5000
): Promise<TileTestResult> {
  const startTime = Date.now();
  const result: TileTestResult = {
    success: false,
    status: 'error',
    tileType: 'unknown',
    message: '',
    errors: [],
    warnings: [],
    details: {}
  };

  // Validate URL has required placeholders
  if (!url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
    result.errors.push('URL must contain {z}, {x}, and {y} placeholders');
    result.message = 'Invalid URL format';
    return result;
  }

  // Replace placeholders with zoom level 0 (always exists)
  const testUrl = url
    .replace(/{z}/g, '0')
    .replace(/{x}/g, '0')
    .replace(/{y}/g, '0')
    .replace(/{s}/g, 'a');

  const isVector = isVectorTileUrl(url);
  result.tileType = isVector ? 'vector' : 'raster';

  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal,
      mode: 'cors',
      cache: 'no-store'
    });

    clearTimeout(timeoutId);

    result.details.responseTime = Date.now() - startTime;
    result.details.httpStatus = response.status;
    result.details.contentType = response.headers.get('content-type') || undefined;

    // Check HTTP status
    if (!response.ok) {
      if (response.status === 404) {
        result.errors.push(`Tile not found (404). The tile server may not have tiles at zoom level 0.`);
      } else if (response.status === 403) {
        result.errors.push(`Access denied (403). The tile server requires authentication or doesn't allow access from this origin.`);
      } else {
        result.errors.push(`Server returned error: ${response.status} ${response.statusText}`);
      }
      result.message = `HTTP ${response.status}`;
      return result;
    }

    // Get response data
    const data = await response.arrayBuffer();
    result.details.tileSize = data.byteLength;

    if (data.byteLength === 0) {
      result.errors.push('Server returned empty response');
      result.message = 'Empty response';
      return result;
    }

    // Validate based on tile type
    if (isVector) {
      // Parse vector tile layers
      const layers = parseVectorTileLayers(data);
      result.details.vectorLayers = layers;

      if (layers.length === 0) {
        // Could be empty tile at z=0 or parsing failed
        result.warnings.push('No layers found in tile. This could be normal for zoom level 0, or the tile format may be incompatible.');
      } else {
        const compatibility = checkLayerCompatibility(layers);
        result.details.matchedLayers = compatibility.matched;
        result.details.missingLayers = compatibility.missing;

        if (compatibility.matched.length === 0) {
          result.errors.push(
            `No compatible layers found. Expected OpenMapTiles schema with layers like: ${EXPECTED_VECTOR_LAYERS.slice(0, 4).join(', ')}, etc.`
          );
          result.warnings.push(`Found layers: ${layers.join(', ')}`);
          result.message = 'Incompatible schema';
          result.status = 'error';
          return result;
        }

        if (compatibility.missing.length > 0) {
          result.warnings.push(
            `Missing some expected layers: ${compatibility.missing.join(', ')}. Some map features may not display.`
          );
        }

        if (compatibility.matched.length >= EXPECTED_VECTOR_LAYERS.length / 2) {
          result.success = true;
          result.status = compatibility.missing.length > 0 ? 'warning' : 'success';
        } else {
          result.status = 'warning';
          result.success = true;
        }
      }

      // If we got here with no errors, consider it a success
      if (result.errors.length === 0 && !result.success) {
        result.success = true;
        result.status = result.warnings.length > 0 ? 'warning' : 'success';
      }
    } else {
      // Raster tile validation
      const contentType = result.details.contentType?.toLowerCase() || '';

      if (contentType.includes('image/') ||
          contentType.includes('png') ||
          contentType.includes('jpeg') ||
          contentType.includes('jpg') ||
          contentType.includes('webp')) {
        result.success = true;
        result.status = 'success';
      } else if (contentType.includes('application/json') || contentType.includes('text/')) {
        // Might be an error response or metadata
        result.warnings.push(`Unexpected content type: ${contentType}. Expected image/png or image/jpeg.`);

        // Try to read as text to show error
        try {
          const text = new TextDecoder().decode(data);
          if (text.length < 500) {
            result.warnings.push(`Response: ${text}`);
          }
        } catch {
          // Ignore decode errors
        }

        result.success = true;
        result.status = 'warning';
      } else {
        // Unknown content type, but we got data
        result.success = true;
        result.status = 'warning';
        if (contentType) {
          result.warnings.push(`Unexpected content type: ${contentType}`);
        }
      }
    }

    // Set success message
    if (result.success) {
      const typeLabel = isVector ? 'Vector (PBF)' : 'Raster';
      result.message = `${typeLabel} tile loaded successfully`;
    }

  } catch (error) {
    result.details.responseTime = Date.now() - startTime;

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        result.errors.push(`Request timed out after ${timeout}ms. The tile server may be slow or unreachable.`);
        result.message = 'Timeout';
      } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        // CORS or network error
        result.errors.push(
          'Failed to connect. This is usually caused by CORS (Cross-Origin) restrictions on the tile server.'
        );
        result.errors.push(
          'Fix: Configure your tile server to allow requests from this origin, or use a tile server that supports CORS.'
        );
        result.message = 'Connection failed (CORS?)';
      } else {
        result.errors.push(`Error: ${error.message}`);
        result.message = 'Connection failed';
      }
    } else {
      result.errors.push('Unknown error occurred');
      result.message = 'Unknown error';
    }
  }

  return result;
}

/**
 * Format tile size for display
 */
export function formatTileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
