// Test stub for the Vite `?worker&url` virtual import used by
// `src/components/map/maplibreWorker.ts` (#4800). That suffix is a build-only
// Vite feature Vitest cannot resolve, and it targets a v6 dist file the test
// environment need not have. jsdom map tests mock `maplibre-gl` entirely, so
// the real worker URL is irrelevant here — an empty string is enough.
export default '';
