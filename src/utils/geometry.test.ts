import { describe, it, expect } from 'vitest';
import {
  isPointInCircle,
  isPointInPolygon,
  isPointInGeofence,
  getGeofenceCenter,
  distanceToGeofenceCenter,
} from './geometry';
import type { GeofenceShape } from '../components/auto-responder/types';

describe('Geometry Utilities', () => {
  describe('isPointInCircle', () => {
    const center = { lat: 40.7128, lng: -74.006 }; // New York
    const radiusKm = 10;

    it('should return true for a point inside the circle', () => {
      // ~2km north of center
      expect(isPointInCircle(40.73, -74.006, center, radiusKm)).toBe(true);
    });

    it('should return true for the center point', () => {
      expect(isPointInCircle(center.lat, center.lng, center, radiusKm)).toBe(true);
    });

    it('should return false for a point outside the circle', () => {
      // Los Angeles - far outside
      expect(isPointInCircle(34.0522, -118.2437, center, radiusKm)).toBe(false);
    });

    it('should return false for a point just outside the boundary', () => {
      // A point slightly beyond 10km north (~0.09 degrees latitude = ~10km)
      expect(isPointInCircle(40.8128, -74.006, center, radiusKm)).toBe(false);
    });

    it('should handle zero radius', () => {
      expect(isPointInCircle(40.7128, -74.006, center, 0)).toBe(true); // exact center
      expect(isPointInCircle(40.713, -74.006, center, 0)).toBe(false);
    });
  });

  describe('isPointInPolygon', () => {
    // A simple square polygon around Central Park, NYC
    const square = [
      { lat: 40.8, lng: -74.0 },
      { lat: 40.8, lng: -73.9 },
      { lat: 40.7, lng: -73.9 },
      { lat: 40.7, lng: -74.0 },
    ];

    it('should return true for a point inside the polygon', () => {
      expect(isPointInPolygon(40.75, -73.95, square)).toBe(true);
    });

    it('should return false for a point outside the polygon', () => {
      expect(isPointInPolygon(40.6, -73.95, square)).toBe(false);
    });

    it('should return false for a point far away', () => {
      expect(isPointInPolygon(34.0522, -118.2437, square)).toBe(false);
    });

    it('should return false for fewer than 3 vertices', () => {
      expect(isPointInPolygon(40.75, -73.95, [])).toBe(false);
      expect(isPointInPolygon(40.75, -73.95, [{ lat: 40.8, lng: -74.0 }])).toBe(false);
      expect(
        isPointInPolygon(40.75, -73.95, [
          { lat: 40.8, lng: -74.0 },
          { lat: 40.7, lng: -73.9 },
        ])
      ).toBe(false);
    });

    it('should handle a triangle', () => {
      const triangle = [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 10 },
        { lat: 10, lng: 5 },
      ];
      expect(isPointInPolygon(3, 5, triangle)).toBe(true);
      expect(isPointInPolygon(11, 5, triangle)).toBe(false);
    });

    it('should handle a concave polygon', () => {
      // L-shaped polygon
      const lShape = [
        { lat: 0, lng: 0 },
        { lat: 10, lng: 0 },
        { lat: 10, lng: 5 },
        { lat: 5, lng: 5 },
        { lat: 5, lng: 10 },
        { lat: 0, lng: 10 },
      ];
      // Inside the bottom part
      expect(isPointInPolygon(2, 7, lShape)).toBe(true);
      // Inside the tall part
      expect(isPointInPolygon(8, 2, lShape)).toBe(true);
      // In the notch (outside)
      expect(isPointInPolygon(8, 7, lShape)).toBe(false);
    });
  });

  describe('isPointInGeofence', () => {
    it('should dispatch to circle check for circle shapes', () => {
      const shape: GeofenceShape = {
        type: 'circle',
        center: { lat: 40.7128, lng: -74.006 },
        radiusKm: 10,
      };
      expect(isPointInGeofence(40.72, -74.006, shape)).toBe(true);
      expect(isPointInGeofence(34.0522, -118.2437, shape)).toBe(false);
    });

    it('should dispatch to polygon check for polygon shapes', () => {
      const shape: GeofenceShape = {
        type: 'polygon',
        vertices: [
          { lat: 40.8, lng: -74.0 },
          { lat: 40.8, lng: -73.9 },
          { lat: 40.7, lng: -73.9 },
          { lat: 40.7, lng: -74.0 },
        ],
      };
      expect(isPointInGeofence(40.75, -73.95, shape)).toBe(true);
      expect(isPointInGeofence(40.6, -73.95, shape)).toBe(false);
    });
  });

  describe('getGeofenceCenter', () => {
    it('should return center for circle shapes', () => {
      const shape: GeofenceShape = {
        type: 'circle',
        center: { lat: 40.7128, lng: -74.006 },
        radiusKm: 10,
      };
      const center = getGeofenceCenter(shape);
      expect(center.lat).toBe(40.7128);
      expect(center.lng).toBe(-74.006);
    });

    it('should return centroid for polygon shapes', () => {
      const shape: GeofenceShape = {
        type: 'polygon',
        vertices: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 10 },
          { lat: 10, lng: 10 },
          { lat: 10, lng: 0 },
        ],
      };
      const center = getGeofenceCenter(shape);
      expect(center.lat).toBe(5);
      expect(center.lng).toBe(5);
    });

    it('should return origin for empty polygon', () => {
      const shape: GeofenceShape = {
        type: 'polygon',
        vertices: [],
      };
      const center = getGeofenceCenter(shape);
      expect(center.lat).toBe(0);
      expect(center.lng).toBe(0);
    });
  });

  describe('distanceToGeofenceCenter', () => {
    it('should return 0 for a point at the center of a circle', () => {
      const shape: GeofenceShape = {
        type: 'circle',
        center: { lat: 40.7128, lng: -74.006 },
        radiusKm: 10,
      };
      expect(distanceToGeofenceCenter(40.7128, -74.006, shape)).toBe(0);
    });

    it('should return positive distance for a point away from center', () => {
      const shape: GeofenceShape = {
        type: 'circle',
        center: { lat: 40.7128, lng: -74.006 },
        radiusKm: 10,
      };
      const dist = distanceToGeofenceCenter(40.8, -74.006, shape);
      expect(dist).toBeGreaterThan(0);
      expect(dist).toBeLessThan(15); // roughly 9.7km
    });

    it('should work with polygon shapes', () => {
      const shape: GeofenceShape = {
        type: 'polygon',
        vertices: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 10 },
          { lat: 10, lng: 10 },
          { lat: 10, lng: 0 },
        ],
      };
      // Distance from (0,0) to centroid (5,5)
      const dist = distanceToGeofenceCenter(0, 0, shape);
      expect(dist).toBeGreaterThan(700); // roughly 786km
      expect(dist).toBeLessThan(800);
    });
  });
});
