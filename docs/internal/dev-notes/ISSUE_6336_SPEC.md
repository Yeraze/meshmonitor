## Maintainer decisions (2026-11-10, binding)
Ship subdivision + city: Natural Earth admin-1 (public domain) dissolved to top-level ISO 3166-2, plus GeoNames cities15000 (CC BY 4.0) in a separate droppable module; embed as gzip base64 .ts modules; add THIRD_PARTY_DATA.md attribution; no new UI field; do not patch upstream naming mismatches locally; manual data refresh pinned by version/sha256.

# Spec: offline geocoder for subdivision and city rows (MeshMonitor #6336, phase 2 of #6287)

## 1. Findings (file:line)

**The ladder is ready, but nothing feeds it a place.**
- `Place {cc, subdivisionName?, subdivisionIso?, city?}` is optional and documented as "Phase 1 has no geocoder" (`src/server/services/mqttRootFinder/ladder.ts:35-44`).
- `buildLadder` returns only the region row when `place?.cc` is missing (`ladder.ts:220`).
- Segment resolution goes: directory `subdivisionSegments` by lowercase name, then the ISO 3166-2 suffix, then `sanitizeSegment(name)` (`ladder.ts:120-137`).
- City is `sanitizeSegment(city).toLowerCase()` under the subdivision root (`ladder.ts:159-170`).
- Neighbors are looked up by `place.subdivisionIso` (`ladder.ts:287-302`). Tier 1 is "under subdivision or city" (`ladder.ts:323-326`).
- The service accepts `place` and stores it on the job (`rootFinderService.ts:60-61, 82-83, 165-171`). `get()` passes it to the ladder, community and rank code, and `hasLocation` already counts it (`rootFinderService.ts:188-205`). The directory is injected through options (`rootFinderService.ts:103-106`).
- The route passes only `userPos` and never a `place` (`src/server/routes/mqttRootFinderRoutes.ts:47-53`).
- `userPos` comes from the radio position or position override (`src/server/utils/mqttRootFinderTarget.ts:140-152`) or a bridge geo-center (`:166-167`, `:246-279`).

**Directory data** (`src/server/data/mqttRoots.json`, 8.4 KB, imported as JSON at `directory.ts:9`):
- `subdivisionSegments` covers the US only (52 names).
- `neighbors` covers 49 US codes only.
- There are 20 entries.

**Geometry helpers**
- Ray-cast point-in-polygon already exists in `src/server/services/automation/geo.ts:87-97` and `src/utils/geometry.ts:24`. Both take `{lat,lng}` object arrays.
- The finder may not import `automation/geo.ts`: `isolation.test.ts:223` forbids `/automation/i` for every file under `mqttRootFinder/`.
- There are no geo dependencies in `package.json` (also noted at `ISSUE_6287_SPEC.md:81`).

**How data ships**
- `tsconfig.server.json` includes `src/server/**/*`, so tsc writes imported JSON or TS into `dist/`. That `dist/` reaches:
  - Docker (`Dockerfile:62`, `:72`, `:128`);
  - LXC (`src` is in `lxc/sparse-cone.txt`; build at `lxc/build-lxc-template.sh:245`);
  - desktop (`desktop/src-tauri/tauri.conf.json:32` bundles `../resources/dist`).
- Non-imported assets need manual copies in three places. Precedent is `openapi.yaml`: `package.json:16` plus `.github/workflows/desktop-release.yml:64-65` and `:279-280`.

**Licence and existing privacy rules**
- Licence is BSD-3-Clause (`LICENSE`, `package.json:5`). The repo has no NOTICE or third-party attribution file.
- Privacy rules from the #6287 spec:
  - R3: location never reaches the broker and is never logged (`ISSUE_6287_SPEC.md:12`).
  - Coordinates never appear in responses; only km distances do (`:149`, `:248`).
  - Q3 rejected online geocoders (`:282-285`).

## 2. Dataset options

| | Natural Earth 10m admin-1 (recommended) | geoBoundaries (gbOpen ADM1 / CGAZ) | GeoNames cities15000 (city rung) |
|---|---|---|---|
| Licence | Public domain. No conflict with BSD-3. | CC BY 4.0 for CGAZ. gbOpen licences vary per country and some are ODbL (share-alike on derived databases). Needs a per-country audit. | CC BY 4.0. Compatible; needs attribution. |
| ISO fields | `iso_a2`, `iso_3166_2` (`US-WA`, `DE-SH`), `name`, `region`. | `shapeGroup` is ISO3. `shapeISO` is often empty or inconsistent. | `country code`, `admin1 code`. admin1 is not ISO outside some countries, so join by polygon instead. |
| Raw size | ≈14 MB zipped shapefile, ≈40 MB GeoJSON, ≈4.6k features | ≈ tens of MB | ≈33k rows, ≈3 MB zip |
| After build | Topology-preserving simplification (mapshaper, Visvalingam ≈3-5%), int32 quantised at 1e-5°: ≈1.5 MB raw, **≈0.8-1 MB gz** | similar or larger | name, lat/lon int32, polygon index: ≈0.65 MB raw, **≈0.35 MB gz** |

Natural Earth quirks:
- Admin-1 granularity is uneven: FR departments, IT/ES provinces, GB counties. The generator dissolves these to top-level ISO 3166-2 using NE's `region`/`region_cod` plus a small override table. GB becomes GB-ENG/SCT/WLS/NIR.
- Country (admin-0) comes from dissolving admin-1 by `iso_a2`. No separate admin-0 file is needed.
- Fix NE's `-99` codes for FR, NO and Kosovo from an override table.

Total footprint is **≈1.2-1.4 MB gz**, or ≈1.7-1.9 MB if stored as base64 in a `.ts` module. It ships with no build changes in the server `dist`, Docker, LXC (`src` is in the cone; each data refresh grows the sparse `.git` by ≈1.3 MB) and desktop. Docker image growth is under 1%.

**Recommendation:** Natural Earth for polygons, GeoNames cities15000 for cities. Store both as generated `src/server/data/geo/*.ts` modules that export a base64 gzip string:
- tsc emits them, so no change to `build:server` or `desktop-release.yml`.
- A multi-MB `.json` import would make tsc infer a giant literal type, which is slow and uses a lot of memory in CI.

Pin the inputs like `MQTT_ROOTS_UPSTREAM_*`:
- the NE release tag (`v5.1.2`);
- the GeoNames download date and sha256;
- the generator version.

## 3. Ladder use (region, `<CC>`, subdivision, city), deterministic

New module `src/server/services/offlineGeocoder/`, outside `mqttRootFinder/` so MeshCore can reuse it later:
- `reverseGeocode(pos: LatLon): Place | undefined`
- a pure lookup over typed arrays;
- lazy-loaded on first call;
- no I/O except `zlib.gunzipSync` of the embedded string.

Lookup algorithm:
1. **Subdivision.**
   - Prefilter with per-feature bbox (Float64Array) and ray-cast even-odd over all rings. Holes and multipolygons come out correct for free.
   - Hits in several features (should not happen with topology-preserving simplification): pick the lowest ISO 3166-2 code.
   - No hit (coast, pier, or simplification error): use the nearest feature edge within **10 km**, ties broken by lowest ISO code. Otherwise return `undefined` (open sea).
   - `cc` = the feature's ISO alpha-2. `subdivisionIso` = the feature code. `subdivisionName` = NE `name`, which matches the `subdivisionSegments` keys, e.g. `washington`.
2. **City.**
   - Candidates are cities whose generation-time polygon index equals the user's subdivision.
   - Pick the nearest by haversine within **15 km**. Ties go to higher population, then lower geonameid. `city` = GeoNames `name` (UTF-8). The existing `cityRootFor` already applies NFC, sanitising and lowercasing.

Same coordinate plus same pinned data gives the same `Place`, so the same ladder. No randomness, no locale and no float-order dependence: coordinates are quantised integers and ties are ordered.

Wiring:
- `RootFinderServiceOptions.geocoder?` is injectable and defaults to `reverseGeocode`.
- `start()` sets `place = params.place ?? geocoder(params.userPos)` once per job, so `get()` stays cheap.
- The route stays unchanged; `rootFinderService.ts:160-171` changes.
- The place is never logged.
- No new response field. Recommendation: the ladder rows already reveal subdivision and city, and only to the user who started the sample (see Q3).

## 4. Point-in-polygon cost (Raspberry Pi)

Write a ≈25-line typed-array ray-cast in the geocoder module. The existing helpers take object arrays and `automation/geo.ts` is import-forbidden.

| Cost | Estimate |
|---|---|
| Decoded memory, ≈300-400k vertices as Int32 pairs | ≈3 MB |
| Bboxes and offsets | <0.5 MB |
| Cities | ≈1 MB |
| **Resident total** | **≈5 MB**, versus ≈60-120 MB peak if parsed as GeoJSON objects (another reason not to use JSON) |
| One-time decode on a Pi 4 | ≈30-80 ms |
| Lookup | bbox scan over ≈4k features, plus a few thousand edges, plus a city scan: <2 ms |

It runs only on finder start, which is capped at 2 active instance-wide. Load lazily and drop the cache after 10 min idle.

## 5. Community naming vs ISO codes (bundled directory)

| Directory root | ISO 3166-2 | Ladder segment | Matches? |
|---|---|---|---|
| `msh/US/CA/sacvalley`, `msh/US/CA/socalmesh` | US-CA | `CA` (via `subdivisionSegments`) | yes, tier 1 |
| `msh/US/IL/Chi`, `msh/US/IL/Central`, `msh/US/NY/CNY`, `msh/US/NY/WNY`, `msh/US/PA/WPAmesh`, `msh/US/VA/VBMesh`, `msh/US/GA/csramsh` | US-IL/NY/PA/VA/GA | suffix | yes |
| `msh/US/DMV`, `msh/US/GSMC`, `msh/US/SecKC`, `msh/US/MeshSTL`, `msh/US/bayarea` | none (multi-state or metro) | n/a | only via R6 center/radius (phase 1 already does this) |
| `msh/EU_868/DE/S-H` | DE-SH | `SH` (`sanitizeSegment` drops `-`) | **no**: `msh/EU_868/DE/SH` ≠ `S-H`. Caught only by its 75 km radius. |
| `msh/EU_868/Hamburg/hamburg` | DE-HH | `msh/EU_868/DE/HH` | no (not under `/DE`) |
| `msh/EU_868/Scotland` | GB-SCT | `msh/EU_868/GB/SCT` | no (not under `/GB`) |
| `msh/EU_868/9A` | HR (`9A` is the ITU callsign prefix) | `HR` | no |
| `msh/EU_868/nedermsh/potatonet` | NL | — | no |

So phase 2 sharpens tier 1 and neighbor tier 2 in the US. Outside the US it adds suggested `<CC>/<sub>[/city]` rows and the country row, but **0 of 5 EU directory entries match by ISO**. Fixing that is upstream directory data: `subdivisionSegments` for DE, GB, etc., e.g. `schleswig-holstein → S-H`. That belongs in meshtastic/api, not here.

## 6. Work packages

1. **Generator.** `scripts/geo/build-offline-geocoder.mjs`, run manually; mapshaper through a pinned `npx`, not a dependency. It:
   - downloads the pinned inputs and checks their sha256;
   - dissolves to top-level ISO;
   - simplifies topology-preserving;
   - quantises;
   - writes `src/server/data/geo/{admin1,cities}.data.ts` plus a `geoDataVersion.ts` with the SHAs;
   - prints sizes.
2. **Geocoder.** `src/server/services/offlineGeocoder/{decode,pip,reverseGeocode}.ts`.
3. **Service wiring.** `rootFinderService.ts` (injectable geocoder).
4. **Attribution.** New `THIRD_PARTY_DATA.md` (or NOTICE) with GeoNames CC BY 4.0 and the Natural Earth credit; link it from `docs/features/mqtt-setups.md` and the desktop About page if one exists. Docs: the finder now names your state/province and city offline.

## 7. Test plan

**`offlineGeocoder/reverseGeocode.test.ts`, fixed coordinates:**
- Seattle → US/US-WA/Washington/seattle
- Texarkana TX side → US-TX; ladder tier 2 includes `msh/US/AR`
- Kiel → DE-SH
- Edinburgh → GB-SCT, not a council area
- Paris → FR-IDF (region, not department)
- Tokyo → JP-13 with city `東京` or GeoNames name (NFC; ≤31 bytes after `trimToBytes`)
- A point 2 km offshore of Miami → US-FL via the 10 km fallback
- Mid-Atlantic → `undefined`
- Fiji or Chukotka on either side of the antimeridian
- A point inside an enclave or hole (Lesotho → LS, not ZA)
- A US-WA/US-OR border point → stable answer over 1,000 repeated calls

**Determinism and invariants:**
- Snapshot of `reverseGeocode` over ≈200 seeded random land points (the dataset version is in the snapshot name).
- Every feature has a 2-letter `cc` and a `cc-XXX` subdivision code.
- No feature has `-99`.
- Every US NE `name` lowercased exists in `subdivisionSegments.US`.

**Performance (loose CI bound):**
- Decode under 1 s.
- 10k lookups under 2 s.
- `process.memoryUsage().heapUsed` delta under 30 MB.

**Wiring and privacy:**
- `rootFinderService` with an injected fake geocoder: `place` is set at start, and `get()` ladder has subdivision and city rows.
- Without `userPos`: no geocoder call.
- Route test: the response JSON contains no `lat`/`lon` numbers. The existing check stays green.
- Logger spy: the place name is never logged.

**Isolation:**
- Extend `isolation.test.ts` so the geocoder directory is scanned too.
- `ladder.test.ts` cases for `place` built from real geocoder output: Washington/Seattle, DE-SH.

**Shipping:**
- The existing Docker and desktop CI builds prove `dist/server/data/geo/*.js` exists. Add an assertion in the desktop CI step that it exists.

## 8. Open questions (recommended answer first)

1. **Is phase 2 worth ≈1.2-1.4 MB gz (≈1.8 MB as base64 in source, ≈5 MB RAM while in use)?** **Yes, for subdivision.**
   - Cost: under 1% of the Docker image, invisible in desktop installers, ≈1.3 MB per refresh in LXC `.git`.
   - Benefit: real tier-1 and neighbor ranking for the US, which holds most directory entries (15 of 20), and spec-conformant R4 rows everywhere.
   - Caveat: outside the US no directory entry matches by ISO today (§5).
2. **City rung: ship cities15000 (+≈0.35 MB gz) or skip?** **Ship it, in a separate data module so it can be dropped.**
   - R4 requires a city row.
   - Matching city-level roots are rare in the directory (`msh/US/IL/Chi`, `Hamburg/hamburg`), so the row will often be "not heard", which is harmless.
   - Alternative: defer to 2b and save 0.35 MB.
3. **Show the detected place in the UI ("Detected: Washington, US")?** **No new field in phase 2.** The ladder already conveys it. Add one later if users ask; it would only go to the starting user.
4. **Subdivision level for multi-tier countries (FR, IT, ES, GB): top-level 3166-2 (region or nation) or NE native?** **Top-level.** It matches community naming (`Scotland`) and is far fewer features.
5. **Cross-client determinism ("same ladder on every client").** **Propose this pinned dataset and algorithm to meshtastic/design#167** as the reference. Within MeshMonitor it is deterministic now; other clients use platform geocoders.
6. **Fix `S-H`, `Scotland` and similar mismatches locally?** **No.** File upstream `subdivisionSegments` additions in meshtastic/api; the bundled copy stays verbatim (R9).
7. **Derive non-US `neighbors` from polygon adjacency at generation time?** **No, not yet.** Neighbors stay upstream directory data. Revisit if upstream doesn't add them.
8. **Data refresh cadence.** **Manual, with NE releases** (about yearly). GeoNames is pinned by date. No runtime download.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/services/mqttRootFinder/ladder.ts
- /home/yeraze/Development/meshmonitor/src/server/services/mqttRootFinder/rootFinderService.ts
- /home/yeraze/Development/meshmonitor/src/server/services/mqttRootFinder/isolation.test.ts
- /home/yeraze/Development/meshmonitor/src/server/data/mqttRoots.json
- /home/yeraze/Development/meshmonitor/tsconfig.server.json (with `.github/workflows/desktop-release.yml:64-65,279-280` if any non-imported asset is chosen instead)
