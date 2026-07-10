/**
 * Shared Leaflet default-marker-icon fix.
 *
 * Leaflet's bundled default icon resolves image URLs relative to the CSS file,
 * which breaks under most bundlers (Vite included). The conventional fix is to
 * delete the built-in `_getIconUrl` resolver and re-point `L.Icon.Default` at
 * bundler-resolved PNG asset URLs.
 *
 * This is a side-effect module: importing it applies the fix once (and is
 * idempotent — re-importing / re-running is harmless, see BaseMap.test.tsx).
 *
 * See docs/internal/dev-notes/MAP_CONSOLIDATION_P1_SPEC.md §2.5 / §6.1 for why
 * this is the canonical (PNG) fix, replacing the App.tsx SVG teardrop variant
 * that had no rendered consumer.
 */
import L from 'leaflet';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

// Narrowed cast (no `any`) to delete the private `_getIconUrl` method Leaflet
// uses to derive image paths from the CSS file location.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl,
  iconUrl,
  shadowUrl,
});
