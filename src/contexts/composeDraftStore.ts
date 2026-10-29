/**
 * Compose-draft store.
 *
 * The text in the message compose box changes on every keystroke. It used to
 * live in `MessagingContext` state, and App reads that context, so each
 * keystroke re-rendered App and with it most of the tree. The draft now lives
 * in this small external store instead: only the components that subscribe
 * (the compose host, via `useComposeDraft`) re-render when it changes. Code
 * that needs the draft at a single moment (the send handlers) reads it with
 * `store.get()` and does not subscribe.
 *
 * `MessagingProvider` owns one store per provider and keeps the #4183
 * draft-scoping rules (clear on conversation switch, prefill on
 * `openDmWithDraft`). Outside a provider (bare unit renders) the hooks fall
 * back to a module-level store so they never throw.
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

export type ComposeDraftUpdate = string | ((prev: string) => string);

export interface ComposeDraftStore {
  get: () => string;
  set: (next: ComposeDraftUpdate) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createComposeDraftStore(initial = ''): ComposeDraftStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === 'function' ? next(value) : next;
      if (resolved === value) return;
      value = resolved;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const ComposeDraftContext = createContext<ComposeDraftStore | null>(null);

const fallbackStore = createComposeDraftStore();

/** The store itself — stable identity, never causes a re-render. */
export function useComposeDraftStore(): ComposeDraftStore {
  return useContext(ComposeDraftContext) ?? fallbackStore;
}

/** Subscribe to the draft. Only call this where the text is rendered. */
export function useComposeDraft(): [string, ComposeDraftStore['set']] {
  const store = useComposeDraftStore();
  const value = useSyncExternalStore(store.subscribe, store.get, store.get);
  return [value, store.set];
}
