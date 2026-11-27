/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { DecodedMcoImage } from '../../utils/mcoImage/types.js';

const loaderState = vi.hoisted(() => ({
  loaded: null as unknown,
  load: null as unknown as () => Promise<unknown>,
}));

vi.mock('./loadMcoCodec.js', () => ({
  getLoadedMcoCodec: () => loaderState.loaded,
  loadMcoCodec: () => loaderState.load(),
}));

import { useMcoImageDecode } from './useMcoImageDecode.js';

const img = (w: number): DecodedMcoImage => ({
  format: 'im3',
  width: w,
  height: 1,
  rgba: new Uint8ClampedArray(w * 4),
});
const codec = () => ({ decodeMcoImageText: (p: string) => (p === 'bad' ? null : img(p.length)) });

describe('useMcoImageDecode', () => {
  beforeEach(() => {
    loaderState.loaded = null;
  });

  it('is ready synchronously when the codec is preloaded', () => {
    loaderState.loaded = codec();
    const { result } = renderHook(() => useMcoImageDecode('abc'));
    expect(result.current.status).toBe('ready');
  });

  it('is failed synchronously when decode returns null', () => {
    loaderState.loaded = codec();
    const { result } = renderHook(() => useMcoImageDecode('bad'));
    expect(result.current.status).toBe('failed');
  });

  it('loads then decodes', async () => {
    loaderState.load = () => Promise.resolve(codec());
    const { result } = renderHook(() => useMcoImageDecode('abc'));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('fails when the load rejects', async () => {
    loaderState.load = () => Promise.reject(new Error('chunk'));
    const { result } = renderHook(() => useMcoImageDecode('abc'));
    await waitFor(() => expect(result.current.status).toBe('failed'));
  });

  it('does not update after unmount', async () => {
    let resolve!: (c: unknown) => void;
    loaderState.load = () => new Promise((r) => (resolve = r));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useMcoImageDecode('abc'));
    unmount();
    resolve(codec());
    await Promise.resolve();
    expect(result.current.status).toBe('loading');
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('re-decodes when the payload changes', async () => {
    loaderState.loaded = codec();
    const { result, rerender } = renderHook(({ p }) => useMcoImageDecode(p), {
      initialProps: { p: 'abc' },
    });
    expect(result.current.status === 'ready' && result.current.image.width).toBe(3);
    rerender({ p: 'abcde' });
    await waitFor(() =>
      expect(result.current.status === 'ready' && result.current.image.width).toBe(5),
    );
  });
});
