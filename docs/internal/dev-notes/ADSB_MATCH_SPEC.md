# ADS-B flight matching for likely aircraft (#5374)

Builds on the likely-aircraft epic (#5364 / #5365; see `AIRCRAFT_DETECTION_EPIC.md`).

When a node becomes a likely aircraft, MeshMonitor can look it up in a free, community ADS-B feed. It confirms the flag and shows the flight: callsign, type, registration, speed and heading.

## Decisions (user, 2026-09-27)

- **D1 Sources.** Online community feeds only; no local receiver, OpenSky or paid APIs in v1.
  - Choices: **adsb.lol** (default), **adsb.fi** and **airplanes.live**.
  - All three return the same ADSBx v2 / readsb JSON, so one client and one parser serve them.
  - Off by default. A stock install makes no third-party calls.
- **D2 When to look up.** Only in response to a node **becoming** a likely aircraft (the Phase 1 live transition), with at most **2 lookups per flagging**:
  - Lookup 1 runs on the transition, and a hit shows as **"Possible match"**.
  - Lookup 2 runs on the node's next live position, at least 60 s and at most 30 min after lookup 1. If it names the same aircraft (ICAO hex), the match becomes **"Matched"**.
  - After that, nothing more is looked up until the node becomes flagged again.
- **D3 Display.** The popup and the node details show one line, for example "Matched: UAL123 · B738 · N12345 · 450 kt 270°". The line links to the flight on the chosen feed's map and credits the feed.
  - The node keeps its own name. The marker and the automation engine are unchanged.
- **D4 Confidence.** This is a two-fix confirm (see D2).
  - **A match only confirms.** No match never clears or downgrades the likely-aircraft flag. Light aircraft often lack ADS-B, and some suppress it.

## Mesh impact

- **Airtime:** none. This makes outbound HTTPS only; no packets go to the mesh.
- **Spam:** no notifications, events or automation triggers.
- **Rate:**
  - At most 2 requests per node per flagging.
  - One global queue spaces requests at least 1.1 s apart, under the feeds' 1 request/s cap.
  - A 10-minute global backoff follows any 429, 403 or 5xx, or a timeout. A failed lookup does not use up the node's allowance.
- **Timers and persistence:** the per-flagging lookup count lives in the database (the match row), so a restart or settings save can't reset it and allow extra lookups. A restart is not a flag transition, so it triggers no lookup.

## Settings (global; add to `VALID_SETTINGS_KEYS`)

These are global, not per source: they configure an outbound service, like `elevationEnabled`.

| key | values | default |
|---|---|---|
| `adsbMatchEnabled` | `'true'`/`'false'` | false |
| `adsbFeed` | `'adsb.lol'` / `'adsb.fi'` / `'airplanes.live'` | `'adsb.lol'` |
| `adsb_api_token` | string, optional | empty; kept for adsb.lol's announced future key. Server-only: the `_token` suffix matches `SECRET_SETTINGS_KEY_PATTERN`, so it is never sent to clients. |

- Validate `adsbFeed` against the list, returning 400 `INVALID_ADSB_FEED` otherwise.
- **Secret keys and non-admin saves (added in review):** a non-admin never receives `adsb_api_token` (or any secret key), so their Settings save carries it blank. `POST /api/settings` drops secret keys from non-admin writers, so such a save can neither wipe nor set a key. This also closes the same gap for `elevationSourceUrl`.
- **UI:** a "Flight matching (ADS-B)" block in Settings, next to the Elevation settings (global section).
  - An enable switch, a feed select and an optional key field.
  - Help text: "When a node becomes a likely aircraft, MeshMonitor asks the selected public ADS-B feed which aircraft is at that spot. At most two lookups per flagging. Nothing is sent over the mesh."
  - Show the feed's terms line next to the select: adsb.lol is ODbL; adsb.fi and airplanes.live are for personal, non-commercial use.

## Feed endpoints (one client)

| feed | point query | flight link |
|---|---|---|
| adsb.lol | `https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}` | `https://adsb.lol/?icao={hex}` |
| adsb.fi | `https://opendata.adsb.fi/api/v3/lat/{lat}/lon/{lon}/dist/{nm}` | `https://globe.adsb.fi/?icao={hex}` |
| airplanes.live | `https://api.airplanes.live/v2/point/{lat}/{lon}/{nm}` | `https://globe.airplanes.live/?icao={hex}` |

- **Live check (2026-09-27, point query over Miami, 10 NM):**
  - adsb.lol returned 200 with 12 aircraft. adsb.fi returned 200 with 11, and it was the same aircraft as adsb.lol (AAL1498, B38M, N316RK). Both used the `{ac, msg, now, total, ctime, ptime}` shape with every field below.
  - **airplanes.live returned 403** to an anonymous request with a descriptive User-Agent. Keep it in the feed list only if a key or registration path is confirmed at implementation time; otherwise drop it from v1 and say so in the PR.
- The response is `{ ac: [...], now, ... }`. Fields used from each aircraft:
  - `hex`, `flight` (trim it), `t` (type), `r` (registration);
  - `lat`, `lon`;
  - `alt_geom` (ft), `alt_baro` (ft or `"ground"`);
  - `gs` (kt), `track` (°), `seen_pos` (s).
- Client behaviour:
  - Send a `User-Agent: MeshMonitor/<version> (+https://github.com/Yeraze/meshmonitor)` header.
  - Time out after 10 s.
  - Send `adsb_api_token` as a header only when it is set; the header name follows adsb.lol's docs.
- Put the client in `src/server/services/adsbFeedClient.ts`, with the HTTP call injectable for tests.

## Matching (pure: `src/utils/adsbMatch.ts`)

Inputs: the node's effective position, its altitude (m) and `positionTimestamp`, which since #5401 is the observation time.

- **Radius:** `r_km = clamp(5 + ageSec × 0.13, 5, 90)`, where `ageSec` is the age of the node's fix and 0.13 km/s is about 250 kt. The query distance is `ceil(r_km / 1.852)` NM, which is well under the adsb.fi 250 NM cap.
- **Candidates:**
  - drop aircraft with no position, or with `alt_baro === "ground"`;
  - altitude: `|node_alt_m − ac_alt_m| ≤ 300`, where `ac_alt_m` is `alt_geom` × 0.3048, or `alt_baro` × 0.3048 when there is no `alt_geom`;
  - horizontal distance ≤ `r_km`.
- **Pick:** the nearest candidate. The pick is **ambiguous**, meaning no match, when a second candidate is within 1.25× of the nearest distance.
- **Output:** `{ hex, callsign, type, registration, gsKt, trackDeg, altM, distanceKm }` or null.
- **Tests:** units, the radius clamp, the altitude window, `ground`, and the ambiguity rule.

## Data: migration 180, `aircraft_flight_matches` (per source)

Check the next free number when implementing.

| column | notes |
|---|---|
| `sourceId` | FK to sources, cascade on delete. PK is (`sourceId`, `nodeNum`). |
| `nodeNum` | BIGINT on PG/MySQL |
| `episodeStartedAt` | ms; time of the flag transition that opened this flagging |
| `lookups` | int, 0–2; lookups used in this flagging |
| `firstLookupAt` | ms |
| `status` | `'none'` / `'possible'` / `'matched'` |
| `feed` | the feed that answered |
| `hex`, `callsign`, `aircraftType`, `registration` | nullable text |
| `gsKt`, `trackDeg`, `altM`, `distanceKm` | nullable real |
| `matchedAt` | ms, the time of the last lookup that produced this status |

- Use full DDL on all three backends, with the migration helpers.
- Add a repository `src/db/repositories/aircraftFlightMatches.ts` with `get`, `startEpisode` (upsert: resets `lookups` to 0, `status` to `'none'` and clears the match fields), `recordLookup` and `deleteForNode`, and expose it through `DatabaseService` with the `Async` suffix.
- Per-source scoping is mandatory. Add a `*.perSource.test.ts`.

## Service: `src/server/services/adsbMatchService.ts`

- **Transition hook.** Subscribe where Phase 1 emits `node:aircraft` (the transition event), or add a call next to `emitAircraft` in `aircraftClassificationService`.
  - If matching is enabled, call `startEpisode` (only when the stored `episodeStartedAt` is older than this transition), then run lookup 1.
- **Next-fix hook.** On a **live** position (`aircraftAgeOutService.handlePositionReception`, where `isLiveReception` is already true), look up the node's row. Run lookup 2 only if all of these hold:
  - status is `'possible'` or `'none'`;
  - `lookups` is 1;
  - at least 60 s and at most 30 min have passed since `firstLookupAt`.

  The DB read should only happen for nodes flagged `likelyAircraft`; use the node cache.
- **Lookup:**
  - Skip if the global backoff is active.
  - Queue globally at ≥ 1.1 s spacing.
  - **Cross-source reuse:** keep an in-memory cache keyed by `(nodeNum, rounded lat/lon, minute)` for 60 s, so a node flagged on several sources at once makes one HTTP request. Each source still records its own row.
  - Match the result, then write the row: `lookups + 1`, status and fields.
  - **Status rules:**
    - Lookup 1 with a hit sets `'possible'`; without a hit, `'none'`.
    - Lookup 2 with a hit on the **same hex** sets `'matched'`.
    - Lookup 2 with a hit on a different hex sets `'possible'` with the new aircraft.
    - Lookup 2 with no hit keeps the previous status and fields.
  - A failed lookup (network, 4xx or 5xx) does not increment `lookups`.
  - **Retry of a failed lookup 1 (added in review):** if lookup 1 failed (so `lookups` is still 0), the next live fix retries it while the flagging is at most 30 min old. The 60 s per-node retry floor and the global backoff still apply.
- **Exclusions:** skip MeshCore, meshcore_mqtt and Reticulum sources (`AIRCRAFT_EXCLUDED_SOURCE_TYPES`).

## Route

`GET /api/sources/:id/nodes/:nodeNum/flight-match`
- Requires `nodes:read` on that source, and respects the private-position rule: return nothing for a node with a private override when the user lacks `nodes_private:read`.
- Returns `ok(res, match | null)`, with `feedName`, `flightUrl` and `attribution` added.
- **Tests:** use the route harness (`createRouteTestApp`). Cover per-source isolation and privacy.

## Frontend

- In the popup (`sections.tsx` / `nodeCardModel.ts`) and in `NodeDetailsBlock.tsx`: when `likelyAircraft` is true and matching is enabled, fetch the match lazily when the popup opens. Use a TanStack hook over an `ApiService` method, with `staleTime` of 60 s.
- Render "Matched: UAL123 · B738 · N12345 · 450 kt 270°" or "Possible match: …", linked to `flightUrl`, with a small credit ("Data: adsb.lol").
  - Leave out the parts that are missing.
  - Render nothing when there is no match.
- Use `UiIcon` `aircraft`; add `en.json` keys.
- Docs: add a "Flight matching (ADS-B)" section to `docs/features/maps.md` (or settings.md), covering the feeds, their terms, the 2-lookup limit, and "a match only confirms".

## Exit criteria

- Unit tests for the matcher, feed parsing (a fixture JSON per feed shape), the episode and lookup-cap rules, backoff, and cross-source reuse.
- Tests showing a restart doesn't reset the cap (the cap is DB-backed) and that a failed lookup doesn't count.
- Route permission and privacy tests; migration tests on all three backends.
- Browser check with a real flagged node, if one is available; otherwise a recorded fixture served by a test stub.
- Full suite passes with PG/MySQL up; `tsc` and `lint:ci` are clean.
