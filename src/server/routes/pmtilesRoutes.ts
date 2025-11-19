/**
 * PMTiles Routes
 *
 * Routes for managing PMTiles offline maps
 */

import { Router, Request, Response } from 'express';
import db from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const router = Router();

interface NodeBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  centerLat: number;
  centerLon: number;
  nodeCount: number;
}

interface RegionRecommendation {
  id: string;
  name: string;
  url: string;
  size: string;
  sizeBytes: number;
  description: string;
  matchScore: number;
}

/**
 * GET /api/pmtiles/coverage
 * Calculate the bounding box from all nodes with positions
 */
router.get('/coverage', async (_req: Request, res: Response) => {
  try {
    const nodes = db.db.prepare(`
      SELECT latitude, longitude, nodeId
      FROM nodes
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND latitude != 0
        AND longitude != 0
    `).all() as Array<{ latitude: number; longitude: number; nodeId: string }>;

    if (nodes.length === 0) {
      return res.json({
        hasCoverage: false,
        message: 'No nodes with position data found'
      });
    }

    const lats = nodes.map(n => n.latitude);
    const lons = nodes.map(n => n.longitude);

    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;

    // Add 20% buffer to the bounds
    const latBuffer = (maxLat - minLat) * 0.2;
    const lonBuffer = (maxLon - minLon) * 0.2;

    const bounds: NodeBounds = {
      minLat: minLat - latBuffer,
      maxLat: maxLat + latBuffer,
      minLon: minLon - lonBuffer,
      maxLon: maxLon + lonBuffer,
      centerLat,
      centerLon,
      nodeCount: nodes.length
    };

    return res.json({
      hasCoverage: true,
      bounds,
      bufferedBounds: {
        minLat: bounds.minLat,
        maxLat: bounds.maxLat,
        minLon: bounds.minLon,
        maxLon: bounds.maxLon
      }
    });
  } catch (error) {
    logger.error('Error calculating node coverage:', error);
    return res.status(500).json({ error: 'Failed to calculate coverage' });
  }
});

/**
 * GET /api/pmtiles/status
 * Check if PMTiles files exist and get their info
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const pmtilesDir = path.join(process.cwd(), 'public', 'pmtiles');
    const basemapPath = path.join(pmtilesDir, 'basemap.pmtiles');

    let exists = false;
    let size = 0;
    let sizeFormatted = '0 B';

    try {
      const stats = await fs.stat(basemapPath);
      exists = stats.isFile();
      size = stats.size;

      // Format size
      if (size > 1024 * 1024 * 1024) {
        sizeFormatted = `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
      } else if (size > 1024 * 1024) {
        sizeFormatted = `${(size / (1024 * 1024)).toFixed(2)} MB`;
      } else if (size > 1024) {
        sizeFormatted = `${(size / 1024).toFixed(2)} KB`;
      } else {
        sizeFormatted = `${size} B`;
      }
    } catch (error) {
      // File doesn't exist
      exists = false;
    }

    return res.json({
      installed: exists,
      size,
      sizeFormatted,
      path: '/pmtiles/basemap.pmtiles'
    });
  } catch (error) {
    logger.error('Error checking PMTiles status:', error);
    return res.status(500).json({ error: 'Failed to check PMTiles status' });
  }
});

/**
 * GET /api/pmtiles/recommendations
 * Get recommended PMTiles downloads based on node coverage
 */
router.get('/recommendations', async (_req: Request, res: Response) => {
  try {
    // Get coverage first
    const nodes = db.db.prepare(`
      SELECT latitude, longitude
      FROM nodes
      WHERE latitude IS NOT NULL
        AND longitude IS NOT NULL
        AND latitude != 0
        AND longitude != 0
    `).all() as Array<{ latitude: number; longitude: number }>;

    const recommendations: RegionRecommendation[] = [];

    if (nodes.length > 0) {
      const lats = nodes.map(n => n.latitude);
      const lons = nodes.map(n => n.longitude);

      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const minLon = Math.min(...lons);
      const maxLon = Math.max(...lons);

      const centerLat = (minLat + maxLat) / 2;
      const centerLon = (minLon + maxLon) / 2;

      // Add 20% buffer to the bounds
      const latBuffer = (maxLat - minLat) * 0.2;
      const lonBuffer = (maxLon - minLon) * 0.2;

      const bounds = {
        minLat: minLat - latBuffer,
        maxLat: maxLat + latBuffer,
        minLon: minLon - lonBuffer,
        maxLon: maxLon + lonBuffer
      };

      // Determine region based on coordinates
      const region = determineRegion(centerLat, centerLon);

      // Build recommendations with bounds
      recommendations.push(...getRegionRecommendations(region, centerLat, centerLon, bounds));
    }

    // Always add worldwide option
    recommendations.push({
      id: 'worldwide',
      name: 'Worldwide (Daily Build)',
      url: 'https://maps.protomaps.com/builds/',
      size: '~120 GB',
      sizeBytes: 120 * 1024 * 1024 * 1024,
      description: 'Protomaps daily planet build with worldwide coverage (zoom 0-15)',
      matchScore: 0
    });

    return res.json({
      recommendations: recommendations.sort((a, b) => b.matchScore - a.matchScore)
    });
  } catch (error) {
    logger.error('Error getting PMTiles recommendations:', error);
    return res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

/**
 * Determine geographic region from coordinates
 */
function determineRegion(lat: number, lon: number): string {
  if (lat >= 24 && lat <= 72 && lon >= -170 && lon <= -52) {
    return 'north-america';
  } else if (lat >= 35 && lat <= 71 && lon >= -25 && lon <= 45) {
    return 'europe';
  } else if (lat >= -55 && lat <= 38 && lon >= -82 && lon <= -34) {
    return 'south-america';
  } else if (lat >= -35 && lat <= 37 && lon >= -18 && lon <= 52) {
    return 'africa';
  } else if (lat >= -47 && lat <= 81 && lon >= 25 && lon <= 180) {
    return 'asia';
  } else if (lat >= -48 && lat <= -10 && lon >= 110 && lon <= 180) {
    return 'oceania';
  }
  return 'unknown';
}

/**
 * Get recommended downloads for a region
 */
function getRegionRecommendations(region: string, _lat: number, _lon: number, bounds?: { minLat: number; maxLat: number; minLon: number; maxLon: number }): RegionRecommendation[] {
  const recommendations: RegionRecommendation[] = [];

  switch (region) {
    case 'north-america':
      // Add custom extract recommendation if we have bounds
      if (bounds) {
        const extractCommand = `pmtiles extract input.pmtiles output.pmtiles --bbox=${bounds.minLon.toFixed(4)},${bounds.minLat.toFixed(4)},${bounds.maxLon.toFixed(4)},${bounds.maxLat.toFixed(4)}`;
        recommendations.push({
          id: 'custom-extract',
          name: 'Custom Region Extract (Smallest)',
          url: 'https://github.com/protomaps/go-pmtiles#installation',
          size: '~50-200 MB (estimated)',
          sizeBytes: 100 * 1024 * 1024,
          description: `Extract exactly your coverage area from a larger PMTiles file. Install pmtiles CLI, download a source file (e.g., Florida or US), then run: ${extractCommand}`,
          matchScore: 110
        });
      }

      // Florida state extract
      recommendations.push({
        id: 'florida',
        name: 'Florida State (Geofabrik)',
        url: 'https://download.geofabrik.de/north-america/us/florida-latest.osm.pbf',
        size: '~300 MB (PBF format)',
        sizeBytes: 300 * 1024 * 1024,
        description: 'Florida state extract from Geofabrik - convert to PMTiles using tippecanoe or use as source for pmtiles extract',
        matchScore: 100
      });

      recommendations.push({
        id: 'north-america-us',
        name: 'United States (OSM Extracts)',
        url: 'https://download.geofabrik.de/north-america/us-latest.osm.pbf',
        size: 'Varies (PBF format)',
        sizeBytes: 10 * 1024 * 1024 * 1024,
        description: 'OpenStreetMap extract for USA - convert to PMTiles using tippecanoe',
        matchScore: 80
      });
      recommendations.push({
        id: 'protomaps-daily',
        name: 'Protomaps Daily Build (extract region)',
        url: 'https://maps.protomaps.com/builds/',
        size: '~120 GB (full planet)',
        sizeBytes: 120 * 1024 * 1024 * 1024,
        description: 'Download daily planet build, then extract your region using pmtiles CLI',
        matchScore: 70
      });
      break;

    case 'europe':
      recommendations.push({
        id: 'europe',
        name: 'Europe',
        url: 'https://build.protomaps.com/europe.pmtiles',
        size: '~12 GB',
        sizeBytes: 12 * 1024 * 1024 * 1024,
        description: 'Complete Europe coverage',
        matchScore: 100
      });
      break;

    case 'south-america':
      recommendations.push({
        id: 'south-america',
        name: 'South America',
        url: 'https://build.protomaps.com/south-america.pmtiles',
        size: '~5 GB',
        sizeBytes: 5 * 1024 * 1024 * 1024,
        description: 'Complete South America coverage',
        matchScore: 100
      });
      break;

    case 'asia':
      recommendations.push({
        id: 'asia',
        name: 'Asia',
        url: 'https://build.protomaps.com/asia.pmtiles',
        size: '~18 GB',
        sizeBytes: 18 * 1024 * 1024 * 1024,
        description: 'Complete Asia coverage',
        matchScore: 100
      });
      break;

    case 'africa':
      recommendations.push({
        id: 'africa',
        name: 'Africa',
        url: 'https://build.protomaps.com/africa.pmtiles',
        size: '~6 GB',
        sizeBytes: 6 * 1024 * 1024 * 1024,
        description: 'Complete Africa coverage',
        matchScore: 100
      });
      break;

    case 'oceania':
      recommendations.push({
        id: 'oceania',
        name: 'Oceania',
        url: 'https://build.protomaps.com/oceania.pmtiles',
        size: '~2 GB',
        sizeBytes: 2 * 1024 * 1024 * 1024,
        description: 'Complete Oceania coverage (Australia, New Zealand, Pacific Islands)',
        matchScore: 100
      });
      break;
  }

  return recommendations;
}

export default router;
