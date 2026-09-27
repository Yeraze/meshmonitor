/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet';
import { AssetPlaybackBar, type AssetPlaybackFix } from './AssetPlaybackBar';
import { PLAYBACK_SPEED_STORAGE_KEY } from '../../utils/trackPlayback';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const MIN = 60_000;

// Two drives: 0-20 min, a gap, then 120-130 min.
const FIXES: AssetPlaybackFix[] = [
  { timestamp: T0, latitude: 0, longitude: 0, groundSpeed: 36 },
  { timestamp: T0 + 10 * MIN, latitude: 1, longitude: 1 },
  { timestamp: T0 + 20 * MIN, latitude: 2, longitude: 2 },
  { timestamp: T0 + 120 * MIN, latitude: 5, longitude: 5, segmentStart: true },
  { timestamp: T0 + 130 * MIN, latitude: 6, longitude: 6 },
];
const END = T0 + 130 * MIN;

// Manual requestAnimationFrame so each test drives time explicitly.
let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
function tick(now: number) {
  const due = [...frames.values()];
  frames = new Map();
  act(() => { due.forEach(cb => cb(now)); });
}

function makeMap() {
  const layers = new Set<unknown>();
  const map = {
    addLayer: vi.fn((l: unknown) => { layers.add(l); return map; }),
    removeLayer: vi.fn((l: unknown) => { layers.delete(l); return map; }),
    hasLayer: (l: unknown) => layers.has(l),
    latLngToContainerPoint: vi.fn(() => ({ x: 500, y: 250 })),
    getSize: () => ({ x: 1000, y: 500 }),
    panTo: vi.fn(),
  };
  return map;
}

function setup(overrides: Partial<React.ComponentProps<typeof AssetPlaybackBar>> = {}) {
  const map = makeMap();
  const onTrailCursorChange = vi.fn();
  const props = {
    fixes: FIXES,
    map: map as unknown as LeafletMap,
    resetKey: 'node-a',
    timeFormat: '24' as const,
    dateFormat: 'YYYY-MM-DD' as const,
    distanceUnit: 'km' as const,
    onTrailCursorChange,
    ...overrides,
  };
  const utils = render(<AssetPlaybackBar {...props} />);
  return { ...utils, map, onTrailCursorChange, props };
}

const timeline = () => screen.getByTestId('asset-playback-timeline');
const cursorValue = () => Number(timeline().getAttribute('aria-valuenow'));
const playButton = () => screen.getByTestId('asset-playback-play');
const markerOf = (map: ReturnType<typeof makeMap>) => map.addLayer.mock.calls.at(-1)?.[0] as LeafletMarker;

describe('AssetPlaybackBar', () => {
  beforeEach(() => {
    frames = new Map();
    nextFrameId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    localStorage.removeItem(PLAYBACK_SPEED_STORAGE_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts at the end with the trail untouched and no marker', () => {
    const { map, onTrailCursorChange } = setup();
    expect(cursorValue()).toBe(END);
    expect(map.addLayer).not.toHaveBeenCalled();
    expect(onTrailCursorChange).toHaveBeenLastCalledWith(null);
  });

  it('play at the end restarts from the beginning and advances at the chosen speed', () => {
    const { map } = setup();
    fireEvent.click(playButton());
    expect(cursorValue()).toBe(T0);
    tick(0);
    tick(1000); // 1 s at the default 600× = 10 min of track
    expect(cursorValue()).toBe(T0 + 10 * MIN);
    expect(markerOf(map).getLatLng()).toMatchObject({ lat: 1, lng: 1 });
  });

  it('interpolates the marker between fixes', () => {
    const { map } = setup();
    fireEvent.click(playButton());
    tick(0);
    tick(500); // 5 min: halfway between the first two fixes
    expect(markerOf(map).getLatLng()).toMatchObject({ lat: 0.5, lng: 0.5 });
  });

  it('holds the marker inside a gap and says so in the readout', () => {
    const { map } = setup();
    fireEvent.click(playButton());
    tick(0);
    tick(6000); // 60 min: inside the 20-120 min gap
    expect(markerOf(map).getLatLng()).toMatchObject({ lat: 2, lng: 2 });
    expect(timeline().getAttribute('aria-valuetext')).toContain('map.playback.noFixes');
  });

  it('pause stops the cursor', () => {
    setup();
    fireEvent.click(playButton());
    tick(0);
    tick(300);
    fireEvent.click(playButton()); // pause
    const paused = cursorValue();
    tick(5000);
    expect(cursorValue()).toBe(paused);
    expect(frames.size).toBe(0);
  });

  it('stops at the end', () => {
    setup();
    fireEvent.click(playButton());
    tick(0);
    tick(1_000_000);
    expect(cursorValue()).toBe(END);
    expect(playButton().getAttribute('aria-label')).toBe('map.playback.play');
    expect(frames.size).toBe(0);
  });

  it('only commits React state about 5 times a second while the marker moves every frame', () => {
    const { map } = setup();
    fireEvent.click(playButton());
    tick(0);
    tick(250); // commits (>= 200 ms since start)
    const committed = cursorValue();
    tick(266); // moves the marker, too soon to commit
    expect(cursorValue()).toBe(committed);
    expect(markerOf(map).getLatLng().lat).toBeGreaterThan(0);
  });

  it('step buttons move one fix and pause', () => {
    setup();
    fireEvent.click(screen.getByLabelText('map.playback.stepBack'));
    expect(cursorValue()).toBe(T0 + 120 * MIN);
    fireEvent.click(screen.getByLabelText('map.playback.stepBack'));
    expect(cursorValue()).toBe(T0 + 20 * MIN);
    fireEvent.click(screen.getByLabelText('map.playback.stepForward'));
    expect(cursorValue()).toBe(T0 + 120 * MIN);
  });

  it('persists the speed and uses it', () => {
    const { unmount } = setup();
    fireEvent.change(screen.getByTestId('asset-playback-speed'), { target: { value: '3600' } });
    expect(localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY)).toBe('3600');
    unmount();

    setup();
    expect((screen.getByTestId('asset-playback-speed') as HTMLSelectElement).value).toBe('3600');
    fireEvent.click(playButton());
    tick(0);
    tick(1000); // 1 s at 3600× = 60 min
    expect(cursorValue()).toBe(T0 + 60 * MIN);
  });

  it('survives a storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    setup();
    expect((screen.getByTestId('asset-playback-speed') as HTMLSelectElement).value).toBe('600');
    expect(() => fireEvent.change(screen.getByTestId('asset-playback-speed'), { target: { value: '60' } })).not.toThrow();
  });

  it('keyboard: arrows step, Home/End jump, Space plays and pauses', () => {
    setup();
    const el = timeline();
    expect(el.getAttribute('role')).toBe('slider');
    fireEvent.keyDown(el, { key: 'Home' });
    expect(cursorValue()).toBe(T0);
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(cursorValue()).toBe(T0 + 10 * MIN);
    fireEvent.keyDown(el, { key: 'ArrowLeft' });
    expect(cursorValue()).toBe(T0);
    fireEvent.keyDown(el, { key: 'End' });
    expect(cursorValue()).toBe(END);
    fireEvent.keyDown(el, { key: ' ' });
    expect(playButton().getAttribute('aria-label')).toBe('map.playback.pause');
    fireEvent.keyDown(el, { key: ' ' });
    expect(playButton().getAttribute('aria-label')).toBe('map.playback.play');
  });

  it('aria-valuetext carries the readout', () => {
    setup();
    fireEvent.keyDown(timeline(), { key: 'Home' });
    const text = timeline().getAttribute('aria-valuetext');
    expect(text).toContain('2026-01-01');
    expect(text).toContain('36 km/h');
    expect(screen.getByTestId('asset-playback-readout').textContent).toBe(text);
  });

  it('calls back with the cursor time for trail-up-to-cursor, and null when off', () => {
    const { onTrailCursorChange } = setup();
    fireEvent.keyDown(timeline(), { key: 'Home' });
    expect(onTrailCursorChange).toHaveBeenLastCalledWith(T0);
    fireEvent.click(screen.getByTestId('asset-playback-trail'));
    expect(onTrailCursorChange).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByTestId('asset-playback-trail'));
    expect(onTrailCursorChange).toHaveBeenLastCalledWith(T0);
    fireEvent.keyDown(timeline(), { key: 'End' });
    expect(onTrailCursorChange).toHaveBeenLastCalledWith(null);
  });

  it('follow pans only when the marker leaves the middle of the view, at most every 500 ms', () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { map } = setup();
    fireEvent.click(screen.getByTestId('asset-playback-follow'));
    fireEvent.keyDown(timeline(), { key: 'Home' });
    expect(map.panTo).not.toHaveBeenCalled(); // centred

    map.latLngToContainerPoint.mockReturnValue({ x: 20, y: 250 });
    now += 100;
    fireEvent.keyDown(timeline(), { key: 'ArrowRight' });
    expect(map.panTo).toHaveBeenCalledTimes(1);

    now += 100; // within 500 ms of the last pan
    fireEvent.keyDown(timeline(), { key: 'ArrowRight' });
    expect(map.panTo).toHaveBeenCalledTimes(1);

    now += 600;
    fireEvent.keyDown(timeline(), { key: 'ArrowRight' });
    expect(map.panTo).toHaveBeenCalledTimes(2);
  });

  it('follow is off by default', () => {
    const { map } = setup();
    map.latLngToContainerPoint.mockReturnValue({ x: 0, y: 0 });
    fireEvent.keyDown(timeline(), { key: 'Home' });
    expect(map.panTo).not.toHaveBeenCalled();
    expect((screen.getByTestId('asset-playback-follow') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('asset-playback-trail') as HTMLInputElement).checked).toBe(true);
  });

  it('resets when the node changes', () => {
    const { rerender, props, map } = setup();
    fireEvent.click(playButton());
    tick(0);
    tick(500);
    expect(cursorValue()).toBeLessThan(END);
    rerender(<AssetPlaybackBar {...props} resetKey="node-b" />);
    expect(cursorValue()).toBe(END);
    expect(playButton().getAttribute('aria-label')).toBe('map.playback.play');
    expect(frames.size).toBe(0);
    expect(map.hasLayer(markerOf(map))).toBe(false);
  });

  it('resets when the history reloads', () => {
    const { rerender, props } = setup();
    fireEvent.keyDown(timeline(), { key: 'Home' });
    rerender(<AssetPlaybackBar {...props} fixes={[...FIXES]} />);
    expect(cursorValue()).toBe(END);
  });

  it('cancels the animation and clears the trail cutoff on unmount', () => {
    const { unmount, onTrailCursorChange } = setup();
    fireEvent.click(playButton());
    tick(0);
    tick(300);
    unmount();
    expect(frames.size).toBe(0);
    expect(onTrailCursorChange).toHaveBeenLastCalledWith(null);
  });

  it('draws the notches as one path and shades gaps', () => {
    setup();
    const svg = timeline();
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelector('path')?.getAttribute('d')?.match(/M/g)).toHaveLength(FIXES.length);
    // One gap rect plus the played-progress rect.
    expect(svg.querySelectorAll('rect')).toHaveLength(2);
  });
});
