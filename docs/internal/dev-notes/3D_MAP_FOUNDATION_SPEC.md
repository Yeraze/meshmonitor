# 3D Map Foundation — Implementation Spec (3D Map & Elevation Epic #3826, Phase 2)

Branch: `feature/3826-3d-map-foundation` (worktree `meshmonitor-3826-p2`, based on
`origin/main` which already contains Phase 1).

This spec covers Phase 2 only: the **DEM tile proxy** (backend) and the **3D map
foundation** (frontend MapLibre GL component + a 2D/3D toggle on Map Analysis
rendering node markers). It binds to the epic interview decisions (2026-07-20):
server proxy for DEM tiles, 3D only on Map Analysis, indoor/venue tilesets out of
scope. Phase 3 (neighbor links / traceroutes in 3D, full inspector parity,
settings surface, docs) is explicitly out of scope here and is noted where the
seam falls.

**Do not** implement from memory — every reused symbol is cited with a path
below. Read the cited file before extending it.

---

## 0. Binding constraints (from CLAUDE.md — re-read before coding)

- **Response envelope.** JSON handlers use `ok(res, data)` → `{success:true,data}`
  and `fail(res, status, code, message, extra?)` → `{success:false,error,code,...}`
  (`src/server/utils/apiResponse.ts`). The **binary tile handler returns raw
  `image/png` bytes** (no envelope); only its error paths use `fail()`.
- **The ApiService unwrap gotcha.** `ApiService.request()` returns the raw JSON
  body and does **not** unwrap `data`. So any *new* frontend consumer of an
  `ok(res, x)` handler must read `body.data`. (Contrast: `useElevationEnabled`
  reads `GET /api/settings`, which returns a **bare** map, not an envelope — do
  not copy that shape for the new capabilities endpoint, which *is* enveloped.)
- **No raw SQL outside repositories.** No DB schema work in this phase (settings
  are key/value rows; both elevation keys already exist — see §1).
- **Route tests MUST use `createRouteTestApp()`** (`src/server/test-helpers/routeTestApp.ts`);
  mock only `safeFetch`, never the DB.
- **Lint ratchet.** `npm run lint:ci` must exit 0. TS strict, no `any`, no raw
  `fetch()` in `src/components/**` or `src/pages/**` (MapLibre fetching tile URLs
  internally is fine and expected — the ban is on *app* code), `react-hooks/exhaustive-deps`
  clean for all new code.
- **No new settings keys.** `elevationEnabled` and `elevationSourceUrl` already
  exist in `VALID_SETTINGS_KEYS` (settings.ts L297–298) and
  `SECRET_SETTINGS_KEYS` (L526). Terrain exaggeration is client-local state; the
  2D/3D toggle persists in the existing `mapAnalysis.config.v1` localStorage blob
  (a client config, not a server settings key).

---

## 1. Reuse inventory (use / extend these — do not reinvent)

### Backend

| Concern | Reuse | Path |
|---|---|---|
| Terrarium URL template + SSRF-guarded fetch | `TerrariumTileProvider` (URL `{z}/{x}/{y}` substitution, `safeFetch`, `SsrfBlockedError` catch, degrade-to-null resilience) | `src/server/services/elevationProvider.ts` |
| Provider-type detection | `detectProviderType(url)` → `'terrarium' \| 'json'`; `resolveProvider(sourceUrl)`; `DEFAULT_TERRARIUM_URL` | `src/server/services/elevationProvider.ts` |
| SSRF guard | `safeFetch`, `SsrfBlockedError` (reuse verbatim — do **not** pass `strict:true`; custom sources may be a LAN tileserver) | `src/server/utils/ssrfGuard.ts` |
| Generic LRU | `LruCache<K,V>` | `src/server/utils/lruCache.ts` |
| Route orchestration seam | `computeProfile`, `testSource` live in a service, routes stay thin | `src/server/services/elevationService.ts` |
| Gating pattern (elevationEnabled → 403, optionalAuth, limiter, settings read) | `POST /profile` in the existing router | `src/server/routes/elevationRoutes.ts` |
| Rate-limiter factory | `rateLimit(...)` + shared `rateLimitConfig` + `env.isProduction` split (model on `meshcoreDeviceLimiter`; `elevationLimiter` already exists but is 20/min — wrong for tiles) | `src/server/middleware/rateLimiters.ts` |
| Envelope helpers | `ok`, `fail` | `src/server/utils/apiResponse.ts` |
| Settings read | `databaseService.settings.getAllSettings()` / `getSetting(key)` | `src/services/database.js` |
| Route mount point | `apiRouter.use('/elevation', elevationRoutes)` already mounted in server.ts | `src/server/server.ts` |
| CSP (already permits what MapLibre needs) | `worker-src 'self' blob:`, built-in raster tile hosts in `connect-src`, custom tile hosts added dynamically | `src/server/middleware/dynamicCsp.ts` |

**Why the tile route belongs in `elevationRoutes.ts`, not a new router:** it shares
the *exact* gating primitives (`elevationEnabled` flag, `optionalAuth`, a
per-domain limiter, the `elevationSourceUrl` settings read) and the same
`elevationService`/`elevationProvider` stack. A new router would duplicate the
mount, the gating, and the settings plumbing for one more path under the same
`/api/elevation` prefix. Add the two new routes to the existing router.

### Frontend

| Concern | Reuse | Path |
|---|---|---|
| Availability flag | `useElevationEnabled()` (TanStack, reads bare `/api/settings`) | `src/hooks/useElevationEnabled.ts` |
| Shared positioned+visible node list (the data the 3D markers consume) | `useAnalysisNodes()` → `AnalysisNode[] { node: NodeRecord; latLng:[lat,lng]; key:string }` | `src/components/MapAnalysis/useAnalysisNodes.ts` |
| Map Analysis client config + persistence | `useMapAnalysisConfig()` (localStorage `mapAnalysis.config.v1`, version-guarded `load()` that merges defaults) | `src/hooks/useMapAnalysisConfig.ts` |
| Context exposure of config fields | `MapAnalysisProvider` / `useMapAnalysisCtx()` (pattern: `followMode`/`setFollowMode` etc.); selection via `selected`/`setSelected` (`SelectedTarget { type:'node'\|'segment'\|'neighbor'\|'trail'; ... }`) | `src/components/MapAnalysis/MapAnalysisContext.tsx` |
| Toolbar toggle-button + gating pattern | `MapAnalysisToolbar` (measure/link-profile buttons: `className={active?'active':''}`, `disabled`, hidden-when-unavailable, title-hint tooltips) | `src/components/MapAnalysis/MapAnalysisToolbar.tsx` |
| 2D canvas host (unchanged in 2D) | `MapAnalysisCanvas` composes `BaseMap` + panes | `src/components/MapAnalysis/MapAnalysisCanvas.tsx` |
| Current basemap tileset id/URL + custom list | `useSettings()` → `mapTileset`, `customTilesets`, `setMapTileset`; `getTilesetById(id, custom)`, `TILESETS`, `DEFAULT_TILESET_ID='osm'`, `isVectorTileUrl` | `src/contexts/SettingsContext.tsx`, `src/config/tilesets.ts` |
| MapLibre CSS + dep | `maplibre-gl ^5.24.0`; CSS import precedent `'maplibre-gl/dist/maplibre-gl.css'` | `package.json`, `src/components/VectorTileLayer.tsx` |

**Why `Base3DMap` cannot reuse `BaseMap`:** `BaseMap` is hard-wired to
react-leaflet (`MapContainer`, `TileLayer`, a Leaflet `Map` instance, Leaflet
panes). MapLibre GL is a different renderer with its own `maplibregl.Map`, its own
sources/layers, and a WebGL context — there is no shared surface to parameterize.
`Base3DMap` is a genuinely new sibling that wraps `maplibregl.Map` **directly**
(`import maplibregl from 'maplibre-gl'`), **not** via `@maplibre/maplibre-gl-leaflet`
(that adapter embeds MapLibre *inside* Leaflet for vector tiles — the opposite of
what we need). It sits beside `BaseMap` in `src/components/map/`.

**Why not reuse the Leaflet `NodeMarkersLayer`:** it renders react-leaflet
`<Marker>` children with Leaflet `DivIcon`s — Leaflet-only, unusable in a WebGL
map. The 3D marker layer consumes the **same `useAnalysisNodes()` data** but
renders it as a MapLibre GeoJSON source + `circle`/`symbol` layer (see §2/§D).
Full icon parity with 2D DivIcons is Phase 3.

---

## 2. Design decisions

### 2.1 JSON-source behavior → machine-coded error (NOT silent terrarium fallback)

When `elevationSourceUrl` resolves to a **JSON point provider**
(`detectProviderType(url) === 'json'`), the tile endpoint returns
`fail(res, 409, 'TERRAIN_TILES_UNAVAILABLE', ...)` and the capabilities endpoint
reports `terrainTiles:false`. It does **not** silently fall back to the public
AWS terrarium URL.

Rationale:
1. **Admin intent / privacy.** Configuring a JSON source (self-hosted / API-keyed
   Open-Topo-Data) is a deliberate choice, often for air-gapped or
   cost-controlled deployments. Silently routing 3D tile traffic to
   `s3.amazonaws.com` would leak requests to a third party the admin explicitly
   opted away from.
2. **Consistency.** The 2D profile feature (`/profile`) samples the JSON source;
   if 3D terrain used AWS terrarium instead, the two features would disagree on
   elevation for the same coordinates.
3. **Clean UX.** A precise "3D terrain not available with the configured
   elevation source" state lets the frontend **disable the toggle with a
   tooltip** (a Phase-2 requirement) rather than render broken/blank terrain.

The default/unset and explicit-terrarium cases still use the public terrarium
provider exactly as `/profile` does — no regression for the common install.

### 2.2 Capabilities signal → new lightweight `GET /api/elevation/capabilities`

The frontend must know **before** rendering whether to enable the toggle, but it
**cannot** see `elevationSourceUrl` (secret, stripped from `/api/settings` for
non-admins). So provider type must be derived **server-side** and exposed as a
non-secret boolean. Add:

`GET /api/elevation/capabilities` → `ok(res, { enabled, terrainTiles, provider })`
- `enabled`  = `elevationEnabled !== 'false'`
- `provider` = `detectProviderType(sourceUrl || DEFAULT_TERRARIUM_URL)` (`'terrarium'|'json'`)
- `terrainTiles` = `enabled && provider === 'terrarium'`

Public (`optionalAuth`), no network I/O (reads two settings), no URL leak. This is
not a settings key — it is a derived capability, so it does not touch
`VALID_SETTINGS_KEYS`.

### 2.3 Raw-tile caching → small module-scope raw-PNG LRU, separate from the decoded cache

The existing `tileCache` in `elevationProvider.ts` stores **decoded `Float32Array`**
keyed `"z/x/y"` at the fixed sampling zoom 12 — useless to the proxy, which needs
**raw PNG bytes at arbitrary client zoom**. Add a **second, independent**
module-scope LRU holding raw tile buffers:

```ts
const rawTileCache = new LruCache<string, Buffer>(RAW_TILE_CACHE_MAX); // key `"z/x/y"`
export const RAW_TILE_CACHE_MAX = 256;
```

Memory bound: terrarium PNGs are ~10–120 KB (typ. ~50 KB); 256 × ~120 KB worst
case ≈ **~30 MB** ceiling, typically ~13 MB. Justification for caching at all
(vs. relying solely on the browser HTTP cache): the browser cache already absorbs
per-client repeats (we set `immutable`, §2.4); the server LRU dampens **cold /
cross-user / cross-session** refetches and shields the upstream tile host from
duplicate fan-out during multi-user bursts. Keep it separate from the decoded
cache — different key space (variable z), different value type, and mixing them
would evict warm profile tiles under 3D browsing pressure.

### 2.4 Cache-Control → long immutable

DEM terrain is static. On success respond:
`Cache-Control: public, max-age=604800, immutable` (7 days). This makes the
browser (and any intermediary) serve repeats from cache without revalidation,
which is the dominant traffic-reduction lever. Error responses set
`Cache-Control: no-store`.

### 2.5 Rate limiting → new `elevationTileLimiter` (generous), not `elevationLimiter`

`elevationLimiter` (20/min prod) is correct for `/profile` (one heavy fan-out per
call) but a 3D interaction legitimately fetches dozens of DEM tiles. Add a
dedicated limiter modeled on the same factory:

```ts
export const elevationTileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.isProduction ? 600 : 3000,   // 10/s prod; DEM tiles only — basemap tiles go direct to OSM/etc.
  message: 'Too many elevation tile requests, please slow down',
  handler: (req, res) => { logger.warn(`🚫 Rate limit exceeded for ELEVATION_TILES - IP: ${req.ip||'unknown'}`); res.status(429).json({ error: 'Too many elevation tile requests, please slow down', retryAfter: '1 minute' }); },
  ...rateLimitConfig,   // private IPs exempt, shared keygen
});
```

600/min comfortably covers first-load + pan/zoom bursts (a fresh 3D view is
~20–40 DEM tiles; only these hit the proxy). Abuse (outbound amplification) stays
bounded by the raw-tile LRU + SSRF guard + `immutable` browser caching + the
z/x/y validation cap (§2.6). Admin can hard-disable via `elevationEnabled=false`.

### 2.6 Tile coordinate validation + zoom cap

Parse `:z/:x/:y` as integers. Reject (→ `fail(res, 400, 'INVALID_TILE_COORDS')`)
when: non-integer; `z < 0 || z > MAX_TERRARIUM_TILE_ZOOM` (=15, AWS terrarium's
max native zoom); `x`/`y` outside `[0, 2^z − 1]`. This also caps the SSRF
guard's attack surface (only well-formed tile URLs are ever substituted). The
raster-dem source sets `maxzoom: 15`; MapLibre overzooms terrain past that
client-side.

### 2.7 Basemap resolution + the `{s}` subdomain gotcha (vector fallback)

3D basemap comes from the user's **current** raster tileset
(`getTilesetById(mapTileset, customTilesets)`). Two transforms are required
because MapLibre raster sources differ from Leaflet `TileLayer`:

- **Vector-only tileset → fall back to `TILESETS.osm`.** MapLibre raster sources
  can't consume a `.pbf`/`.mvt` vector tileset without a full style JSON (out of
  scope this phase). If `tileset.isVector`, use the default `osm` raster for the
  3D basemap and surface a subtle note. (The 2D view is unaffected — only the 3D
  basemap substitutes.)
- **`{s}` subdomain token → expand to a `tiles[]` array.** MapLibre does **not**
  support Leaflet's `{s}` placeholder. `osm`/`osmHot`/`carto*`/`openTopo` all use
  `https://{s}...`. A pure helper `expandSubdomains(url)` returns
  `['a','b','c'].map(s => url.replace('{s}', s))` when `{s}` is present, else
  `[url]`. `esriSatellite` has no `{s}` and uses `{z}/{y}/{x}` order — MapLibre
  substitutes `{x}/{y}/{z}` tokens regardless of order, so it works unmodified.

These two transforms live in a pure, unit-tested util (`§2/D basemap3d.ts`).

### 2.8 Toggle persistence → `viewMode` in the existing Map Analysis config

Add `viewMode: '2d' | '3d'` (default `'2d'`) to `MapAnalysisConfig` and a
`setViewMode` setter, persisted through the existing `mapAnalysis.config.v1`
localStorage mechanism. `load()` spreads `DEFAULT_CONFIG` first, so pre-existing
stored configs (no `viewMode`) default to `'2d'` with **no version bump**. This
is the same persistence path as `followMode`/`autoZoom`, satisfying "consistent
with existing Map Analysis prefs." (Not a server settings key — no
`VALID_SETTINGS_KEYS` involvement.)

### 2.9 Terrain exaggeration → client-local transient state

`useState<number>` in `Base3DMap` (default `1.0`, slider range `0`–`2`), applied
via `map.setTerrain({ source, exaggeration })`. Not persisted — per the phase
constraint, and it avoids a settings key. Phase 3 may promote a *default* value to
a real setting (with the `VALID_SETTINGS_KEYS` + `SettingsTab.handleSave` recipe).

### 2.10 3D interactivity: in-scope vs Phase 3

**In this phase:** raster basemap, `raster-dem` terrain from the proxy, hillshade
layer, `NavigationControl` (pitch/bearing/zoom/compass), exaggeration slider,
node markers (GeoJSON `circle` + short-name `symbol` label) built from
`useAnalysisNodes()`, and **click-a-marker → `setSelected({type:'node', ...})`**
(minimum viable: opens the existing inspector on the clicked node). Attribution.
WebGL teardown on unmount.

**Deferred to Phase 3:** neighbor links & traceroute paths in 3D; full node-icon
parity (DivIcon-equivalent styling, spiderfy, age-fade); popups/tooltips;
follow/auto-zoom; time-slider integration; the terrain-profile action; vector
basemap styling. `Base3DMap` is built generic (data in via props) so Phase 3 adds
layers without reshaping it.

### 2.11 Attribution

Enable MapLibre's built-in `AttributionControl` (compact). Attach the basemap
`tileset.attribution` (HTML) to the raster source's `attribution`, and an
elevation credit (`Elevation: Mapzen / AWS Terrain Tiles` for terrarium) to the
`raster-dem` source's `attribution`. MapLibre aggregates and renders them.

### 2.12 WebGL lifecycle / teardown

`Base3DMap` creates the `maplibregl.Map` in a `useEffect` and calls `map.remove()`
in cleanup to release the WebGL context (prevents "too many active WebGL contexts"
leaks on repeated 2D⇄3D toggles). The `Map` instance is held in a `ref`; the
create/remove pair is symmetric so React 19 StrictMode's dev double-mount
(mount→unmount→mount) is safe. Basemap/terrain/exaggeration/node-data updates go
through separate effects that mutate the existing map (`setStyle`/`getSource().setData()`/
`setTerrain()`), **not** by remounting the map.

### 2.13 CSP — no change expected (verify in browser)

`dynamicCsp.ts` already ships everything MapLibre needs: `worker-src 'self' blob:`
(MapLibre's blob-URL web workers), the four built-in raster hosts + dynamically
added custom hosts in `connect-src` (MapLibre fetches raster/DEM tiles via
`fetch`), and the DEM proxy is same-origin (`connect-src 'self'`). `img-src`
includes `data: http: https:`. **Verify during browser validation** that
hillshade/terrain render; the *only* plausible gap is if a browser lacks
`createImageBitmap` and MapLibre falls back to `Image()` from a blob URL — if (and
only if) tiles fail with a `blob:` `img-src` violation, add `'blob:'` to the
`img-src` array in `dynamicCsp.ts` (one-line, low-risk). Do not add it
preemptively.

### 2.14 Tile-proxy URL construction (base-path)

MapLibre fetches the DEM source URL directly, so the app must build an absolute
path that honors the deployment base (`BASE_URL`, e.g. `/meshmonitor`). Reuse the
same base prefix `ApiService` prepends (`ApiService` holds a `baseUrl` field;
Vite exposes `import.meta.env.BASE_URL`). The DEM source `tiles` entry is
`` `${base}/api/elevation/tiles/{z}/{x}/{y}` `` where `base` is that prefix
(trailing-slash-normalized). Keep this in the `basemap3d.ts` util
(`buildTerrainTileUrl(base)`), unit-tested, so it is not hand-rolled per call
site and does not use raw `fetch`.

---

## 3. File-by-file changes

### Backend

#### 3.1 `src/server/services/elevationProvider.ts` (EDIT)
Add raw-tile fetch + cache + a small validation/type helper. No change to
existing point-sampling code.
```ts
export const RAW_TILE_CACHE_MAX = 256;
export const MAX_TERRARIUM_TILE_ZOOM = 15;
// module-scope, separate from the decoded `tileCache`:
const rawTileCache = new LruCache<string, Buffer>(RAW_TILE_CACHE_MAX);

/** Integer + range validation for slippy-tile coords. */
export function isValidTileCoord(z: number, x: number, y: number): boolean;

/**
 * Fetch a raw terrarium PNG tile (bytes) for the given z/x/y from a terrarium
 * URL template, via safeFetch, with a shared raw-PNG LRU. Returns null on
 * invalid coords, non-terrarium template, non-OK response, SSRF block, or
 * network error (never throws). Substitutes {z}/{x}/{y} (client-supplied z,
 * unlike the fixed-zoom point sampler).
 */
export async function fetchTerrariumTilePng(
  urlTemplate: string, z: number, x: number, y: number,
): Promise<Buffer | null>;
```
- `fetchTerrariumTilePng` reuses the exact `safeFetch` + `SsrfBlockedError` catch
  + `{z}/{x}/{y}` `.replace(...)` pattern already in `TerrariumTileProvider`.
  Cache hit → return buffer; miss → fetch, `Buffer.from(await res.arrayBuffer())`,
  `set`, return. Non-OK / thrown → `logger.debug/warn` + return `null` (do not
  cache failures).

#### 3.2 `src/server/services/elevationService.ts` (EDIT — orchestration, keep routes thin)
```ts
export interface ElevationCapabilities { enabled: boolean; terrainTiles: boolean; provider: ProviderType; }

/** Pure-ish: derives capabilities from settings values (no network). */
export function getElevationCapabilities(
  elevationEnabled: string | undefined, sourceUrl: string | undefined,
): ElevationCapabilities;

/**
 * Resolve the terrain tile bytes for z/x/y honoring elevationSourceUrl.
 * - elevationEnabled === 'false'      → { code:'ELEVATION_DISABLED', status:403 }
 * - provider is JSON (no tiles)       → { code:'TERRAIN_TILES_UNAVAILABLE', status:409 }
 * - invalid coords                    → { code:'INVALID_TILE_COORDS', status:400 }
 * - upstream miss/failure             → { code:'TILE_FETCH_FAILED', status:502 }
 * - success                           → { png: Buffer }
 */
export async function fetchTerrainTile(
  z: number, x: number, y: number, elevationEnabled: string | undefined, sourceUrl: string | undefined,
): Promise<{ png: Buffer } | { code: string; status: number; message: string }>;
```
`fetchTerrainTile` resolves the terrarium template (`sourceUrl` if terrarium else
`DEFAULT_TERRARIUM_URL` is **not** used for JSON — JSON short-circuits to
`TERRAIN_TILES_UNAVAILABLE`), validates coords, calls `fetchTerrariumTilePng`.

#### 3.3 `src/server/middleware/rateLimiters.ts` (EDIT)
Append `elevationTileLimiter` (§2.5).

#### 3.4 `src/server/routes/elevationRoutes.ts` (EDIT — add two routes)
```ts
// GET /api/elevation/capabilities — PUBLIC (optionalAuth), no network.
router.get('/capabilities', optionalAuth(), async (_req, res) => {
  const s = await databaseService.settings.getAllSettings();
  ok(res, getElevationCapabilities(s.elevationEnabled, s.elevationSourceUrl));
});

// GET /api/elevation/tiles/:z/:x/:y — PUBLIC (optionalAuth) + tile limiter.
router.get('/tiles/:z/:x/:y', optionalAuth(), elevationTileLimiter, async (req, res) => {
  const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
  const s = await databaseService.settings.getAllSettings();
  const r = await fetchTerrainTile(z, x, y, s.elevationEnabled, s.elevationSourceUrl);
  if ('code' in r) {
    res.set('Cache-Control', 'no-store');
    return fail(res, r.status, r.code, r.message);
  }
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  return res.send(r.png);           // raw bytes — NOT ok()
});
```
- `:y` may arrive as `123.png`? No — MapLibre requests the template we give it
  (`.../{z}/{x}/{y}`, no extension), so `:y` is a bare integer. `Number('123')`
  is fine; a stray extension → `NaN` → `INVALID_TILE_COORDS`.
- Never include the resolved source URL (or key) in any `fail()` message.

*No `server.ts` change* — `/elevation` is already mounted.

### Frontend

#### 3.5 `src/config/basemap3d.ts` (NEW — pure, react-free, unit-tested)
```ts
import { getTilesetById, TILESETS, type TilesetId, type CustomTileset, type TilesetConfig } from './tilesets';

export interface Basemap3DSource { tiles: string[]; attribution: string; maxZoom: number; usedFallback: boolean; }

/** Expand Leaflet {s} into MapLibre tiles[]; single-element when absent. */
export function expandSubdomains(url: string): string[];

/** Raster basemap for the GL map; vector-only tileset → osm fallback (usedFallback=true). */
export function resolve3DBasemap(tilesetId: TilesetId, custom: CustomTileset[]): Basemap3DSource;

/** DEM proxy tile URL honoring the deployment base path. */
export function buildTerrainTileUrl(basePath: string): string; // `${base}/api/elevation/tiles/{z}/{x}/{y}`
```

#### 3.6 `src/hooks/useTerrainCapabilities.ts` (NEW)
TanStack query on `/api/elevation/capabilities`. **Reads `body.data`** (enveloped
— the ApiService gotcha). Returns `{ enabled, terrainTiles, provider }` with safe
defaults while loading (treat as loading, not available). Sibling test file
mirrors `useElevationEnabled.test.tsx`.
```ts
export function useTerrainCapabilities(): { enabled: boolean; terrainTiles: boolean; isLoading: boolean };
```

#### 3.7 `src/hooks/useMapAnalysisConfig.ts` (EDIT)
- Add `viewMode: '2d' | '3d'` to `MapAnalysisConfig`; `DEFAULT_CONFIG.viewMode='2d'`.
- `load()` already merges `DEFAULT_CONFIG` first → old blobs default to `'2d'`.
- Add `setViewMode` callback (mirrors `setFollowMode`), export it.

#### 3.8 `src/components/MapAnalysis/MapAnalysisContext.tsx` (EDIT)
Expose `viewMode` / `setViewMode` from the config hook through `CtxShape` (mirror
`followMode`/`setFollowMode`).

#### 3.9 `src/components/map/Base3DMap.tsx` (NEW)
Generic MapLibre GL surface (no Map-Analysis coupling — data via props).
```ts
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

export interface Node3DFeature { key: string; lat: number; lng: number; label?: string; color?: string; }
export interface Base3DMapProps {
  center: [number, number];        // [lat, lng]
  zoom: number;
  basemap: Basemap3DSource;        // from resolve3DBasemap
  terrainTileUrl: string;          // from buildTerrainTileUrl
  nodes: Node3DFeature[];
  onNodeClick?: (key: string) => void;
  className?: string;
}
```
Responsibilities: construct `maplibregl.Map` with a minimal style (raster basemap
source/layer); on `load` add `raster-dem` source (`encoding:'terrarium'`,
`tileSize:256`, `maxzoom:15`, `tiles:[terrainTileUrl]`), `map.setTerrain({source,
exaggeration})`, a `hillshade` layer, a GeoJSON `nodes` source + `circle` +
`symbol` label layer; `addControl(NavigationControl {visualizePitch:true})` and a
compact `AttributionControl`; register a `click` handler on the node circle layer
→ `onNodeClick(feature.properties.key)`; render an exaggeration `<input
type=range>` overlay (local state → `setTerrain`). Effects: basemap change →
update raster source; `nodes` change → `getSource('nodes').setData(...)`; unmount
→ `map.remove()`. All effect deps exhaustive.

#### 3.10 `src/components/MapAnalysis/MapAnalysisCanvas.tsx` (EDIT — add 3D branch)
- Read `viewMode` from `useMapAnalysisCtx()`; keep `mapTileset`/`customTilesets`
  from `useSettings()`.
- When `viewMode === '3d'`: render `Base3DMap` with
  `basemap = resolve3DBasemap(mapTileset, customTilesets)`,
  `terrainTileUrl = buildTerrainTileUrl(base)`, `nodes` mapped from
  `useAnalysisNodes()` (`{key, lat:latLng[0], lng:latLng[1], label:node.shortName}`),
  `onNodeClick = key => setSelected({type:'node', ... resolve from analysisNodes})`.
  Center/zoom from the existing `defaultMapCenter*`/`FALLBACK_*` values.
- When `viewMode === '2d'` (default): render the **existing** `BaseMap` tree
  **verbatim** — no behavioral change. The 3D branch is additive; 2D is untouched.
- If `usedFallback` (vector tileset), render a small non-blocking note over the 3D
  map ("Showing default basemap in 3D — the selected map style is vector-only").

#### 3.11 `src/components/MapAnalysis/MapAnalysisToolbar.tsx` (EDIT — 2D/3D toggle)
- `const caps = useTerrainCapabilities();`  `const { viewMode, setViewMode } = useMapAnalysisCtx();`
- Add a 2D/3D toggle button beside existing tools:
  - **Disabled** (with tooltip) when `!caps.enabled` → "Elevation is disabled"
    or `caps.enabled && !caps.terrainTiles` → "3D terrain is unavailable with the
    configured elevation source". While `caps.isLoading`, render disabled/neutral.
  - Enabled otherwise: `className={viewMode==='3d'?'active':''}`, onClick toggles
    `setViewMode(viewMode==='3d'?'2d':'3d')`.
- Follow the existing measure/link-profile title-hint + `active` class pattern.
- Consider forcing `viewMode` back to `'2d'` if it is `'3d'` but caps become
  unavailable (guard in the canvas or an effect) so a persisted `'3d'` never
  strands a user on a disabled feature.

#### 3.12 `src/services/api.ts` (EDIT — optional typed helper)
Optionally add `getTerrainCapabilities()` for symmetry with `getElevationProfile`;
acceptable for `useTerrainCapabilities` to call `apiService.get('/api/elevation/capabilities')`
directly (still reading `body.data`). Either is fine; keep app code off raw `fetch`.

---

## 4. Test plan (Vitest only; route tests via `createRouteTestApp`)

### Backend — `src/server/routes/elevationRoutes.test.ts` (EXTEND, harness)
Mock **only** `safeFetch` (return a tiny fake PNG `Buffer` for terrarium; a JSON
body for the JSON case). Use `createRouteTestApp({ mount })`.
- `GET /tiles/:z/:x/:y` **default provider** → 200, `Content-Type: image/png`,
  `Cache-Control` has `immutable`, body is the mocked bytes; anonymous succeeds
  (optionalAuth).
- **`elevationEnabled='false'`** → 403 `ELEVATION_DISABLED`, `no-store`.
- **JSON `elevationSourceUrl`** (e.g. `https://x/v1/test?locations={locations}`) →
  409 `TERRAIN_TILES_UNAVAILABLE`; body must **not** contain the URL/key.
- **Invalid coords** (`z=99`, `x=-1`, `y=NaN`/`abc`) → 400 `INVALID_TILE_COORDS`.
- **SSRF still applies**: `safeFetch` mock throws `SsrfBlockedError` → 502
  `TILE_FETCH_FAILED`, no key leak; assert `safeFetch` was the fetch path (no raw
  fetch).
- **Upstream non-OK** (mock `{ok:false,status:404}`) → 502 `TILE_FETCH_FAILED`.
- `GET /capabilities`: default → `{enabled:true,terrainTiles:true,provider:'terrarium'}`;
  `elevationEnabled='false'` → `enabled:false,terrainTiles:false`; JSON url →
  `terrainTiles:false,provider:'json'`. Assert envelope shape (`success:true,data`).
- Rate limiter smoke: not exhaustively (limiter internals are shared/tested), but
  assert the route is wired with `elevationTileLimiter` (a 200 path suffices;
  avoid flakiness).

### Backend — `src/server/services/elevationProvider.test.ts` (EXTEND)
- `isValidTileCoord` truth table (bounds, negative, non-integer, z>15).
- `fetchTerrariumTilePng`: mocked `safeFetch` → returns buffer + caches (second
  call does not re-fetch); non-OK → null; `SsrfBlockedError` → null (no throw);
  non-terrarium template guarded.

### Backend — `src/server/services/elevationService.test.ts` (EXTEND)
- `getElevationCapabilities` matrix (enabled/disabled × terrarium/json/default).
- `fetchTerrainTile` returns the right `{code,status}` per branch and `{png}` on
  success.

### Frontend (jsdom; **mock `maplibre-gl`** — no WebGL in jsdom)
`vi.mock('maplibre-gl')` exporting a fake `Map` class capturing constructor
options and recording `on/addSource/addLayer/setTerrain/addControl/getSource/
remove` calls; `NavigationControl`/`AttributionControl` as no-op classes;
`getSource` returns `{ setData: vi.fn() }`.
- `basemap3d.test.ts` (pure): `expandSubdomains` ({s}→3 urls, none→1);
  `resolve3DBasemap` (raster passthrough; vector → osm fallback + `usedFallback`;
  custom raster); `buildTerrainTileUrl` (base-path join, trailing slash).
- `useTerrainCapabilities.test.tsx`: reads `body.data`; loading defaults;
  disabled/json cases (mirror `useElevationEnabled.test.tsx`).
- `Base3DMap.test.tsx`: constructs `Map` with expected center/zoom/basemap tiles;
  on fake `load` adds `raster-dem` + hillshade + nodes source; node `click` →
  `onNodeClick`; **unmount calls `map.remove()`** (lifecycle). Exaggeration slider
  change → `setTerrain` called with new value.
- `MapAnalysisToolbar.test.tsx` (EXTEND): toggle hidden/disabled + tooltip when
  `!enabled` and when `enabled && !terrainTiles`; enabled path toggles
  `setViewMode`; reflects persisted `viewMode`.
- `MapAnalysisCanvas.test.tsx` (EXTEND): `viewMode='2d'` renders `BaseMap` (2D
  unchanged — assert no `Base3DMap`); `viewMode='3d'` renders `Base3DMap`
  (mocked) fed the mapped node data; vector tileset → fallback note.
- `useMapAnalysisConfig.test.ts` (EXTEND): `viewMode` default `'2d'`; old stored
  blob without `viewMode` loads as `'2d'`; `setViewMode` persists.

**Final gate (last package):** full Vitest suite (not targeted) + `npm run lint:ci`
exit 0 before PR (CLAUDE.md).

---

## 5. Work packages

Dependency graph: **WP-A** (backend) and **WP-B** (frontend pure/config) are
independent and may run in parallel. **WP-C** (Base3DMap) depends on WP-B.
**WP-D** (integration) depends on WP-A + WP-B + WP-C.

### WP-A — Backend DEM tile proxy + capabilities *(independent; start immediately)*
Files: `elevationProvider.ts` (raw fetch/cache/validation), `elevationService.ts`
(`getElevationCapabilities`, `fetchTerrainTile`), `rateLimiters.ts`
(`elevationTileLimiter`), `elevationRoutes.ts` (2 routes), and the three backend
test files (§4).
Acceptance: `GET /tiles/:z/:x/:y` returns `image/png` + `immutable` for the
default provider (anonymous 200); `ELEVATION_DISABLED` (403), `TERRAIN_TILES_UNAVAILABLE`
(409, no URL leak), `INVALID_TILE_COORDS` (400), `TILE_FETCH_FAILED` (502 incl.
SSRF-block) all correct; `GET /capabilities` matrix correct and enveloped; raw-tile
LRU is separate from the decoded cache; route tests use `createRouteTestApp` +
mocked `safeFetch` only; `npm run lint:ci` clean. **No frontend dependency.**

### WP-B — Frontend pure utils + capabilities hook + config field *(independent of WP-A)*
Files: `src/config/basemap3d.ts` (+ test), `src/hooks/useTerrainCapabilities.ts`
(+ test), `useMapAnalysisConfig.ts` (`viewMode` + setter, + test),
`MapAnalysisContext.tsx` (expose `viewMode`/`setViewMode`).
Acceptance: `expandSubdomains`/`resolve3DBasemap`/`buildTerrainTileUrl` unit-tested
incl. vector fallback and `{s}` expansion; `useTerrainCapabilities` reads
`body.data` with safe loading defaults; `viewMode` persists and old blobs default
to `'2d'`; suite green for touched files; lint clean.

### WP-C — `Base3DMap` MapLibre component *(depends WP-B for basemap3d types)*
Files: `src/components/map/Base3DMap.tsx` (+ `Base3DMap.test.tsx` with mocked
`maplibre-gl`).
Acceptance: constructs the GL map from `basemap`/`terrainTileUrl`/`nodes`; adds
`raster-dem` + terrain + hillshade + node circle/label layers; NavigationControl +
compact attribution; node click → `onNodeClick`; exaggeration slider → `setTerrain`;
`map.remove()` on unmount; effect deps exhaustive; lint clean. Renders generic
(no Map-Analysis imports).

### WP-D — Map Analysis integration (toggle + canvas branch) *(depends A+B+C)*
Files: `MapAnalysisToolbar.tsx` (2D/3D toggle + gating/tooltips), `MapAnalysisCanvas.tsx`
(3D branch feeding `useAnalysisNodes` → `Base3DMap`, `setSelected` on click, vector
fallback note, force-2D guard when caps unavailable), `src/services/api.ts`
(optional typed helper), extend `MapAnalysisToolbar.test.tsx` + `MapAnalysisCanvas.test.tsx`.
Acceptance: toggle disabled+tooltip when elevation disabled / JSON source; 3D
renders pitched terrain + hillshade + node markers on the dev container; 2D mode
byte-for-byte unchanged (regression-free); persisted `viewMode` respected and
never strands the user on a disabled feature; browser-validated with screenshots
(pitched terrain visible, markers clickable, 2D unchanged). **Final gate:** full
Vitest suite + `npm run lint:ci` exit 0; CSP verified (§2.13) — add `'blob:'` to
`img-src` *only if* browser validation shows a violation.

---

## 6. Invariants honored / explicit non-goals

- **Honored:** response envelope on all JSON (`ok`/`fail`), raw bytes only for the
  tile body; no raw SQL / no migration (settings keys pre-exist); route tests via
  harness with `safeFetch`-only mocking; SSRF guard on every outbound fetch; no
  secret (`elevationSourceUrl`) ever reaches the client or an error message; no
  new `VALID_SETTINGS_KEYS`; TS strict / no `any` / no raw `fetch` in components/pages;
  exhaustive-deps clean; 2D path untouched.
- **Non-goals (Phase 3):** neighbor links / traceroutes in 3D; full node-icon +
  spiderfy + popup parity; follow/auto-zoom; time slider in 3D; terrain-profile
  action from 3D; default-exaggeration setting; vector-basemap styling in 3D;
  README/docs updates; indoor/venue 3D tilesets (out of scope for the whole epic —
  fill-extrusion buildings noted as the cheap future first step in the #3826
  closing comment).
