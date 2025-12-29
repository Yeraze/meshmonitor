import { describe, it, expect } from 'vitest';
import { calculateDistance, kmToMiles, formatDistance, getDistanceToNode } from './distance';

describe('Distance Utilities', () => {
  describe('calculateDistance', () => {
    it('should calculate distance between New York and Los Angeles', () => {
      // New York: 40.7128° N, 74.0060° W
      // Los Angeles: 34.0522° N, 118.2437° W
      const distance = calculateDistance(40.7128, -74.0060, 34.0522, -118.2437);

      // Expected distance is approximately 3935 km
      expect(distance).toBeGreaterThan(3900);
      expect(distance).toBeLessThan(4000);
    });

    it('should calculate distance between London and Paris', () => {
      // London: 51.5074° N, 0.1278° W
      // Paris: 48.8566° N, 2.3522° E
      const distance = calculateDistance(51.5074, -0.1278, 48.8566, 2.3522);

      // Expected distance is approximately 344 km
      expect(distance).toBeGreaterThan(330);
      expect(distance).toBeLessThan(360);
    });

    it('should return 0 for same location', () => {
      const distance = calculateDistance(40.7128, -74.0060, 40.7128, -74.0060);
      expect(distance).toBe(0);
    });

    it('should handle negative coordinates', () => {
      // Sydney: -33.8688° S, 151.2093° E
      // Melbourne: -37.8136° S, 144.9631° E
      const distance = calculateDistance(-33.8688, 151.2093, -37.8136, 144.9631);

      // Expected distance is approximately 713 km
      expect(distance).toBeGreaterThan(700);
      expect(distance).toBeLessThan(730);
    });

    it('should calculate short distances accurately', () => {
      // Two points very close together (1 km apart approximately)
      const distance = calculateDistance(40.7128, -74.0060, 40.7218, -74.0060);
      expect(distance).toBeGreaterThan(0.9);
      expect(distance).toBeLessThan(1.1);
    });

    it('should handle equator crossing', () => {
      // Point north of equator and point south of equator
      const distance = calculateDistance(1.0, 0.0, -1.0, 0.0);
      expect(distance).toBeGreaterThan(220);
      expect(distance).toBeLessThan(224);
    });

    it('should handle international date line crossing', () => {
      // Points on opposite sides of the date line
      const distance = calculateDistance(0.0, 179.0, 0.0, -179.0);
      expect(distance).toBeGreaterThan(220);
      expect(distance).toBeLessThan(224);
    });

    it('should calculate antipodal points correctly', () => {
      // Approximately antipodal points (opposite sides of Earth)
      const distance = calculateDistance(0, 0, 0, 180);

      // Should be approximately half Earth's circumference (~20,000 km)
      expect(distance).toBeGreaterThan(19500);
      expect(distance).toBeLessThan(20500);
    });
  });

  describe('kmToMiles', () => {
    it('should convert kilometers to miles correctly', () => {
      expect(kmToMiles(1)).toBeCloseTo(0.621371, 5);
      expect(kmToMiles(100)).toBeCloseTo(62.1371, 3);
      expect(kmToMiles(0)).toBe(0);
    });

    it('should handle decimal kilometers', () => {
      expect(kmToMiles(5.5)).toBeCloseTo(3.4175, 3);
      expect(kmToMiles(10.25)).toBeCloseTo(6.369, 3);
    });

    it('should handle large distances', () => {
      expect(kmToMiles(1000)).toBeCloseTo(621.371, 2);
      expect(kmToMiles(10000)).toBeCloseTo(6213.71, 1);
    });
  });

  describe('formatDistance', () => {
    it('should format distance in kilometers by default', () => {
      expect(formatDistance(10.5)).toBe('10.5 km');
      expect(formatDistance(100.25)).toBe('100.3 km');
    });

    it('should format distance in miles when specified', () => {
      expect(formatDistance(10, 'mi')).toBe('6.2 mi');
      expect(formatDistance(100, 'mi')).toBe('62.1 mi');
    });

    it('should respect decimal places parameter', () => {
      expect(formatDistance(10.12345, 'km', 0)).toBe('10 km');
      expect(formatDistance(10.12345, 'km', 2)).toBe('10.12 km');
      expect(formatDistance(10.12345, 'km', 3)).toBe('10.123 km');
    });

    it('should handle zero distance', () => {
      expect(formatDistance(0)).toBe('0.0 km');
      expect(formatDistance(0, 'mi')).toBe('0.0 mi');
    });

    it('should handle very small distances', () => {
      expect(formatDistance(0.1, 'km', 2)).toBe('0.10 km');
      expect(formatDistance(0.05, 'mi', 3)).toBe('0.031 mi');
    });

    it('should handle very large distances', () => {
      expect(formatDistance(10000, 'km', 0)).toBe('10000 km');
      expect(formatDistance(10000, 'mi', 0)).toBe('6214 mi');
    });

    it('should convert and format correctly in one operation', () => {
      const kmDistance = 160.9344; // Exactly 100 miles
      expect(formatDistance(kmDistance, 'mi', 0)).toBe('100 mi');
    });
  });

  describe('getDistanceToNode', () => {
    const homeNode = {
      user: { id: '!home1234' },
      position: { latitude: 40.7128, longitude: -74.0060 } // New York
    };

    const targetNode = {
      user: { id: '!target56' },
      position: { latitude: 34.0522, longitude: -118.2437 } // Los Angeles
    };

    it('should calculate distance between two nodes with positions', () => {
      const result = getDistanceToNode(homeNode, targetNode, 'km');
      expect(result).not.toBeNull();
      // NY to LA is approximately 3935 km
      expect(result).toMatch(/^\d+\.?\d*\s*km$/);
      const distanceValue = parseFloat(result!.replace(' km', ''));
      expect(distanceValue).toBeGreaterThan(3900);
      expect(distanceValue).toBeLessThan(4000);
    });

    it('should format distance in miles when specified', () => {
      const result = getDistanceToNode(homeNode, targetNode, 'mi');
      expect(result).not.toBeNull();
      expect(result).toMatch(/^\d+\.?\d*\s*mi$/);
      const distanceValue = parseFloat(result!.replace(' mi', ''));
      // ~3935 km = ~2444 miles
      expect(distanceValue).toBeGreaterThan(2400);
      expect(distanceValue).toBeLessThan(2500);
    });

    it('should return null when home node is undefined', () => {
      const result = getDistanceToNode(undefined, targetNode, 'km');
      expect(result).toBeNull();
    });

    it('should return null when home node has no position', () => {
      const noPositionHome = { user: { id: '!home1234' } };
      const result = getDistanceToNode(noPositionHome, targetNode, 'km');
      expect(result).toBeNull();
    });

    it('should return null when home node has null latitude', () => {
      const nullLatHome = { user: { id: '!home1234' }, position: { latitude: null as unknown as number, longitude: -74.0060 } };
      const result = getDistanceToNode(nullLatHome, targetNode, 'km');
      expect(result).toBeNull();
    });

    it('should return null when target node has no position', () => {
      const noPositionTarget = { user: { id: '!target56' } };
      const result = getDistanceToNode(homeNode, noPositionTarget, 'km');
      expect(result).toBeNull();
    });

    it('should return null when target node has null longitude', () => {
      const nullLonTarget = { user: { id: '!target56' }, position: { latitude: 34.0522, longitude: null as unknown as number } };
      const result = getDistanceToNode(homeNode, nullLonTarget, 'km');
      expect(result).toBeNull();
    });

    it('should return null when nodes are the same (by user id)', () => {
      const sameNode = {
        user: { id: '!home1234' },
        position: { latitude: 40.7128, longitude: -74.0060 }
      };
      const result = getDistanceToNode(homeNode, sameNode, 'km');
      expect(result).toBeNull();
    });

    it('should calculate distance when nodes have matching undefined user ids', () => {
      // When both nodes have undefined user ids, they're not considered the same
      const noIdHome = { position: { latitude: 40.7128, longitude: -74.0060 } };
      const noIdTarget = { position: { latitude: 34.0522, longitude: -118.2437 } };
      const result = getDistanceToNode(noIdHome, noIdTarget, 'km');
      expect(result).not.toBeNull();
    });

    it('should calculate short distances accurately', () => {
      const nearbyNode = {
        user: { id: '!nearby00' },
        position: { latitude: 40.7218, longitude: -74.0060 } // ~1km north of home
      };
      const result = getDistanceToNode(homeNode, nearbyNode, 'km');
      expect(result).not.toBeNull();
      const distanceValue = parseFloat(result!.replace(' km', ''));
      expect(distanceValue).toBeGreaterThan(0.9);
      expect(distanceValue).toBeLessThan(1.1);
    });
  });
});
