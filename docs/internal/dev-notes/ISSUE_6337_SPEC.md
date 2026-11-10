# Issue #6337 spec: MQTT root finder live directory refresh

## Maintainer decisions (2026-11-10, binding)
Default OFF, admin opt-in: global admin-only strict-boolean setting mqttRootDirectoryRefreshEnabled (read as === 'true'). Lazy fetch only on a successful sample start, 24 h in-memory cache, 1 h failure backoff, 256 KB streamed cap, strict validation, entries replace wholesale, bundled fallback, redirect: 'error'. Support design#167 'subdivisions' entries. Show a one-line 'Directory: bundled / updated' footnote. No env var. Keep re-syncing the bundle at release time.

# Spec: #6337 MQTT root finder, live refresh of the community root directory

The decisions above override anything below that disagrees with them. File:line references in §1 are from before #6335 and may have moved.

## Implementation notes (as built)

- The refresh trigger lives in `POST /samples` (`mqttRootFinderRoutes.ts`), after `service.start()` succeeds, and only for the Meshtastic protocol: MeshCore regions use no directory.
- The route reads the setting and hands the check to `directoryProvider.refreshIfStale(isEnabled)`. The provider cannot read it itself, because `isolation.test.ts` forbids any file under `mqttRootFinder/` from importing the database service. With no check passed, the provider treats the refresh as off.
- With the setting off, `refreshIfStale` drops any live copy, so the next poll serves the bundled one.
- `SampleView.directory` is `{source: 'bundled'}` or `{source: 'live', fetchedAt}`; the finder shows it as a one-line footnote.

## 1. Findings

- `src/server/services/mqttRootFinder/directory.ts:1-42` loads the bundled `src/server/data/mqttRoots.json` (8.4 KB: 20 entries, 49 `neighbors`, 1 `subdivisionSegments` country). It pins the upstream commit `7406a79f…` (date 2026-10-18), blob `75379aac…`, at lines 12-16. `getDirectory()` at :35 fills in defaults for missing sections but does no validation.
- `rootFinderService.ts:105` reads the directory once, in the constructor. The singleton is built at module load (`:229`), and `get()` hands `this.directory` to `buildLadder`, `buildCommunity` and `rankHeard` (`:186-198`). **This has to become a per-call lookup, or a refresh never takes effect.** The constructor's `directory` option (`:88-90`) is the test seam.
- `ladder.ts:246-256` (`entryServesUser`) dereferences `entry.center[0]` and `entry.radiusKm` with no check. design#167's "Directory shape" also allows `{root, name, subdivisions:[...]}` entries with no `center`. Our `DirectoryEntry` type does not model that form. A live document containing such an entry would throw on every poll of `GET /samples/:id`. **Validation is needed for safety, not just hygiene.**
- `safeFetch` (`src/server/utils/ssrfGuard.ts:289-296`) checks only the first URL and then calls plain `fetch`, so redirects are followed without being checked. Use `redirect: 'error'`.
- Pattern to copy: `src/server/services/gnss/tleService.ts`. It fetches lazily with no boot scheduler (`:8-12`), has a 24 h TTL (`:51-52`), shares one in-flight request between concurrent callers (`:101-128`), and keeps the last good data on failure without ever caching the failure (`:150-200`). `scriptUpdateService.ts:32,169-176` shows a size cap, but it checks only after reading the whole body. We need a streamed cap.
- Opt-out setting precedent: `ductingOverlayEnabled`, a global outbound-service toggle that only admins can write. See `src/server/constants/settings.ts:521-524` (VALID_SETTINGS_KEYS, which starts at :14), `:1022` (GLOBAL_ONLY, set at :960) and `:1195-1196` (ADMIN_ONLY). It is also in the strict-boolean list at `src/server/routes/settingsRoutes.ts:~443-457` and is read with `getSetting` (`ductingRoutes.ts:218`).
- Default-on precedent (not used; the maintainer chose default off): `elevationEnabled` (`SettingsTab.tsx:232,596,859`, read as `!== 'false'`). The environment-variable opt-out precedent is `VERSION_CHECK_DISABLED` (`versionCheckService.ts:10,55`).
- Entry point: `POST /api/mqtt/root-finder/samples` (`mqttRootFinderRoutes.ts:39`, mounted at `server.ts:1090`). It sits behind `requireAuth` and `mqttRootFinderLimiter`.
- Root validator: `validateMqttRoot` in `src/utils/mqttRootTopic.ts:33`.

## 2. The canonical source exists

- **URL:** `https://api.meshtastic.org/resource/mqttRoots` (meshtastic/api#154, merged).
- **Response:** HTTP 200, `application/json`, `content-length: 8647`. Served by Cloudflare with `cache-control: public, max-age=300, s-maxage=86400, stale-if-error=86400` and an `etag`.
- **Shape:** identical to our bundled file. Top-level keys are `entries`, `neighbors` and `subdivisionSegments`. There are 20 entries and no version or updated field.
  ```json
  {"root":"msh/US/CA/sacvalley","name":"sacvalley","center":[38.64,-121.163],"radiusKm":60}
  "neighbors": {"US-AL":["US-FL","US-GA","US-MS","US-TN"]}
  "subdivisionSegments": {"US":{"alabama":"AL", ...}}
  ```
- **Freshness:** upstream `data/mqttRoots.json` is still at blob `75379aac`, the same one we bundle. Its last commit, 7406a79 on 2026-10-18, says "mqttRoots has no Railway fallback", meaning the endpoint has no backup host. Three commits landed in two days, then nothing for three weeks.
- **Coming change:** api#171 (roots in any script, e.g. `msh/EU_868/NO/Østlandet`) is still OPEN. Once it merges, live refresh is how those roots reach us.
- **Design intent:** design#167 (OPEN) names this endpoint "so new entries reach clients without a release". "Where does the directory live?" is still listed there as an open question.
- **Mapping to our format:** 1:1 for the center/radius form. The design's `subdivisions` form also needs handling (see §3).

## 3. Fetch design

**New module:** `src/server/services/mqttRootFinder/directoryProvider.ts`. `directory.ts` keeps the bundled data and gains a shared validator.

- **API:**
  - `current(): MqttRootDirectory`: synchronous; returns the live copy if one is held and enabled, otherwise the bundled one.
  - `refreshIfStale(): Promise<void>`: never throws.
  - `status(): {source: 'bundled'|'live', fetchedAt?: number}`
  - `__resetForTests()`
- **Wiring:** `RootFinderService` takes `directory?: MqttRootDirectory | (() => MqttRootDirectory)` and calls the function in `get()`. The default is `() => directoryProvider.current()`.
- **Trigger, so there is no fetch when the finder is unused:**
  - The only trigger is a successful `start()` in `POST /samples`, via a fire-and-forget `void directoryProvider.refreshIfStale()`.
  - Nothing runs at boot or import, and there is no timer.
  - The 60 s sample hides the fetch latency, and the first poll after it lands uses the new data.
- **Cache:** in memory only. The response is ~9 KB, refetching once per process start on first use is cheap, and this avoids a migration.
  - TTL is 24 h, matching the CDN's `s-maxage`.
  - Concurrent callers share one in-flight request.
  - After a failure, back off for 1 h so every sample start does not hit the network.
  - Keep the last good copy indefinitely; never cache a failure.
- **Request:**
  - The URL is a hard-coded constant, not a setting.
  - Call `safeFetch(URL, {redirect: 'error', signal: AbortSignal.timeout(10_000), headers: {Accept: 'application/json'}})`.
  - Optionally send `If-None-Match` with the stored ETag; a 304 just bumps `fetchedAt`.
- **Size caps:**
  - Reject if `Content-Length` is over 256 KB.
  - Read the body as a stream and abort once it passes 256 KB.
  - Then `JSON.parse` inside a try block.
  - Limits: entries ≤ 2000; `neighbors` ≤ 1000 keys with ≤ 32 codes each; `subdivisionSegments` ≤ 250 countries with ≤ 300 names each.
- **Validation** (`validateDirectory(raw): MqttRootDirectory | null` in `directory.ts`):
  - The top level must be an object.
  - Entry `root`: a string that passes `validateMqttRoot` and starts with `msh/`.
  - Entry `name`: a string of 1-64 characters with control characters stripped.
  - Location: either `center` (finite numbers, lat in [-90, 90], lon in [-180, 180]) with `radiusKm` (finite, 0 < r ≤ 250, the design's cutoff), or `subdivisions` (ISO 3166-2 codes matching `^[A-Z]{2}-[A-Z0-9]{1,3}$`). An entry may have both.
  - Bad entries are dropped one by one. Duplicate roots are removed, first one wins.
  - `neighbors` and `subdivisionSegments` must be string maps in ISO or lowercase-name form, with values that are codes or segments.
  - Reject the whole document (keep the current data) if it has zero valid entries or if more than half its entries are invalid.
- **Merge rules:**
  - **`entries` replace the bundled list wholesale.** Upstream deletes entries on purpose (e.g. "Drop the Four Corners pair"), and a union would bring them back.
  - Each of `neighbors` and `subdivisionSegments` is taken from the remote copy when it is present and non-empty, otherwise from the bundled copy.
- **`subdivisions` support:**
  - Widen `DirectoryEntry` to `center?`, `radiusKm?`, `subdivisions?`.
  - `entryServesUser` returns true when `place.subdivisionIso` is listed in `entry.subdivisions`, and checks distance only when `center` exists.
  - If this is cut from scope, the validator must drop entries without a `center` instead.
- **Opt-in setting:** `mqttRootDirectoryRefreshEnabled`.
  - Global, admin-only, strict boolean, **default off** (maintainer decision): read as `getSetting(...) === 'true'` when `refreshIfStale` runs.
  - Register it in VALID_SETTINGS_KEYS, GLOBAL_ONLY_SETTINGS_KEYS, ADMIN_ONLY_SETTINGS_KEYS and settingsRoutes' STRICT_BOOLEAN list.
  - Add a toggle in SettingsTab beside Elevation.
  - When it is off: no fetch, and `current()` returns the bundled copy even if a live copy is held.
- **Visibility (optional):**
  - Add `directory: {source, fetchedAt}` to `SampleView`.
  - The finder sheet shows "Directory: bundled (2026-10-18)" or "updated <relative time>".
  - Log the outcome at info level when the live data changes and at warn level when a fetch fails, at most once per backoff window.

## 4. Privacy

- The request is a bare GET to api.meshtastic.org, behind Cloudflare.
- **What it reveals:** the instance's egress IP and the time of a finder use, at most once per 24 h per process. That reveals that someone on this instance used the finder.
- **What it does not send:** no query string, cookies, location, region, broker, root or user identity. The User-Agent is Node's default; do not add an instance-identifying one.
- The fetch does not run unless an admin turns the setting on and someone then uses the finder. It is off by default.
- Document it with the other outbound services in the docs and settings help text.

## 5. Test plan (Vitest, all network mocked with `vi.mock('../../utils/ssrfGuard.js')`)

- **`directoryProvider.test.ts`:**
  - No fetch at import or construction.
  - Within the TTL, no fetch; once stale, exactly one fetch; concurrent calls are shared.
  - On failure, the last good copy is kept, or the bundled copy if there is none, and the 1 h backoff applies.
  - With the setting `'false'`: no fetch, and the bundled copy is served even after a successful earlier fetch.
  - Rejections: `Content-Length` over the cap, a streamed body over the cap, non-JSON, HTTP 500, an `SsrfBlockedError`, a timeout.
  - `redirect: 'error'` is passed to `safeFetch`.
  - Replace semantics: an entry removed upstream disappears. Section fallback: an empty `neighbors` falls back to the bundled one.
  - A 304 bumps `fetchedAt`.
- **`directory.test.ts`:**
  - The bundled JSON passes `validateDirectory` unchanged (catches drift).
  - Bad roots, out-of-range coordinates, radius over 250, oversize name or control characters, duplicates, a mostly-invalid document, and caps are each rejected or dropped as specified.
  - A subdivisions-only entry is accepted.
- **`ladder.test.ts`:** `buildCommunity` handles a subdivisions-only entry and does not throw when `center` is missing.
- **`rootFinderService` (extend `isolation.test.ts`):**
  - `get()` uses the provider's current value at poll time.
  - `start()` calls `refreshIfStale` once and still succeeds if it rejects.
- **`mqttRootFinderRoutes.test.ts`:** a rate-limited or failed start triggers no refresh.
- **Settings:** the key is accepted, strict-boolean, rejected from non-admins, and global-only.
- No live-network test in CI.

## 6. Open questions (recommended answer first; see the maintainer decisions at the top for the answers)

1. **Worth doing?** **Yes.**
   - The source exists, is live, has the same shape as our bundle, and is the design's stated way for entries to reach clients without a release.
   - It is about 200 lines plus tests, with no migration.
   - Without it, the api#171 non-ASCII roots and new communities reach us only through a MeshMonitor release.
   - Had no canonical source existed, I would have recommended closing this issue in favour of re-syncing the bundle at release time.
2. **Wait for design#167 to close its "where does the directory live" question?** **No; ship now.** The URL is a single constant and the bundled copy stays as the fallback. Not checked: whether Apple and Android fetch it live.
3. **Default on or off?** **Decided: off**, admin opt-in, matching `ductingOverlayEnabled`. (The original recommendation was on, as the issue says "opt-out".)
4. **Persist the cache in the database?** **No; in memory.** Revisit only if instances restart often and the first sample's use of the bundled copy matters.
5. **Support design#167 `subdivisions` entries in this PR?** **Yes.** It is small and makes the refresh safe against the documented shape. The fallback is to drop such entries in the validator.
6. **Add an environment variable (e.g. `MQTT_ROOT_DIRECTORY_REFRESH_DISABLED`) for air-gapped or IaC deployments?** **No, the setting is enough.** Add one later if asked, following `VERSION_CHECK_DISABLED`.
7. **Show where the directory came from in the finder UI?** **Yes, as a one-line footnote.** It helps explain why suggestions differ between instances.
8. **Keep refreshing the bundled file at release time?** **Yes.** Add a release checklist step to re-copy `data/mqttRoots.json` and update the SHA constants at `directory.ts:12-16`.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/services/mqttRootFinder/directory.ts
- /home/yeraze/Development/meshmonitor/src/server/services/mqttRootFinder/rootFinderService.ts
- /home/yeraze/Development/meshmonitor/src/server/services/mqttRootFinder/ladder.ts
- /home/yeraze/Development/meshmonitor/src/server/services/gnss/tleService.ts (pattern to copy)
- /home/yeraze/Development/meshmonitor/src/server/constants/settings.ts and /home/yeraze/Development/meshmonitor/src/server/routes/settingsRoutes.ts
- /home/yeraze/Development/meshmonitor/src/server/utils/ssrfGuard.ts
