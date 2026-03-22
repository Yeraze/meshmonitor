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
      tracerouteForward: '#f5c2e7',
      tracerouteReturn: '#f5c2e7',
      mqttSegment: '#b4befe',
      neighborLine: '#fab387',
      positionHistoryOld: { r: 0, g: 191, b: 255 },
      positionHistoryNew: { r: 255, g: 69, b: 0 },
      hopColors: {
        local: '#22c55e',
        noData: '#9ca3af',
        max: '#FF0000',
        gradient: ['#0000FF', '#3300CC', '#660099', '#990066', '#CC0033', '#FF0000'],
      },
      snrColors: {
        good: '#a6e3a1',
        medium: '#f9e2af',
        poor: '#f38ba8',
        noData: '#6c7086',
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

    it('should render hop gradient bar with labels', () => {
      const { container } = renderExpanded();

      const gradientBar = container.querySelector('.legend-gradient-bar');
      expect(gradientBar).toBeInTheDocument();

      expect(screen.getByText('map.legend.local')).toBeInTheDocument();
      expect(screen.getByText('6+')).toBeInTheDocument();
    });

    it('should render all legend items', () => {
      const { container } = renderExpanded();

      // Count legend-item rows: 2 neighbor styles + 2 other lines = 4 (hops are a gradient bar)
      const legendItems = container.querySelectorAll('.legend-item');
      expect(legendItems.length).toBe(4);
    });
  });

  describe('color mapping', () => {
    it('should render hop gradient bar with correct colors', () => {
      const { container } = renderExpanded();

      const gradientBar = container.querySelector('.legend-gradient-bar') as HTMLElement;
      expect(gradientBar).toBeInTheDocument();

      expect(gradientBar.style.background).toContain('linear-gradient');
      // Should contain the local color (green) — browser converts hex to rgb
      expect(gradientBar.style.background).toContain('34, 197, 94');
    });
  });

  describe('structure and styling', () => {
    it('should have proper CSS class for map overlay', () => {
      const { container } = renderExpanded();

      const overlayContainer = container.firstChild as HTMLElement;
      expect(overlayContainer).toBeInTheDocument();
      expect(overlayContainer).toHaveClass('draggable-overlay');
      expect(overlayContainer).toHaveClass('map-legend-wrapper');

      const legendElement = container.querySelector('.map-legend');
      expect(legendElement).toBeInTheDocument();
    });

    it('should have legend title with proper class', () => {
      const { container } = renderExpanded();

      const titleElement = container.querySelector('.legend-title');
      expect(titleElement).toBeInTheDocument();
      expect(titleElement).toHaveTextContent('map.legend.hops');
    });

    it('should have no legend dots (hops use gradient bar)', () => {
      const { container } = renderExpanded();

      const legendDots = container.querySelectorAll('.legend-dot');
      expect(legendDots.length).toBe(0);
    });
  });

  describe('accessibility', () => {
    it('should have readable text for hop gradient labels', () => {
      renderExpanded();

      expect(screen.getByText('map.legend.local')).toBeVisible();
      expect(screen.getByText('6+')).toBeVisible();
    });

    it('should have legend labels with proper class', () => {
      const { container } = renderExpanded();

      const legendLabels = container.querySelectorAll('.legend-label');
      // 2 neighbor styles + 2 other lines = 4 (hops use gradient labels)
      expect(legendLabels.length).toBe(4);
    });
  });

  describe('legend items structure', () => {
    it('should have hop gradient with Local and 6+ labels', () => {
      renderExpanded();

      expect(screen.getByText('map.legend.local')).toBeInTheDocument();
      expect(screen.getByText('6+')).toBeInTheDocument();
    });
  });
});
