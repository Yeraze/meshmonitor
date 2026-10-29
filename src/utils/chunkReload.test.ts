import { describe, it, expect, vi } from 'vitest';
import { installChunkReloadHandler, CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS } from './chunkReload';

function setup(initial: Record<string, string> = {}, now = 1_000_000) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  const target = new EventTarget();
  const reload = vi.fn();
  installChunkReloadHandler({ target, getStorage: () => storage, reload, now: () => now });
  const fire = () => {
    const event = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { store, reload, fire };
}

describe('installChunkReloadHandler', () => {
  it('reloads once on a chunk load failure and records the attempt', () => {
    const { store, reload, fire } = setup();
    const event = fire();
    expect(reload).toHaveBeenCalledTimes(1);
    // preventDefault stops Vite from rethrowing the error we are handling.
    expect(event.defaultPrevented).toBe(true);
    expect(store.get(CHUNK_RELOAD_KEY)).toBe('1000000');
  });

  it('does not reload again within the guard window, so a broken deploy cannot loop', () => {
    const { reload, fire } = setup({ [CHUNK_RELOAD_KEY]: String(1_000_000 - CHUNK_RELOAD_WINDOW_MS + 1) });
    const event = fire();
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('reloads again once the guard window has passed', () => {
    const { reload, fire } = setup({ [CHUNK_RELOAD_KEY]: String(1_000_000 - CHUNK_RELOAD_WINDOW_MS - 1) });
    fire();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves the failure alone when storage is blocked', () => {
    const target = new EventTarget();
    const reload = vi.fn();
    installChunkReloadHandler({
      target,
      getStorage: () => {
        throw new Error('SecurityError');
      },
      reload,
    });
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    expect(reload).not.toHaveBeenCalled();
  });
});
