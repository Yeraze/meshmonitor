/**
 * Tile Server Test Routes
 *
 * Backend proxy for testing tile server connectivity, avoiding browser CORS restrictions.
 */

import express from 'express';
import net from 'net';
import dns from 'dns';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const dnsLookup = promisify(dns.lookup);

const router = express.Router();

/**
 * Common tile URL patterns to test during autodetection
 */
const TILE_URL_PATTERNS = {
  vector: [
    // tileserver-gl patterns
    '/data/v3/{z}/{x}/{y}.pbf',
    '/data/{z}/{x}/{y}.pbf',
    '/tiles/{z}/{x}/{y}.pbf',
    '/tiles/v3/{z}/{x}/{y}.pbf',
    '/{z}/{x}/{y}.pbf',
    // MVT patterns
    '/data/v3/{z}/{x}/{y}.mvt',
    '/data/{z}/{x}/{y}.mvt',
    '/tiles/{z}/{x}/{y}.mvt',
    '/{z}/{x}/{y}.mvt',
  ],
  raster: [
    // tileserver-gl raster patterns
    '/styles/basic-preview/{z}/{x}/{y}.png',
    '/styles/bright/{z}/{x}/{y}.png',
    '/styles/osm-bright/{z}/{x}/{y}.png',
    // Standard patterns
    '/tiles/{z}/{x}/{y}.png',
    '/{z}/{x}/{y}.png',
    '/tiles/{z}/{x}/{y}.jpg',
    '/{z}/{x}/{y}.jpg',
  ]
};

/**
 * Expected source layers in OpenMapTiles schema
 */
const EXPECTED_VECTOR_LAYERS = [
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
];

interface TileTestResult {
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

interface AutodetectResult {
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

/**
 * Detect if URL is for vector tiles based on extension
 */
function isVectorTileUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('.pbf') || lowerUrl.includes('.mvt');
}

/**
 * Parse vector tile to extract layer names using basic protobuf parsing
 * This is a simplified parser that only extracts layer names for validation.
 */
function parseVectorTileLayers(data: Buffer): string[] {
  const layers: string[] = [];
  const maxIterations = 10000; // Safety limit to prevent infinite loops

  try {
    let pos = 0;
    let iterations = 0;

    const readVarint = (): number => {
      let result = 0;
      let shift = 0;
      while (pos < data.length && shift < 35) { // Max 5 bytes for 32-bit varint
        const byte = data[pos++];
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      return result >>> 0; // Ensure unsigned
    };

    const skipField = (wireType: number): boolean => {
      const startPos = pos;
      switch (wireType) {
        case 0: // Varint
          readVarint();
          break;
        case 1: // 64-bit fixed
          pos += 8;
          break;
        case 2: // Length-delimited
          pos += readVarint();
          break;
        case 5: // 32-bit fixed
          pos += 4;
          break;
        default:
          // Unknown wire type - skip one byte to make progress
          pos += 1;
          return false;
      }
      return pos > startPos; // Return true if we made progress
    };

    // Vector tile format: repeated Layer layers = 3
    while (pos < data.length && iterations < maxIterations) {
      iterations++;
      const startPos = pos;

      const tag = readVarint();
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;

      if (fieldNum === 3 && wireType === 2) {
        // Layer (length-delimited message)
        const layerLen = readVarint();
        const layerEnd = Math.min(pos + layerLen, data.length);

        // Read layer name (field 1, string) - just scan for the first string field
        let layerIterations = 0;
        while (pos < layerEnd && layerIterations < 1000) {
          layerIterations++;
          const innerStartPos = pos;

          const layerTag = readVarint();
          const layerFieldNum = layerTag >> 3;
          const layerWireType = layerTag & 0x7;

          if (layerFieldNum === 1 && layerWireType === 2) {
            // Found the name field
            const nameLen = readVarint();
            if (nameLen > 0 && nameLen < 256 && pos + nameLen <= data.length) {
              const name = data.slice(pos, pos + nameLen).toString('utf-8');
              pos += nameLen;
              if (name && !layers.includes(name)) {
                layers.push(name);
              }
            }
            // Skip to end of this layer since we found the name
            pos = layerEnd;
            break;
          } else {
            if (!skipField(layerWireType)) {
              // Couldn't skip field, jump to layer end
              pos = layerEnd;
              break;
            }
          }

          // Safety: ensure we're making progress
          if (pos <= innerStartPos) {
            pos = layerEnd;
            break;
          }
        }

        pos = layerEnd;
      } else {
        if (!skipField(wireType)) {
          // Couldn't skip field, break to avoid infinite loop
          break;
        }
      }

      // Safety: ensure we're making progress
      if (pos <= startPos) {
        break;
      }
    }
  } catch {
    // Failed to parse, return whatever we found
  }

  return layers;
}

/**
 * Check vector tile layer compatibility
 */
function checkLayerCompatibility(foundLayers: string[]): {
  matched: string[];
  missing: string[];
} {
  const matched = EXPECTED_VECTOR_LAYERS.filter(layer => foundLayers.includes(layer));
  const missing = EXPECTED_VECTOR_LAYERS.filter(layer => !foundLayers.includes(layer));
  return { matched, missing };
}

/**
 * Test a single tile URL
 */
async function testTileUrl(url: string, timeout: number = 5000): Promise<TileTestResult> {
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

  // Replace placeholders with zoom level 0
  const testUrl = url
    .replace(/{z}/g, '0')
    .replace(/{x}/g, '0')
    .replace(/{y}/g, '0')
    .replace(/{s}/g, 'a');

  const isVector = isVectorTileUrl(url);
  result.tileType = isVector ? 'vector' : 'raster';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(testUrl, {
      method: 'GET',
      signal: controller.signal
    });

    result.details.responseTime = Date.now() - startTime;
    result.details.httpStatus = response.status;
    result.details.contentType = response.headers.get('content-type') || undefined;

    if (!response.ok) {
      clearTimeout(timeoutId);
      if (response.status === 404) {
        result.errors.push('Tile not found (404). The tile server may not have tiles at zoom level 0.');
      } else if (response.status === 403) {
        result.errors.push('Access denied (403). The tile server requires authentication.');
      } else {
        result.errors.push(`Server returned error: ${response.status} ${response.statusText}`);
      }
      result.message = `HTTP ${response.status}`;
      return result;
    }

    // Keep timeout active during body read - arrayBuffer() can hang if connection is slow
    // Use race with timeout to ensure we don't hang on body read
    const remainingTimeout = timeout - (Date.now() - startTime);
    const data = await Promise.race([
      response.arrayBuffer(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Body read timeout')), Math.max(remainingTimeout, 500))
      )
    ]);
    clearTimeout(timeoutId);
    result.details.tileSize = data.byteLength;

    if (data.byteLength === 0) {
      result.errors.push('Server returned empty response');
      result.message = 'Empty response';
      return result;
    }

    if (isVector) {
      const layers = parseVectorTileLayers(Buffer.from(data));
      result.details.vectorLayers = layers;

      if (layers.length === 0) {
        result.warnings.push('No layers found in tile. This could be normal for zoom level 0.');
      } else {
        const compatibility = checkLayerCompatibility(layers);
        result.details.matchedLayers = compatibility.matched;
        result.details.missingLayers = compatibility.missing;

        if (compatibility.matched.length === 0) {
          result.errors.push('No compatible layers found. Expected OpenMapTiles schema.');
          result.warnings.push(`Found layers: ${layers.join(', ')}`);
          result.message = 'Incompatible schema';
          result.status = 'error';
          return result;
        }

        if (compatibility.missing.length > 0) {
          result.warnings.push(`Missing some expected layers: ${compatibility.missing.join(', ')}`);
        }
      }

      result.success = true;
      result.status = result.warnings.length > 0 ? 'warning' : 'success';
    } else {
      // Raster tile validation
      const contentType = result.details.contentType?.toLowerCase() || '';

      if (contentType.includes('image/') ||
          contentType.includes('png') ||
          contentType.includes('jpeg') ||
          contentType.includes('webp')) {
        result.success = true;
        result.status = 'success';
      } else {
        result.success = true;
        result.status = 'warning';
        if (contentType) {
          result.warnings.push(`Unexpected content type: ${contentType}`);
        }
      }
    }

    if (result.success) {
      const typeLabel = isVector ? 'Vector (PBF)' : 'Raster';
      result.message = `${typeLabel} tile loaded successfully`;
    }

  } catch (error) {
    result.details.responseTime = Date.now() - startTime;

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        result.errors.push(`Request timed out after ${timeout}ms`);
        result.message = 'Timeout';
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
 * Parse a base URL from user input
 */
function parseBaseUrl(input: string): { host: string; port?: string } | null {
  let cleanInput = input.trim();

  // Remove any path components
  cleanInput = cleanInput.split('/').slice(0, 3).join('/');

  // Add protocol if missing
  if (!cleanInput.startsWith('http://') && !cleanInput.startsWith('https://')) {
    cleanInput = 'http://' + cleanInput;
  }

  try {
    const url = new URL(cleanInput);
    return {
      host: url.hostname,
      port: url.port || undefined
    };
  } catch {
    return null;
  }
}

/**
 * Build full tile URL from base and pattern
 */
function buildTileUrl(protocol: 'http' | 'https', host: string, port: string | undefined, pattern: string): string {
  const portSuffix = port ? `:${port}` : '';
  return `${protocol}://${host}${portSuffix}${pattern}`;
}

/**
 * POST /api/tile-server/test
 * Test a single tile URL
 */
router.post('/test', async (req, res) => {
  const { url, timeout = 5000 } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const result = await testTileUrl(url, timeout);
    res.json(result);
  } catch (error) {
    logger.error('Tile server test error:', error);
    res.status(500).json({ error: 'Test failed' });
  }
});

/**
 * Run promises with limited concurrency to avoid overwhelming the system
 */
async function runWithConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  const executing: Set<Promise<void>> = new Set();

  for (const task of tasks) {
    const promise = (async () => {
      try {
        const result = await task();
        results.push(result);
      } catch {
        // Task failed, don't add to results
      }
    })();

    executing.add(promise);
    promise.finally(() => executing.delete(promise));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * POST /api/tile-server/autodetect
 * Autodetect tile server URL by testing common patterns
 */
router.post('/autodetect', async (req, res) => {
  const { baseUrl } = req.body;

  if (!baseUrl || typeof baseUrl !== 'string') {
    return res.status(400).json({ error: 'baseUrl is required' });
  }

  const result: AutodetectResult = {
    success: false,
    detectedUrls: [],
    baseUrl,
    testedPatterns: 0,
    errors: []
  };

  const parsed = parseBaseUrl(baseUrl);
  if (!parsed) {
    result.errors.push('Invalid base URL format. Enter a hostname:port or full URL.');
    return res.json(result);
  }

  const { host, port } = parsed;

  // Determine protocols to test - try most likely first
  const protocols: Array<'http' | 'https'> = [];
  if (port === '443') {
    protocols.push('https');
  } else if (port === '80' || !port) {
    protocols.push('http');
    if (!port) protocols.push('https');
  } else {
    // Custom port - HTTP is most common for local tile servers
    protocols.push('http', 'https');
  }

  logger.info(`🔍 Autodetecting tile server at ${host}${port ? ':' + port : ''}`);

  // Quick DNS and TCP connectivity check before testing all patterns
  // This prevents hanging when the server is completely unreachable
  const testPort = parseInt(port || '80', 10);

  // First verify DNS resolution works
  try {
    await Promise.race([
      dnsLookup(host),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 2000))
    ]);
  } catch (error) {
    logger.warn(`DNS lookup failed for ${host}: ${error instanceof Error ? error.message : 'unknown'}`);
    result.errors.push(`Cannot resolve hostname "${host}". Check the server address.`);
    return res.json(result);
  }

  // Quick TCP connectivity check with proper timeout
  const tcpReachable = await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);

    socket.connect(testPort, host, () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
  });

  if (!tcpReachable) {
    logger.warn(`TCP connection to ${host}:${testPort} failed`);
    result.errors.push(`Cannot connect to ${host}:${testPort}. Ensure the tile server is running and the port is correct.`);
    return res.json(result);
  }

  // Test patterns with limited concurrency to avoid overwhelming the system
  const MAX_CONCURRENT = 3; // Limit parallel connections to prevent lockup

  for (const protocol of protocols) {
    // Build all test URLs for this protocol
    const vectorTests = TILE_URL_PATTERNS.vector.map(pattern => ({
      url: buildTileUrl(protocol, host, port, pattern),
      type: 'vector' as const,
      protocol
    }));

    const rasterTests = TILE_URL_PATTERNS.raster.map(pattern => ({
      url: buildTileUrl(protocol, host, port, pattern),
      type: 'raster' as const,
      protocol
    }));

    const allTests = [...vectorTests, ...rasterTests];

    // Create test tasks with short timeout
    const testTasks = allTests.map(test => async () => {
      try {
        const testResult = await testTileUrl(test.url, 2000); // 2 second timeout
        return { ...test, testResult, success: testResult.success };
      } catch {
        return { ...test, testResult: null, success: false };
      }
    });

    // Run with limited concurrency to avoid overwhelming the server
    const testResults = await runWithConcurrencyLimit(testTasks, MAX_CONCURRENT);
    result.testedPatterns += testResults.length;

    // Collect successful results
    for (const test of testResults) {
      if (test.success && test.testResult) {
        result.detectedUrls.push({
          url: test.url,
          type: test.type,
          protocol: test.protocol,
          testResult: test.testResult
        });
        logger.info(`✅ Found working ${test.type} URL: ${test.url}`);
      }
    }

    // If we found URLs with this protocol, stop testing other protocols
    if (result.detectedUrls.length > 0) {
      break;
    }
  }

  result.success = result.detectedUrls.length > 0;

  if (!result.success) {
    result.errors.push(
      `No working tile URLs found at ${host}${port ? ':' + port : ''}. ` +
      'Ensure the tile server is running and accessible.'
    );
    logger.warn(`❌ No working tile URLs found at ${host}${port ? ':' + port : ''}`);
  }

  res.json(result);
});

export default router;
