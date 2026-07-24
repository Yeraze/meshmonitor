# MQTT `ok_to_mqtt` Violation Detection — Epic Plan

**Tracking issue:** #4114
**Status:** Phase 1 in progress
**Branch strategy:** one worktree + PR per phase, branched from `origin/main`.
**Started:** 2026-07-24

## Goal

Surface, in MeshMonitor, when an MQTT-relayed packet's `ok_to_mqtt` bit was violated by the
publishing gateway — i.e. the packet was uplinked by a node **other than its originator**,
despite the originator not having opted in.

Firmware's `MQTT::onSend()` only enforces the bit (`Data.bitfield` bit 0) when relaying other
nodes' packets, and only when `isMqttServerAddressPrivate` is false. That check is a pure
IP-byte test with no NAT/port-forward awareness, so a gateway reaching its broker via a
LAN-literal address that is *also* port-forwarded gets misclassified as "private" and silently
skips the opt-out check for every packet it relays. Given a packet where the bit is off and the
publishing gateway isn't the originator, `isMqttServerAddressPrivate == true` on that gateway is
the only explanation — so this is a **provable, detectable signature**, not a guess.

## Prior art — what issue #4114 already got for free

Design items **1, 2 (partly), and 3** of the issue body were delivered by the **MQTT Packet
Monitor epic (#4124)** — see `MQTT_PACKET_MONITOR_EPIC.md`:

- MQTT *is* wired into the Packet Monitor (`mqtt_packet_log`, migration **121**,
  `mqttPacketLogService.logEnvelope`, `mqttPacketRoutes.ts`, `MqttPacketMonitorView.tsx`).
- Every envelope reaching `ingestServiceEnvelope` is logged **unconditionally, before** the
  decrypt/geo/portnum early returns, with an `ingestOutcome`
  (`ingested | encrypted | ignored | geo-ignored | distance | unsupported-portnum | decode-error`)
  — this satisfies the bulk of @.m.a.t.t.'s 2026-07-14 comment.
- Rows are grouped by packet in the list view with a per-gateway receptions detail modal —
  the issue's item 3.
- Gateway identity is already captured as `gatewayId` / `gatewayNodeNum` from
  `envelope.gatewayId`, so the issue's "derive the gateway from the topic string" trick is
  unnecessary — we have the value directly.

**What remains is the issue's item 4 — the violation flag itself** — plus the gaps below,
found during Stage 0 exploration:

| Gap | Location |
|---|---|
| `mqtt_packet_log` has no `bitfield` / `okToMqtt` / violation column | `src/db/schema/mqttPacketLog.ts` (25 columns, none of them this) |
| Ingest **discards `bitfield`** on server-side decrypt even though `tryDecrypt` returns it | `src/server/mqttIngestion.ts:190-205` vs `channelDecryptionService.ts:350` |
| Bit-evaluation logic exists but is `private` and **uplink-only** | `MqttBridgeManager.evaluateOkToMqtt`, `src/server/mqttBridgeManager.ts:482-499` |
| Raw MQTT `topic` is in scope at both ingest call sites but never passed | `MqttIngestionInput` has no `topic` field (`mqttIngestion.ts:134-146`) |
| Reports area is **cross-source/global** (no `SourceContext`) while `mqtt_packet_log` is per-source | `/reports` route, `src/main.tsx:168-171` |

## Interview decisions (2026-07-24)

1. **Violation rule — tri-state, strict default.** Store `okToMqtt` as **true / false /
   unknown**. A violation is flagged only when the bit is **explicitly 0** *and* the publishing
   gateway is not the originator. An **absent** bitfield is stored as `unknown` and is *not*
   flagged by default — mirroring firmware exactly (absent ⇒ violation) would flag a large
   fraction of all relayed traffic. `unknown` remains reachable via an opt-in toggle
   (see decision 6).
2. **Store the raw `topic`.** Add a `topic` column to `mqtt_packet_log` and thread `topic`
   through `MqttIngestionInput` (already in scope at both call sites — one-line change each).
   Purely diagnostic now that `gatewayId` covers gateway identity, but directly useful for the
   "which nodes is MQTT actually receiving" diagnosis in the issue comment.
3. **Pre-ingest-filter drops: OUT OF SCOPE.** #4124 deliberately excluded copies rejected by
   the topic/node/portnum pre-filter before `ingestServiceEnvelope`. That exclusion stands;
   file a separate issue if the diagnosis gap resurfaces.
4. **Durable violation history.** The packet log is trimmed to 5000 rows / 24h by default, so a
   report reading it directly could only ever show ~a day and would empty on every trim.
   Phase 1 therefore also writes a **retention-immune** violation record with its own, much
   longer retention policy, and the report reads from that.
5. **Report shape — gateway summary + drill-down.** Top table = one row per offending gateway
   (violation count, distinct originators affected, sources, first/last seen), expandable /
   clickable into the underlying violating packets. Answers "which gateway is misbehaving"
   directly.
6. **Report features (all four):** lookback/date-range control, CSV export, column sorting +
   pagination, include-`unknown`-bitfield toggle (off by default).
7. **UI surfaces:** violation **badge in the Packet Monitor list**, a minimal **per-gateway
   marker in the existing detail modal** (so the badge isn't a dead end when a packet has N
   gateways), and the **Reports view** as the search/analysis surface. Not doing: a
   "violations only" toolbar filter, or violation counts in the gateway multi-select.
8. **Report is cross-source.** `/reports` is a global route outside `source/:sourceId/*`, so
   the report aggregates across **all sources the user may read**, via a new endpoint in
   `analysisRoutes.ts` using the existing `resolvePermittedSourceIds(req, 'packetmonitor')`
   (the resource is already a parameter, defaulting to `'nodes'`), with an optional
   `?sources=` CSV filter.

## Architecture facts (Stage 0 exploration)

- **`Data.bitfield` is protobuf field 9** (`protobufs/meshtastic/mesh.proto:1233-1235`,
  `optional uint32`); bit 0 = "user approves upload to MQTT". It **is** present on the loaded
  protobufjs `meshtastic.Data` type (reflected from the .proto by `protobufLoader.ts:20-32`).
- **It is already typed on the ingest shape:** `MeshPacketShape.decoded.bitfield?: number`
  (`src/server/mqttPacketFilter.ts:47`). For **plaintext** MQTT copies it is populated and
  reachable with no changes. For **server-decrypted** copies it is lost at
  `mqttIngestion.ts:190-205`, which synthesizes `packet.decoded` with only
  `{ portnum, payload, emoji, replyId, channelDatabaseId }`.
- **Both decrypt services already return it:** `channelDecryptionService.ts:34-39, 302-315, 350`
  and `pkiDecryptionService.ts:40, 155`.
- **Existing evaluator to extract (not reimplement):** `MqttBridgeManager.evaluateOkToMqtt`
  (`mqttBridgeManager.ts:482-499`) — reads `decoded.bitfield & 0x1`, falls back to
  `channelDecryptionService.tryDecrypt` for encrypted payloads, and is **fail-closed**
  (absent/undecryptable ⇒ `false`). Its only caller is the **uplink** path
  (`:760-767`, gated on `!config.ignoreOkToMqtt`, increments `uplinkOkToMqttDrops`).
  Fail-closed is correct for uplink but **wrong** for detection — hence the tri-state helper.
- **Undecryptable channels are unjudgeable.** Where no `channel_database` PSK matches, the bit
  cannot be read at all; those rows are `unknown` by construction. The default
  `LongFast`/short-PSK channels use the publicly known `defaultpsk` family, so they need no
  real secret.
- **Grouped-list projection is explicit.** `getGroupedPackets`
  (`src/db/repositories/mqttPacketLog.ts:138-171`) selects 18 named aggregates and groups by
  `(sourceId, fromNode, COALESCE(NULLIF(packetId,0), -id))`. A new column **will not reach the
  list view** unless an explicit aggregate is added (e.g. `MAX(okToMqttViolation)`). MySQL
  `ONLY_FULL_GROUP_BY`-safe aggregates are required; MySQL also can't do multi-arg
  `COUNT(DISTINCT …)` (see the comment at `:175`).
- **`getReceptions`** (`:200-214`) is a bare `.select()`, so it returns all columns
  automatically — but the **frontend** `MqttReception` type
  (`src/components/MQTT/mqttPacketTypes.ts:50-59`) exposes only 8 of them and must be extended.
- **Existing badge system to reuse:** `outcomeBadgeClass` +
  `mqpm-badge mqpm-badge-{encrypted|ignored|geo-ignored|distance|error}`
  (`MqttPacketDetailModal.tsx:26-44`, `src/components/MQTT/MqttPacketMonitor.css`).
- **Reports area anatomy:** `/reports` → `ReportsPage.tsx` → `AnalysisTab.tsx`, which is a
  **card grid with component-local `useState` selection** (no URL param, not deep-linkable).
  Adding a report = 3 edits in `AnalysisTab.tsx` (the `AnalysisType` union at `:13`, the
  `reports` registry array at `:26-45`, an early-return render block cloned from `:62-75`) plus
  the new component. Outer chrome in `ReportsPage.tsx:24-33` needs no change.
- **Report templates:** shape/fetch from `NodeInfoEnrichmentReport.tsx` (TanStack `useQuery` +
  `api.get`, **explicitly returning `body.data`** because `ApiService` does not unwrap the
  envelope); deferred-run pattern from `SolarMonitoringReport.tsx:110-121, 167-184`;
  filters/pagination/CSV mechanics from `AuditLogTab.tsx:52-62, 130-194`. Prefer the existing
  CSV helpers `escapeCsvField` / `downloadTextFile` in `src/utils/nodeExport.ts:123, 207-212`
  over hand-rolling a Blob.
- **`.reports-*` global classes** in `src/styles/analysis-reports.css` cover the shared chrome
  (stats row, panel, controls, table, banners, buttons, pills). Reuse those; put genuinely new
  report-specific styling in a `*.module.css` per CLAUDE.md, not appended to the global sheet.
- **Permissions:** there is no `analysis`/`reports` resource. `packetmonitor` is in
  `SOURCEY_RESOURCES` (`src/server/constants/permissions.ts:7-14`), so every check needs a
  `sourceId`. Cross-source precedent: `unifiedRoutes.ts:988, 1113`.
- **Raw `fetch()` is lint-banned** in `src/components/**` and `src/pages/**` — use `ApiService`
  or a TanStack hook. `MqttPacketMonitorView.tsx` uses `useCsrfFetch` (a baselined legacy
  site); do not copy that part into new code.
- **Next migration number: 128** (highest registered is 127, `add_atak_contacts`,
  `src/db/migrations.ts:2015-2023`). `migrations.test.ts` asserts contiguity and all three
  dialects, but hardcodes no total.
- **Settings keys** must be added to `VALID_SETTINGS_KEYS`
  (`src/server/constants/settings.ts`) or they silently fail to save.
- **Stale comment to fix in passing:** the `ingestOutcome` doc comment at
  `src/db/schema/mqttPacketLog.ts:53` omits `'distance'`, which both the repo type
  (`repositories/mqttPacketLog.ts:20`) and `mapOutcome`
  (`mqttPacketLogService.ts:167-168`) emit.

## Phases

### Phase 1 — Backend: bitfield capture, violation detection, durable history  [x]

Branch: `feature/mqtt-oktomqtt-violations` (worktree `../meshmonitor-mqtt-violations`).

Deliverables:
- Shared tri-state `ok_to_mqtt` evaluator extracted from
  `MqttBridgeManager.evaluateOkToMqtt`, returning `true | false | unknown`, with
  `MqttBridgeManager` refactored to consume it while **preserving its fail-closed uplink
  semantics** (`unknown ⇒ don't uplink`).
- `bitfield` preserved through the server-side decrypt path in `mqttIngestion.ts:190-205`.
- `topic` threaded through `MqttIngestionInput` and passed at both call sites
  (`mqttBrokerManager.handlePublish`, `mqttBridgeManager.handleDownlink`).
- Migration **128**, idempotent across SQLite/PG/MySQL: `topic`, `okToMqtt` (tri-state),
  and a violation flag on `mqtt_packet_log`; plus a **retention-immune violations table**
  with its own longer-retention settings.
- Violation computed at row-build time in `mqttPacketLogService` (explicit bit=0 **and**
  `gatewayNodeNum != fromNode`), written to both the packet log and the durable table.
- Repository: violation aggregate (per-gateway summary) + drill-down queries, and the
  violation flag added to the `getGroupedPackets` projection so the Phase 2 badge can reach
  the list view. MySQL `ONLY_FULL_GROUP_BY`-safe.
- Cross-source endpoints in `analysisRoutes.ts` via
  `resolvePermittedSourceIds(req, 'packetmonitor')`, supporting lookback, `includeUnknown`,
  sort, and limit/offset. `ok`/`fail` envelope.
- New settings keys registered in `VALID_SETTINGS_KEYS`.
- Tests: migration idempotency; evaluator unit tests (incl. the tri-state/fail-closed
  distinction); bitfield-preservation through server decrypt; violation-computation
  (originator-self-publish must NOT flag); repository aggregates + a
  `*.perSource.test.ts` isolation test; route tests via `createRouteTestApp`.

Exit criteria: full Vitest suite green (`success: true` via `--reporter=json`), `lint:ci`
green (in-repo failures only), typecheck green, PR merged. No user-visible change yet.

### Phase 2 — Packet Monitor UI: violation badge + detail modal marker  [x]

Deliverables:
- Violation badge on grouped rows in `MqttPacketMonitorView.tsx`, reusing the existing
  `mqpm-badge` system.
- Violation row in the packet section of `MqttPacketDetailModal.tsx` **plus** a per-gateway
  violation column in the receptions table, extending `MqttReception` in
  `mqttPacketTypes.ts`.
- `mqtt.packets.*` i18n keys in `public/locales/en.json` (en only — the other locales have
  none of this namespace and rely on the inline English defaults).
- Component tests extending the existing `MqttPacketMonitorView.test.tsx` /
  `MqttPacketDetailModal.test.tsx`.
- Browser validation against a live MQTT source via dev-container deploy + chrome-devtools.

Exit criteria: UI validated in the browser, suite/lint/typecheck/CI green, PR merged.

### Phase 3 — Reports: `ok_to_mqtt` gateway violation report  [ ]

Deliverables:
- New report component under `src/components/Analysis/`, registered in `AnalysisTab.tsx`
  (union member + registry entry + render block).
- Gateway summary table (violation count, distinct originators affected, sources, first/last
  seen) with drill-down to the underlying violating packets.
- Lookback/date-range control using the deferred-run pattern (no expensive scan on mount);
  CSV export via `escapeCsvField`/`downloadTextFile`; sortable columns + pagination;
  include-`unknown`-bitfield toggle, off by default.
- TanStack `useQuery` + `ApiService` (raw `fetch()` is lint-banned here), unwrapping
  `body.data` explicitly.
- i18n keys; reuse `.reports-*` chrome, new styling in a CSS module.
- Tests; browser validation of the report end-to-end.

Exit criteria: report validated in the browser against real data, suite/lint/typecheck/CI
green, PR merged, issue #4114 closed.

**Inherited from Phase 2 — do these in Phase 3:**
1. **Extend the capture-off note to point at the report.** Phase 2 deliberately did not name the
   Reports view, because it did not exist yet. Once the report ships, extend
   `mqtt.packets.violationsStillRecorded` to end with "…they are listed in Reports →
   ok_to_mqtt violations." One locale edit plus the matching inline `t()` defaults.
2. **`suspectedAvailable` does not mean what its name suggests.** Verified live: it is `false`
   whenever `includeUnknown` is not requested, because the packet-log path is deliberately not
   executed at all — it does **not** mean "the packet log is disabled". Only when
   `includeUnknown=true` does it report the real availability. The report must not render
   "suspected data unavailable" off the default-params response.
3. **Reuse `okToMqttState()` / `MqttOkToMqttMarker`** (`src/components/MQTT/`) rather than
   re-deriving the four states, and in particular never recompute `relayed` client-side.
   Note the fourth state is named `optedOut`, not `self`.
4. **The report reads `body.data`** — `ApiService.request()` does not unwrap the envelope.

## Deviations / notes

### Phase 2 (2026-07-24)

Spec: `MQTT_OK_TO_MQTT_PHASE2_SPEC.md`. Three work packages (WP1 primitives → WP2 badge ∥ WP3
modal), plus one browser-found fix. Frontend only — **zero backend files touched**, which was
the phase boundary and it held.

**Corrections to earlier assumptions (both found during Phase 2, both matter):**

1. **The state is FOUR-valued, not tri-state.** Phase 1's spec and this epic both described it as
   tri-state. But `okToMqttViolation === 0` with the bit *explicitly clear* is reachable and
   distinct from both "allowed" and "unknown" — it means the sender opted out but no third-party
   relay could be attributed. Per Phase 1 §2(f) that covers self-publish (rows 2/4/15), malformed
   or absent `gatewayId` (rows 8/9), and missing `fromNode` (row 10). Rendering it as "allowed"
   would have been factually wrong on screen. Named **`optedOut`** (not `self`, which would imply
   only the self-publish sub-case).
2. **`MqttPacketMonitorView.tsx` was never a baselined `fetch` violation.** The epic previously
   claimed it was a "baselined legacy `useCsrfFetch` site". `eslint-baseline.json` has **no entry**
   for either edited component, and the lint selector targets `fetch(...)`, not `csrfFetch(...)`.
   The practical consequence is the opposite of what was assumed: these files have **zero baseline
   headroom**, so any new `no-explicit-any` / `exhaustive-deps` violation fails `lint:ci` outright.

**Design decisions worth remembering:**

- **Only `violation` is badged.** `unknown` is the majority state wherever MeshMonitor lacks a
  channel PSK (measured: 258 of 500 sampled live packets), so badging it would drown the real
  signal. The grouped list renders violations only; the full four-state readout is modal-only.
- **The grouped-row badge means "at least one gateway violated"** (`MAX()` over receptions), not
  "all did" and not "this one did" — the tooltip says so and points at the modal.
- Styling extends the co-located `MqttPacketMonitor.css` (`mqpm-*`), not a CSS module: it is not
  one of the frozen `src/styles/` sheets, a module cannot extend `.mqpm-badge` without duplicating
  it, and the tree still contains exactly one `*.module.css`.
- No `SettingsTab` field and no new `VALID_SETTINGS_KEYS` entry, so the
  `server.settings-persistence.test.ts` allowlist trap (Phase 1 note 4) was avoided by
  construction.

**Browser validation (live dev container, real Florida MQTT source):**

- **The feature detects real violations in production traffic** — 13 of 500 sampled packets, and
  7 offending gateways in the durable table, the worst with 22 confirmed violations seen across
  all three MQTT sources. No staged data was needed; the spec's test-only SQLite staging path
  (§5.4) went unused.
- Per-gateway attribution verified on a genuinely **mixed** packet (`4014764407`): 4 gateways
  badged `violation`, 1 rendering `unknown`, each with the correct distinct tooltip.
- Phase 1's WP5 `sourceIds` fix confirmed live (gateways aggregating across 3 sources).
- **Defect found only by looking at it:** the new 7th column overflowed the modal by ~78 px with
  `overflow-x: visible`, rendering as "ok_to_m…" / "⚠ vio…". jsdom has no layout, so every
  component test passed. Fixed by wrapping the receptions table in
  `.mqpm-recv-table-wrap { overflow-x: auto }` (commit `38b9b8af`), re-verified in-browser at
  desktop and 390×844 mobile, with the modal/page still never scrolling horizontally.
  **Lesson: a new table column is a layout change, and layout changes need a browser.**

**Validation gap, deliberate:** the capture-off availability note was **not** browser-verified.
`mqtt_packet_log_enabled` is global, so toggling it off would have interrupted capture on a live
system carrying real traffic. It is covered by two component tests and the string was confirmed
present in the served bundle.

### Phase 1 (2026-07-24)

Spec: `MQTT_OK_TO_MQTT_PHASE1_SPEC.md`. Implemented as six work packages
(WP1 schema/migration ∥ WP2 evaluator → WP3 repository → WP4 ingest ∥ WP5 routes → WP6
verification). Migration number is **128**.

**Things later phases must know:**

1. **Forward-only — no backfill is possible.** The `ok_to_mqtt` bit was never stored before this
   phase, so historical `mqtt_packet_log` rows cannot be classified retroactively (a backfill
   could only write a guessed value). Both endpoints return empty until new MQTT traffic arrives
   after the upgrade. Pre-migration rows read as `bitfield IS NULL` = "suspected" until the
   packet log's own 24 h retention flushes them.
2. **Cross-phase availability asymmetry — Phase 2 must surface this.** The durable violation
   write is **default ON**, so the Phase 3 report works out of the box. But the Phase 2 badge
   reads `mqtt_packet_log`, which is **opt-in and default OFF**. On a default install the report
   has data while the badge never appears. Phase 2's empty state must explain the packet-monitor
   opt-in rather than implying "no violations".
3. **`includeUnknown` has a much shorter horizon — Phase 3 must surface this.** Confirmed
   violations come from the durable table (90 d). "Suspected" rows (unreadable bit) are read from
   `mqtt_packet_log`, so they are bounded by its ~24 h retention *and* require
   `mqtt_packet_log_enabled`. The endpoints return `suspectedAvailable` and `suspectedWindowMs`
   precisely so the UI can say so. When `includeUnknown` is false (default) the packet-log query
   is not executed at all.
4. **`SERVER_ONLY_SETTINGS` trap.** There is no production `SERVER_ONLY_SETTINGS` constant — it
   is a local allowlist inside `server.settings-persistence.test.ts` that guards only the keys
   `SettingsTab` sends. Phase 1 added no SettingsTab field, so no edit was needed. **If Phase 2
   or 3 adds a UI toggle for any of the three new keys, that test fails** unless the key is
   either loaded by `SettingsContext` or added to that allowlist.
5. **Kill-switch convention is inverted, deliberately.** `mqtt_oktomqtt_violation_log_enabled` is
   `'0'` ⇒ off, anything else *including unset* ⇒ on — unlike `mqtt_packet_log_enabled`
   (`=== '1'`). Required so the feature works on installs that never touched settings. Commented
   at both the constant and the getter.
6. **Dedupe cannot cover `packetId` 0/NULL.** The unique index is
   `(sourceId, packetId, fromNode, gatewayNodeNum)`, and `NULL != NULL` on all three dialects.
   Real mesh packets essentially always carry a nonzero id; same accepted edge already documented
   for `getReceptions`.

**Deviations from the spec as approved:**

- **Self-echo guard added during the spec review** (spec §2(f.1)). The original spec asserted
  MeshMonitor's own republished packets "never reach ingest". Verification showed the mechanism
  was different than claimed and not airtight: `matchesEcho` matches on *exact topic-string
  equality plus packetId*, recorded under the post-rewrite topic, with a 60 s TTL in a 256-entry
  ring that evicts oldest-first — missable on broker topic rewrite, delayed redelivery, or
  eviction under load — and `mqttBrokerManager.handlePublish` has **no** echo suppression at all.
  What actually protects us is that `handleUplink` republishes the payload byte-for-byte and
  rewrites only the topic, so `gatewayId` is never mutated and a missed echo still carries the
  *original* gateway's id. Because that is an implicit property rather than a guarantee, an
  explicit `selfGateway` guard was added (`detectOkToMqttViolation(envelope, localGatewayNodeNum)`,
  threaded via `MqttIngestionInput`), plus a test pinning the byte-for-byte property so a future
  change to the uplink path fails visibly instead of silently producing false accusations.
- **`migrate-db` table list updated** (`src/cli/migrationTables.ts`) — not anticipated by the
  spec, caught by `migrationTables.test.ts` only in the full-suite run. Without it, a user
  migrating SQLite → PostgreSQL/MySQL would have silently lost all recorded violations. The table
  is deliberately migrated (not skipped like the transient packet logs) because it is
  long-retention history.
- **Suspected-violation queries live on `MqttPacketLogRepository`**, not the violations
  repository, since they read `mqtt_packet_log`.
- WP5 calls `databaseService.*` repositories directly from the route handlers (the pattern
  `analysisRoutes.ts` already uses) rather than depending on `mqttPacketLogService` pass-throughs,
  which is what allowed WP4 and WP5 to run in parallel.

**Verification performed:**

- Full Vitest suite with PostgreSQL (`:5433`) and MySQL (`:3307`) containers up — confirmed the
  multi-backend suites actually executed (`nodes.test.ts` ran 52 PG + 56 MySQL tests) rather than
  skipping silently, and confirmed `success: true` from the JSON reporter, not the summary line.
- `tsc --noEmit` clean; `lint:ci` clean (no in-repo `FAIL`); no `eslint-baseline.json` rule count
  grew.
- **Migration 128 executed against live PostgreSQL 16 and MySQL 8.4**, beyond the spec's
  mock-client assertions: DDL applies, is idempotent on re-run, creates all 15 columns and all 3
  indexes on both, the UNIQUE dedupe index rejects duplicates, and the repository's
  `onConflictDoNothing` / `onDuplicateKeyUpdate` forms are true no-ops. Worth repeating for any
  future migration — the repo's migration tests otherwise only assert against mocks, so real
  dialect syntax is not covered by CI.
