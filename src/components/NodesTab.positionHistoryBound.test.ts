/**
 * Position-history render bound (#4743).
 *
 * Tapping a marker for a node on estimated positions froze the UI for ~1 minute
 * on mobile: the map built one `<Polyline>` plus one rich `<Popup>` per segment
 * over a history that can reach 15,000 fixes.
 *
 * Source-extraction rather than a render test: mounting NodesTab needs the map
 * stack, contexts and Leaflet, and what has to hold is that the segment loop
 * reads the BOUNDED array. A render test that mounted 15,000 segments to prove
 * they are slow would itself be the bug.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downsamplePositionHistory, MAX_RENDERED_POSITION_POINTS } from '../utils/positionHistoryDownsample';

const dir = dirname(fileURLToPath(import.meta.url));
const nodesTab = readFileSync(join(dir, 'NodesTab.tsx'), 'utf8');
const app = readFileSync(join(dir, '..', 'App.tsx'), 'utf8');

/** The memo that builds the trail's Polyline/Popup elements. */
function segmentBuilderSource(): string {
  const start = nodesTab.indexOf('const positionHistoryElements = useMemo(');
  expect(start, 'positionHistoryElements memo not found — retarget this test').toBeGreaterThan(-1);
  const end = nodesTab.indexOf('const historyArrows', start);
  expect(end).toBeGreaterThan(start);
  return nodesTab.slice(start, end);
}

describe('trail rendering is bounded', () => {
  it('builds segments from the downsampled array, not the raw history', () => {
    const src = segmentBuilderSource();
    expect(src).toContain('renderedPositionHistory');
    // The unbounded array must not drive the element loop — that is the freeze.
    expect(src).not.toContain('filteredPositionHistory');
  });

  it('derives the bounded array through the shared cap', () => {
    expect(nodesTab).toContain('downsamplePositionHistory(filteredPositionHistory, MAX_RENDERED_POSITION_POINTS)');
  });

  it('keeps the legend reading the FULL filtered history', () => {
    // Bounding the drawing must not shrink the reported time span; the legend
    // states the trail's real oldest/newest.
    const start = nodesTab.indexOf('const positionHistoryLegendData = useMemo(');
    const src = nodesTab.slice(start, start + 400);
    expect(src).toContain('filteredPositionHistory');
  });

  it('caps a realistic estimated-position history to a renderable size', () => {
    // End to end on the real helper: 15,000 fixes is the size the reporter hit.
    const history = Array.from({ length: 15_000 }, (_, i) => ({ timestamp: i }));
    const drawn = downsamplePositionHistory(history, MAX_RENDERED_POSITION_POINTS);

    expect(drawn.length).toBeLessThanOrEqual(MAX_RENDERED_POSITION_POINTS);
    expect(drawn[0].timestamp).toBe(0);
    expect(drawn[drawn.length - 1].timestamp).toBe(14_999);
  });
});

describe('history fetching is bounded', () => {
  it('stops accumulating once it holds enough fixes', () => {
    // The other half of the freeze: 50 sequential requests, each followed by a
    // state update and a full re-render of the trail.
    expect(app).toContain('MAX_ACCUMULATED_FIXES');
    expect(app).toContain('if (accumulated.length >= MAX_ACCUMULATED_FIXES) break;');
  });

  it('fetches more than it draws, so the trail still spans full history', () => {
    const m = /const MAX_ACCUMULATED_FIXES = (\d+);/.exec(app);
    expect(m, 'MAX_ACCUMULATED_FIXES not found').toBeTruthy();
    expect(Number(m![1])).toBeGreaterThan(MAX_RENDERED_POSITION_POINTS);
  });
});
