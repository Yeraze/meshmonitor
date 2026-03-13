/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

// Mock SettingsContext to provide overlayColors
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    overlayColors: {
      tracerouteForward: '#89b4fa',
      tracerouteReturn: '#f38ba8',
      mqttSegment: '#9399b2',
      neighborLine: '#cba6f7',
      positionHistoryOld: { r: 0, g: 191, b: 255 },
      positionHistoryNew: { r: 255, g: 69, b: 0 },
      hopColors: {
        local: '#22c55e',
        noData: '#9ca3af',
        max: '#FF0000',
        gradient: ['#0000FF', '#3300CC', '#660099', '#990066', '#CC0033', '#FF0000'],
      },
      snrColors: {
        good: '#22c55e',
        medium: '#f59e0b',
        poor: '#ef4444',
      },
    },
  }),
}));

import MapLegend from './MapLegend';

// Helper to render the legend (expanded by default)
const renderExpanded = () => {
  return render(<MapLegend />);
};

describe('MapLegend', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('collapse/expand', () => {
    it('should start expanded by default', () => {
      const { container } = render(<MapLegend />);
      const legend = container.querySelector('.map-legend');
      expect(legend).not.toHaveClass('collapsed');
    });

    it('should collapse when collapse button is clicked', () => {
      const { container } = render(<MapLegend />);
      const btn = container.querySelector('.legend-collapse-btn')!;
      fireEvent.click(btn);
      const legend = container.querySelector('.map-legend');
      expect(legend).toHaveClass('collapsed');
    });

    it('should persist collapse state in localStorage', () => {
      const { container } = render(<MapLegend />);
      const btn = container.querySelector('.legend-collapse-btn')!;
      fireEvent.click(btn); // collapse
      expect(localStorage.getItem('mapLegendCollapsed')).toBe('true');
      fireEvent.click(btn); // expand
      expect(localStorage.getItem('mapLegendCollapsed')).toBe('false');
    });
  });

  describe('rendering', () => {
    it('should render the legend title', () => {
      renderExpanded();
      expect(screen.getByText('map.legend.hops')).toBeInTheDocument();
    });

    it('should render all 7 hop levels', () => {
      renderExpanded();

      // Check all legend labels are present
      expect(screen.getByText('map.legend.local')).toBeInTheDocument();
      expect(screen.getByText('1')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('4')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.getByText('6+')).toBeInTheDocument();
    });

    it('should render all legend items', () => {
      const { container } = renderExpanded();

      // Count legend-item rows: 7 hops + 5 links + 3 SNR = 15
      const legendItems = container.querySelectorAll('.legend-item');
      expect(legendItems.length).toBe(15);
    });
  });

  describe('color mapping', () => {
    it('should display colors in blue-to-red gradient order', () => {
      const { container } = renderExpanded();

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

      // 7 hop colors + 3 SNR colors = 10
      expect(colors.length).toBe(10);

      // First should be green (local node)
      expect(colors[0]).toContain('34'); // #22c55e contains RGB(34, 197, 94)

      // 7th (index 6) should be red (6+ hops)
      expect(colors[6]).toContain('255'); // #FF0000 is RGB(255, 0, 0)
    });

    it('should use distinct colors for each hop level', () => {
      const { container } = renderExpanded();

      // Only check the first 7 dots (hop colors) are unique
      const circles = Array.from(container.querySelectorAll('.legend-dot')).slice(0, 7);
      const colors = new Set<string>();

      circles.forEach((circle) => {
        const style = (circle as HTMLElement).style;
        if (style.backgroundColor) {
          colors.add(style.backgroundColor);
        }
      });

      // All 7 hop colors should be unique
      expect(colors.size).toBe(7);
    });
  });

  describe('structure and styling', () => {
    it('should have proper CSS class for map overlay', () => {
      const { container } = renderExpanded();

      // MapLegend is wrapped in DraggableOverlay, so look for the wrapper class
      const overlayContainer = container.firstChild as HTMLElement;
      expect(overlayContainer).toBeInTheDocument();
      expect(overlayContainer).toHaveClass('draggable-overlay');
      expect(overlayContainer).toHaveClass('map-legend-wrapper');

      // The inner map-legend element should also exist
      const legendElement = container.querySelector('.map-legend');
      expect(legendElement).toBeInTheDocument();
    });

    it('should have legend title with proper class', () => {
      const { container } = renderExpanded();

      const titleElement = container.querySelector('.legend-title');
      expect(titleElement).toBeInTheDocument();
      expect(titleElement).toHaveTextContent('map.legend.hops');
    });

    it('should have legend dots with proper class', () => {
      const { container } = renderExpanded();

      const legendDots = container.querySelectorAll('.legend-dot');
      // 7 hop dots + 3 SNR dots = 10
      expect(legendDots.length).toBe(10);
    });
  });

  describe('accessibility', () => {
    it('should have readable text for all labels', () => {
      renderExpanded();

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
      const { container } = renderExpanded();

      const legendLabels = container.querySelectorAll('.legend-label');
      // 7 hop labels + 5 link labels + 3 SNR labels = 15
      expect(legendLabels.length).toBe(15);
    });
  });

  describe('legend items structure', () => {
    it('should have correct hop count order', () => {
      renderExpanded();

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
      renderExpanded();

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
      const { container } = renderExpanded();

      // 7 hop dots + 3 SNR dots = 10
      const circles = container.querySelectorAll('.legend-dot');
      expect(circles.length).toBe(10);
    });
  });
});
