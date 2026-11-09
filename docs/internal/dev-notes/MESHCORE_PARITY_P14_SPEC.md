# MeshCore Parity follow-up: Traceroute Explorer includes MeshCore traces (#6276)

## Maintainer decisions (2026-11-09, binding)
Q1: B — ship the read-only Explorer (WP1–WP3), then the meshcore_trace_runs attempt log (WP4, one migration; use the next free migration number at implementation time, not necessarily 225). Q2: initiated traces only. Q3: fix v1 meshcoreTraceToV1 through the shared builder, with a release note.


Part of the parity epic (`MESHCORE_PARITY_EPIC.md`, P5 decision 3 split this out). Base is `origin/main` @ 4402509fe. Paths are relative to `src/`.

**Binding rule:** one implementation for all sources. The Explorer (`components/Analysis/tracerouteExplorer/*`, `GET /api/traceroutes/explorer`) is extended. No MeshCore copy. MeshCore runs reach the client in the same wire shape as Meshtastic runs and go through the same model, table, map and detail drawer. Identity moves from `nodeNum` to the unified `nodeKey` (`mt:<n>` / `mc:<pk>`). The synthetic `nodeNumFromPubkey` stays only where nodeNum-keyed display code needs a number (the strip and copy links), as P5 already ruled.

## Findings

### Explorer today (all Meshtastic nodeNum)
- **Route:** `server/routes/tracerouteRoutes.ts:259-358`.
  - Source set is `resolvePermittedSourceIds(req,'traceroute')` (`:271`). It already includes MeshCore sources, but `traceroutes.getTracesForSources` never returns rows for them.
  - Runs are channel-masked per source (`:291-294`).
  - The `wanted` set is numbers taken from `fromNodeNum/toNodeNum/route/routeBack` (`:297-303`).
  - Names need `nodes:read` (`:307`). Positions need channel `viewOnMap` (`:318-328`).
  - `mergeExplorerNodes` (`server/utils/tracerouteExplorerNodes.ts:56-100`) is keyed by number. `ExplorerNode` has no `nodeKey` or protocol (`:36-45`).
  - Rows come back requester-first through `orientTracerouteRows`. Do not orient again (CLAUDE.md rule).
- **Model:** `components/Analysis/tracerouteExplorer/explorerModel.ts`.
  - `ExplorerRunWire` (`:20-33`) and `ExplorerRun` (`:57-86`) are nums only.
  - `buildRuns` dedupe key is `p:packetId:from:to` (`:127`). `answered = hasRouteData(route)` (`:130`). Legs come from `buildLegHopLinks` (`:96-108`).
  - `filters.nodeNum` (`:194`), `runNodes`, `nodeMatchesSearch` (hex `!id`, `:213-218`), `aggregateLinks` (number keys `a<b`, `:330-354`), and `nodeLabel/nodeLongLabel` (`:360-368`) are all number-based.
  - `transport` comes from `transportMechanism` (`:158`).
- **UI:**
  - `TracerouteExplorerReport.tsx:118-136` keys the `nodes` Map and `devices` by nodeNum. `onNodeClick(nodeNum)` is at `:186`.
  - `ExplorerMap.tsx:140-168`: `pos(n:number)`, focus segments via `decomposeTraceroute(focusRun.wire)`, and the segment tooltip guards `seg.fromNodeNum ?? 0` (`:232`).
  - `ExplorerDetail.tsx:36-45`: `buildTracerouteStripGraph(run.wire)` plus `buildStripNodeMeta(devices)`. `TracerouteCopyLinks` is at `:101-110`. `TracerouteHistoryModal` (`:136-146`) calls the Meshtastic-only `/api/traceroutes/history/:from/:to`.
  - `TracerouteStrip` and `utils/tracerouteStrip.ts` (1,099 lines) are nodeNum-based. `BROADCAST_ADDR` renders the "Unknown" placeholder.

### How MeshCore traces are stored today
- **Table `meshcore_hop_snr`** (`db/schema/meshcoreHopSnr.ts`): one row per directional link `(sourceId, traceTag, authCode, hopIndex)`.
  - Columns: sender/receiver key, hash and candidate count; `snrQuarterDb` (dB×4, same unit as Meshtastic `snrTowards`); `hashBytes`; `initiated`; `timestamp`.
  - Retention is 90 d (`services/meshcoreTraceIngestService.ts:34`).
  - Purged on source delete (`routes/sourceRoutes.ts:1827`).
- **Ingest** (`meshcoreTraceIngestService.ts:76-152`). For path hashes H[0..N-1]:
  - row i: sender is H[i-1], or local when `initiated`; receiver is H[i].
  - final row N: sender H[N-1], receiver **local** (`receiverHash` null).
  - So every completed Companion trace is a loop local → … → local. The target contact is **not stored anywhere**.
  - Hashes resolve only on a unique match. Nothing is guessed (`resolvePathHash`, `:39-50`).
  - Overheard and Repeater in-flight traces (`initiated=false`) have no originator.
- **Only completed traces are stored.** A timeout or failure (`meshcoreManager.ts:8058-8067`, `MeshCoreTracePathOutcome` `:473-487`) leaves no row. Today a MeshCore "answer rate" would always read 100%.
- **Path shape** (`utils/meshcorePath.ts:109-121`, `buildTracePathHops`):
  - auto-return to a repeater or room: `out + [T] + reverse(out)`. This is an odd palindrome with T in the middle.
  - auto-return to a companion: `out + reverse(out)[1:]`. This is an odd palindrome that turns at the last repeater. The target is not on the wire.
  - direct trace: `[T]`.
  - no auto-return (scheduled `tracePathScheduleService`, v1 action `routes/v1/actions.ts:150`, automation `meshActionDeps.ts:296`): `out` only. This is not a palindrome, and the target is not on the wire.
- **The tag is created inside the backend** (`meshcoreNativeBackend.ts:2092-2093`, `ownTraceTags` `:466`). The manager never learns it (return value `:2180-2186`).
- **Readers that already exist** (`db/repositories/meshcoreHopSnr.ts`):
  - `getInitiatedTraces(sourceId, sinceMs, limitTraces)` (`:178-201`): grouped by `(tag, auth)`, deduped per hop index, newest first. Its row scan is capped at 20,000 and truncation is silent.
  - `getLatestInitiatedTraceFor` (`:155-170`).
  - `getLocalNodePublicKeysBySource` (`db/repositories/meshcore.ts:596`).
  - Segment type `utils/tracerouteSegments.ts:215-233` already has optional `fromKey/toKey`.
  - `utils/meshcoreTraceSegments.ts` draws key-only links: both ends resolved, candidates ≤ 1.
- **Existing bug (P6) in `server/utils/protocolRows.ts:154-185` `meshcoreTraceToV1`:** `to = last.receiverPublicKey`. For every real Companion trace that is the local node, so the v1 API reports `toNodeId === fromNodeId`. The unit test fixture (`protocolRows.test.ts:71-79`) leaves out the final row into our own radio, so it does not catch this.
- **Position and visibility helpers to reuse:**
  - `buildMeshCorePositionFilter` (`server/utils/positionVisibility.ts:203-236`): presence, plus `nodes:viewOnMap`, plus a private override needing `nodes_private:read`.
  - `loadMeshCoreNodesBySource` (`:169`).
  - `applyMeshCorePositionOverride(s)` and `loadMeshCorePositionOverrides` (`server/utils/meshcorePositionOverride.ts:66-130`).
  - Pattern of one grants load plus both filters: `crossSourceLinkRoutes.ts:136-150`.
- **SNR sentinel edge case:** `UNKNOWN_SNR_SENTINEL = -32` dB (`tracerouteSegments.ts:40`). A real MeshCore reading of q = -128 (-32 dB) would show as "unknown" in the strip. This is cosmetic and accepted.
- **No MeshCore MQTT ingest of traces.** Only `meshcoreManager.storeTraceData` (`:4945`) writes, so `meshcore_mqtt` sources contribute nothing.
- **Latest migration is `224_meshcore_packet_log_derived_fields`.** The next is 225.

## Design

### Shared pieces first
1. **`utils/meshcoreTraceRun.ts` (new, pure, used by server and client types).**
   - Signature: `buildMeshCoreTraceRun(rows: MeshCoreHopSnrRow[], opts: { localPublicKey: string|null; targetPublicKey?: string|null })`.
   - Returns `{ fromKey, toKey, turnaroundKey, reachedTarget, forwardKeys, forwardSnrQ, backKeys, backSnrQ, hops: [{key, hash, candidates}], hashBytes, traceTag, authCode, timestamp, sourceId }`, or `null`.
   - **Hop keys:** a resolved hop is `mc:<pk>`. An unresolved or ambiguous hop is `mch:<hash>`, with its candidate count kept in `hops`. Local is `mc:<localPk>`, or `src:<sourceId>` when the local key is unknown.
   - **Split rule** (structural only, never guesses identity). Pick split index `s`:
     - if `targetPublicKey` resolves to H[t], then `s = t`;
     - else if the hash list is an odd palindrome, `s = (N-1)/2`;
     - else `s = N-1`.
   - **Legs:**
     - forward = `[local, H0..Hs]` with SNR rows `0..s`;
     - back = `[Hs..H(N-1), local]` with rows `s+1..N`. Back is `null` when it is empty.
   - **To:** `toKey` is the target when one is known and present, otherwise H[s]. When a known target is not on the wire (a companion target), set `toKey = mc:<target>`, `turnaroundKey = H[s]`, `reachedTarget = false`.
   - **Also emits Meshtastic-shape fields:** `fromNodeNum/toNodeNum/route/routeBack/snrTowards/snrBack` as JSON with synthetic `nodeNumFromPubkey` numbers (`UNRESOLVED_NODE_NUM`/`BROADCAST_ADDR` for `mch:` hops). This lets `buildTracerouteStripGraph`, `TracerouteCopyLinks` and `decomposeTraceroute` render unchanged (display-only, per P5's identity rule).
   - **v1 fix:** `protocolRows.meshcoreTraceToV1` delegates to this builder, which fixes the `to == from` bug (Q3).
2. **`server/utils/tracerouteExplorerNodes.ts`.**
   - Extract the newest-named / newest-positioned pick into a generic helper.
   - Add `mergeMeshCoreExplorerNodes(rows, wantedKeys)`. Rows are already filtered and override-applied. Output has the same `ExplorerNode` shape plus `nodeKey`, `protocol`, `publicKey?`, `meshcoreType` (advType); `role: null`; `nodeNum` is synthetic; `nodeId` is `mc:<pk>`.
   - Meshtastic entries gain `nodeKey: mt:<n>` and `protocol: 'meshtastic'`.
3. **Wire `ExplorerRunWire`** gains:
   - `protocol: 'meshtastic'|'meshcore'`;
   - optional `fromKey, toKey, routeKeys, routeBackKeys, turnaroundKey, reachedTarget, hopMeta: {key,hash,candidates}[], traceTag, hashBytes, status?: 'answered'|'timeout'|'failed'`.
   - Meshtastic rows do not send keys; the client derives `mt:<n>`. The Meshtastic wire is otherwise unchanged.
4. **`explorerModel.ts` moves to key space.**
   - `ExplorerRun` gets `protocol`, `fromKey/toKey`, `forward/back: string[]|null` (keys), `pairKey = fromKey>toKey`.
   - `filters.nodeNum` becomes `filters.nodeKey: string|null`.
   - `runNodes`, `aggregateLinks` (string keys, sorted), `pathKey`, `pathVariants`, `nodeLabel/nodeLongLabel(nodes: Map<string,…>, key)` all work on keys. Labels: `mt:` uses short name or `!last4`; `mc:` uses name or the first 8 hex; `mch:` shows `?<hash>`.
   - `nodeMatchesSearch` matches `!hex`, the pubkey prefix, and the hash.
   - **Dedupe:**
     - Meshtastic keeps `p:packetId:from:to`.
     - MeshCore uses `mc:<sourceId>:<tag>:<auth>`. Runs never merge across sources, because only initiated traces are included (Q2).
   - **Answered:** a MeshCore run is answered when `status` is answered, or hop rows exist when there is no run log. `transport` is `'rf'`.
   - Meshtastic legs still go through `buildLegHopLinks`, then are mapped to `mt:` keys. MeshCore legs come straight from the wire key arrays.
5. **`ExplorerMap`.**
   - `pos(key)`.
   - Focus segments: Meshtastic keeps `decomposeTraceroute`. MeshCore uses a new `runToKeySegments(run, pos)` in `explorerModel.ts`, which emits `TracerouteRenderSegment` with `fromKey/toKey`, one per consecutive positioned pair, skipping `mch:` ends.
   - The tooltip resolves `seg.fromKey ?? mt:${seg.fromNodeNum}`.
   - The unanswered dashed line uses keys.
6. **`ExplorerDetail`.**
   - The strip and copy links run unchanged on the synthetic wire fields.
   - `devices` are built per run's protocol, so a synthetic-number collision cannot cross protocols. `mch:` hops get meta `{shortName:'?a3', longName:'Unresolved hash a3 (n matches)'}` through a per-run synthetic placeholder.
   - When `reachedTarget === false`, show "Turned at {{turnaround}}; {{target}} does not forward traces".
   - Hide "Pair history" for MeshCore. That modal is Meshtastic-route-bound; the drawer's path variants already cover the pair inside the window.
7. **Report.**
   - Protocol chip per row in `ExplorerTable`.
   - A Protocol segmented filter (All / Meshtastic / MeshCore), shown only when both protocols are present in the window. It is persisted with `filters`.
   - Footer: the retention line adds `meshcoreRetentionDays` (90).

### Server route (`tracerouteRoutes.ts /explorer`)
- After the Meshtastic block, take `mcSources` = permitted ∩ requested sources of type `meshcore` (`isAnyMeshCoreSourceType`, excluding `meshcore_mqtt`, which stores no traces).
- For each MeshCore source, run a new repo reader `getInitiatedTracesForExplorer(sourceId, sinceMs, limitTraces)` that returns `{traces, truncated}`. It reports truncation when either the trace cap (`limit+1`) or the 20,000-row scan cap is hit. Cap: `MESHCORE_EXPLORER_TRACE_LIMIT = 5000` per source. `truncated` ORs into the response.
- The local key comes from `getLocalNodePublicKeysBySource(mcSources)`.
- Build runs with `buildMeshCoreTraceRun`. `id` = the first row id, `packetId: null`, `channel: null`.
- Nodes:
  - collect `mc:` keys from the runs;
  - read `loadMeshCoreNodesBySource(mcSources ∩ nodes:read)`;
  - apply overrides per source with `canViewPrivate = nodes_private:read`;
  - strip lat/lon where `buildMeshCorePositionFilter` (one shared `loadSourcePermissions` result) fails;
  - drop bogus positions;
  - then `mergeMeshCoreExplorerNodes`.
- Merge into the response. `runs` is sorted newest first across protocols. `nodes` holds both kinds.
- Raw `ok()` envelope is unchanged. Meshtastic orientation is untouched: MeshCore rows never pass through `orientTracerouteRows`.

## Mesh impact
- **WP1–WP3: RF none.** One GET is extended and pure helpers are added. No write path, timer or send changes. The route keeps its "Read-only: sends nothing" comment.
- **WP4 (only if Q1 = B):** still **RF none**. It records attempts that already go out, using the same `trace_path` frame, cadence and gating. The manager picks the tag and passes `params.tag`, which the backend uses in place of `Math.random`. That is the same 4 bytes on air; only who chose them changes. A no-transmit pin test asserts the send count is unchanged.

## Security / permissions
- **Runs:** `traceroute:read` on the source. This is the same gate the Explorer and `/hop-snr` already use. MeshCore traces have no channel, so there is no channel mask.
- **Names:** `nodes:read` on the source that holds the `meshcore_nodes` row. Without it the run shows key prefixes only, matching Meshtastic's hex ids.
- **Positions:** `buildMeshCorePositionFilter`, which covers presence, `nodes:viewOnMap`, and a private override needing `nodes_private:read`. Overrides are applied before merging. An anonymous user never gets a position.
- **Cross-source:** node rows are merged only across sources in the caller's selected and permitted set, the same as the Meshtastic merge. No run names another source, and runs never merge across sources, so the two-source read rule does not apply.
- **Validation:** `hours` validation is unchanged. No new params beyond the optional `sources`.
- **Tests:** a user with `traceroute:read` but no `nodes:read` gets no MeshCore names; no `viewOnMap` gives no position; a private override without `nodes_private` is dropped; an unpermitted MeshCore source is absent; anonymous gets nothing.

## Work packages: WP1 → (WP2 ∥ WP3) → WP4 (optional)

**WP1 Shared run builder and v1 fix.**
- Files: `utils/meshcoreTraceRun.ts`, `server/utils/protocolRows.ts` (delegate), `utils/meshcoreNodeNum.ts` (import only).
- Tests in `utils/meshcoreTraceRun.test.ts`:
  - repeater round trip splits at T;
  - companion round trip turns at the last repeater (`reachedTarget=false` when a target is given);
  - direct `[T]`;
  - one-way non-palindrome (`s=N-1`);
  - unresolved and ambiguous hashes become `mch:`;
  - local key unknown;
  - synthetic route JSON uses `UNRESOLVED_NODE_NUM`;
  - SNR arrays per leg.
- Fix `protocolRows.test.ts` to use a realistic final row into local, asserting `to ≠ from` (if Q3 = yes).

**WP2 Server explorer.**
- Files: `server/routes/tracerouteRoutes.ts`, `server/utils/tracerouteExplorerNodes.ts`, `db/repositories/meshcoreHopSnr.ts` (`getInitiatedTracesForExplorer`).
- Tests:
  - `tracerouteRoutes.explorer.meshcore.test.ts` (harness): mixed sources, sort order, truncation, all permission cases above, `meshcore_mqtt` ignored, Meshtastic output byte-identical apart from the added `nodeKey/protocol`;
  - `tracerouteExplorerNodes.test.ts` (MeshCore merge, override, newest-named);
  - repo multi-backend test for the new reader (SQLite/PG/MySQL isolated DBs: grouping, both truncation flags, `initiated` only).
- Existing `tracerouteRoutes.explorer.test.ts` and `tracerouteRoutes.orientation.test.ts` stay green.

**WP3 Client.**
- Files: `explorerModel.ts`, `explorerApi.ts` (types), `ExplorerMap.tsx`, `ExplorerTable.tsx`, `ExplorerDetail.tsx`, `TracerouteExplorerReport.tsx`, `TracerouteExplorer.module.css`, `public/locales/en.json` (flat `analysis.traceroute_explorer.*` keys: protocol filter, turnaround note, unresolved hash, MeshCore retention).
- Tests:
  - `explorerModel.test.ts`: key identity; a Meshtastic node and a MeshCore node with colliding synthetic numbers stay distinct; `aggregateLinks` skips `mch:`; MeshCore dedupe; search by pubkey prefix and hash; protocol filter;
  - `ExplorerMap.test.tsx`: MeshCore focus segments carry `fromKey/toKey`, unpositioned hops are skipped;
  - `TracerouteExplorerReport.test.tsx`: mixed window, protocol chip, filter hidden when only one protocol is present, pair history hidden for MeshCore, turnaround note.
- Every WP: typecheck, lint ratchet, CSS modules + `var(--color-*)`, `UiIcon`, `.js` server imports.

**WP4 Trace attempt log (only if Q1 = B).**
- **Migration `225_add_meshcore_trace_runs`** on all three backends (use the `migration` skill). Register it and bump the count test.
- **Table `meshcore_trace_runs`:**
  - columns: `id, sourceId, traceTag BIGINT, authCode BIGINT, targetPublicKey, pathHex, hashBytes, autoReturn bool, origin ('manual'|'schedule'|'automation'|'api'), status ('pending'|'answered'|'timeout'|'failed'), sentAt BIGINT, completedAt BIGINT null`;
  - indexes `(sourceId, sentAt)` and `(sourceId, traceTag, authCode)`.
- **Repository** `db/repositories/meshcoreTraceRuns.ts`: `insertPending`, `complete`, `getForExplorer`, `deleteOlderThan`, `deleteBySourceId`. Register it in `services/database.ts`.
- **Manager:** `traceContactPathDetailed` gains `origin`.
  - It generates the tag and passes `params.tag` (`meshcoreNativeBackend.ts:2092` uses it when present).
  - It inserts a pending row only once the frame is dispatched. A no-path or disconnected result is not recorded, matching Meshtastic, which records only sent traceroutes.
  - It completes the row on answered, timeout or failed.
  - Callers pass `origin`: `meshcoreContactsRoutes.ts:629`, `v1/actions.ts:150`, `meshActionDeps.ts:296`.
- **Lifecycle:** prune alongside `HOP_SNR_RETENTION_MS` (`meshcoreTraceIngestService.pruneIfDue`); delete on source delete (`sourceRoutes.ts:1827`). On startup, sweep stale `pending` rows older than the max wait to `timeout`.
- **Explorer:** run-log rows in the window become runs. They are joined in code to hop groups by `(tag, auth)`, which supplies `targetPublicKey` to the builder. Timeout and failed runs are unanswered with `fromKey/toKey`. Hop groups with no log row (rows from before the migration, Virtual Node traces) fall back to the structural rule.
- **Tests:**
  - migration on 3 backends;
  - repo multi-backend;
  - manager: answered, timeout and failed outcomes each recorded once; tag passed through; no-transmit pin (send count unchanged);
  - existing `meshcoreTracePath.timeout`/`.autoReturn` tests green;
  - explorer route with timeouts gives a real `answeredPct`;
  - source delete purges the table.
- **CLAUDE.md:** note the table under per-source data.

## Open questions for the maintainer
1. **Record trace attempts (needs migration 225)?** (A) Read-only: MeshCore runs are completed traces only, always "answered", and the pair is local → structural turnaround, so a companion target shows as its last repeater. (B) Add the `meshcore_trace_runs` log (WP4): real destination, timeouts as failed runs, and a true answer rate. **Recommend B**, shipped as WP4 after WP1–3. WP1–3 already work on their own and keep A as the fallback for older rows.
2. **Include overheard traces (`initiated=false`, which is everything from Repeater sources)?** They have no originator, so a run would read "unknown → X". **Recommend initiated only.** Overheard links already show on the Map Analysis traceroute layer and in the Trace SNR history. As a result, Repeater sources contribute no Explorer runs.
3. **Fix v1 `meshcoreTraceToV1` (to == from today) through the shared builder?** This changes the v1 API output for MeshCore traces. **Recommend yes**, with a release note: the current value is wrong for every Companion trace.

## Out of scope
- Re-resolving hashes at read time against current contacts (the "nothing guessed" rule).
- Pair-history modal for MeshCore.
- MeshCore in `/api/traceroutes/recent`, `/history`, and the Meshtastic traceroute-confirmed links layer.
- MeshCore MQTT trace ingest.
- Sending traces from the Explorer.
- Virtual Node app-initiated traces (`tracePathRaw`, not tagged as ours) as initiated runs.
- The SNR -32 dB sentinel collision.
- Cross-source merging of one trace heard by several MeshCore sources.

## Browser check
- Use a throwaway volume. Seed a Companion source with `meshcore_hop_snr` traces: a repeater round trip, a companion round trip, a one-way trace, an ambiguous hash. With WP4, also seed run-log rows including a timeout.
- Seed a Meshtastic source with traceroutes. Check:
  - the mixed table, protocol filter and chip;
  - map links and focus run with keys;
  - the strip for a MeshCore run and the turnaround note;
  - the answer rate.
- As a non-admin without `nodes:read`/`viewOnMap`: no names or positions.
- Network: only `GET /api/traceroutes/explorer`.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/routes/tracerouteRoutes.ts
- /home/yeraze/Development/meshmonitor/src/components/Analysis/tracerouteExplorer/explorerModel.ts
- /home/yeraze/Development/meshmonitor/src/server/utils/tracerouteExplorerNodes.ts
- /home/yeraze/Development/meshmonitor/src/db/repositories/meshcoreHopSnr.ts
- /home/yeraze/Development/meshmonitor/src/server/utils/protocolRows.ts (plus new src/utils/meshcoreTraceRun.ts)
