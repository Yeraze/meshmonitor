import { describe, it, expect } from 'vitest';
import {
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  formatTemperature,
  getTemperatureUnit,
  getTemperatureUnitSymbol,
  type TemperatureUnit
} from './temperature';

describe('Temperature Conversion Utilities', () => {
  describe('celsiusToFahrenheit', () => {
    it('should convert 0°C to 32°F', () => {
      expect(celsiusToFahrenheit(0)).toBe(32);
    });

    it('should convert 100°C to 212°F', () => {
      expect(celsiusToFahrenheit(100)).toBe(212);
    });

    it('should convert -40°C to -40°F', () => {
      expect(celsiusToFahrenheit(-40)).toBe(-40);
    });

    it('should convert 25°C to 77°F', () => {
      expect(celsiusToFahrenheit(25)).toBe(77);
    });

    it('should convert -273.15°C to -459.67°F (absolute zero)', () => {
      expect(celsiusToFahrenheit(-273.15)).toBeCloseTo(-459.67, 2);
    });

    it('should handle decimal values correctly', () => {
      expect(celsiusToFahrenheit(20.5)).toBeCloseTo(68.9, 1);
      expect(celsiusToFahrenheit(37.5)).toBeCloseTo(99.5, 1);
    });
  });

  describe('fahrenheitToCelsius', () => {
    it('should convert 32°F to 0°C', () => {
      expect(fahrenheitToCelsius(32)).toBe(0);
    });

    it('should convert 212°F to 100°C', () => {
      expect(fahrenheitToCelsius(212)).toBe(100);
    });

    it('should convert -40°F to -40°C', () => {
      expect(fahrenheitToCelsius(-40)).toBe(-40);
    });

    it('should convert 77°F to 25°C', () => {
      expect(fahrenheitToCelsius(77)).toBe(25);
    });

    it('should convert -459.67°F to -273.15°C (absolute zero)', () => {
      expect(fahrenheitToCelsius(-459.67)).toBeCloseTo(-273.15, 2);
    });

    it('should handle decimal values correctly', () => {
      expect(fahrenheitToCelsius(68.9)).toBeCloseTo(20.5, 1);
      expect(fahrenheitToCelsius(99.5)).toBeCloseTo(37.5, 1);
    });
  });

  describe('formatTemperature', () => {
    it('should return same value when from and to units are the same', () => {
      expect(formatTemperature(25, 'C', 'C')).toBe(25);
      expect(formatTemperature(77, 'F', 'F')).toBe(77);
    });

    it('should convert from Celsius to Fahrenheit', () => {
      expect(formatTemperature(0, 'C', 'F')).toBe(32);
      expect(formatTemperature(100, 'C', 'F')).toBe(212);
      expect(formatTemperature(25, 'C', 'F')).toBe(77);
    });

    it('should convert from Fahrenheit to Celsius', () => {
      expect(formatTemperature(32, 'F', 'C')).toBe(0);
      expect(formatTemperature(212, 'F', 'C')).toBe(100);
      expect(formatTemperature(77, 'F', 'C')).toBe(25);
    });

    it('should handle negative values correctly', () => {
      expect(formatTemperature(-10, 'C', 'F')).toBe(14);
      expect(formatTemperature(14, 'F', 'C')).toBe(-10);
    });

    it('should handle decimal values', () => {
      expect(formatTemperature(22.5, 'C', 'F')).toBeCloseTo(72.5, 1);
      expect(formatTemperature(72.5, 'F', 'C')).toBeCloseTo(22.5, 1);
    });

    it('should handle invalid unit combinations gracefully', () => {
      // Test with invalid combinations - should return original value
      expect(formatTemperature(25, 'C' as TemperatureUnit, 'X' as TemperatureUnit)).toBe(25);
      expect(formatTemperature(25, 'X' as TemperatureUnit, 'C' as TemperatureUnit)).toBe(25);
    });
  });

  describe('getTemperatureUnit', () => {
    it('should return °C for Celsius', () => {
      expect(getTemperatureUnit('C')).toBe('°C');
    });

    it('should return °F for Fahrenheit', () => {
      expect(getTemperatureUnit('F')).toBe('°F');
    });
  });

  describe('getTemperatureUnitSymbol', () => {
    it('should return C for Celsius', () => {
      expect(getTemperatureUnitSymbol('C')).toBe('C');
    });

    it('should return F for Fahrenheit', () => {
      expect(getTemperatureUnitSymbol('F')).toBe('F');
    });
  });

  describe('Round-trip conversions', () => {
    it('should maintain value accuracy in round-trip conversions', () => {
      const testValues = [0, 25, -40, 100, -273.15, 37.5, -10];

      testValues.forEach(celsius => {
        const fahrenheit = celsiusToFahrenheit(celsius);
        const backToCelsius = fahrenheitToCelsius(fahrenheit);
        expect(backToCelsius).toBeCloseTo(celsius, 10);
      });
    });

    it('should handle round-trip conversion through formatTemperature', () => {
      const originalTemp = 25;
      const toFahrenheit = formatTemperature(originalTemp, 'C', 'F');
      const backToCelsius = formatTemperature(toFahrenheit, 'F', 'C');
      expect(backToCelsius).toBeCloseTo(originalTemp, 10);
    });
  });

  describe('Edge cases', () => {
    it('should handle very large numbers', () => {
      const largeTemp = 1000000;
      const converted = celsiusToFahrenheit(largeTemp);
      expect(converted).toBe(1800032);
      expect(fahrenheitToCelsius(converted)).toBeCloseTo(largeTemp, 5);
    });

    it('should handle very small numbers', () => {
      const smallTemp = -1000000;
      const converted = celsiusToFahrenheit(smallTemp);
      expect(converted).toBe(-1799968);
      expect(fahrenheitToCelsius(converted)).toBeCloseTo(smallTemp, 5);
    });

    it('should handle zero correctly', () => {
      expect(celsiusToFahrenheit(0)).toBe(32);
      expect(fahrenheitToCelsius(0)).toBe(-160/9);
      expect(formatTemperature(0, 'C', 'F')).toBe(32);
      expect(formatTemperature(0, 'F', 'C')).toBeCloseTo(-17.778, 3);
    });

    it('should handle NaN gracefully', () => {
      expect(celsiusToFahrenheit(NaN)).toBeNaN();
      expect(fahrenheitToCelsius(NaN)).toBeNaN();
      expect(formatTemperature(NaN, 'C', 'F')).toBeNaN();
    });

    it('should handle Infinity', () => {
      expect(celsiusToFahrenheit(Infinity)).toBe(Infinity);
      expect(fahrenheitToCelsius(Infinity)).toBe(Infinity);
      expect(celsiusToFahrenheit(-Infinity)).toBe(-Infinity);
      expect(fahrenheitToCelsius(-Infinity)).toBe(-Infinity);
    });
  });
});