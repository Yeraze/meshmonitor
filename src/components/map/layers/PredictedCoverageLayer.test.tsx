/**
 * @vitest-environment jsdom
 *
 * Predicted coverage layer (#4727).
 *
 * The layer draws a claim about radio reach, so the assertions are about what
 * the drawing asserts: that it is visually separable from MEASURED coverage,
 * that the caveats cannot be detached from the shape, and that a degenerate
 * result draws nothing rather than a misleading sliver.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// react-leaflet needs a live map context; the layer's logic is in what it
// passes down, so the primitives are stubbed to plain DOM that exposes it.
vi.mock('react-leaflet', () => ({
  Polygon: ({ positions, pathOptions, className, children }: Record<string, unknown>) => (
    <div
      data-testid="polygon"
      data-count={(positions as unknown[]).length}
      data-dash={(pathOptions as { dashArray?: string }).dashArray ?? ''}
      data-color={(pathOptions as { color?: string }).color ?? ''}
      className={className as string}
    >
      {children as React.ReactNode}
    </div>
  ),
  Popup: ({ children }: { children: React.ReactNode }) => <div data-testid="popup">{children}</div>,
}));

import PredictedCoverageLayer from './PredictedCoverageLayer';
import {
  coverageToPolygon,
  radiusLimitedFraction,
  hasAnyPockets,
  type PredictedCoverage,
} from './predictedCoverageGeometry';

const radial = (bearingDeg: number, reachKm: number, o: Record<string, unknown> = {}) => ({
  bearingDeg, reachKm, limitedByRadius: false, reachablePocketsBeyond: false, hasDataGaps: false, ...o,
});

const coverage = (o: Partial<PredictedCoverage> = {}): PredictedCoverage => ({
  origin: { lat: 30, lng: -97 },
  radiusKm: 15,
  generatedAt: 1,
  model: 'fresnel-path-loss',
  radials: [radial(0, 5), radial(90, 8), radial(180, 3), radial(270, 6)],
  assumptions: ['Predicted from terrain elevation only — this is a model, not measured coverage.'],
  ...o,
});

describe('coverageToPolygon', () => {
  it('produces one vertex per radial', () => {
    expect(coverageToPolygon(coverage())).toHaveLength(4);
  });

  it('sorts by bearing so an out-of-order result cannot draw a bow-tie', () => {
    // Unsorted input would self-intersect, which reads as a rendering bug
    // rather than as bad data.
    const shuffled = coverage({ radials: [radial(180, 5), radial(0, 5), radial(270, 5), radial(90, 5)] });
    const pts = coverageToPolygon(shuffled);

    // North first, then east, south, west: latitude highest at bearing 0.
    expect(pts[0][0]).toBeGreaterThan(pts[2][0]);
    expect(pts[1][1]).toBeGreaterThan(pts[3][1]);
  });

  it('places each vertex at its reach distance', () => {
    const pts = coverageToPolygon(coverage({ radials: [radial(0, 10), radial(120, 10), radial(240, 10)] }));
    // ~10 km north of 30N is ~0.09 degrees of latitude.
    expect(pts[0][0]).toBeCloseTo(30.09, 1);
  });

  it('returns nothing below three radials — two points bound no area', () => {
    expect(coverageToPolygon(coverage({ radials: [radial(0, 5), radial(180, 5)] }))).toEqual([]);
  });

  it('treats a negative reach as zero rather than inverting the polygon', () => {
    const pts = coverageToPolygon(coverage({ radials: [radial(0, -5), radial(120, 5), radial(240, 5)] }));
    expect(pts[0][0]).toBeCloseTo(30, 4);
  });
});

describe('summary helpers', () => {
  it('reports the fraction of radials limited by the search radius', () => {
    const c = coverage({ radials: [radial(0, 15, { limitedByRadius: true }), radial(180, 3)] });
    expect(radiusLimitedFraction(c)).toBe(0.5);
  });

  it('reports pockets when any radial has them', () => {
    expect(hasAnyPockets(coverage())).toBe(false);
    expect(hasAnyPockets(coverage({ radials: [radial(0, 5, { reachablePocketsBeyond: true })] }))).toBe(true);
  });
});

describe('PredictedCoverageLayer', () => {
  it('draws a DASHED outline, so it cannot be read as measured coverage', () => {
    // Observed coverage renders as a diffuse leaflet.heat blob. A prediction
    // must not look like a measurement — the boundary is exactly where the
    // model is least trustworthy.
    render(<PredictedCoverageLayer coverage={coverage()} />);
    const poly = screen.getByTestId('polygon');

    expect(poly.getAttribute('data-dash')).toBeTruthy();
    expect(poly.className).toContain('predicted-coverage-polygon');
  });

  it('attaches the model assumptions to the shape itself', () => {
    // In a popup on the polygon, not only in a side panel — the caveats must
    // not be separable from the thing they qualify.
    render(<PredictedCoverageLayer coverage={coverage()} />);
    expect(screen.getByTestId('popup').textContent).toMatch(/not measured/i);
  });

  it('says the true reach is further when radials hit the search radius', () => {
    const c = coverage({ radials: [radial(0, 15, { limitedByRadius: true }), radial(120, 15, { limitedByRadius: true }), radial(240, 3)] });
    render(<PredictedCoverageLayer coverage={c} />);

    expect(screen.getByTestId('popup').textContent).toMatch(/further than drawn/i);
  });

  it('discloses reachable pockets beyond the boundary', () => {
    const c = coverage({ radials: [radial(0, 5, { reachablePocketsBeyond: true }), radial(120, 5), radial(240, 5)] });
    render(<PredictedCoverageLayer coverage={c} />);

    expect(screen.getByTestId('popup').textContent).toMatch(/beyond the drawn boundary/i);
  });

  it('discloses terrain data gaps', () => {
    const c = coverage({ radials: [radial(0, 5, { hasDataGaps: true }), radial(120, 5), radial(240, 5)] });
    render(<PredictedCoverageLayer coverage={c} />);

    expect(screen.getByTestId('popup').textContent).toMatch(/terrain data was missing/i);
  });

  it('renders nothing without coverage, when hidden, or when degenerate', () => {
    const { rerender } = render(<PredictedCoverageLayer coverage={null} />);
    expect(screen.queryByTestId('polygon')).toBeNull();

    rerender(<PredictedCoverageLayer coverage={coverage()} visible={false} />);
    expect(screen.queryByTestId('polygon')).toBeNull();

    // Two radials cannot bound an area — draw nothing rather than a sliver
    // that looks like a real, very narrow coverage lobe.
    rerender(<PredictedCoverageLayer coverage={coverage({ radials: [radial(0, 5), radial(180, 5)] })} />);
    expect(screen.queryByTestId('polygon')).toBeNull();
  });
});
