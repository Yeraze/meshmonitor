# Carto Basemap API Key + Vector Basemaps — Implementation Plan

**Issue:** (to be filed) — "Support a Carto basemap API key + add Carto vector basemaps"
**Status:** Plan / not started
**Author:** Claude (for Randall)

## Background

Carto is retiring its free, keyless raster basemaps. When a client requests
`basemaps.cartocdn.com/{dark_all,light_all}/…` without a key, Carto now returns
tiles stamped with a repeated **"API key required"** watermark (the map still
works — it's a notice, not an outage). We use exactly those two endpoints for the
`cartoDark` / `cartoLight` tilesets (`src/config/tilesets.ts:65,73`), which is
why users see the watermark. `cartoDark` is also the default dark tileset
(`SettingsContext.tsx:87`).

Carto keys are **free, instant, no account, domain-restricted**. Request at
<https://carto.com/basemaps/apikey/>. The key attaches as a `?key=YOUR_KEY`
query parameter on the **same** endpoints — host is unchanged, so our CSP
(`src/server/middleware/dynamicCsp.ts:114`, `embedMiddleware.ts:48-49`) already
permits it with no change.

Carto also recommends moving from raster to **vector** GL basemaps
(sharper, fresher, restyleable):
| Raster | Vector GL style URL |
|--------|---------------------|
| `rastertiles/voyager` | `https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json` |
| `light_all` | `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json` |
| `dark_all` | `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json` |

## Design decisions (settled)

1. **Key scope: server-wide (deployment-global), admin-writable, publicly-readable.**
   One key per instance, set once by an admin in Settings; delivered to *every*
   client (including anonymous embed viewers, whose maps must load unwatermarked).

2. **NOT a secret. NOT a tile proxy.** A Carto basemap key is a *publishable,
   domain-restricted* token (like a Mapbox public token / Google Maps JS key).
   The browser sends it on every tile request by design — it cannot be hidden
   while using Carto's CDN, and its protection is the domain allowlist, not
   secrecy. A server-side tile proxy was explicitly rejected: it would route
   every basemap tile through MeshMonitor, defeating Carto's CDN and adding large
   bandwidth/latency for zero security gain. Therefore the key is appended
   **client-side** and is **not** placed in `SECRET_SETTINGS_KEYS`.

3. **Key attaches via `transformRequest` for vector, `?key=` string-append for raster.**
   The Leaflet MapLibre adapter forwards all options to `new maplibregl.Map(options)`
   (`node_modules/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js:125-131`),
   so `transformRequest` works in both 2D (via the adapter) and 3D (native). One
   `transformRequest` hook covers a GL style's style.json + tiles + sprites +
   glyphs, so we never have to guess whether the key propagates to sub-requests.

4. **Vector-in-3D is deferred** to a follow-up issue. `Base3DMap` renders a
   *raster* basemap source today; a full GL-vector 3D basemap is a substantial
   rework. 3D stays on raster-with-key (Phase 1), which already removes the
   watermark there.

## Phase 1 — Raster key (removes the watermark on every surface)

### 1a. Setting definition — `src/server/constants/settings.ts`
- Add `'cartoApiKey'` to `VALID_SETTINGS_KEYS` (near the `mapTileset*` keys, ~L95-97).
- Add `'cartoApiKey'` to `GLOBAL_ONLY_SETTINGS_KEYS` (global/deployment-wide;
  never written into a source namespace — mirrors `externalUrl`, `elevationEnabled`).
- **Do NOT** add to `SECRET_SETTINGS_KEYS` and **do not** name it with a
  `_secret`/`_token`/`_private_key` suffix — it must survive `stripSecretSettings`
  so anonymous/non-admin clients receive it.

### 1b. Deliver the key to clients
- **Logged-in / normal app:** the GET `/api/settings` response already flows into
  `SettingsContext` (`fetch` at `SettingsContext.tsx:1454`, `response.json()` at
  1459, field reads ~1604). Add a `cartoApiKey: string | null` field to
  `SettingsContextType` (`SettingsContext.tsx:101+`, near `mapTilesetDark:` L120)
  and populate it from that settings payload. Expose via `useSettings()`.
  - Unlike `mapTileset*` (localStorage per-user prefs), this is a **server-loaded
    global** — load it from the settings fetch, do not persist to localStorage.
- **Anonymous embed:** the public embed config is built at
  `src/server/routes/embedPublicRoutes.ts:82` (`tileset: profile.tileset, …`).
  Add `cartoApiKey` there, read server-side via
  `databaseService.settings.getSetting('cartoApiKey')`. `EmbedMap` then reads it
  from `config` (it has no `useSettings()`) and threads it into `BaseMap`.

### 1c. Append helper — new `src/config/cartoKey.ts` (unit-tested)
```ts
// Appends ?key= to Carto CDN URLs only; leaves every other host untouched.
// Safe on both {z}/{x}/{y} raster templates and GL style.json URLs.
export function withCartoKey(url: string, key: string | null | undefined): string
```
- Guard: only touch hosts ending in `basemaps.cartocdn.com`; no-op when `key` is
  empty. Preserve any existing query string (use `&` vs `?` correctly). Must not
  collide with `{s}`/`{z}` placeholder substitution (append at the end; the `{…}`
  tokens are in the path, not the query).

### 1d. Wire the helper at the tile-URL choke points
Thread the key (from `useSettings()` or embed `config`) to each consumer and wrap
the URL with `withCartoKey`:
- `src/components/map/BaseMap.tsx` — raster `<TileLayer url>` (L155) and the
  `overlayUrl` layer (L175). Add a `cartoApiKey?: string` prop (BaseMap currently
  takes no settings; keep it prop-driven per its design note L90). Callers pass it.
- `src/config/basemap3d.ts` `resolve3DBasemap` — the `tiles` array built from
  `tileset.url` (expandSubdomains, L34-64). Add a `cartoApiKey` param; callers
  (`NodesTab.tsx:982`, `DashboardMap.tsx:275`, `MapAnalysisCanvas.tsx:221`) pass
  `settings.cartoApiKey`. Consumed by `Base3DMap.tsx:378-379,641-643`.
- `src/components/*TracerouteWidget*.tsx` — builds its own `<TileLayer url>` (~L492-496),
  bypassing BaseMap. Wrap here too.
- `EmbedMap.tsx` (L414) — pass `cartoApiKey={config.cartoApiKey}` into `BaseMap`.

### 1e. Admin UI — `src/components/SettingsTab.tsx`
- Add an admin-only text input (masked/password style is nice-to-have; it is not
  a hard secret) in the map/appearance settings area, loaded + saved directly via
  the settings API — mirror an existing admin-only server field such as
  `elevationSourceUrl` / `appriseApiServerUrl`. Include a short helper line with
  the <https://carto.com/basemaps/apikey/> link and note it's free.
- Because the value is surfaced through `SettingsContext` (1b), the
  `server.settings-persistence.test.ts` guard (loaded-OR-in-`SERVER_ONLY_SETTINGS`)
  is satisfied **without** adding it to `SERVER_ONLY_SETTINGS`. Confirm which side
  of that guard we land on and adjust exactly one of {context load, SERVER_ONLY list}.

### 1f. Tests (Phase 1)
- `src/config/cartoKey.test.ts` — append/no-op/existing-query/non-carto-host/empty-key.
- `resolve3DBasemap` test — carto tileset + key ⇒ every `tiles[]` entry carries `?key=`.
- `BaseMap` test — raster carto url renders with the key (jsdom: assert the
  `url` prop passed to `TileLayer`, following the existing BaseMap test style).
- Embed: `embedPublicRoutes` test — public config includes `cartoApiKey` from
  global settings; `EmbedMap.test.tsx` — forwards `config.cartoApiKey` to `BaseMap`.
- Settings persistence test — `cartoApiKey` POST is accepted and round-trips; not
  stripped for a non-admin GET (unlike the secret keys).

## Phase 2 — Carto vector basemaps (2D)

### 2a. Tileset model — `src/config/tilesets.ts`
- Carto vector basemaps are **GL style JSON URLs**, not `{z}/{x}/{y}` tile
  templates. Add a distinct field (e.g. `styleUrl?: string`) so the vector branch
  knows to hand MapLibre a style URL rather than synthesize a `.pbf` style.
  `isVectorTileUrl()` keys off `.pbf`/`.mvt` today and must not misclassify these.
- Add three predefined entries: `cartoVoyager`, `cartoPositron`, `cartoDarkMatter`
  (styleUrl per the table above), with Carto+OSM attribution.

### 2b. `src/components/VectorTileLayer.tsx`
- When a `styleUrl` is provided: pass `style: styleUrl` **directly** to
  `L.maplibreGL({ style, attribution, transformRequest })` (skip the
  patch-sources / default-style branches, which assume a `.pbf` template).
- `transformRequest: (u) => u.includes('basemaps.cartocdn.com') ? { url: withCartoKey(u, key) } : undefined`
  — attaches the key to style.json + tiles + sprites + glyphs in one place.
- Thread `cartoApiKey` down from `BaseMap` (new prop) → `VectorTileLayer`.

### 2c. Tests (Phase 2)
- `VectorTileLayer` styleUrl branch — asserts the style URL + a `transformRequest`
  that rewrites carto hosts and no-ops others. (Mock `L.maplibreGL`.)
- `tilesets` — new entries resolve, `isVector` true, not misclassified by
  `isVectorTileUrl`, `validateTileUrl` not applied to styleUrl entries.

## Phase 3 — Vector basemaps in 3D (DEFERRED — separate issue)

`Base3DMap` builds a raster basemap source (`map.addSource('basemap', {type:'raster', tiles})`).
Supporting a Carto GL vector style in 3D means driving the `maplibregl.Map` from a
GL `style` (+ `transformRequest`) instead, and re-adding our overlay
sources/layers on top. Track separately; 3D stays raster-with-key until then.

## Cross-cutting / gotchas
- **CSP:** no change needed for raster (`?key=` same host). For vector, sprites
  and glyphs are also under `basemaps.cartocdn.com` — already allowed by
  `dynamicCsp.ts:114`; verify the embed CSP (`embedMiddleware.ts:48-49`) covers
  `img-src`/`connect-src` for the style/sprite/glyph fetches (it lists the host).
- **Attribution stays visible.** Carto terms require the notice/attribution
  remain; our tilesets already carry CARTO attribution — keep it.
- **Server ESM import extension rule:** any new server-side `.ts` imported in
  compiled code needs explicit `.js` in relative specifiers (CLAUDE.md).
- **No mesh-impact** (no packets/timers/notifications) — checklist N/A.
- **Multi-DB:** `cartoApiKey` is a plain settings row; no schema/migration.

## Rollout note (optional, not in scope)
Consider changing the default dark tileset off `cartoDark` only if we do *not*
ship a bundled key — with this feature the watermark is user-fixable, so the
default can stay. Decide at PR time.
