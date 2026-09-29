/**
 * Client-side fan-out for MeshCore Ignore / Block list changes (#5408).
 *
 * The ignored state of a message is computed by the server at read time, so
 * when a list changes every view that holds messages must reload them. The
 * server emits `meshcore:filters:changed` over the socket; `useMeshCore`
 * receives it and re-broadcasts it here, and local mutations emit it directly
 * so the change shows at once in this tab.
 */

export interface FiltersChangedDetail {
  sourceId: string;
}

const EVENT = 'meshcore-filters-changed';

export function emitFiltersChanged(detail: FiltersChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<FiltersChangedDetail>(EVENT, { detail }));
}

export function subscribeFiltersChanged(cb: (detail: FiltersChangedDetail) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<FiltersChangedDetail>).detail;
    if (detail && typeof detail.sourceId === 'string') cb(detail);
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
