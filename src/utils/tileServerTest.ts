/**
 * Tile Server Test Utility
 *
 * Tests tile server connectivity and validates vector tile schema compatibility
 * for the custom tileset manager.
 */

/**
 * Expected source layers in OpenMapTiles schema
 * These are the layers that VectorTileLayer.tsx styles and renders
 */
export const EXPECTED_VECTOR_LAYERS = [
  'water',
  'waterway',
  'landuse',
  'landcover',
  'park',
  'building',
  'aeroway',
  'transportation',
  'transportation_name',
  'boundary',
  'place',
  'water_name',
  'poi'
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
  // Route through backend proxy to avoid CORS issues when testing
  // new tileservers that aren't in the allowed origins yet
  try {
    const { default: api } = await import('../services/api.js');
    const apiBase = await api.getBaseUrl();

    const csrfToken = sessionStorage.getItem('csrfToken');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch(`${apiBase}/api/tile-server/test`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ url, timeout })
    });

    if (!response.ok) {
      return {
        success: false,
        status: 'error',
        tileType: 'unknown',
        message: `Server error: ${response.status}`,
        errors: [`Server returned ${response.status} ${response.statusText}`],
        warnings: [],
        details: {}
      };
    }

    return await response.json();
  } catch (error) {
    return {
      success: false,
      status: 'error',
      tileType: 'unknown',
      message: 'Test failed',
      errors: [error instanceof Error ? error.message : 'Unknown error'],
      warnings: [],
      details: {}
    };
  }
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

export interface AutodetectResult {
  success: boolean;
  detectedUrls: Array<{
    url: string;
    type: 'vector' | 'raster';
    protocol: 'http' | 'https';
    testResult: TileTestResult;
  }>;
  baseUrl: string;
  testedPatterns: number;
  errors: string[];
}

export interface AutodetectProgress {
  current: number;
  total: number;
  currentUrl: string;
  phase: 'http' | 'https';
}

/**
 * Autodetect tile server URL by testing common patterns
 * Uses backend API to avoid CORS restrictions
 *
 * @param baseUrl - Base URL or hostname:port to test
 * @param _onProgress - Optional callback for progress updates (not used with backend API)
 * @returns AutodetectResult with all working URLs found
 */
export async function autodetectTileServer(
  baseUrl: string,
  _onProgress?: (progress: AutodetectProgress) => void
): Promise<AutodetectResult> {
  try {
    // Dynamically import api to avoid circular dependencies
    const { default: api } = await import('../services/api.js');
    const apiBase = await api.getBaseUrl();

    // Get CSRF token from sessionStorage
    const csrfToken = sessionStorage.getItem('csrfToken');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const response = await fetch(`${apiBase}/api/tile-server/autodetect`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ baseUrl })
    });

    if (!response.ok) {
      return {
        success: false,
        detectedUrls: [],
        baseUrl,
        testedPatterns: 0,
        errors: [`Server error: ${response.status} ${response.statusText}`]
      };
    }

    return await response.json();
  } catch (error) {
    return {
      success: false,
      detectedUrls: [],
      baseUrl,
      testedPatterns: 0,
      errors: [error instanceof Error ? error.message : 'Failed to connect to server']
    };
  }
}
