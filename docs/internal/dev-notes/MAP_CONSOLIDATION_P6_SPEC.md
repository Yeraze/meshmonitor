# Map Consolidation — Phase 6 Spec: Embed Traceroute Alignment

**Epic:** #4047 · **Phase:** 6 · **Branch:** `feature/4047-p6-embed-traceroutes` (from `origin/4049-map-refactor`)
**Status:** Spec — no feature code written yet.
**Scope:** the public embed map only (`src/components/EmbedMap.tsx` + `src/embed.tsx` bundle,
`GET /api/embed/:profileId/traceroutes`). This is the ONE phase with a backend/API surface.

## 0. TL;DR for implementers

Today the public embed renders traceroutes as **server-computed straight fixed-mauve (`#cba6f7`)
weight-3 lines**, one `snr` per segment, no legs / no direction / no MQTT distinction / no theme
awareness. The app (post-Phase-3) renders traceroutes through the shared
`TraceroutePathsLayer` + `decomposeTraceroute` with the canonical 4-band theme-aware SNR scale,
forward/return legs, arrows, and MQTT/unknown dashing. Phase 6 makes the embed match.

**Decision (binding, from the epic interview — "Align fully"):** extend the embed traceroute API to
carry SNR + leg data **backward-compatibly**, and render the embed through the shared
`TraceroutePathsLayer` with the canonical SNR palette chosen from the profile's tileset scheme.

**The two load-bearing architecture calls this spec makes (justified in §2):**

1. **Decompose with the shared util `decomposeTraceroute`, invoked SERVER-SIDE, and return an
   ADDITIVE SUPERSET of the existing wire segment shape** — NOT raw rows + a new endpoint, and NOT
   a re-implemented server decomposition. The bespoke hand-rolled decomposition loop in
   `embedPublicRoutes.ts` (parse `route`, build `fullPath`, per-pair dedup) is **deleted** and
   replaced by `decomposeTraceroute` (the ONE decomposition), which the app already uses. Old cached
   embed clients keep working because every field they read is still present; new fields are ignored
   by them.
2. **The embed bundle has no `SettingsContext`** (`src/embed.tsx` renders `<EmbedMap>` bare — no
   `SettingsProvider`). So the SNR palette CANNOT come from `useSettings()`. It is computed directly
   from the profile's tileset: `getOverlayColors(getSchemeForTileset(config.tileset))`. This is the
   canonical answer to "which palette (light vs dark) and how is it chosen" for the embed.
   `TraceroutePathsLayer` already takes `snrColors` as a **prop** (Phase-3 design choice, context-
   free) so it drops into the isolated embed bundle with no provider.

Two work packages: **WP1 server** (rewrite the endpoint via the shared util, additive fields, tests) →
**WP2 client** (EmbedMap renders via the shared layer, palette from tileset scheme, tests + iframe
validation).

**Explicitly OUT of scope (do NOT touch — flag to orchestrator if tempted):** BaseMap adoption for
EmbedMap (its isolated bundle + custom zoom/attribution/URL-param center logic — Phase 7 or a later
follow-up); the embed's node markers (already use the Phase-4 `createNodeIcon` factory) and its
bespoke node popup (Phase-5 popup-family alignment for the embed is not this phase); the
`showPaths`/`showTraceroutes` gate quirk (§6.4); the neighbor-info lines (unrelated feature).

---

## 1. Reuse inventory (serena/grep-verified 2026-07-10)

### 1.1 Server side — `src/server/routes/embedPublicRoutes.ts`

| Element | Fact |
|---|---|
| Route | `GET /:profileId/traceroutes` (L196-304), mounted **outside** the API router — no CSRF, no rate limiter, no session/auth. |
| Auth model | **Anonymous, gated by profile-ID-as-token.** `createEmbedCspMiddleware()` (`embedMiddleware.ts`) looks up the profile by ID, 404s if missing/disabled, attaches `req.embedProfile`. No `requirePermission`. |
| Opt-in gate | Returns `404 { error: 'Traceroutes not enabled for this profile' }` unless `profile.showTraceroutes` (default false — avoids leaking mesh topology). **Keep this gate unchanged.** |
| Response shape | **Bare JSON array** `res.json(Array.from(segmentMap.values()))` — NOT the `ok()`/`fail()` envelope (see §3.1). |
| Data available | `getAllTraceroutes(100, profile.sourceId ?? ALL_SOURCES)` → full `DbTraceroute[]` incl. `route`, `routeBack`, `snrTowards`, `snrBack`, `routePositions` (the #1862 snapshot), `timestamp`. |
| Position filter | Builds `nodePositions: Map<nodeNum → {lat,lng,name}>` from `getActiveNodes(7, …)` with the SAME filters as `/nodes`: effective position (`getEffectiveDbNodePosition`, #2847), drop `(0,0)`, drop `hideFromMap` (#3549), MQTT filter (`!showMqttNodes && viaMqtt`), channel filter. A segment is emitted **only when BOTH endpoints resolve** in this filtered map. This is the leak boundary — hidden/filtered nodes never leave the server. |
| Current SNR | `snr: snrValues[i] ?? null` where `snrValues = JSON.parse(tr.snrTowards)` — the **raw firmware int (dB×4), UN-scaled** (a latent bug, same class as Dashboard's pre-P3 un-scaled SNR). The old client popup prints `{seg.snr} dB` (wrong magnitude). |
| Cross-source | `profile.sourceId ?? ALL_SOURCES` — a source-less profile intentionally spans all sources (established by commit 45f7e7be / 64081b6f; `withSourceScope` fails closed, `ALL_SOURCES` is the sanctioned cross-source sentinel). **Preserve verbatim.** |
| Route-level tests | **NONE.** `embedPublicRoutes.test.ts` does not exist. `embedProfileRoutes.test.ts` covers only the ADMIN profile-CRUD routes. The public traceroute endpoint is currently untested. |

### 1.2 Current wire shape (the backward-compat contract) — `EmbedTracerouteSegment`

`EmbedMap.tsx` L61-72 and the server's `segmentMap` value type agree on:
```ts
{ fromNum, toNum, fromLat, fromLng, fromName, toLat, toLng, toName, snr: number|null, timestamp }
```
The old client reads ONLY: `fromLat/fromLng/toLat/toLng` (positions), `fromName/toName` + `snr`
(popup text). It renders `<Polyline color="#cba6f7" weight={3} opacity={0.8}>` per segment (L324-355).
**Any new response MUST keep these fields populated and correctly typed** or an open/cached old
iframe breaks.

### 1.3 Client side — `src/components/EmbedMap.tsx` + `src/embed.tsx`

| Element | Fact |
|---|---|
| Bundle isolation | `src/embed.tsx` mounts `<EmbedMap>` with **NO** `SettingsProvider`/`SettingsContext`/`ThemeProvider`. `EmbedMap` calls no `useSettings()`. It CANNOT read `overlayColors` from context. |
| Map shell | Raw `MapContainer` + `TileLayer` (Phase 1 deliberately left EmbedMap un-migrated). Custom center/zoom logic incl. URL-param overrides `?lat=&lon=&zoom=` (#2668). **Do NOT adopt BaseMap here (out of scope).** |
| Node markers | `createNodeIcon(...)` via `../utils/mapIcons` (the Phase-4 shim → `src/components/map/markerIcons.ts`). Already canonical — leave as-is. |
| Traceroute block | L324-355: `config.showPaths && tracerouteSegments.map(seg => <Polyline color="#cba6f7" weight={3} …>)` with a `<Popup>` showing `{seg.snr} dB`. **This block is what P6 replaces.** |
| Fetch | Raw `fetch(`${baseUrl}/api/embed/${profileId}/traceroutes`)` (L182-192), gated `config.showPaths`, polled every `pollIntervalSeconds`. Reads bare JSON directly (no `ApiService`, no envelope unwrap). |
| Tileset | `config.tileset` (per-profile, chosen in `EmbedSettings`), resolved by `getEmbedTileset` → `TILESETS[...]`. |
| Popup CSS | Inline `embedPopupCss` (Catppuccin dark, hardcoded — the embed doesn't load app CSS vars). Reused for the new traceroute popup. |

### 1.4 Shared modules P6 consumes (Phase-3 output — verified present on this branch)

| Symbol | File | Relevance |
|---|---|---|
| `decomposeTraceroute(tr, {resolvePosition})` | `src/utils/tracerouteSegments.ts` | The ONE decomposition. Pure/React-free/leaflet-free — **importable server-side** (see §2.2). Input `TracerouteDecomposeInput` is a structural subset of `DbTraceroute`. Emits `TracerouteRenderSegment[]` with `leg`, `avgSnr` (**/4-scaled**, null=no data), `isMqtt` (per-hop #2931 sentinel), `fromNodeNum`/`toNodeNum`, `timestamp`. |
| `TracerouteRenderSegment` | `src/utils/tracerouteSegments.ts` | The layer's segment type. |
| `TraceroutePathsLayer` | `src/components/map/layers/TraceroutePathsLayer.tsx` | The ONE renderer. Named export, `memo`, takes `snrColors` as a **prop** (no `useSettings` — embed-safe). Imports only `mapHelpers` + `tracerouteSegments` + `react-leaflet` (no context). |
| `snrToColor`, `weightBySnr`, `MQTT_DASH`, `SnrColorScale` | `src/utils/mapHelpers.tsx` | Canonical scale/weight/dash. |
| `getOverlayColors`, `getSchemeForTileset`, `OverlayColors.snrColors {excellent,good,fair,poor,noData}` | `src/config/overlayColors.ts` | 4-band theme palette + tileset→scheme map (`osm/osmHot/cartoLight/openTopo`→light; `cartoDark/esriSatellite`→dark; custom→dark). Plain TS module (no context) — embed imports it directly. |

### 1.5 Server import boundary (verified)

`tsconfig.server.json` `include` lists `src/utils/**/*`. Server routes already import root `src/utils/*`
(`meshcoreRoutes.ts` imports `../../utils/nullIsland.js`, `../../utils/meshcorePacketDecode.js`,
`../../utils/safeRegex.js`). So `import { decomposeTraceroute } from '../../utils/tracerouteSegments.js'`
in `embedPublicRoutes.ts` is precedented and compiles. `tracerouteSegments.ts` is explicitly documented
leaflet-free/React-free for exactly this cross-boundary reuse.

---

## 2. API design

### 2.1 Backward-compat strategy — ADDITIVE SUPERSET on the existing endpoint (chosen)

The wire response of `GET /api/embed/:profileId/traceroutes` stays a **bare JSON array** whose element
type is a **superset** of the current `EmbedTracerouteSegment`:

```ts
interface EmbedTracerouteSegmentV2 {
  // --- existing fields (UNCHANGED — old cached clients read these) ---
  fromNum: number;
  toNum: number;
  fromLat: number;
  fromLng: number;
  fromName: string;
  toLat: number;
  toLng: number;
  toName: string;
  snr: number | null;   // see §2.3 — now the /4-scaled value (was raw dB×4)
  timestamp: number;
  // --- additive fields (NEW — old clients ignore; new client renders from these) ---
  leg: 'forward' | 'return';
  avgSnr: number | null; // canonical /4-scaled dB; null = no data / MQTT sentinel
  isMqtt: boolean;       // per-hop #2931 sentinel, NOT node.viaMqtt
}
```

**Why additive-superset and NOT a versioned endpoint or raw-rows:**

| Option | Backward-compat | "One decomposition" | Leak surface | Server code | Verdict |
|---|---|---|---|---|---|
| **Additive superset, shared util server-side** (chosen) | ✅ old clients read the same fields | ✅ uses `decomposeTraceroute` verbatim (server-side invocation of the ONE util) | ✅ unchanged — still filters to visible-node positions | ✅ net simpler (delete bespoke loop) | **Chosen** |
| Raw rows on same endpoint + client decomposition | ❌ **breaks** old clients (they map `seg.fromLat` → undefined) | ✅ | ⚠️ must ship raw `route`/`routeBack` arrays; snapshot leak risk if `routePositions` shipped | ➖ needs client position plumbing | Rejected (breaks compat) |
| Versioned `/traceroutes/v2` raw rows + client decomposition | ✅ old `/v1` untouched | ✅ | ⚠️ same raw-array concern | ❌ **TWO endpoints** to carry; v1 still does bespoke decomposition | Rejected (more surface, not less) |
| Additive superset but re-implement leg/isMqtt logic server-side | ✅ | ❌ re-implements decomposition (drift) | ✅ | ➖ | Rejected (violates epic spirit) |

The decisive points: (a) client-side decomposition **necessarily requires raw route arrays**, which
on the shared endpoint breaks old clients, and via a v2 endpoint doubles the server surface while
leaving the bespoke v1 loop alive; (b) "one decomposition" is satisfied by invoking the **shared
`decomposeTraceroute` util server-side** — this is NOT "fattening a bespoke server segment builder,"
it is deleting the bespoke builder and calling the same pure util the app calls; (c) additive-superset
is the only option that is *both* backward-compatible on a single endpoint *and* least total code.

No new endpoint. No `?format=` param. No version field. The response is a strict superset — an old
bundle rendering against the new server is unaffected.

### 2.2 Server handler rewrite (`GET /:profileId/traceroutes`)

Replace the L232-299 hand-rolled decomposition with:

1. Keep the existing preamble unchanged: profile 404, `showTraceroutes` 404 gate, `getActiveNodes` +
   the `nodePositions: Map<nodeNum → {lat,lng,name}>` build (all filters intact), `getAllTraceroutes(100, sourceId ?? ALL_SOURCES)`, and the 24h `cutoffMs` window.
2. Build a **live-only** `resolvePosition`:
   ```ts
   const resolvePosition = (n: number): [number, number] | null => {
     const p = nodePositions.get(n);
     return p ? [p.lat, p.lng] : null;
   };
   ```
   **Deliberately no snapshot** (`routePositions`) — see §5 (leak avoidance + parity with the embed's
   current live-only behavior). `decomposeTraceroute` skips any segment whose endpoint resolves to
   `null`, so hidden/filtered nodes never appear and never leak, exactly as today.
3. For each traceroute within the window (`tsMs >= cutoffMs`), call
   `decomposeTraceroute(tr, { resolvePosition })` → `TracerouteRenderSegment[]`.
4. **Dedup across traceroutes by `seg.key`** (the util's key is `` `${leg}:${fromNum}-${toNum}` `` —
   forward and return legs are distinct keys, so both survive), keeping the segment with the newest
   `timestamp`. (Directional-within-leg dedup is fine and matches app behavior; do NOT collapse
   forward+return into one bidirectional key — that would drop the return leg the epic wants shown.)
5. Map each surviving `TracerouteRenderSegment` → `EmbedTracerouteSegmentV2`, pulling `fromName`/
   `toName` from `nodePositions` (`.get(fromNodeNum)!.name`), setting `snr = avgSnr` (§2.3),
   `avgSnr`, `isMqtt`, `leg`, positions from `seg.from`/`seg.to`.
6. **Cap the output** at `MAX_EMBED_TR_SEGMENTS = 500` (response-size guard; public/cacheable
   endpoint) — sort by `timestamp` desc before slicing so the freshest survive. In practice 100
   traceroutes over 24h rarely approach this, but the cap is a hard ceiling.
7. `res.json(segments)` — bare array, unchanged envelope posture.

Net: the handler gets **shorter** (the parse/fullPath/segment-loop is gone) and gains correct
forward/return legs + per-hop MQTT/unknown handling for free from the shared util.

### 2.3 The legacy `snr` field

The old server populated `snr` with the **raw un-scaled** `snrTowards[i]` (dB×4). The shared util
exposes `avgSnr` (/4-scaled, sentinel→null). Set the legacy `snr = avgSnr`. Effect on an old cached
client: its popup `{seg.snr} dB` now shows the **correct scaled** dB instead of the former ×4 value —
a strict fix, non-breaking (still a number-or-null, still renders). Listed in §7 as an accepted
incidental change to stale clients. The new client ignores `snr` entirely and reads `avgSnr`.

### 2.4 Permission / envelope — UNCHANGED

- **No permission change.** Still anonymous, still gated by `showTraceroutes` + profile-ID-as-token.
  No `requirePermission`, no session. Do not introduce the envelope: these routes are consumed by raw
  `fetch()` reading a bare array; wrapping in `ok(res, …)` would break both old AND new clients (per
  the CLAUDE.md `ApiService` unwrap gotcha — and here there's no `ApiService` at all). `fail()` is not
  introduced either; the existing bare `{ error }` 404/500 bodies stay (the client's `catch`/`!res.ok`
  paths already handle them).

---

## 3. Client render design

### 3.1 Palette selection (the canonical theme answer)

EmbedMap computes the palette once from the profile tileset — no context, no `useSettings`:
```ts
import { getOverlayColors, getSchemeForTileset } from '../config/overlayColors';
// after config loads:
const overlay = getOverlayColors(getSchemeForTileset(config.tileset));
const snrColors = overlay.snrColors;      // 4-band {excellent,good,fair,poor,noData}
const mqttColor = overlay.mqttSegment;    // MQTT/IP-bridged distinction
```
`getSchemeForTileset` maps built-in tilesets to light/dark and defaults **custom tilesets → dark**
(matches the app). This is the sole palette signal for the embed (EmbedSettings has no per-profile
overlay-scheme override; if one is ever added it would thread here). Memoize on `config.tileset`.

### 3.2 The render block (replaces `EmbedMap.tsx` L324-355)

Map the wire segments → `TracerouteRenderSegment[]` (positions already resolved server-side; this is a
trivial field rename, no decomposition on the client) and render through the shared layer:

```tsx
const renderSegments: TracerouteRenderSegment[] = tracerouteSegments.map(s => ({
  key: `${s.leg}:${s.fromNum}-${s.toNum}`,
  from: [s.fromLat, s.fromLng],
  to: [s.toLat, s.toLng],
  fromNodeNum: s.fromNum,
  toNodeNum: s.toNum,
  leg: s.leg,
  avgSnr: s.avgSnr,
  isMqtt: s.isMqtt,
  timestamp: s.timestamp,
}));

{config.showPaths && (
  <TraceroutePathsLayer
    segments={renderSegments}
    snrColors={snrColors}
    colorMode="snr"
    mqttColor={mqttColor}
    curvature={0.2}
    weight={weightBySnr}
    opacity={0.85}
    dashMode="mqtt-unknown"
    showArrows
    renderPopup={config.showPopups ? renderTraceroutedPopup : undefined}
  />
)}
```

**Props rationale (per the P3 §3.2 consumer-table pattern):**

| Prop | Value | Why |
|---|---|---|
| `colorMode` | `'snr'` | Canonical 4-band coloring — the core alignment goal. |
| `snrColors` | tileset-derived (§3.1) | Theme-aware light/dark, no context. |
| `mqttColor` | `overlay.mqttSegment` | Keeps MQTT/unknown segments distinct from no-data gray (P3 amendment). |
| `curvature` | `0.2` | Bows forward/return legs opposite ways so both are visible (straight would draw them coincident). |
| `weight` | `weightBySnr` | Canonical SNR-scaled weight (2..6). |
| `opacity` | `0.85` | Matches the app paths presentation. |
| `dashMode` | `'mqtt-unknown'` | Canonical MQTT/unknown-SNR dashing (`3,6`). |
| `showArrows` | `true` | Direction cue for forward vs return; the embed's dedup'd segment count is modest. |
| `renderPopup` | callback (if `showPopups`) | Keeps the embed popup, now band/MQTT-aware (§3.3). |
| `temporalFade` | *(omitted)* | Not used by the embed (no per-sample timestamps beyond the segment ts; keep simple). |

This mirrors the app's richest traceroute presentation (NodesTab selected-route styling) applied
across the embed's recent-traceroute set — delivering legs + direction + bands + MQTT dashing, i.e.
"the same traceroute visuals as the app." The exact numbers (`curvature 0.2`, `showArrows`, `weight`)
are the recommended default; see §8 D3 for the orchestrator toggle to the flatter Dashboard-paths
preset (`curvature 0`, arrows off, `weight 2`) if arrow noise is judged too busy in browser validation.

### 3.3 Popup

`renderTraceroutedPopup(seg)` returns a `<Popup>` reusing the existing `embed-popup` CSS classes,
showing `fromName ↔ toName`, the scaled SNR (`seg.avgSnr` → `{avgSnr.toFixed(1)} dB`, hidden when
null), and a "via MQTT" indicator when `seg.isMqtt`. Names come from a `Map<nodeNum → name>` built
from the current `nodes` state (the client already has visible-node names) OR — simpler — keep the
raw wire segments around and index the popup by `key`, reading `fromName`/`toName` off the wire object
(they're already on it). Prefer the latter (zero extra plumbing).

### 3.4 Bundle impact

Importing `TraceroutePathsLayer` (+ `mapHelpers`, `tracerouteSegments`, `overlayColors`) into the
embed bundle adds modest weight; `leaflet`/`react-leaflet` are already in the bundle. `mapHelpers`
imports `leaflet` (already present). No `SettingsContext`/`ThemeProvider` is pulled in (the layer and
palette functions are context-free) — verified by reading the layer's imports. Acceptable.

---

## 4. File-by-file changes

### Modified — server
- `src/server/routes/embedPublicRoutes.ts` — rewrite the `/:profileId/traceroutes` handler body
  (§2.2): import `decomposeTraceroute` from `../../utils/tracerouteSegments.js`; delete the bespoke
  parse/`fullPath`/segment loop; build `resolvePosition` (live-only); decompose + dedup-by-key +
  cap-500; map to `EmbedTracerouteSegmentV2` (`snr = avgSnr`, plus `leg`/`avgSnr`/`isMqtt`). Preamble
  (profile 404, `showTraceroutes` gate, `nodePositions` build, `ALL_SOURCES`) unchanged.

### Modified — client
- `src/components/EmbedMap.tsx` —
  - Extend the `EmbedTracerouteSegment` interface to `EmbedTracerouteSegmentV2` (add `leg`, `avgSnr`,
    `isMqtt`).
  - Import `getOverlayColors`/`getSchemeForTileset` from `../config/overlayColors`, `weightBySnr` from
    `../utils/mapHelpers`, `TraceroutePathsLayer` from `./map/layers/TraceroutePathsLayer`, and
    `TracerouteRenderSegment` type from `../utils/tracerouteSegments`.
  - Compute `snrColors`/`mqttColor` from `config.tileset` (memoized).
  - Replace the L324-355 `tracerouteSegments.map(<Polyline color="#cba6f7"…>)` block with the
    `<TraceroutePathsLayer>` render (§3.2) + `renderTraceroutedPopup` (§3.3).
  - Delete the inline fixed-mauve Polyline + old segment popup.

### Created — tests
- `src/server/routes/embedPublicRoutes.test.ts` — **NEW** (§5.1).
- `src/components/EmbedMap.traceroutes.test.tsx` — **NEW** (§5.2).

### NOT changed (guardrails)
- `src/embed.tsx`, the map shell / node markers / node popup / neighbor lines in `EmbedMap.tsx`, the
  `/config`, `/nodes`, `/neighborinfo`, `/geojson` handlers, `embedMiddleware.ts`, the embed profile
  schema/migrations, `overlayColors.ts` (already 4-band from P3), `TraceroutePathsLayer.tsx`,
  `tracerouteSegments.ts`, `mapHelpers.tsx` (all Phase-3 shared code — consumed, not modified).

---

## 5. Test plan

### 5.1 Server — `embedPublicRoutes.test.ts` (NEW)
These are public routes with **no `requirePermission`/`optionalAuth`** — the `createRouteTestApp`
harness (CLAUDE.md) targets auth routes and is **not the right fit here**. Instead mount the router on
a bare `express()` app and seed the singleton `:memory:` SQLite DB directly (an embed profile via
`databaseService.embedProfiles`, nodes via the nodes repo, traceroutes via
`databaseService.traceroutes.insertTraceroute`), following the DB-seeding style of
`embedProfileRoutes.test.ts` (minus the auth/session wiring). Assert:
- **Bare array** (not enveloped) — response is an array, not `{success,data}`.
- **Additive fields present**: each element has `leg`, `avgSnr`, `isMqtt` AND all legacy fields
  (`fromLat`,`fromLng`,`toLat`,`toLng`,`fromName`,`toName`,`snr`,`timestamp`,`fromNum`,`toNum`).
- **Legacy fields still populated** (backward-compat): positions + names present and correct.
- **`snr === avgSnr`** and **`avgSnr` is /4-scaled** (feed `snrTowards=[20]` → expect `avgSnr=5`,
  band=excellent) — pins the un-scaled→scaled fix.
- **Forward + return legs**: a traceroute with populated `route` AND `routeBack`/`snrBack` yields both
  `leg:'forward'` and `leg:'return'` segments (#2051 guard flows through the util).
- **`isMqtt` from sentinel** (#2931): a hop with `snrTowards` element `-128` (raw sentinel) →
  `isMqtt:true`, `avgSnr:null`.
- **Filtering/leak**: a traceroute hop that is `hideFromMap`, off-channel, MQTT-when-`!showMqttNodes`,
  or positionless produces **no segment revealing it** (endpoint unresolved → segment skipped).
- **`showTraceroutes` gate**: profile with `showTraceroutes:false` → 404.
- **Cross-source**: source-less profile (`sourceId` null) returns segments across sources
  (`ALL_SOURCES` path) without throwing.
- **Cap**: > 500 candidate segments → response length ≤ 500.

### 5.2 Client — `EmbedMap.traceroutes.test.tsx` (NEW)
EmbedMap has no test today. Mock `fetch` (config + nodes + the new traceroute wire shape) and mock
`react-leaflet` the way `src/components/map/layers/TraceroutePathsLayer.test.tsx` already does (or
spy on `TraceroutePathsLayer`). Assert:
- With `showPaths:true`, `TraceroutePathsLayer` is rendered with `colorMode:'snr'`, the tileset-derived
  `snrColors`, `mqttColor`, and the segment array mapped from the wire response.
- **Palette selection**: `config.tileset:'cartoDark'` → dark `snrColors`; `'osm'`/`'osmHot'` → light
  `snrColors` (assert a band hex differs between the two).
- A wire segment with `leg:'return'` maps to a render segment with `leg:'return'` (both legs pass
  through).
- `showPaths:false` → no `TraceroutePathsLayer`.
- Old-shape resilience (optional): a wire segment lacking the additive fields still yields a rendered
  polyline (defensive — the client tolerates a stale server, mirror of the server tolerating a stale
  client).

### 5.3 Gate
Full Vitest suite `success:true` via `--reporter=json` (project memory: the rtk summary line masks
suite-collection failures). `npm run lint:ci` exits 0 (no baseline growth, no new `any` — type the
wire shape and the mapping fully). `tsc` server + client clean. Browser-validate an actual embed
iframe (§8 D4).

---

## 6. Notes / pre-existing quirks (do NOT "fix" in P6)

### 6.1 `#1862` snapshot positions are intentionally NOT adopted for the embed
The app's `decomposeTraceroute` can prefer `routePositions` snapshots; the embed's `resolvePosition`
is **live-only** (§2.2). Reasons: (a) it matches the embed's current behavior (it already resolves
from live `getActiveNodes` positions); (b) shipping/resolving snapshots would risk leaking historical
positions of nodes that are currently hidden/filtered (a NEW leak the live-only filter structurally
prevents). "Same visuals as the app" here means the SNR bands / legs / dashing, not historical
snapshot placement. Document this in a code comment at the handler.

### 6.2 The leak boundary is the visible-node position filter — preserve it exactly
Only segments whose BOTH endpoints resolve in the filtered `nodePositions` map are emitted. A hidden
intermediate hop breaks the chain (both adjacent segments skipped) and is never revealed. `avgSnr`,
`leg`, and `isMqtt` are non-sensitive RF/topology metadata about already-visible node pairs — no new
data class is exposed.

### 6.3 Response is public and cacheable — mind size
Keep the 24h / 100-traceroute window and add the 500-segment cap (§2.2). Additive fields are ~3 small
values/segment.

### 6.4 `showPaths` (client gate) vs `showTraceroutes` (server gate)
Pre-existing: the client fetches/renders traceroutes gated on `config.showPaths`, while the server
404s unless `profile.showTraceroutes`. Both must effectively be on. This is a pre-existing gate quirk;
**leave it unchanged** in P6 (aligning it is scope creep — flag to orchestrator if a user reports it).

---

## 7. Approved visible changes (this IS the phase's purpose — enumerated)

Per the epic "one canonical look per feature, no case-by-case appearance approvals," the embed's
traceroute appearance changes as follows (all intended):

1. **Segment color**: fixed mauve `#cba6f7` → **canonical 4-band SNR** (`excellent`/`good`/`fair`/
   `poor`/`noData`), scheme-derived: dark palette on dark tilesets, **light palette on light tilesets**
   (previously mauve regardless of tileset). MQTT/unknown-SNR segments render in `mqttSegment` color.
2. **Legs / direction**: single straight line per node pair → **forward + return legs** curved
   opposite ways (curvature 0.2) with **direction arrows**.
3. **Weight**: fixed 3 → **SNR-scaled** `weightBySnr` (2..6).
4. **Dashing**: none → **MQTT/unknown-SNR segments dashed** (`3,6`).
5. **Popup**: SNR now **/4-scaled (correct)** and band-consistent; gains a "via MQTT" indicator.
6. **Stale old clients** (open/cached old bundles hitting the new server): their popup `{snr} dB` now
   shows the correct scaled value instead of the former raw ×4 — strict fix, non-breaking; positions/
   lines unchanged. No other old-client change (additive superset).

Unchanged: node markers, node popup, neighbor lines, legend, tiles, center/zoom/URL-param behavior.

---

## 8. Orchestrator decisions

| # | Question | Recommended resolution |
|---|---|---|
| **D1** | Additive-superset vs versioned endpoint vs raw-rows? | **Additive superset + shared `decomposeTraceroute` invoked server-side** (§2.1). Only option that is backward-compatible on one endpoint, honors "one decomposition" (shared util, not re-implemented), keeps the leak boundary, and reduces server code. Confirm. |
| **D2** | Decompose server-side (util invoked in the route) vs ship raw rows and decompose client-side? | **Server-side** (§2.1/§2.2). Client-side needs raw route arrays → breaks old clients on the shared endpoint or forces a v2 endpoint (double surface); and the client lacks snapshots. Server-side reuses the exact same pure util. Confirm. |
| **D3** | Embed render preset: rich (curvature 0.2 + arrows + `weightBySnr`, mirrors NodesTab-selected) vs flat (curvature 0 + no arrows + weight 2, mirrors Dashboard-paths)? | **Rich preset** (§3.2) as default — it actually surfaces forward/return legs (flat draws them coincident). Fall back to flat if browser validation finds arrow density too busy on a dense mesh. Orchestrator confirms after D4. |
| **D4** | Browser validation via a real embed iframe (exit criterion). | Create/enable a profile with `showTraceroutes` + `showPaths` on both a **dark** tileset (cartoDark) and a **light** tileset (osmHot); load `/embed/:id` in an iframe; confirm 4-band colors, light-vs-dark palette switch, legs+arrows, MQTT dashing, and a working popup. Required before merge. |
| **D5** | Snapshot #1862 for the embed? | **No** (§6.1) — live-only resolve; leak-avoidance + parity with current embed. Confirm. |
| **D6** | BaseMap adoption / node-popup-family alignment for EmbedMap in P6? | **No** — out of scope; defer to Phase 7 / follow-up (§0). Confirm the boundary. |
| **D7** | Align the `showPaths`/`showTraceroutes` gate quirk (§6.4)? | **No** — leave pre-existing behavior; scope creep. Confirm. |

---

## 9. Work packages (Sonnet-sized, ordered)

### WP1 — Server: shared-util decomposition + additive fields + tests
Files: `src/server/routes/embedPublicRoutes.ts`, `src/server/routes/embedPublicRoutes.test.ts` (new).
**Acceptance:** `/traceroutes` returns the additive-superset bare array via `decomposeTraceroute`
(bespoke loop deleted); legacy fields preserved; `snr==avgSnr` scaled; forward+return legs; `isMqtt`
from sentinel; visible-node leak boundary intact; `showTraceroutes` gate + `ALL_SOURCES` cross-source
unchanged; 500-cap; new route test green; server `tsc` + `lint:ci` clean.

### WP2 — Client: EmbedMap renders via the shared layer + tests + iframe validation *(deps: WP1 wire contract)*
Files: `src/components/EmbedMap.tsx`, `src/components/EmbedMap.traceroutes.test.tsx` (new).
**Acceptance:** EmbedMap maps wire→`TracerouteRenderSegment[]`, derives `snrColors`/`mqttColor` from
`config.tileset`, renders `<TraceroutePathsLayer colorMode="snr" …>` (§3.2) with the new popup; the
fixed-mauve block is deleted; render test asserts canonical props + light/dark palette switch + both
legs; browser-validated in an embed iframe on a dark AND a light tileset (D4); full suite `success:true`;
`lint:ci` clean (no new `any`, no baseline growth).

**Dependency:** WP1 → WP2 (WP2 consumes the WP1 wire shape). WP2 may start against the agreed §2.1
contract in parallel, but must integrate/validate against the real WP1 endpoint before its PR slice.

---

## 10. Risks & gotchas

- **Old-client compat (primary risk):** the response MUST stay a bare array whose elements keep every
  legacy field. Do not envelope it, do not rename/drop legacy fields. Test 5.1 pins this.
- **Anonymous leak surface:** preserve the visible-node position filter as the leak boundary; do NOT
  ship `routePositions` snapshots or raw hop arrays; live-only `resolvePosition` (§6.1/§6.2).
- **Embed bundle isolation:** no `useSettings`/`SettingsProvider` exists in `src/embed.tsx` — palette
  MUST come from `getOverlayColors(getSchemeForTileset(config.tileset))`, and `TraceroutePathsLayer`
  MUST be fed `snrColors` as a prop (it is context-free by P3 design — verified). Do not add a
  provider to the embed bundle.
- **Server importing `src/utils/`:** precedented + `tsconfig.server.json` includes `src/utils/**`
  (§1.5); `tracerouteSegments.ts` is leaflet/React-free by design. Safe.
- **SNR scaling:** the util's `avgSnr` is /4-scaled; the old server field was raw. Set `snr=avgSnr`
  and assert the scaling in tests (feed raw ×4, expect scaled) — a silent regression here would
  mis-color every band.
- **Directional dedup:** dedup by the util's `leg:from-to` key, NOT a bidirectional pair key —
  collapsing legs would drop the return leg the epic requires.
- **Response size:** 500-segment cap + existing 24h/100-tr window; public/cacheable endpoint.
- **No route-level test exists today** — WP1 stands up `embedPublicRoutes.test.ts` from scratch
  (bare-express + seeded singleton DB; the auth harness does not apply).
- **Verify suite via `--reporter=json`** (`success:true`) — the rtk summary line masks suite-collection
  failures (project memory).
</content>
</invoke>


---

## Orchestrator resolutions (gate review 2026-07-10)

- D1–D2, D4–D7: architect recommendations ACCEPTED as written (additive superset wire
  shape; server-side decomposeTraceroute; palette via getSchemeForTileset; live-only
  position resolution preserving the leak boundary; bare-express route tests for the
  anonymous endpoint; snr=avgSnr correction shipped as non-breaking).
- **D3 → FLAT preset (overriding the 'rich' recommendation).** Embeds render an
  all-segments overview; the app's canonical look for all-segments views (NodesTab base
  layer, Dashboard paths pass) is straight/flat, SNR-colored, MQTT/unknown-dashed, no
  arrows. Arrows are canonical only for single-route views (selected route, widget).
  Embed consumer props: colorMode 'snr' + mqttColor, curvature 0, weight 2, opacity
  0.85, dashMode default. This is consistency, not taste.
