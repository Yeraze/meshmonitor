/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGeolocationWatch } from './useGeolocationWatch';

type PosCb = (p: GeolocationPosition) => void;
type ErrCb = (e: GeolocationPositionError) => void;

let posCb: PosCb;
let errCb: ErrCb;
const watchPosition = vi.fn((ok: PosCb, err: ErrCb) => { posCb = ok; errCb = err; return 7; });
const clearWatch = vi.fn();
const getCurrentPosition = vi.fn();
const release = vi.fn().mockResolvedValue(undefined);
const wakeRequest = vi.fn();

const pos = (accuracy: number, timestamp: number) => ({
  coords: { latitude: 1, longitude: 2, accuracy },
  timestamp,
}) as unknown as GeolocationPosition;

function setSecure(v: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value: v, configurable: true });
}
function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  wakeRequest.mockResolvedValue({ release });
  setSecure(true);
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition, clearWatch, getCurrentPosition },
    configurable: true,
  });
  Object.defineProperty(navigator, 'wakeLock', { value: { request: wakeRequest }, configurable: true });
});
afterEach(() => { vi.useRealTimers(); });

describe('useGeolocationWatch', () => {
  it('reports insecure and refuses to start', () => {
    setSecure(false);
    const { result } = renderHook(() => useGeolocationWatch(vi.fn()));
    expect(result.current.support).toBe('insecure');
    act(() => result.current.start());
    expect(watchPosition).not.toHaveBeenCalled();
  });

  it('reports unavailable without navigator.geolocation', () => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    const { result } = renderHook(() => useGeolocationWatch(vi.fn()));
    expect(result.current.support).toBe('unavailable');
  });

  it('does not watch until start, then forwards fixes', () => {
    const onFix = vi.fn();
    const { result } = renderHook(() => useGeolocationWatch(onFix));
    expect(watchPosition).not.toHaveBeenCalled();
    act(() => result.current.start());
    expect(watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 }));
    act(() => posCb(pos(12, 1234)));
    expect(onFix).toHaveBeenCalledWith({ latitude: 1, longitude: 2, accuracy: 12, timestamp: 1234 });
    expect(result.current.accuracy).toBe(12);
    expect(result.current.state).toBe('watching');
  });

  it('enters denied on PERMISSION_DENIED and clears the watch', () => {
    const { result } = renderHook(() => useGeolocationWatch(vi.fn()));
    act(() => result.current.start());
    act(() => errCb({ code: 1, message: 'no' } as GeolocationPositionError));
    expect(result.current.state).toBe('denied');
    expect(clearWatch).toHaveBeenCalledWith(7);
  });

  it('asks for a position after 5 s of silence', () => {
    const { result } = renderHook(() => useGeolocationWatch(vi.fn()));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(4_999); });
    expect(getCurrentPosition).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(getCurrentPosition.mock.calls[0][2]).toMatchObject({ maximumAge: 2_000 });
  });

  it('a fix resets the heartbeat', () => {
    const { result } = renderHook(() => useGeolocationWatch(vi.fn()));
    act(() => result.current.start());
    act(() => { vi.advanceTimersByTime(4_000); });
    act(() => posCb(pos(10, 1)));
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('records time hidden and re-requests the wake lock on return', async () => {
    const { result } = renderHook(() => useGeolocationWatch(vi.fn()));
    act(() => result.current.start());
    await act(async () => { await Promise.resolve(); });
    expect(wakeRequest).toHaveBeenCalledTimes(1);
    expect(result.current.wakeLockActive).toBe(true);
    act(() => setVisibility('hidden'));
    act(() => { vi.advanceTimersByTime(120_000); });
    await act(async () => { setVisibility('visible'); await Promise.resolve(); });
    expect(result.current.pausedMs).toBeGreaterThanOrEqual(120_000);
    expect(wakeRequest).toHaveBeenCalledTimes(2);
    act(() => result.current.clearPaused());
    expect(result.current.pausedMs).toBeNull();
  });

  it('stop clears the watch and releases the wake lock', async () => {
    const { result } = renderHook(() => useGeolocationWatch(vi.fn()));
    act(() => result.current.start());
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.stop());
    expect(clearWatch).toHaveBeenCalledWith(7);
    expect(release).toHaveBeenCalled();
    expect(result.current.state).toBe('idle');
  });
});
