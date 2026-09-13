/**
 * #5196 — telemetry markers have to answer to the room each point gets, or a
 * 24-hour series in a ~300px phone card renders as one solid band.
 */
import { describe, it, expect } from 'vitest';
import {
  telemetryMarkerRadius,
  telemetryDotProp,
  FULL_MARKER_RADIUS,
  SMALL_MARKER_RADIUS,
} from './telemetryChartDensity';

describe('telemetryMarkerRadius', () => {
  it('keeps full-size markers before the container has been measured', () => {
    // Server render / first paint / jsdom without ResizeObserver.
    expect(telemetryMarkerRadius(500, 0)).toBe(FULL_MARKER_RADIUS);
  });

  it('keeps full-size markers on a sparse series, the case they are useful for', () => {
    // The reporter's noise-floor chart: a handful of samples, wide apart.
    expect(telemetryMarkerRadius(6, 370)).toBe(FULL_MARKER_RADIUS);
  });

  it('shrinks the marker once points crowd', () => {
    // 370px card - 70px axis allowance = 300px of plot; 51 points ≈ 6px apart.
    expect(telemetryMarkerRadius(51, 370)).toBe(SMALL_MARKER_RADIUS);
  });

  it('drops to line-only once markers would overlap', () => {
    // The reporter's voltage chart: hundreds of samples in a phone-width card.
    expect(telemetryMarkerRadius(400, 370)).toBeNull();
  });

  it('still draws full-size markers for the same series on a desktop column', () => {
    // 670px container leaves 600px of plot, so 51 points sit ~12px apart.
    expect(telemetryMarkerRadius(51, 670)).toBe(FULL_MARKER_RADIUS);
  });

  it('handles a single point and an empty series', () => {
    expect(telemetryMarkerRadius(1, 370)).toBe(FULL_MARKER_RADIUS);
    expect(telemetryMarkerRadius(0, 370)).toBe(FULL_MARKER_RADIUS);
  });

  it('returns line-only when the container is narrower than the axis allowance', () => {
    expect(telemetryMarkerRadius(50, 40)).toBeNull();
  });
});

describe('telemetryDotProp', () => {
  it('returns a Recharts marker spec in the series colour', () => {
    expect(telemetryDotProp(6, 370, '#89b4fa')).toEqual({ fill: '#89b4fa', r: FULL_MARKER_RADIUS });
  });

  it('returns false — the Recharts "no dots" value — at high density', () => {
    expect(telemetryDotProp(400, 370, '#89b4fa')).toBe(false);
  });
});
