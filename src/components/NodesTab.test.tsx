/**
 * @vitest-environment jsdom
 *
 * NodesTab Component Tests
 *
 * Tests helper functions and basic functionality. jsdom is required even
 * for the pure `computeNeighborLinkStyle` import below because importing
 * NodesTab.tsx pulls in `leaflet`, which touches `window` at module load.
 */

import { describe, it, expect } from 'vitest';
import { computeNeighborLinkStyle } from './NodesTab';

describe('NodesTab', () => {
  // #4047 Phase 7 WP11 — pins NodesTab's neighbor-link adapter: the 4-tier
  // SNR→weight/opacity table (deliberately NOT the shared layer's continuous
  // snrToNeighborOpacity curve, see utils/neighborLinks.ts) and the
  // unidirectional-only arrow gate consumed by the shared NeighborLinksLayer.
  describe('computeNeighborLinkStyle', () => {
    const color = '#f5a623';

    it('applies the strong tier (weight 4, opacity 0.85) for snr > 10', () => {
      const { pathOptions } = computeNeighborLinkStyle(15, true, color);
      expect(pathOptions.weight).toBe(4);
      expect(pathOptions.opacity).toBe(0.85);
      expect(pathOptions.color).toBe(color);
    });

    it('applies the mid tier (weight 3, opacity 0.6) for 0 <= snr <= 10', () => {
      expect(computeNeighborLinkStyle(10, true, color).pathOptions).toMatchObject({ weight: 3, opacity: 0.6 });
      expect(computeNeighborLinkStyle(0, true, color).pathOptions).toMatchObject({ weight: 3, opacity: 0.6 });
    });

    it('applies the weak tier (weight 2, opacity 0.4) for snr < 0', () => {
      expect(computeNeighborLinkStyle(-5, true, color).pathOptions).toMatchObject({ weight: 2, opacity: 0.4 });
    });

    it('applies the unknown tier (weight 2, opacity 0.3) for null snr', () => {
      expect(computeNeighborLinkStyle(null, true, color).pathOptions).toMatchObject({ weight: 2, opacity: 0.3 });
    });

    it('omits dashArray and arrows for bidirectional links', () => {
      const { pathOptions, arrows } = computeNeighborLinkStyle(5, true, color);
      expect(pathOptions.dashArray).toBeUndefined();
      expect(arrows).toBeUndefined();
    });

    it('dashes the line and emits an arrow descriptor for unidirectional links', () => {
      const { pathOptions, arrows } = computeNeighborLinkStyle(5, false, color);
      expect(pathOptions.dashArray).toBe('5, 5');
      expect(arrows).toEqual({ color });
    });
  });


  describe('Helper Functions', () => {
    describe('isToday', () => {
      it('should return true for today\'s date', () => {
        const today = new Date();
        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(today)).toBe(true);
      });

      it('should return false for yesterday', () => {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(yesterday)).toBe(false);
      });

      it('should return false for tomorrow', () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);

        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(tomorrow)).toBe(false);
      });

      it('should handle dates from different months', () => {
        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);

        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(lastMonth)).toBe(false);
      });

      it('should handle dates from different years', () => {
        const lastYear = new Date();
        lastYear.setFullYear(lastYear.getFullYear() - 1);

        const isToday = (date: Date): boolean => {
          const now = new Date();
          return date.getDate() === now.getDate() &&
            date.getMonth() === now.getMonth() &&
            date.getFullYear() === now.getFullYear();
        };

        expect(isToday(lastYear)).toBe(false);
      });
    });
  });

  describe('Date Handling', () => {
    it('should correctly identify same day dates', () => {
      const date1 = new Date(2025, 0, 15, 10, 30);
      const date2 = new Date(2025, 0, 15, 15, 45);

      const areSameDay = (d1: Date, d2: Date): boolean => {
        return d1.getDate() === d2.getDate() &&
          d1.getMonth() === d2.getMonth() &&
          d1.getFullYear() === d2.getFullYear();
      };

      expect(areSameDay(date1, date2)).toBe(true);
    });

    it('should correctly identify different day dates', () => {
      const date1 = new Date(2025, 0, 15, 23, 59);
      const date2 = new Date(2025, 0, 16, 0, 1);

      const areSameDay = (d1: Date, d2: Date): boolean => {
        return d1.getDate() === d2.getDate() &&
          d1.getMonth() === d2.getMonth() &&
          d1.getFullYear() === d2.getFullYear();
      };

      expect(areSameDay(date1, date2)).toBe(false);
    });
  });
});
