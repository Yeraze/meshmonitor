# Elevation Backend Implementation Spec — Terrain Link Profile Epic Phase 1 (#4111)

**Branch:** `feature/elevation-backend` (worktree `../meshmonitor-elevation-backend`)
**Scope:** Backend elevation service only. No frontend, no DB migration, no link-budget math (that is Phase 2).
**Exit criteria (from epic):** API returns correct profiles for known coordinates (unit-tested with mocked fetches); custom-source test endpoint works; suite green; merged.

---

## 1. Reuse inventory (search results — use/extend these, do not reinvent)

| Need | Existing mechanism | Path | Decision |
|------|-------------------|------|----------|
| Outbound HTTP (SSRF-safe) | `safeFetch(rawUrl, init?, opts?)` → `Promise<Response>`; `assertSafeUrl`; `SsrfBlockedError` (has `.reason`); `SsrfCheckOptions { protocols?, strict? }` (default protocols `['http:','https:']`, `strict` defaults **false** so LAN targets allowed) | `src/server/utils/ssrfGuard.ts` | **Reuse verbatim.** ALL provider fetches go through `safeFetch`. Do not pass `strict:true` (custom providers may be a LAN tileserver, mirroring tileServerTest/mapStyle). |
| "Test a URL" route pattern (probe + measure latency) | `tileServerTest.ts` — `startTime = Date.now()`, `responseTime = Date.now()-startTime`, returns `{ success, details }`, autodetect loop over URL patterns | `src/server/routes/tileServerTest.ts` | **Model the `/test` handler on this.** Note tileServerTest itself is mounted with `optionalAuth()` (public); we deliberately gate our `/test` stricter (see §permission decision). |
| Fetch-then-store external content w/ `requirePermission('settings','write')` | `mapStyleRoutes.ts` `POST /from-url` uses `safeFetch` + `SsrfBlockedError` catch + `requirePermission('settings','write')` | `src/server/routes/mapStyleRoutes.ts` | **Model gating of `/test` on this.** |
| API envelope | `ok(res, data?)` → `{success:true,data}`; `fail(res, status, code, message, extra?)` → `{success:false,error,code,...extra}` | `src/server/utils/apiResponse.ts` | **Use for all new handlers** (greenfield, no consumer to break). |
| Great-circle distance | `calculateDistance(lat1,lon1,lat2,lon2)` → **km** (Haversine); `kmToMiles`, `formatDistance` | `src/utils/distance.ts` | **Reuse for `distanceMeters`** (`×1000`). Already imported server-side (via `measureDistance.ts`), so importing from a route handler is fine. It gives distance only — **great-circle *interpolation* does not exist** → add `greatCircle.ts` alongside it (§WP1). |
| Two-point util placement precedent | `measureDistance.ts` (pure, react-free, unit-tested, sits in `src/utils/`) | `src/utils/measureDistance.ts` | New interpolation util follows this convention: `src/utils/greatCircle.ts`. |
| Rate limiting | `apiLimiter` / `authLimiter` / `messageLimiter` / `meshcoreDeviceLimiter` factory pattern; `isPrivateNetworkIp`, `normalizeRateLimitKey`, shared `rateLimitConfig` | `src/server/middleware/rateLimiters.ts` | **Add `elevationLimiter`** following the `meshcoreDeviceLimiter` template (stricter than general API since each call fans out to N outbound tile fetches). |
| Settings keys | `VALID_SETTINGS_KEYS` (append-only list); `SECRET_SETTINGS_KEYS` + `stripSecretSettings(merged, isAdmin)` — **admins receive the unmodified map** (`if (isAdmin) return settings;` — full values, no masking, so secret keys stay fully admin-readable/editable via the normal GET/POST settings flow); non-admin & anonymous callers get secret keys removed. `GET /api/settings` is **public (`optionalAuth`)**; `POST /api/settings` is `requirePermission('settings','write')` | `src/server/constants/settings.ts`, `src/server/routes/settingsRoutes.ts` | Add `elevationEnabled` (**non-secret** — the public availability flag the Map Analysis page reads) and `elevationSourceUrl` (**secret — add to `SECRET_SETTINGS_KEYS`**): a custom elevation URL may embed an API key and is never needed client-side since all fetches are server-proxied. Precedent: `securityDigestAppriseUrl`, an existing credential-bearing URL in `SECRET_SETTINGS_KEYS` handled the same way, and it does not break the settings UI because admins see full values. (Note: there is **no** `SERVER_ONLY_SETTINGS` constant in this codebase; the task brief's term maps to `SECRET_SETTINGS_KEYS` here.) |
| Route test harness | `createRouteTestApp({ mount })` → real session + real auth + `:memory:` SQLite; `harness.grant(userId,resource,action,sourceId?)`, `harness.loginAs(user|null)`, `harness.admin/limited/anonymous` | `src/server/test-helpers/routeTestApp.ts` | **All route tests use this** (CLAUDE.md hard rule). Mock only `safeFetch`, never the DB. |
| Route mounting | `apiRouter` mounted at `/api`; `apiRouter.use('/tile-server', optionalAuth(), tileServerRoutes)` (line 784), `apiRouter.use('/analysis', analysisRoutes)` (802) | `src/server/server.ts` | Mount `apiRouter.use('/elevation', elevationRoutes)` next to these. |
| Anonymous/public data route precedent | `analysisRoutes.ts`: `router.use(optionalAuth())`, "The page itself is public; data filtering happens here." | `src/server/routes/analysisRoutes.ts` | Elevation profile is **source-agnostic public DEM data** (no per-source scoping) → same public/`optionalAuth` posture + rate limit. |

### New dependency: `pngjs`
No PNG decoder is currently a dependency (`grep` for `pngjs|sharp|upng|pixelmatch` in `package.json` → none). Terrarium tiles are RGB PNGs that must be decoded server-side.

**Choose `pngjs` (+ `@types/pngjs` devDep).** Justification vs alternatives:
- `sharp` — native (libvips) binary. CLAUDE.md explicitly cautions about native modules (better-sqlite3 ABI) across the multi-arch Docker/LXC/CI matrix (Node 20/22/24/25). A second native dep is a build/portability liability for a task that only needs to read RGB bytes. **Rejected.**
- `upng-js` — pure JS but unmaintained and ships no types (would force `any`, violating the ESLint ratchet). **Rejected.**
- `pngjs` — pure JS, maintained, ships CommonJS + `@types/pngjs`. Synchronous `PNG.sync.read(buffer) → { width, height, data: Buffer(RGBA) }` and `PNG.sync.write({...})` (lets tests synthesize fixture tiles). **Selected.**

Add to `dependencies`: `"pngjs": "^7.0.0"`; to `devDependencies`: `"@types/pngjs": "^6.0.5"`. Regenerate `package-lock.json` via `npm install --package-lock-only` (`.npmrc` pins `legacy-peer-deps=true`).

---

## 2. File-by-file changes

### 2.1 `src/utils/greatCircle.ts` (NEW — pure, react-free, mirrors `measureDistance.ts`)

```ts
export interface LatLng { lat: number; lng: number; }

/**
 * Spherical-linear (great-circle) interpolation of `count` points from a→b,
 * inclusive of both endpoints. count>=2. Handles antimeridian implicitly
 * (works in 3D unit-vector space, converts back to [-180,180] lng).
 * When a≈b (angular distance ~0) returns `count` copies of a (callers reject
 * identical points upstream, but this must not NaN).
 */
export function interpolateGreatCircle(a: LatLng, b: LatLng, count: number): LatLng[];

/** Web-Mercator slippy tile for a coordinate at zoom z: { x, y } (integer tile indices). */
export function lngLatToTile(lat: number, lng: number, z: number): { x: number; y: number };

/**
 * Fractional pixel within a `tileSize`-px tile for a coordinate at zoom z:
 * { x, y, px, py } where px,py are integer pixel offsets [0,tileSize).
 */
export function lngLatToTilePixel(
  lat: number, lng: number, z: number, tileSize: number
): { x: number; y: number; px: number; py: number };
```

- `interpolateGreatCircle`: standard slerp — angular distance `d = 2*asin(sqrt(hav))`; for `f=i/(count-1)`, `A=sin((1-f)d)/sin d`, `B=sin(fd)/sin d`, combine cartesian, atan2 back. Guard `sin d ≈ 0`.
- `lngLatToTile`: `n=2^z; x=floor((lng+180)/360*n); y=floor((1 - asinh(tan(latRad))/π)/2 * n)`. Clamp lat to Web-Mercator range (±85.0511) before conversion.
- No other module imports at runtime except `Math`. Keep dependency-free so it is unit-testable in isolation and reusable by Phase 2.

### 2.2 `src/server/utils/lruCache.ts` (NEW — generic, reusable)

```ts
export class LruCache<K, V> {
  constructor(maxEntries: number);
  get(key: K): V | undefined;      // hit promotes to most-recent
  set(key: K, value: V): void;     // evicts least-recent when over capacity
  has(key: K): boolean;
  get size(): number;
  clear(): void;
}
```
- Backed by a `Map` (insertion-ordered): `get` deletes+re-sets to promote; `set` evicts `map.keys().next().value` when `size > maxEntries`. No external dep. Pure/synchronous → trivially unit-testable.

### 2.3 `src/server/services/elevationProvider.ts` (NEW — provider abstraction + decode)

```ts
export type ProviderType = 'terrarium' | 'json';
export interface ElevationProvider {
  readonly type: ProviderType;
  /** Returns one elevation (meters) per input point; null where DEM data is unavailable. */
  sample(points: LatLng[]): Promise<(number | null)[]>;
}

export const DEFAULT_TERRARIUM_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_ZOOM = 12;      // ~38 m/px @ equator; bounds tile fan-out
export const TILE_SIZE = 256;

/** URL-shape detection: contains {z}&{x}&{y} → terrarium tile; else → json. */
export function detectProviderType(url: string): ProviderType;

/** Decode a terrarium RGB(A) tile buffer → Float32Array (length = w*h) of meters. */
export function decodeTerrariumTile(png: Buffer): { width: number; height: number; data: Float32Array };
//   elevation = (R*256 + G + B/256) - 32768
//   Float32 (not Float64): terrarium values are exact multiples of 1/256 m within
//   ±32768 m — fully representable in f32 — and it halves cache memory.

/** Build the provider implied by settings (url empty/default → terrarium@DEFAULT_TERRARIUM_URL). */
export function resolveProvider(sourceUrl: string | undefined): ElevationProvider;
```

- **`TerrariumTileProvider`** (implements `ElevationProvider`, `type:'terrarium'`):
  - Module-scope `LruCache<string, Float32Array>` keyed `"z/x/y"`, **cap 64 tiles** (`TILE_CACHE_MAX = 64`).
    **Worst-case memory budget:** 256×256 px × 4 B (Float32) = 256 KB/tile × 64 = **16 MB** steady-state ceiling (plus Map/key overhead, negligible). A 500 km path at z=12 crosses ≲ 60 tiles, so one max-length profile still fits in cache; repeat/nearby queries hit warm tiles.
  - For each point → `lngLatToTilePixel(...,TERRARIUM_ZOOM,TILE_SIZE)`; group by tile; fetch each unique tile once via `safeFetch(url.replace {z}{x}{y})`; on non-OK response or thrown `SsrfBlockedError`/network error → treat that tile as **void** (all its points → `null`); never throw out of `sample()`.
  - Decode with `decodeTerrariumTile` (uses `pngjs` `PNG.sync.read`); cache the Float32Array; read `data[py*width+px]`.
  - Ocean returns valid ≈0 from terrarium — that is a real sample, not void. Only *fetch failure / missing tile* → `null`.
- **`JsonPointProvider`** (`type:'json'`, Open-Topo-Data compatible):
  - Module-scope `LruCache<string, number|null>` keyed by rounded `"lat.5,lng.5"`, **cap 10 000 samples**.
  - Batch uncached points (max **100 locations/request**) into `?locations=lat,lng|lat,lng`; `safeFetch`; parse `{ results: [{ elevation, location:{lat,lng} }] }`; `elevation === null` in a result → `null` sample. Request/parse failure → those points `null`.
  - URL template substitution: replace a `{locations}` placeholder if present, else append `?locations=` (support both Open-Topo-Data query styles). Document the accepted template shape in a header comment.
- `resolveProvider('' | undefined)` → terrarium@default. Otherwise `detectProviderType` → build the matching impl with the supplied template.

### 2.4 `src/server/services/elevationService.ts` (NEW — orchestration; holds no state beyond providers' caches)

```ts
export interface ProfileSample { distance: number; lat: number; lng: number; elevation: number | null; }
export interface ProfileResult {
  distanceMeters: number;
  provider: ProviderType;
  samples: ProfileSample[];
}
export interface ProfileError { code: string; message: string; status: number; }   // for fail()

export const MIN_SAMPLES = 64;
export const MAX_SAMPLES = 512;
export const DEFAULT_SAMPLES = 256;
export const MAX_PATH_KM = 500;

/** Validate + compute. Returns ProfileResult or a ProfileError (never throws for expected cases). */
export async function computeProfile(input: {
  pointA: LatLng; pointB: LatLng; samples?: number;
}, sourceUrl: string | undefined): Promise<ProfileResult | ProfileError>;

export interface TestResult {
  success: boolean;
  detectedType: ProviderType;
  sampleElevation: number | null;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}
/** Probe a candidate URL against a known coordinate; models tileServerTest. */
export async function testSource(url: string, probe?: LatLng): Promise<TestResult>;
```

- `computeProfile` validation order → returns `ProfileError` (route maps to `fail`):
  1. lat ∈ [−90,90], lng ∈ [−180,180] for both points → else `{status:400, code:'INVALID_COORDINATES'}`.
  2. `pointA` deep-equals `pointB` (or distance ≈0) → `{status:400, code:'IDENTICAL_POINTS'}`.
  3. `distanceKm = calculateDistance(...)`; if `> MAX_PATH_KM` → `{status:400, code:'PATH_TOO_LONG'}`.
  4. `n = clamp(samples ?? DEFAULT_SAMPLES, MIN_SAMPLES, MAX_SAMPLES)`.
  5. `pts = interpolateGreatCircle(a,b,n)`; `elevs = await resolveProvider(sourceUrl).sample(pts)`.
  6. Build samples with cumulative `distance` (meters) = `distanceKm*1000 * i/(n-1)` (great-circle even spacing). Return `{ distanceMeters: distanceKm*1000, provider, samples }`.
- `testSource`: `detectedType = detectProviderType(url)`; `startTime = Date.now()`; call `resolveProvider(url).sample([probe ?? KNOWN_POINT])`; `latencyMs = Date.now()-startTime`; `sampleElevation = result[0]`; `success = sampleElevation != null`. Default probe = a well-known coordinate, e.g. **Mount Everest summit `{lat:27.9881, lng:86.9250}` (~8848 m)** or a low-relief sea-level point — pick a mid-elevation land point to distinguish "provider works" from ocean-0; document the expected value in a comment. Catch `SsrfBlockedError` → `{success:false, error, latencyMs}`.

### 2.5 `src/server/middleware/rateLimiters.ts` (EDIT — add `elevationLimiter`)

Append, following the `meshcoreDeviceLimiter` template (production-tight, dev-loose, private IPs exempt via shared config):
```ts
// Elevation profile/test — each call fans out to N outbound tile fetches.
// Default: 20/min production, 120/min development.
export const elevationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.isProduction ? 20 : 120,
  message: 'Too many elevation requests, please slow down',
  handler: (req, res) => {
    logger.warn(`🚫 Rate limit exceeded for ELEVATION - IP: ${req.ip || 'unknown'}, Path: ${req.path}`);
    res.status(429).json({ error: 'Too many elevation requests, please slow down', retryAfter: '1 minute' });
  },
  ...rateLimitConfig,
});
```

### 2.6 `src/server/routes/elevationRoutes.ts` (NEW — default-export Router)

```ts
import { Router } from 'express';
import { optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { elevationLimiter } from '../middleware/rateLimiters.js';
import { ok, fail } from '../utils/apiResponse.js';
import databaseService from '../../services/database.js';
import { computeProfile, testSource } from '../services/elevationService.js';

const router = Router();
// No per-route express.json(): server.ts applies a global
// `app.use(express.json({ limit: '10mb' }))` (line 269) before apiRouter,
// matching neighboring routes (analysisRoutes, tileServerTest).

// POST /api/elevation/profile — PUBLIC (optionalAuth) + rate-limited.
router.post('/profile', optionalAuth(), elevationLimiter, async (req, res) => {
  // 1. If elevationEnabled setting === 'false' → fail(res,403,'ELEVATION_DISABLED',...)
  // 2. Parse body { pointA:{lat,lng}, pointB:{lat,lng}, samples? }; missing/NaN → fail(400,'INVALID_BODY')
  // 3. sourceUrl = (await databaseService.settings.getAllSettings()).elevationSourceUrl
  // 4. const r = await computeProfile({pointA,pointB,samples}, sourceUrl)
  //    'code' in r → fail(res, r.status, r.code, r.message)
  //    else → ok(res, r)
});

// POST /api/elevation/test — ADMIN (settings:write), like mapStyleRoutes /from-url.
router.post('/test', requirePermission('settings', 'write'), elevationLimiter, async (req, res) => {
  // Parse { url, lat?, lng? }; missing url → fail(400,'MISSING_URL')
  // const r = await testSource(url, probe?); ok(res, r)   // report even on success:false
});

export default router;
```

**Permission decision (justified):**
- **`/profile` → public via `optionalAuth()`, protected by `elevationLimiter`.** Rationale: the Map Analysis page is public (per epic + `analysisRoutes.ts` precedent), and elevation is generic public DEM — not per-source, not user-scoped, so there is nothing to `requirePermission`-gate against. Consistency demands the same posture as the public analysis/tile-server routes. Abuse (outbound fetch amplification) is the real risk, addressed by the dedicated stricter rate limiter + the `MAX_SAMPLES`/`MAX_PATH_KM` caps + SSRF guard, not by an auth wall. An admin can hard-disable via `elevationEnabled=false`.
- **`/test` → `requirePermission('settings','write')`.** Rationale: it probes an *admin-supplied arbitrary URL* (config-time action), identical trust level to `mapStyleRoutes` `POST /from-url`. No anonymous user should be able to point the server at arbitrary URLs to measure/scan.

### 2.7 `src/server/server.ts` (EDIT — import + mount)

- Near line 671 (with the other route imports): `import elevationRoutes from './routes/elevationRoutes.js';`
- Near line 802 (with `apiRouter.use('/analysis', ...)`): `apiRouter.use('/elevation', elevationRoutes);`
  (Router-level `optionalAuth()`/`requirePermission` are applied per-route inside the router, matching how `/tile-server` composes middleware.)

### 2.8 `src/server/constants/settings.ts` (EDIT — append keys)

- Add to `VALID_SETTINGS_KEYS` (append-only): `'elevationEnabled'`, `'elevationSourceUrl'`.
- **Secrecy split:**
  - `'elevationEnabled'` — **non-secret**: it is the availability flag the public Map Analysis page reads via the already-public `GET /api/settings`.
  - `'elevationSourceUrl'` — **add to `SECRET_SETTINGS_KEYS`**: a custom elevation URL may embed an API key (e.g. `?key=...`), and unlike tileset URLs it is *never* needed client-side — every fetch is server-proxied. `stripSecretSettings` returns the **unmodified map to admins** (`if (isAdmin) return settings;` — no masking, not write-only), so the Phase 3 settings UI (admin-gated by `settings:write`) reads and edits it exactly like the existing secret `securityDigestAppriseUrl` (the closest precedent — also a credential-bearing URL). Anonymous/non-admin callers never see it. The frontend must rely **only** on `elevationEnabled` for availability.
- Global (not per-source) → **not** added to `PER_SOURCE_SETTINGS_KEYS`.
- Semantics: `elevationSourceUrl` empty/unset → default terrarium provider. `elevationEnabled` unset/`'true'` → feature on (default provider needs no config); `'false'` → `/profile` returns `ELEVATION_DISABLED`. No migration — settings are key/value rows created on write.

### 2.9 `package.json` / `package-lock.json` (EDIT)
Add `pngjs` dep + `@types/pngjs` devDep; regenerate lockfile (§1).

---

## 3. Test plan (Vitest; no standalone scripts)

| Test file | Cases |
|-----------|-------|
| `src/utils/greatCircle.test.ts` | `interpolateGreatCircle`: returns exactly `count` points; index 0 == a, last == b (within epsilon); midpoint of two known coords (e.g. equator 0,0→0,90 midpoint ≈ 0,45); near-antimeridian pair (179→−179) stays on short arc; identical points → no NaN. `lngLatToTile`: known slippy indices (e.g. z=12 for a known lat/lng vs reference); lat clamp beyond ±85. `lngLatToTilePixel`: px,py within [0,256). |
| `src/server/utils/lruCache.test.ts` | insert/get roundtrip; eviction of least-recently-used past capacity; `get` promotes (recently-read survives eviction); `size`/`clear`/`has`. |
| `src/server/services/elevationProvider.test.ts` | `decodeTerrariumTile`: synthesize a PNG via `PNG.sync.write` with pixels of known R,G,B → assert `(R*256+G+B/256)-32768` (incl. a 0 m ocean pixel and a negative/void-style value). `detectProviderType`: terrarium template, Open-Topo-Data URL, `{locations}` template. `TerrariumTileProvider.sample` with **mocked `safeFetch`** returning a synthesized tile buffer → correct elevation for a coordinate; second call for same tile hits cache (assert `safeFetch` called once). Missing tile (mock `safeFetch` → `{ok:false}` or throws) → sample `null`, no throw. `JsonPointProvider.sample`: mock JSON response → parsed elevations; `elevation:null` result → `null`; batching >100 points issues multiple requests. |
| `src/server/services/elevationService.test.ts` | `computeProfile` happy path (mocked provider/`safeFetch`): `samples.length === clamp(n)`, endpoints match input, `distanceMeters ≈ calculateDistance*1000`, monotonic `distance`. Validation: out-of-range lat/lng → `INVALID_COORDINATES`; identical points → `IDENTICAL_POINTS`; >500 km → `PATH_TOO_LONG`; `samples` below 64 / above 512 clamps. Void samples surface as `null` (not error). `testSource`: mocked success → `success:true` + `latencyMs>=0` + `detectedType`; mocked fetch failure/`SsrfBlockedError` → `success:false` with `error`. |
| `src/server/routes/elevationRoutes.test.ts` | Via `createRouteTestApp({ mount: app => app.use('/elevation', elevationRoutes) })`, **mock `../utils/ssrfGuard.js` `safeFetch`** (never the DB). `POST /profile` anonymous (`loginAs(null)`) → 200 `{success:true,data:{distanceMeters,samples}}`. Bad body → 400 `INVALID_BODY`; bad coords → 400 `INVALID_COORDINATES`; same point → 400 `IDENTICAL_POINTS`. `elevationEnabled='false'` seeded (`harness.db.settings.setSetting`) → 403 `ELEVATION_DISABLED`. `POST /test`: anonymous/`limited` → 403; `admin` (or `limited` after `grant(id,'settings','write')`) → 200 with `TestResult`. Assert envelope shape (`success`, `data`/`error`/`code`). Secrecy guard: `stripSecretSettings({elevationSourceUrl:'x', elevationEnabled:'true'}, false)` drops `elevationSourceUrl` and keeps `elevationEnabled` (unit assertion — pins the `SECRET_SETTINGS_KEYS` membership so the public settings GET can never leak the URL). |

Mocking note: route + service + provider tests mock `safeFetch` (return a `Response`-shaped object with `ok`, `status`, `arrayBuffer()`/`json()`); they must **not** hit the network. Follow CLAUDE.md: harness for route tests, `vi.mock` only for non-DB collaborators.

---

## 4. Work packages

Three packages, strictly linear dependency (each leaves the tree compiling + its tests green; a package's tests land with it). WP1 is the independent root; WP2 depends on WP1; WP3 depends on WP2. WP1 could be started in parallel with nothing else — the chain is the natural critical path, so parallelism is limited by design (small phase).

### WP1 — Pure geometry + cache utilities *(no deps; start immediately)*
Implements §2.1, §2.2 and their tests (§3 rows 1–2).
- Files: `src/utils/greatCircle.ts`, `src/server/utils/lruCache.ts`, `src/utils/greatCircle.test.ts`, `src/server/utils/lruCache.test.ts`.
- Acceptance: interpolation endpoints/midpoint/count/antimeridian correct; slippy-tile math matches reference values; LRU eviction + promotion verified; `tsc` clean; new tests green; no ESLint ratchet regression (no `any`).

### WP2 — Provider abstraction, terrarium decode, service, settings keys *(depends WP1)*
Implements §2.3, §2.4, §2.8, §2.9 and their tests (§3 rows 3–4).
- Files: add `pngjs`/`@types/pngjs` + lockfile; `src/server/services/elevationProvider.ts`, `src/server/services/elevationService.ts`; edit `src/server/constants/settings.ts`; `src/server/services/elevationProvider.test.ts`, `src/server/services/elevationService.test.ts`.
- Acceptance: terrarium decode matches the `(R*256+G+B/256)-32768` formula on synthesized PNGs; provider type detection correct; tile & JSON caches hit (mocked `safeFetch` call-count asserted); void/ocean handling returns `null` not throw; `computeProfile` validation + clamping + `distanceMeters` correct; `testSource` reports type/latency/sample; settings keys present in `VALID_SETTINGS_KEYS`; `elevationSourceUrl` present in `SECRET_SETTINGS_KEYS` and `elevationEnabled` absent from it; neither in `PER_SOURCE_SETTINGS_KEYS`; tile cache uses `Float32Array` with `TILE_CACHE_MAX = 64` (≤16 MB worst case); `tsc` clean; tests green.

### WP3 — HTTP surface: rate limiter, routes, mount, route tests *(depends WP2)*
Implements §2.5, §2.6, §2.7 and its tests (§3 row 5).
- Files: edit `src/server/middleware/rateLimiters.ts` (add `elevationLimiter`); `src/server/routes/elevationRoutes.ts`; edit `src/server/server.ts` (import + `apiRouter.use('/elevation', …)`); `src/server/routes/elevationRoutes.test.ts`.
- Acceptance: `/api/elevation/profile` public (anonymous 200) with correct envelope; validation → correct `fail()` codes; `elevationEnabled=false` → 403 `ELEVATION_DISABLED`; `/api/elevation/test` → 403 without `settings:write`, 200 with it; route tests use `createRouteTestApp` + mocked `safeFetch` (no DB mock); full suite green; `npm run lint:ci` exits 0.

**Final gate (any package that finishes last):** run the full Vitest suite (not targeted) + `npm run lint:ci` before PR, per CLAUDE.md.

---

## 5. Invariants honored / explicit non-goals

- **No DB migration** — settings are k/v rows; caches are in-memory. (No compelling reason for a DEM table in Phase 1.)
- **No raw SQL** — service reads settings via `databaseService.settings.*` (repository-backed); no new queries.
- **All outbound HTTP via `safeFetch`** — provider + test both. No direct `fetch`.
- **Envelope** — every handler uses `ok`/`fail`; greenfield so no bare-payload consumers to break.
- **No frontend changes** (Phase 2/3). Settings keys are backend-only here; UI is Phase 3. Phase 2/3 frontend must gate on `elevationEnabled` only — `elevationSourceUrl` is secret and server-side only.
- **Bounded memory** — tile cache ≤16 MB worst case (64 × 256 KB Float32 tiles); JSON sample cache 10 000 boxed numbers (< 1 MB).
- **Source-agnostic by design** — elevation is not per-source data; no `sourceId` column/scoping (documented exception rationale: public DEM, like decryption PSKs are global). This is intentional and called out so a reviewer doesn't flag a missing `sourceId`.
- **ESLint ratchet** — no new `any`, no raw `fetch`; `@types/pngjs` keeps decode typed.
