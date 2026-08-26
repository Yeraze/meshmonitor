/**
 * Carto basemap API key helper.
 *
 * Carto is retiring its free, keyless raster basemaps: requests to
 * `basemaps.cartocdn.com` without a key come back stamped with an
 * "API key required" watermark. A free, domain-restricted key removes it and is
 * attached simply as a `?key=` query parameter on the same endpoints.
 *
 * The key is a *publishable* token (like a Mapbox public token) — it is sent
 * from the browser on every tile request by design, so we append it client-side
 * rather than proxying tiles. See docs/internal/dev-notes/CARTO_API_KEY_PLAN.md.
 */

/** Host suffix that identifies a Carto basemap CDN URL. */
const CARTO_HOST_SUFFIX = 'basemaps.cartocdn.com';

/**
 * Returns true when `url` points at the Carto basemap CDN (raster tiles, GL
 * style JSON, sprites, or glyphs — all served from that host).
 *
 * Tolerant of tile-template placeholders (`{s}`, `{z}`, …) in the URL: it
 * inspects the host portion only, which never contains a path placeholder.
 */
export function isCartoUrl(url: string): boolean {
  try {
    // Substitute the subdomain placeholder so the URL parses; other `{…}`
    // tokens live in the path and don't affect the hostname.
    const host = new URL(url.replace(/\{s\}/g, 'a')).hostname.toLowerCase();
    return host === CARTO_HOST_SUFFIX || host.endsWith('.' + CARTO_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/**
 * Appends the Carto `?key=` parameter to a Carto CDN URL. No-op when:
 * - `key` is empty/nullish,
 * - `url` is not a Carto CDN URL,
 * - the URL already carries a `key` parameter.
 *
 * Preserves any existing query string (uses `&` when a query already exists)
 * and any URL fragment, and leaves `{s}`/`{z}`/`{x}`/`{y}` path placeholders
 * intact so the result is still a valid tile template.
 */
export function withCartoKey(url: string, key: string | null | undefined): string {
  if (!key) return url;
  if (!isCartoUrl(url)) return url;

  // Split off any fragment first so the key lands before it.
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;

  // Already keyed? Leave it alone (idempotent).
  if (/[?&]key=/.test(base)) return url;

  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}key=${encodeURIComponent(key)}${fragment}`;
}
