/**
 * Placeholder filled in at dev/build time by the `meshmonitor-eager-css`
 * plugin in `vite.config.ts`.
 *
 * The route pages in `main.tsx` are lazy chunks, but their CSS must stay in
 * the entry stylesheet in its original cascade order. The plugin replaces this
 * module with a side-effect import of every stylesheet the lazy pages reach,
 * in the order the old all-static import graph ran them. Under Vitest (which
 * does not load that plugin) this stays an empty module.
 */
export {};
