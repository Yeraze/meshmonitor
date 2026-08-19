import { describe, it, expect } from 'vitest';
import {
  computeDopStepDeg,
  dopCellBounds,
  dopCellKey,
  gdopToColor,
  DOP_GOOD,
  DOP_POOR,
} from './gnssDopGeometry';

describe('gnssDopGeometry', () => {
  describe('computeDopStepDeg', () => {
    it('sizes the step from the larger span so neither axis blows the cell cap', () => {
      // 8° lat, 2° lon -> driven by the 8° axis / 40 = 0.2.
      expect(computeDopStepDeg(8, 2)).toBeCloseTo(0.2, 6);
    });

    it('clamps to a minimum step for tiny (high-zoom) viewports', () => {
      const step = computeDopStepDeg(0.001, 0.001);
      expect(step).toBeGreaterThanOrEqual(0.02);
    });

    it('is robust to a zero/degenerate span', () => {
      expect(computeDopStepDeg(0, 0)).toBeGreaterThan(0);
    });
  });

  describe('dopCellBounds', () => {
    it('centers the cell on its point', () => {
      const bounds = dopCellBounds(30, -90, 0.2);
      expect(bounds).toEqual([
        [29.9, -90.1],
        [30.1, -89.9],
      ]);
    });
  });

  describe('gdopToColor', () => {
    it('maps good (low) GDOP and poor (high) GDOP to visibly distinct colors', () => {
      const good = gdopToColor(DOP_GOOD - 0.5);
      const poor = gdopToColor(DOP_POOR + 2);
      expect(good).not.toEqual(poor);
    });

    it('maps a low GDOP toward green and a high GDOP toward red', () => {
      const good = gdopToColor(1); // <= DOP_GOOD
      const poor = gdopToColor(9); // >= DOP_POOR
      // Green: high green channel, low red channel.
      expect(good.toLowerCase()).toBe('#2ecc40');
      // Red: high red channel, low green channel.
      expect(poor.toLowerCase()).toBe('#e74c3c');
    });

    it('interpolates through amber in the moderate band (distinct from both ends)', () => {
      const mid = gdopToColor(4);
      expect(mid).not.toEqual(gdopToColor(1));
      expect(mid).not.toEqual(gdopToColor(9));
    });

    it('renders an unsolvable (null) GDOP as a neutral gray, not as "poor"', () => {
      const none = gdopToColor(null);
      expect(none).toBe('#9aa0a6');
      expect(none).not.toEqual(gdopToColor(9));
    });
  });

  describe('dopCellKey', () => {
    it('produces distinct keys for distinct points', () => {
      expect(dopCellKey({ lat: 30, lon: -90, gdop: 1 })).not.toEqual(
        dopCellKey({ lat: 30.1, lon: -90, gdop: 1 }),
      );
    });
  });
});
