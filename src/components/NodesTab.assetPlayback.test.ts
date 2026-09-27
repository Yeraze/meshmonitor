/**
 * Asset playback wiring (#5354 Phase 3).
 *
 * Mounting NodesTab needs the whole map and context stack, so, like
 * NodesTab.positionHistoryBound.test.ts, this pins the wiring at the source
 * boundary and tests the gating predicate on its own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldShowAssetPlayback } from '../utils/trackPlayback';

const dir = dirname(fileURLToPath(import.meta.url));
const nodesTab = readFileSync(join(dir, 'NodesTab.tsx'), 'utf8');

describe('shouldShowAssetPlayback', () => {
  const base = { isAsset: true, assetTrackLoaded: true, showPositionHistory: true, fixCount: 2 };

  it('shows for an asset with its track loaded, history on, and more than one fix', () => {
    expect(shouldShowAssetPlayback(base)).toBe(true);
  });

  it('hides for a node that is not an asset', () => {
    expect(shouldShowAssetPlayback({ ...base, isAsset: false })).toBe(false);
  });

  it('hides until the asset track (not a previous node\'s history) is loaded', () => {
    expect(shouldShowAssetPlayback({ ...base, assetTrackLoaded: false })).toBe(false);
  });

  it('hides when Show Position History is off', () => {
    expect(shouldShowAssetPlayback({ ...base, showPositionHistory: false })).toBe(false);
  });

  it('hides with one fix or none', () => {
    expect(shouldShowAssetPlayback({ ...base, fixCount: 1 })).toBe(false);
    expect(shouldShowAssetPlayback({ ...base, fixCount: 0 })).toBe(false);
  });
});

describe('NodesTab asset playback wiring', () => {
  it('gates the bar on the predicate, the selected node\'s asset flag, and 2D', () => {
    const start = nodesTab.indexOf('const showAssetPlayback = shouldShowAssetPlayback({');
    expect(start).toBeGreaterThan(-1);
    const src = nodesTab.slice(start, start + 300);
    expect(src).toContain('isAsset: Boolean(selectedMapNode?.asset)');
    expect(src).toContain('showPositionHistory: showMotion');
    expect(src).toContain('fixCount: filteredPositionHistory.length');
    expect(nodesTab).toMatch(/!effective3D && showAssetPlayback && selectedNodeId && \(\s*<AssetPlaybackBar/);
  });

  it('feeds the bar the hours-filtered history and the map instance', () => {
    const start = nodesTab.indexOf('<AssetPlaybackBar');
    const src = nodesTab.slice(start, start + 500);
    expect(src).toContain('fixes={filteredPositionHistory}');
    expect(src).toContain('map={playbackMap}');
    expect(src).toContain('resetKey={selectedNodeId}');
    expect(src).toContain('onTrailCursorChange={setPlaybackTrailCursor}');
    expect(nodesTab).toContain('<MapInstanceBridge onMap={setPlaybackMap} />');
  });

  it('trims the trail at the cursor BEFORE downsampling and segmenting', () => {
    const rendered = nodesTab.indexOf('const renderedPositionHistory = useMemo(');
    const trimmed = nodesTab.indexOf('const trailPositionHistory = useMemo(');
    expect(trimmed).toBeGreaterThan(-1);
    expect(trimmed).toBeLessThan(rendered);
    expect(nodesTab.slice(rendered, rendered + 200)).toContain('trailPositionHistory');
    const breaks = nodesTab.indexOf('const positionHistorySegmentBreaks = useMemo(');
    expect(nodesTab.slice(breaks, breaks + 200)).toContain('segmentBreaks(trailPositionHistory, renderedPositionHistory)');
  });

  it('only trims while playback is showing', () => {
    const start = nodesTab.indexOf('const trailCutIndex =');
    expect(nodesTab.slice(start, start + 200)).toContain('showAssetPlayback && playbackTrailCursor !== null');
  });
});
