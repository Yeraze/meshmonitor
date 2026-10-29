import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** A `React.lazy` component that can also start loading its chunk early. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint as React.lazy's own signature
export type PreloadableComponent<T extends ComponentType<any>> = LazyExoticComponent<T> & {
  /** Start (or reuse) the chunk download. Safe to call any number of times. */
  preload: () => Promise<unknown>;
};

/**
 * `React.lazy` plus a `preload()` that fetches the chunk ahead of the first
 * render, so a tab opened later (hover, idle, or the route the page landed
 * on) does not wait on the network.
 *
 * The `meshmonitor-eager-css` plugin in `vite.config.ts` follows
 * `lazyWithPreload(() => import('...'))` calls, so the CSS of a component
 * split this way stays in the entry sheet in its old cascade order. Keep the
 * call in exactly that shape (an arrow returning `import('literal')`, with an
 * optional `.then(...)` after it) or its CSS moves into the lazy chunk.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same constraint as React.lazy's own signature
export function lazyWithPreload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): PreloadableComponent<T> {
  let pending: Promise<{ default: T }> | null = null;
  const load = () => {
    if (!pending) {
      // A failed load must not stick: the next render (or a reload) retries.
      pending = factory().catch((err) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
  const component = lazy(load) as PreloadableComponent<T>;
  component.preload = load;
  return component;
}
