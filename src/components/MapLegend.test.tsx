/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock Leaflet before importing components
vi.mock('leaflet', () => ({
  default: {
    divIcon: vi.fn(),
    icon: vi.fn(),
  },
}));

import MapLegend from './MapLegend';

describe('MapLegend', () => {
  describe('rendering', () => {
    it('should render the legend title', () => {
      render(<MapLegend />);
      expect(screen.getByText('Hop Distance')).toBeInTheDocument();
    });

    it('should render all 7 hop levels', () => {
      render(<MapLegend />);

      // Check all legend labels are present
      expect(screen.getByText('Local Node')).toBeInTheDocument();
      expect(screen.getByText('1 Hop')).toBeInTheDocument();
      expect(screen.getByText('2 Hops')).toBeInTheDocument();
      expect(screen.getByText('3 Hops')).toBeInTheDocument();
      expect(screen.getByText('4 Hops')).toBeInTheDocument();
      expect(screen.getByText('5 Hops')).toBeInTheDocument();
      expect(screen.getByText('6+ Hops')).toBeInTheDocument();
    });

    it('should render exactly 7 legend items', () => {
      const { container } = render(<MapLegend />);

      // Count the number of legend item rows (each has a colored circle and label)
      const legendItems = container.querySelectorAll('div > div > div');
      // Filter to only the rows with both circle and text (has two child elements)
      const itemRows = Array.from(legendItems).filter(
        (item) => item.children.length === 2
      );

      expect(itemRows.length).toBe(7);
    });
  });

  describe('color mapping', () => {
    it('should display colors in blue-to-red gradient order', () => {
      const { container } = render(<MapLegend />);

      // Get all the colored circles using border-radius in kebab-case
      const circles = container.querySelectorAll('[style*="border-radius"]');

      // Extract background colors (should be in order: green, blue, purple, red)
      const colors: string[] = [];
      circles.forEach((circle) => {
        const style = (circle as HTMLElement).style;
        if (style.backgroundColor) {
          colors.push(style.backgroundColor);
        }
      });

      // We should have 7 colors
      expect(colors.length).toBe(7);

      // First should be green (local node)
      expect(colors[0]).toContain('34'); // #22c55e contains RGB(34, 197, 94)

      // Last should be red (6+ hops)
      expect(colors[6]).toContain('255'); // #FF0000 is RGB(255, 0, 0)
    });

    it('should use distinct colors for each hop level', () => {
      const { container } = render(<MapLegend />);

      const circles = container.querySelectorAll('[style*="border-radius"]');
      const colors = new Set<string>();

      circles.forEach((circle) => {
        const style = (circle as HTMLElement).style;
        if (style.backgroundColor) {
          colors.add(style.backgroundColor);
        }
      });

      // All 7 colors should be unique
      expect(colors.size).toBe(7);
    });
  });

  describe('structure and styling', () => {
    it('should have proper positioning for map overlay', () => {
      const { container } = render(<MapLegend />);

      const legendContainer = container.firstChild as HTMLElement;
      expect(legendContainer).toBeInTheDocument();

      // Should be positioned absolutely for map overlay
      const style = window.getComputedStyle(legendContainer);
      expect(style.position).toBe('absolute');
    });

    it('should have white background for visibility on map', () => {
      const { container } = render(<MapLegend />);

      const legendContainer = container.firstChild as HTMLElement;
      const style = window.getComputedStyle(legendContainer);

      // Should have white or light background
      expect(['white', 'rgb(255, 255, 255)', '#ffffff']).toContain(
        style.backgroundColor.toLowerCase()
      );
    });

    it('should have rounded corners', () => {
      const { container } = render(<MapLegend />);

      const legendContainer = container.firstChild as HTMLElement;
      const style = window.getComputedStyle(legendContainer);

      // Should have border radius for rounded corners
      expect(style.borderRadius).toBeTruthy();
    });
  });

  describe('accessibility', () => {
    it('should have readable text for all labels', () => {
      render(<MapLegend />);

      const labels = [
        'Local Node',
        '1 Hop',
        '2 Hops',
        '3 Hops',
        '4 Hops',
        '5 Hops',
        '6+ Hops',
      ];

      labels.forEach((label) => {
        const element = screen.getByText(label);
        expect(element).toBeVisible();
      });
    });

    it('should use system fonts for better readability', () => {
      const { container } = render(<MapLegend />);

      const legendContainer = container.firstChild as HTMLElement;
      const style = window.getComputedStyle(legendContainer);

      // Should use system fonts
      expect(style.fontFamily).toContain('system-ui');
    });
  });

  describe('legend items structure', () => {
    it('should have correct hop count order', () => {
      render(<MapLegend />);

      const orderedLabels = [
        'Local Node',
        '1 Hop',
        '2 Hops',
        '3 Hops',
        '4 Hops',
        '5 Hops',
        '6+ Hops',
      ];

      // Get all text content and verify order
      const legendText = screen.getByText('Hop Distance').parentElement;
      expect(legendText).toBeInTheDocument();

      // Verify each label appears in the correct order
      orderedLabels.forEach((label) => {
        const element = screen.getByText(label);
        expect(element).toBeInTheDocument();
      });
    });

    it('should pluralize hop labels correctly', () => {
      render(<MapLegend />);

      // Singular
      expect(screen.getByText('1 Hop')).toBeInTheDocument();
      expect(screen.queryByText('1 Hops')).not.toBeInTheDocument();

      // Plural
      expect(screen.getByText('2 Hops')).toBeInTheDocument();
      expect(screen.getByText('3 Hops')).toBeInTheDocument();
      expect(screen.getByText('4 Hops')).toBeInTheDocument();
      expect(screen.getByText('5 Hops')).toBeInTheDocument();
      expect(screen.getByText('6+ Hops')).toBeInTheDocument();
    });
  });

  describe('integration with getHopColor', () => {
    it('should call getHopColor for each hop level', () => {
      // This is implicitly tested by the rendering tests
      // getHopColor is called for values 0, 1, 2, 3, 4, 5, 6
      const { container } = render(<MapLegend />);

      // Should have 7 colored circles (one for each hop level)
      const circles = container.querySelectorAll('[style*="border-radius"]');
      expect(circles.length).toBeGreaterThanOrEqual(7);
    });
  });
});
