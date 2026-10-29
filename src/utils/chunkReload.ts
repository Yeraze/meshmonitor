/**
 * Self-heal stale-deploy chunk failures (#4047 investigation).
 *
 * After a redeploy rotates hashed chunk names, a browser holding cached HTML
 * 404s on lazy chunks: the dynamic import rejects and the affected subtree
 * wedges (seen as a dead map and unresponsive controls). Pages and the
 * per-source app's tabs are all lazy chunks, so this can hit any navigation.
 * Vite surfaces these failures as `vite:preloadError`; reload once to pick up
 * coherent HTML and chunks, with a sessionStorage guard so a genuinely broken
 * deploy can't reload-loop.
 */

/** sessionStorage key holding the time of the last chunk-error reload. */
export const CHUNK_RELOAD_KEY = 'mm-chunk-reload-at';

/** A second failure within this window is left to the error boundaries. */
export const CHUNK_RELOAD_WINDOW_MS = 30_000;

interface ChunkReloadDeps {
  target: Pick<Window, 'addEventListener'>;
  /** Read lazily: touching `window.sessionStorage` throws where storage is blocked. */
  getStorage: () => Pick<Storage, 'getItem' | 'setItem'>;
  reload: () => void;
  now?: () => number;
}

/**
 * Listen for `vite:preloadError` and reload the page once per
 * `CHUNK_RELOAD_WINDOW_MS`. Returns the handler (for tests).
 */
export function installChunkReloadHandler({ target, getStorage, reload, now = Date.now }: ChunkReloadDeps) {
  const handler = (event: Event) => {
    // Reload only when the attempt can be recorded: without the guard a
    // broken deploy would reload forever. Blocked storage leaves the failure
    // to the error boundaries.
    try {
      const storage = getStorage();
      const last = Number(storage.getItem(CHUNK_RELOAD_KEY) ?? 0);
      if (now() - last <= CHUNK_RELOAD_WINDOW_MS) return;
      storage.setItem(CHUNK_RELOAD_KEY, String(now()));
    } catch {
      return;
    }
    event.preventDefault();
    reload();
  };
  target.addEventListener('vite:preloadError', handler);
  return handler;
}
