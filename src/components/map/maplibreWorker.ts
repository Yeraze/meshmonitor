/**
 * Point MapLibre GL at a Vite-bundled worker URL (#4800).
 *
 * MapLibre v6 (#4650) is ESM-only and ships its tiling/layout worker as a
 * separate module, `maplibre-gl-worker.mjs`. It builds that worker's URL
 * *dynamically* (a dev-vs-prod filename ternary), so Vite cannot statically
 * analyse the `new Worker(new URL(...), { type: 'module' })` call and never
 * emits the worker as a build asset. At runtime the browser then requests
 * `<base>/assets/maplibre-gl-worker.mjs`, gets a 404, and the worker never
 * starts.
 *
 * The worker is where GeoJSON sources are parsed into tiles and where symbol /
 * circle layers are laid out, so with a dead worker every GeoJSON source and
 * every symbol/circle layer silently renders nothing — while raster layers
 * (basemap, terrain-dem, hillshade) keep working because they don't use it.
 * That is exactly the 3D-map bug: terrain renders, nodes and labels never do.
 *
 * `?worker&url` makes Vite bundle the worker as its own chunk — resolving its
 * internal `./maplibre-gl-shared.mjs` import — and hand back a base-aware URL,
 * which we register via `setWorkerUrl` before any map is constructed. Importing
 * this module for its side effect at the top of the (single) map-constructing
 * component guarantees it runs first.
 */
import * as maplibregl from 'maplibre-gl';
// Vite virtual import: bundles the worker + its deps, returns the emitted URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// Vite builds with `base: '/'`, so the emitted URL is root-relative
// (`/assets/…`). But the app is served under a runtime base path (e.g.
// `/meshmonitor`) taken from the server-injected `<base>` tag — the same source
// `src/init.ts` uses. Without the prefix the worker 404s under a subpath
// deployment (#4800). Only rewrite a root-relative URL; leave absolute ones be.
const baseHref = document.querySelector('base')?.getAttribute('href') || '/';
const basePrefix = baseHref === '/' ? '' : baseHref.replace(/\/$/, '');
const workerUrl = maplibreWorkerUrl.startsWith('/')
  ? `${basePrefix}${maplibreWorkerUrl}`
  : maplibreWorkerUrl;

maplibregl.setWorkerUrl(workerUrl);
