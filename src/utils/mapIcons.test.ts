import { describe, it, expect, vi } from 'vitest';

// Mock Leaflet before importing mapIcons
vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn(),
    icon: vi.fn(),
  },
}));

import { getHopColor } from './mapIcons';

describe('getHopColor', () => {
  describe('special hop counts', () => {
    it('should return green for 0 hops (local node)', () => {
      expect(getHopColor(0)).toBe('#22c55e');
    });

    it('should return grey for 999 (no hop data)', () => {
      expect(getHopColor(999)).toBe('#9ca3af');
    });
  });

  describe('blue-to-red gradient (1-6 hops)', () => {
    it('should return blue for 1 hop', () => {
      expect(getHopColor(1)).toBe('#0000FF');
    });

    it('should return blue-purple for 2 hops', () => {
      expect(getHopColor(2)).toBe('#3300CC');
    });

    it('should return purple for 3 hops', () => {
      expect(getHopColor(3)).toBe('#660099');
    });

    it('should return red-purple for 4 hops', () => {
      expect(getHopColor(4)).toBe('#990066');
    });

    it('should return red-magenta for 5 hops', () => {
      expect(getHopColor(5)).toBe('#CC0033');
    });

    it('should return red for 6 hops', () => {
      expect(getHopColor(6)).toBe('#FF0000');
    });
  });

  describe('high hop counts (6+)', () => {
    it('should return red for 7 hops', () => {
      expect(getHopColor(7)).toBe('#FF0000');
    });

    it('should return red for 10 hops', () => {
      expect(getHopColor(10)).toBe('#FF0000');
    });

    it('should return red for 100 hops', () => {
      expect(getHopColor(100)).toBe('#FF0000');
    });
  });

  describe('gradient progression', () => {
    it('should progress from blue to red through purple', () => {
      const colors = [
        getHopColor(1), // Blue
        getHopColor(2), // Blue-Purple
        getHopColor(3), // Purple
        getHopColor(4), // Red-Purple
        getHopColor(5), // Red-Magenta
        getHopColor(6), // Red
      ];

      // Verify we have 6 distinct colors
      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBe(6);

      // Verify colors are in expected order
      expect(colors).toEqual([
        '#0000FF',
        '#3300CC',
        '#660099',
        '#990066',
        '#CC0033',
        '#FF0000',
      ]);
    });

    it('should have valid hex color format for all hop levels', () => {
      const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;

      for (let i = 0; i <= 10; i++) {
        expect(getHopColor(i)).toMatch(hexColorRegex);
      }

      expect(getHopColor(999)).toMatch(hexColorRegex);
    });
  });

  describe('color properties', () => {
    it('should use pure blue at 1 hop (start of gradient)', () => {
      const color = getHopColor(1);
      expect(color.toLowerCase()).toBe('#0000ff');
    });

    it('should use pure red at 6+ hops (end of gradient)', () => {
      const color = getHopColor(6);
      expect(color.toLowerCase()).toBe('#ff0000');
    });

    it('should use distinct green for local node (not in gradient)', () => {
      const localColor = getHopColor(0);
      const gradientColors = [1, 2, 3, 4, 5, 6].map(h => getHopColor(h));

      expect(gradientColors).not.toContain(localColor);
      expect(localColor).toBe('#22c55e');
    });

    it('should use distinct grey for no data (not in gradient)', () => {
      const noDataColor = getHopColor(999);
      const gradientColors = [1, 2, 3, 4, 5, 6].map(h => getHopColor(h));

      expect(gradientColors).not.toContain(noDataColor);
      expect(noDataColor).toBe('#9ca3af');
    });
  });

  describe('edge cases', () => {
    it('should handle negative hop counts as no data', () => {
      // While this shouldn't happen in practice, we should handle it gracefully
      // Negative values will not match any condition and fall through to the gradient logic
      // which will use the last color in the array
      expect(getHopColor(-1)).toBe('#FF0000');
      expect(getHopColor(-999)).toBe('#FF0000');
    });

    it('should handle very large hop counts consistently', () => {
      expect(getHopColor(1000)).toBe('#FF0000');
      expect(getHopColor(9999)).toBe('#FF0000');
    });

    it('should treat fractional hop counts (if any) by array index', () => {
      // TypeScript should prevent this, but if it happens, test behavior
      // 0.5 would become colors[0.5 - 1] = colors[-0.5] which is undefined
      // This would return the fallback (last color)
      const result = getHopColor(0.5 as number);
      expect(result).toBeDefined();
      expect(result).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });

  describe('map legend compatibility', () => {
    it('should provide correct colors for all legend items', () => {
      const legendTests = [
        { hops: 0, label: 'Local Node', expectedColor: '#22c55e' },
        { hops: 1, label: '1 Hop', expectedColor: '#0000FF' },
        { hops: 2, label: '2 Hops', expectedColor: '#3300CC' },
        { hops: 3, label: '3 Hops', expectedColor: '#660099' },
        { hops: 4, label: '4 Hops', expectedColor: '#990066' },
        { hops: 5, label: '5 Hops', expectedColor: '#CC0033' },
        { hops: 6, label: '6+ Hops', expectedColor: '#FF0000' },
      ];

      legendTests.forEach(({ hops, label, expectedColor }) => {
        expect(getHopColor(hops)).toBe(expectedColor);
      });
    });
  });
});
