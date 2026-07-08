/**
 * @vitest-environment jsdom
 *
 * FollowController (issue #3788 P2 WP-C, spec test #3). Mocks react-leaflet's
 * useMap with a fake map whose setView/fitBounds synchronously invoke the
 * recorded moveend handler (emulating `{ animate: false }`), plus
 * useAnalysisNodes and useMapAnalysisCtx so each case can drive the effect
 * directly without a real Leaflet map or react-query cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import FollowController from './FollowController';
import type { AnalysisNode } from './useAnalysisNodes';
import type { MapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';
import { DEFAULT_CONFIG } from '../../hooks/useMapAnalysisConfig';

type MoveEndHandler = () => void;

let moveEndHandler: MoveEndHandler | null = null;
let setViewSpy: ReturnType<typeof vi.fn>;
let fitBoundsSpy: ReturnType<typeof vi.fn>;
let onSpy: ReturnType<typeof vi.fn>;
let offSpy: ReturnType<typeof vi.fn>;

function makeFakeMap() {
  onSpy = vi.fn((event: string, handler: MoveEndHandler) => {
    if (event === 'moveend') moveEndHandler = handler;
  });
  offSpy = vi.fn();
  setViewSpy = vi.fn(() => {
    // Emulate animate:false — moveend fires synchronously.
    moveEndHandler?.();
  });
  fitBoundsSpy = vi.fn(() => {
    moveEndHandler?.();
  });
  return {
    on: onSpy,
    off: offSpy,
    setView: setViewSpy,
    fitBounds: fitBoundsSpy,
    getZoom: () => 10,
    getCenter: () => ({ lat: 0, lng: 0 }),
  };
}

let fakeMap: ReturnType<typeof makeFakeMap>;

vi.mock('react-leaflet', () => ({
  useMap: () => fakeMap,
}));

let mockAnalysisNodes: AnalysisNode[] = [];
vi.mock('./useAnalysisNodes', () => ({
  useAnalysisNodes: () => mockAnalysisNodes,
}));

let mockConfig: MapAnalysisConfig;
let mockFollowPaused: boolean;
let setFollowPausedSpy: ReturnType<typeof vi.fn>;
vi.mock('./MapAnalysisContext', () => ({
  useMapAnalysisCtx: () => ({
    config: mockConfig,
    followPaused: mockFollowPaused,
    setFollowPaused: setFollowPausedSpy,
  }),
}));

function node(key: string, latLng: [number, number]): AnalysisNode {
  return { node: { nodeNum: 1 } as AnalysisNode['node'], latLng, key };
}

function setup(overrides: {
  nodes: AnalysisNode[];
  selectedNodeIds: string[];
  followMode?: boolean;
  autoZoom?: boolean;
  followPaused?: boolean;
}) {
  mockAnalysisNodes = overrides.nodes;
  mockConfig = {
    ...DEFAULT_CONFIG,
    selectedNodeIds: overrides.selectedNodeIds,
    followMode: overrides.followMode ?? false,
    autoZoom: overrides.autoZoom ?? false,
  };
  mockFollowPaused = overrides.followPaused ?? false;
  setFollowPausedSpy = vi.fn();
  fakeMap = makeFakeMap();
  moveEndHandler = null;
  return render(<FollowController />);
}

describe('FollowController', () => {
  beforeEach(() => {
    moveEndHandler = null;
  });

  it('Follow with 2 selected points: setView to average center at current zoom, no fitBounds', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
    });
    expect(setViewSpy).toHaveBeenCalledWith([5, 10], 10, { animate: false });
    expect(fitBoundsSpy).not.toHaveBeenCalled();
  });

  it('Auto-zoom with 2 points: fitBounds with padded bounds, no setView', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      autoZoom: true,
    });
    expect(fitBoundsSpy).toHaveBeenCalledWith(
      [
        [-1.5, -3],
        [11.5, 23],
      ],
      { animate: false },
    );
    expect(setViewSpy).not.toHaveBeenCalled();
  });

  it('Both on: fitBounds only, setView (Follow) suppressed', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
      autoZoom: true,
    });
    expect(fitBoundsSpy).toHaveBeenCalledTimes(1);
    expect(setViewSpy).not.toHaveBeenCalled();
  });

  it('Single selected point with Auto-zoom: setView(center, currentZoom), no fitBounds (no zoom-to-max)', () => {
    setup({
      nodes: [node('mt:1', [5, 5])],
      selectedNodeIds: ['mt:1'],
      autoZoom: true,
    });
    expect(setViewSpy).toHaveBeenCalledWith([5, 5], 10, { animate: false });
    expect(fitBoundsSpy).not.toHaveBeenCalled();
  });

  it('Empty selection: neither setView nor fitBounds called', () => {
    setup({
      nodes: [node('mt:1', [5, 5])],
      selectedNodeIds: [], // no keys match
      followMode: true,
      autoZoom: true,
    });
    expect(setViewSpy).not.toHaveBeenCalled();
    expect(fitBoundsSpy).not.toHaveBeenCalled();
  });

  it('a programmatic move does not self-pause', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
    });
    // setView already fired synchronously via the mocked moveend during setup.
    expect(setViewSpy).toHaveBeenCalled();
    expect(setFollowPausedSpy).not.toHaveBeenCalledWith(true);
  });

  it('a genuine user move (flag not set) pauses exactly once', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: false,
      autoZoom: false,
    });
    expect(moveEndHandler).not.toBeNull();
    // The pause-auto-reset effects (selKey / mode toggles) also call
    // setFollowPaused(false) on mount — filter to `true` calls, i.e. actual pauses.
    const pauseCallsBefore = setFollowPausedSpy.mock.calls.filter((c) => c[0] === true).length;
    moveEndHandler?.();
    const pauseCallsAfter = setFollowPausedSpy.mock.calls.filter((c) => c[0] === true).length;
    expect(pauseCallsAfter - pauseCallsBefore).toBe(1);
    expect(setFollowPausedSpy).toHaveBeenLastCalledWith(true);
  });

  it('paused: no setView/fitBounds even with a mode active', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
      autoZoom: true,
      followPaused: true,
    });
    expect(setViewSpy).not.toHaveBeenCalled();
    expect(fitBoundsSpy).not.toHaveBeenCalled();
  });

  it('Follow no-op guard: setView not called when the map center already equals the average', () => {
    // getCenter() is mocked to {lat:0,lng:0}; select points whose average is [0,0].
    setup({
      nodes: [node('mt:1', [-5, -5]), node('mt:2', [5, 5])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
    });
    expect(setViewSpy).not.toHaveBeenCalled();
    expect(fitBoundsSpy).not.toHaveBeenCalled();
  });
});
