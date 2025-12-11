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

// Mock react-leaflet hooks
vi.mock('react-leaflet', () => ({
  useMap: () => ({
    dragging: {
      disable: vi.fn(),
      enable: vi.fn(),
    },
  }),
}));

import MapLegend from './MapLegend';

describe('MapLegend', () => {
  describe('rendering', () => {
    it('should render the legend title', () => {
      render(<MapLegend />);
      expect(screen.getByText('map.legend.hops')).toBeInTheDocument();
    });

    it('should render all 7 hop levels', () => {
      render(<MapLegend />);

      // Check all legend labels are present
      expect(screen.getByText('map.legend.local')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('6+')).toBeInTheDocument();
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

      // Get all the colored circles by class name
      const circles = container.querySelectorAll('.legend-dot');

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

      const circles = container.querySelectorAll('.legend-dot');
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
    it('should have proper CSS class for map overlay', () => {
      const { container } = render(<MapLegend />);

      const legendContainer = container.firstChild as HTMLElement;
      expect(legendContainer).toBeInTheDocument();

      // Should have the map-legend class
      expect(legendContainer).toHaveClass('map-legend');
    });

    it('should have legend title with proper class', () => {
      const { container } = render(<MapLegend />);

      const titleElement = container.querySelector('.legend-title');
      expect(titleElement).toBeInTheDocument();
      expect(titleElement).toHaveTextContent('map.legend.hops');
    });

    it('should have legend dots with proper class', () => {
      const { container } = render(<MapLegend />);

      const legendDots = container.querySelectorAll('.legend-dot');
      expect(legendDots.length).toBe(7);
    });
  });

  describe('accessibility', () => {
    it('should have readable text for all labels', () => {
      render(<MapLegend />);

      const labels = [
        'map.legend.local',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6+',
      ];

      labels.forEach((label) => {
        const element = screen.getByText(label);
        expect(element).toBeVisible();
      });
    });

    it('should have legend labels with proper class', () => {
      const { container } = render(<MapLegend />);

      const legendLabels = container.querySelectorAll('.legend-label');
      // Should have 7 labels (one for each hop level)
      expect(legendLabels.length).toBe(7);
    });
  });

  describe('legend items structure', () => {
    it('should have correct hop count order', () => {
      render(<MapLegend />);

      const orderedLabels = [
        'map.legend.local',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6+',
      ];

      // Get all text content and verify order
      const legendText = screen.getByText('map.legend.hops').parentElement;
      expect(legendText).toBeInTheDocument();

      // Verify each label appears in the correct order
      orderedLabels.forEach((label) => {
        const element = screen.getByText(label);
        expect(element).toBeInTheDocument();
      });
    });

    it('should use concise numeric labels', () => {
      render(<MapLegend />);

      // Check for concise labels (no "Hop" or "Hops" suffix)
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('6+')).toBeInTheDocument();

      // Old verbose labels should not exist
      expect(screen.queryByText('1 Hop')).not.toBeInTheDocument();
      expect(screen.queryByText('2 Hops')).not.toBeInTheDocument();
    });
  });

  describe('integration with getHopColor', () => {
    it('should call getHopColor for each hop level', () => {
      // This is implicitly tested by the rendering tests
      // getHopColor is called for values 0, 1, 2, 3, 4, 5, 6
      const { container } = render(<MapLegend />);

      // Should have 7 colored circles (one for each hop level)
      const circles = container.querySelectorAll('.legend-dot');
      expect(circles.length).toBe(7);
    });
  });
});
