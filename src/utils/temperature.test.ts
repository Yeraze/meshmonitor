import { describe, it, expect } from 'vitest';
import { formatTemperature, getTemperatureUnit } from './temperature';

describe('temperature utilities', () => {
  describe('formatTemperature', () => {
    it('should return same value when units are the same', () => {
      expect(formatTemperature(25, 'C', 'C')).toBe(25);
      expect(formatTemperature(77, 'F', 'F')).toBe(77);
      expect(formatTemperature(0, 'C', 'C')).toBe(0);
    });

    it('should convert Celsius to Fahrenheit correctly', () => {
      // Freezing point of water
      expect(formatTemperature(0, 'C', 'F')).toBe(32);
      // Boiling point of water
      expect(formatTemperature(100, 'C', 'F')).toBe(212);
      // Room temperature
      expect(formatTemperature(20, 'C', 'F')).toBe(68);
      // Body temperature
      expect(formatTemperature(37, 'C', 'F')).toBeCloseTo(98.6, 1);
    });

    it('should convert Fahrenheit to Celsius correctly', () => {
      // Freezing point of water
      expect(formatTemperature(32, 'F', 'C')).toBe(0);
      // Boiling point of water
      expect(formatTemperature(212, 'F', 'C')).toBe(100);
      // Room temperature
      expect(formatTemperature(68, 'F', 'C')).toBe(20);
      // Body temperature
      expect(formatTemperature(98.6, 'F', 'C')).toBeCloseTo(37, 1);
    });

    it('should handle negative temperatures', () => {
      // -40 is the same in both scales
      expect(formatTemperature(-40, 'C', 'F')).toBe(-40);
      expect(formatTemperature(-40, 'F', 'C')).toBe(-40);
      // Other negative values
      expect(formatTemperature(-10, 'C', 'F')).toBe(14);
      expect(formatTemperature(14, 'F', 'C')).toBe(-10);
    });

    it('should handle decimal temperatures', () => {
      expect(formatTemperature(25.5, 'C', 'F')).toBeCloseTo(77.9, 1);
      expect(formatTemperature(77.9, 'F', 'C')).toBeCloseTo(25.5, 1);
    });
  });

  describe('getTemperatureUnit', () => {
    it('should return correct unit symbol for Celsius', () => {
      expect(getTemperatureUnit('C')).toBe('°C');
    });

    it('should return correct unit symbol for Fahrenheit', () => {
      expect(getTemperatureUnit('F')).toBe('°F');
    });
  });
});
