/**
 * @vitest-environment jsdom
 *
 * Regression guard for the Node-Types glyph dedupe (epic #4047 Phase 2,
 * MAP_CONSOLIDATION_P2_SPEC.md §4.1/D1): the Map Analysis legend must render
 * its Node-Types swatches through the shared `roleGlyphMarkerSvg` helper
 * (same color/size the old hand-rolled `RoleIcon` used), not a bespoke copy.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import MapLegend from './MapLegend';
import { roleGlyphMarkerSvg } from '../../utils/mapIcons';
import { DEFAULT_CONFIG, type MapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';
import type { NodeTypeCategory } from '../../utils/nodeTypeCategory';

const mockCtx = vi.fn();
vi.mock('./MapAnalysisContext', () => ({
  useMapAnalysisCtx: () => mockCtx(),
}));

const mockVisibleCategories = vi.fn();
vi.mock('./useVisibleNodeTypeCategories', () => ({
  useVisibleNodeTypeCategories: () => mockVisibleCategories(),
}));

function configWithLayers(overrides: Partial<MapAnalysisConfig['layers']>): MapAnalysisConfig {
  return {
    ...DEFAULT_CONFIG,
    layers: {
      ...DEFAULT_CONFIG.layers,
      ...overrides,
    },
  };
}

describe('MapAnalysis MapLegend — Node Types glyph dedupe (#4047 Phase 2)', () => {
  it('renders one glyph per visible node-type category, sourced from the shared roleGlyphMarkerSvg helper', () => {
    mockCtx.mockReturnValue({
      config: configWithLayers({
        markers: { enabled: true, lookbackHours: null },
        hopShading: { enabled: false, lookbackHours: null },
      }),
    });
    const categories: NodeTypeCategory[] = ['repeater', 'sensor'];
    mockVisibleCategories.mockReturnValue(categories);

    const { container } = render(<MapLegend />);

    const swatches = container.querySelectorAll('.map-analysis-legend-swatch');
    // One swatch for the "Markers" section's plain color dot, plus one glyph
    // swatch per node-type category.
    const glyphSwatches = Array.from(swatches).filter((el) => el.querySelector('svg'));
    expect(glyphSwatches).toHaveLength(categories.length);

    glyphSwatches.forEach((swatch, i) => {
      const expectedHtml = roleGlyphMarkerSvg(categories[i], '#6698f5', 20);
      // Round-trip the expected markup through the DOM too, so the
      // comparison isn't sensitive to jsdom's HTML re-serialization quirks
      // (attribute quoting/ordering) — only the actual glyph content matters.
      const expectedEl = document.createElement('div');
      expectedEl.innerHTML = expectedHtml;
      expect(swatch.innerHTML).toBe(expectedEl.innerHTML);
    });
  });

  it('returns null when no legend-relevant layer is enabled', () => {
    mockCtx.mockReturnValue({
      config: configWithLayers({
        markers: { enabled: false, lookbackHours: null },
        traceroutes: { enabled: false, lookbackHours: 24 },
        neighbors: { enabled: false, lookbackHours: 24 },
        heatmap: { enabled: false, lookbackHours: 24 },
        trails: { enabled: false, lookbackHours: 24 },
        hopShading: { enabled: false, lookbackHours: null },
        snrOverlay: { enabled: false, lookbackHours: null },
      }),
    });
    mockVisibleCategories.mockReturnValue([]);

    const { container } = render(<MapLegend />);

    expect(container.querySelector('.map-analysis-legend')).toBeNull();
  });
});
