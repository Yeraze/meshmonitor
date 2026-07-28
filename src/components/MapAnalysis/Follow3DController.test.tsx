/**
 * @vitest-environment jsdom
 *
 * Follow3DController (#4371 B). Mirrors FollowController.test.tsx case for
 * case, against a fake `maplibregl.Map` whose jumpTo synchronously invokes the
 * recorded moveend handler (which is what real MapLibre does — jumpTo fires
 * movestart/move/moveend inline).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type maplibregl from 'maplibre-gl';
import Follow3DController from './Follow3DController';
import type { AnalysisNode } from './useAnalysisNodes';
import type { MapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';
import { DEFAULT_CONFIG } from '../../hooks/useMapAnalysisConfig';

type MoveEndHandler = () => void;

let moveEndHandler: MoveEndHandler | null = null;
let jumpToSpy: ReturnType<typeof vi.fn>;
/**
 * `jumpTo` is the only camera primitive the controller uses: Auto-zoom
 * resolves a camera via `cameraForBounds` and jumps to it rather than calling
 * `fitBounds`, which in MapLibre animates regardless of `animate:false` and
 * resets bearing to 0.
 */
let cameraForBoundsSpy: ReturnType<typeof vi.fn>;
let onSpy: ReturnType<typeof vi.fn>;
let offSpy: ReturnType<typeof vi.fn>;
/** What the fake `cameraForBounds` resolves to; null emulates "can't fit". */
let cameraForBoundsResult: unknown = { center: [0, 0], zoom: 6, bearing: 45 };

function makeFakeMap() {
  onSpy = vi.fn((event: string, handler: MoveEndHandler) => {
    if (event === 'moveend') moveEndHandler = handler;
  });
  offSpy = vi.fn();
  jumpToSpy = vi.fn(() => {
    // MapLibre's jumpTo fires movestart/move/moveend synchronously.
    moveEndHandler?.();
  });
  cameraForBoundsSpy = vi.fn(() => cameraForBoundsResult ?? undefined);
  return {
    on: onSpy,
    off: offSpy,
    jumpTo: jumpToSpy,
    cameraForBounds: cameraForBoundsSpy,
    getCenter: () => ({ lat: 0, lng: 0 }),
    getBearing: () => 45,
  } as unknown as maplibregl.Map;
}

let fakeMap: maplibregl.Map | null;

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
  mapReady?: boolean;
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
  return render(<Follow3DController map={overrides.mapReady === false ? null : fakeMap} />);
}

describe('Follow3DController', () => {
  beforeEach(() => {
    moveEndHandler = null;
    cameraForBoundsResult = { center: [0, 0], zoom: 6, bearing: 45 };
  });

  it('Follow with 2 selected points: jumpTo the average center in [lng, lat] order, no bounds fit', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
    });
    expect(jumpToSpy).toHaveBeenCalledWith({ center: [10, 5] });
    expect(cameraForBoundsSpy).not.toHaveBeenCalled();
  });

  it('Auto-zoom with 2 points: resolves a camera for the padded bounds as [[W,S],[E,N]] and jumps to it', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      autoZoom: true,
    });
    // Same 15%-padded box the 2D suite pins ([[-1.5,-3],[11.5,23]] in [lat,lng]),
    // transposed into MapLibre's lng-first order.
    expect(cameraForBoundsSpy).toHaveBeenCalledWith(
      [
        [-3, -1.5],
        [23, 11.5],
      ],
      // Current bearing passed explicitly — MapLibre defaults it to 0, which
      // would snap a rotated 3D camera north-up on every follow update.
      { bearing: 45 },
    );
    expect(jumpToSpy).toHaveBeenCalledWith(cameraForBoundsResult);
  });

  it('Auto-zoom when MapLibre cannot fit the bounds: no camera move', () => {
    cameraForBoundsResult = null;
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      autoZoom: true,
    });
    expect(cameraForBoundsSpy).toHaveBeenCalled();
    expect(jumpToSpy).not.toHaveBeenCalled();
  });

  it('Both on: Auto-zoom governs — the bounds camera is used, not the Follow center', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
      autoZoom: true,
    });
    expect(jumpToSpy).toHaveBeenCalledTimes(1);
    expect(jumpToSpy).toHaveBeenCalledWith(cameraForBoundsResult);
  });

  it('Single selected point with Auto-zoom: jumpTo center (keeps zoom), no bounds fit', () => {
    setup({
      nodes: [node('mt:1', [5, 5])],
      selectedNodeIds: ['mt:1'],
      autoZoom: true,
    });
    expect(jumpToSpy).toHaveBeenCalledWith({ center: [5, 5] });
    expect(cameraForBoundsSpy).not.toHaveBeenCalled();
  });

  it('Empty selection: no camera move at all', () => {
    setup({
      nodes: [node('mt:1', [5, 5])],
      selectedNodeIds: [], // no keys match
      followMode: true,
      autoZoom: true,
    });
    expect(jumpToSpy).not.toHaveBeenCalled();
    expect(cameraForBoundsSpy).not.toHaveBeenCalled();
  });

  it('map not ready yet (null): renders without touching the camera or subscribing', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
      mapReady: false,
    });
    expect(jumpToSpy).not.toHaveBeenCalled();
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('a programmatic move does not self-pause', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
    });
    expect(jumpToSpy).toHaveBeenCalled();
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

  it('paused: no camera move even with a mode active', () => {
    setup({
      nodes: [node('mt:1', [0, 0]), node('mt:2', [10, 20])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
      autoZoom: true,
      followPaused: true,
    });
    expect(jumpToSpy).not.toHaveBeenCalled();
    expect(cameraForBoundsSpy).not.toHaveBeenCalled();
  });

  it('Follow no-op guard: jumpTo not called when the map center already equals the average', () => {
    // getCenter() is mocked to {lat:0,lng:0}; select points whose average is [0,0].
    setup({
      nodes: [node('mt:1', [-5, -5]), node('mt:2', [5, 5])],
      selectedNodeIds: ['mt:1', 'mt:2'],
      followMode: true,
    });
    expect(jumpToSpy).not.toHaveBeenCalled();
    expect(cameraForBoundsSpy).not.toHaveBeenCalled();
  });

  it('unsubscribes its moveend handler on unmount', () => {
    const { unmount } = setup({
      nodes: [node('mt:1', [0, 0])],
      selectedNodeIds: ['mt:1'],
      followMode: true,
    });
    unmount();
    expect(offSpy).toHaveBeenCalledWith('moveend', expect.any(Function));
  });
});
