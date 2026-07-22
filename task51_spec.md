# Task 5.1 + 5.2 Spec — DataContext→TanStack remnants + context-value memoization

**Epic:** #3962 Phase 5 (frontend consolidation)
**Branch:** `feature/3962-p51-datacontext-memo` (worktree `meshmonitor-3962-p41`, base origin/main)
**Deliverable of this doc:** written spec only. No feature code.

---

## 0. Census verdict (plan claim vs. reality)

### 5.1 — the premise is WRONG. 5.1 is only *partially* done, not "largely resolved."

The brief flagged that DataContext.tsx being 123 lines might mean the dual-source-of-truth
is already resolved. **It is not.** DataContext.tsx is 123 lines because it is a *pure state
container* — ~18 `useState` pairs and a 30-field inline provider value, with zero logic. The
"useState copies vs. usePoll cache" dual source of truth is **fully live**:

- `DataContext` still holds live `useState` copies of `nodes`, `channels`, `messages`,
  `channelMessages`, `connectionStatus`, `deviceInfo`, `deviceConfig`, `currentNodeId`,
  `nodeAddress`, `nodesWithTelemetry`, `nodesWithWeatherTelemetry`,
  `nodesWithEstimatedPosition`, `nodesWithPKC`, plus 4 pagination maps.
- `App.tsx` is the hub: it calls `usePoll(...)` (L417) **and** `useData()` (L410), then a large
  poll-processing effect (L2280–2590) *copies* the poll payload into DataContext state —
  `setNodes(data.nodes)` (L2306/2308, with a merge branch), `setChannels(data.channels)`
  (L2579), `setMessages(...)` merge (L2436), `setNodesWithTelemetry(new Set(...))` etc.
  (L2571–2574). So poll cache → App effect → DataContext `useState` → consumers. Classic
  dual write.
- Meanwhile `useServerData.ts` selectors (`useNodes`, `useChannels`, `useConnectionStatus`,
  `useTelemetryNodes`, `useUnreadCountsFromPoll`, + `getNodesFromCache`/`getChannelsFromCache`
  cache-peek helpers) **already exist** and **8 files already consume them** directly from the
  cache (`NodesTab`, `MessagesTab`, `ChannelsTab`, `NodeFilterPopup`, `NodeDetailsBlock`,
  `PacketMonitorPanel`, `MQTT/MqttPacketMonitorView`, and `useProcessedNodes`). So a partial
  migration landed in earlier phases; the *remaining* half (delete the context copies, repoint
  App's internal consumers) did not.

**DataContext direct consumers are few (6 files via `useData()`):** `App.tsx`,
`AutoTimeSyncSection`, `FirmwareUpdateSection`, `AutoHeapManagementSection`,
`PacketMonitorPage` (+ `useServerData.ts` only imports types). Most components get nodes/
messages/channels *by prop-drilling from App.tsx*, not from the context — which is why full
deletion of the context copies is entangled with App.tsx's god-component structure.

### Premise correction #1 — MeshCore does NOT complicate DataContext.
The ~30 `setNodes(...)`/`setMessages(...)` call sites in
`src/components/MeshCore/hooks/useMeshCore.ts` write to **local** `useState`
(`const [nodes, setNodes] = useState<MeshCoreNode[]>([])` at L365, messages at L367), **not**
DataContext. The grep for setters is noisy; the only files that touch *DataContext* setters are
App.tsx (+ a handful of `setChannels`/`setConnectionStatus` in config components that also turn
out to be local `useState`). This removes the biggest risk I anticipated: deleting
DataContext.nodes/messages will not break MeshCore.

### Premise correction #2 — `useTelemetry` interval folding is ALREADY DONE.
The plan bullet says "fold `useTelemetry`/`useVersionCheck` hand-rolled setIntervals into
`refetchInterval`." `src/hooks/useTelemetry.ts` **already** uses TanStack `refetchInterval`
(L110/177/234/287; header comment "Replaces manual setInterval polling"). No work remains for
useTelemetry. Only the **version check** half is outstanding.

### Premise correction #3 — the live version-check is inline in App.tsx; `useVersionCheck.ts` is DEAD.
`src/hooks/useVersionCheck.ts` (hand-rolled `setInterval` L77 + **raw `fetch()`**) is imported
**nowhere** (`grep useVersionCheck` in non-test src = empty). It also carries a test
(`useVersionCheck.test.ts`). The *live* implementation is a duplicated inline `useEffect` in
`App.tsx` (~L1278–1325): `api.get('/api/version/check')` (already ApiService, not raw fetch) on
a hand-rolled `setInterval(checkForUpdates, 4*60*60*1000)`, feeding local `useState`
(`updateAvailable`, `latestVersion`, `releaseUrl`, `deploymentMethod`). This inline effect is
the real target for `refetchInterval` conversion.

### 5.2 — every context provider value is UNMEMOIZED. Clean, real win.

| Context | value form | line | setter identity | Notes |
|---|---|---|---|---|
| DataContext | inline `value={{…30 fields}}` | ~L87 | raw `useState` setters (stable) | pure win; deps = state values only |
| MessagingContext | inline `value={{…}}` | L130 | mixed (`useCallback` present) | verify all setters stable |
| UIContext | inline `value={{…}}` | L134 | mixed | consumers heavy (tab/sort/filter) |
| AutomationContext | inline `value={{…}}` | L256 | mixed | |
| MapContext | inline `value={{…}}` | L407 | setters already `useCallback` ✓ | 14 exhaustive-deps in baseline — careful |
| SettingsContext | `const value = {…}` plain | L1677 | mixed | huge; many consumers; biggest win |
| SourceContext | inline `value={{ sourceId, sourceName, sourceType }}` | L35 | n/a (values) | trivial 3-dep memo |
| SaveBarContext | inline `value={{…}}` | L63 | `useCallback` ✓ | |
| AuthContext | `const value = {…}` plain | L314 | `useCallback` ✓ | already has a `useMemo` for boundHasPermission |
| CsrfContext | `const value = {…}` plain | L84 | `useCallback` ✓ | |
| IconStyleContext | `value={value}` (prop) | L8 | n/a | already stable (memoized upstream); **skip** |

All 10 (excluding IconStyleContext) rebuild the value object every render → every consumer
re-renders on the 1-second poll tick. This is the phase's core cheap-win.

---

## 1. Scope decision (honest, given "small phase")

**IN scope (this ONE PR):**
- **5.2 in full** — memoize all 10 provider values with `useMemo` + confirm stable setter identities.
- **5.1 interval folding** — convert the live App.tsx inline version-check effect to a TanStack
  query hook with `refetchInterval`; delete the dead `useVersionCheck.ts` + rewrite its test as
  the new hook's test (or delete + add new test file).
- **5.1 low-risk pure-mirror migration** — migrate the four telemetry-Set mirrors
  (`nodesWithTelemetry`/`Weather`/`EstimatedPosition`/`PKC`) off DataContext onto the existing
  `useTelemetryNodes()` selector, **iff** the consumer audit (Work Item C) shows a small, safe
  consumer set. If it balloons, defer with the rest.

**DEFERRED to 5.4 (App.tsx dissolution) — state this explicitly in the PR body:**
- Deleting `DataContext.nodes` / `channels` / `messages` / `channelMessages` /
  `connectionStatus` and repointing consumers. Rationale: these are not pure cache mirrors —
  `messages`/`channelMessages` carry optimistic-send merge + dedup + infinite-scroll pagination
  state; `connectionStatus` is a client-side state machine (`rebooting`/`connecting`/
  `configuring`/`user-disconnected`) not present in the poll payload; `nodes`/`channels` are
  written through App's merge logic and reach components via App prop-drilling. Untangling that
  prop-drilling *is* the 5.4 work ("dissolve App.tsx, one tab per PR"). Doing it here would
  duplicate that churn and carry high regression risk for a phase the epic marks "small."
- The pagination maps (`channelHasMore`/`LoadingMore`, `dmHasMore`/`LoadingMore`) are pure
  client UI state — they stay in a context regardless; not a dual-source problem.
- Other App.tsx `setInterval`s (neighbor-info L1352, L1892/L1932/L1951 refresh loops) — not
  named by the plan bullet (telemetry/version only). Note as known stragglers; out of scope.

This keeps the PR to "memoize + one clean hook conversion + optional small selector swap" =
genuinely small, matching the epic's expectation, while being honest that the headline
"finish DataContext→TanStack" is a 5.4-sized job.

---

## 2. Work items (file-by-file)

### Work Item A — Version-check → TanStack query hook (5.1 interval fold)

1. **Rewrite `src/hooks/useVersionCheck.ts`** as a real query hook (replacing the dead
   raw-fetch/setInterval version):
   - `queryKey: ['version-check']`; `queryFn` calls `api.get<{updateAvailable, currentVersion,
     latestVersion, releaseUrl, deploymentMethod}>('/api/version/check')` (use `ApiService`, not
     raw fetch — raw-fetch ban).
   - `refetchInterval: VERSION_CHECK_INTERVAL_MS` (keep the exported 4h constant),
     `refetchIntervalInBackground: false`, generous `staleTime`.
   - 404 handling: on `ApiError.status === 404`, disable further polling
     (`refetchInterval: false` via a function form reading the last error, or `retry: false` +
     `enabled` gate) — preserve the "version checking disabled server-side stops polling"
     behavior.
   - Return `{ updateAvailable, latestVersion, releaseUrl, deploymentMethod, dismissUpdate }`.
     `dismissUpdate` sets a local `useState` flag that suppresses the banner without clearing the
     query (so the query result and the dismiss flag are OR-combined for the returned
     `updateAvailable`).
2. **`src/App.tsx`** — delete the inline `useEffect` (~L1278–1325) and its local `useState`
   (`updateAvailable`, `latestVersion`, `releaseUrl`, `deploymentMethod`, and the
   `setLatest*`/`setReleaseUrl`/`setDeploymentMethod`/`setUpdateAvailable` setters). Replace with
   `const { updateAvailable, latestVersion, releaseUrl, deploymentMethod, dismissUpdate } =
   useVersionCheck(baseUrl)`. Wire `dismissUpdate` to wherever the banner's dismiss currently
   calls `setUpdateAvailable(false)`.
   - This removes one `setInterval` + one raw-ish effect from App.tsx and one baseline
     `exhaustive-deps` entry may drop (App.tsx currently 20). Re-run `lint:baseline` only if the
     count *drops* (allowed); never if it rises.
3. **`src/hooks/useVersionCheck.test.ts`** — rewrite to test the new hook with a
   `QueryClientProvider` wrapper + mocked `ApiService`/`fetch`: asserts (a) `updateAvailable`
   reflects payload, (b) 404 stops polling, (c) `dismissUpdate` suppresses the banner. Mirror the
   pattern in `useTelemetry.test.ts`/`usePoll.test.ts`.

### Work Item B — Memoize all provider values (5.2)

For each context below, wrap the value object in `useMemo` with an **explicit, exhaustive** dep
array (every state value + every setter/callback referenced). Raw `useState` dispatchers are
identity-stable by React guarantee — list them in deps for exhaustive-deps compliance; they
never change so they don't defeat the memo.

- **`src/contexts/DataContext.tsx`** (~L87): `const value = useMemo<DataContextType>(() =>
  ({ …all 30 fields }), [nodes, channels, connectionStatus, messages, channelMessages,
  deviceInfo, deviceConfig, currentNodeId, nodeAddress, nodesWithTelemetry,
  nodesWithWeatherTelemetry, nodesWithEstimatedPosition, nodesWithPKC, channelHasMore,
  channelLoadingMore, dmHasMore, dmLoadingMore /* + the setters */])`. Setters are stable →
  including them is harmless. (Note: the 6 baselined `no-explicit-any` here are the `deviceInfo:
  any`/`deviceConfig: any` types — do not touch; unrelated to the memo.)
- **`src/contexts/MessagingContext.tsx`** (L130): same treatment; verify `openDmWithDraft`/
  `fetchUnreadCounts`/`markMessagesAsRead` are already `useCallback` (they are) so they're stable
  deps.
- **`src/contexts/UIContext.tsx`** (L134): memoize; audit that tab/sort/filter setters are stable
  (wrap any bare inline setters in `useCallback` if found).
- **`src/contexts/AutomationContext.tsx`** (L256): memoize; wrap any non-stable callbacks.
- **`src/contexts/MapContext.tsx`** (L407): setters already `useCallback` — just wrap value in
  `useMemo`. **CAUTION:** file has 14 baselined `exhaustive-deps`; do NOT touch existing effect
  dep arrays. Adding a fresh `useMemo` with a correct dep array introduces zero new violations.
- **`src/contexts/SettingsContext.tsx`** (L1677): the big one. Change `const value = {…}` to
  `useMemo`. Dep array is large — enumerate every field. Verify setters are stable; wrap any bare
  ones in `useCallback` (report if this is impractical — SettingsContext has 1 baselined
  exhaustive-deps + 8 only-export-components; keep both counts flat).
- **`src/contexts/SourceContext.tsx`** (L35): `useMemo(() => ({ sourceId, sourceName,
  sourceType }), [sourceId, sourceName, sourceType])`. Trivial.
- **`src/contexts/SaveBarContext.tsx`** (L63): memoize; setters already `useCallback`.
- **`src/contexts/AuthContext.tsx`** (L314): change `const value = {…}` → `useMemo`; setters are
  `useCallback`; it already memoizes `boundHasPermission`.
- **`src/contexts/CsrfContext.tsx`** (L84): change `const value = {…}` → `useMemo`; setters
  `useCallback`.
- **`src/contexts/IconStyleContext.tsx`**: **skip** — value is a prop already stable upstream.

### Work Item C — Telemetry-Set selector migration (5.1, conditional)

1. Audit consumers of `nodesWithTelemetry`/`nodesWithWeatherTelemetry`/
   `nodesWithEstimatedPosition`/`nodesWithPKC` (they are read via `useData()` in App + prop-
   drilled). If the read sites are ≤ a handful and don't cross the App-prop boundary in a
   tangled way, repoint them at `useTelemetryNodes()` from `useServerData.ts` and delete the four
   `useState` + their four `setNodesWith*` writes in App's poll effect (L2571–2574) and the four
   context fields.
2. **If the audit shows the Sets are prop-drilled deep into the node list/map rendering,**
   DEFER to 5.4 with the rest and drop this work item — say so in the PR. Do not force it.

---

## 3. Lint plan (net-zero; exhaustive-deps per-site)

- **`react-hooks/exhaustive-deps` is an ERROR frozen by baseline** (App.tsx 20, MapContext 14,
  SettingsContext 1). **No blanket auto-fix.** Every new `useMemo` must ship a *hand-written,
  correct* dep array so it adds zero violations. Do NOT run any autofixer over these files.
- Adding a correct `useMemo` does **not** touch existing effect dep arrays, so the 14/20/1 counts
  stay flat. Verify with `npm run lint:ci` (the ratchet gate) — must exit 0.
- If Work Item A drops App.tsx's exhaustive-deps count (removing the inline effect), that is a
  *shrink* — regenerate with `npm run lint:baseline` and commit the smaller baseline. Never a
  growth.
- Raw-fetch ban: the new `useVersionCheck` must use `ApiService`, keeping the raw-fetch baseline
  flat/shrinking (the dead hook's raw `fetch` disappears).
- `no-explicit-any` and `react-refresh/only-export-components` baselines for these files must
  stay flat — the memo work touches neither.
- After edits, per CLAUDE.md: verify any callback that gained/lost a dependency still has correct
  `async` and behavior; memoization must not change observable behavior.

---

## 4. Test plan

**Existing tests that pin behavior (must stay green, minimal/no edits):**
- `src/contexts/DataContext.test.tsx`, `MapContext.test.tsx`, `MessagingContext.test.tsx`,
  `SettingsContext.test.tsx`, `UIContext.test.tsx`, `AuthContext.test.tsx` — these assert the
  provider supplies values and `useX must be used within Provider` throws. Memoization is
  transparent to them; expect zero edits. Run all to confirm.
- `src/hooks/usePoll.test.ts`, `useServerData.test.ts`, `useTelemetry.test.ts` — unaffected;
  run to confirm the version-check change didn't disturb the query layer.
- `src/hooks/useVersionCheck.test.ts` — **must be rewritten** for the new query hook (Work Item A).

**New tests (keep minimal — only where the assertion is the whole point):**
- **One referential-stability test** for the memoization win (pick DataContext or SettingsContext
  as representative): render the provider, capture the context value ref, trigger an unrelated
  parent re-render with identical inputs, assert `Object.is(prev, next)` on the value. This
  directly encodes 5.2's purpose. Do **not** write render-count tests for all 10 (flaky,
  low-value) — one representative identity test suffices.
- If Work Item C lands: extend an existing selector/DataContext test to assert the telemetry Sets
  now come from the poll cache, not context.

**Full suite:** run the entire Vitest suite (0 failures) before PR — not just targeted files
(CLAUDE.md rule). Confirm via `--reporter=json` `success=true`, not the rtk summary line
(rtk summary masks suite-collection failures).

**Browser validation (Stage 5 — this PR touches UI plumbing):** deploy the dev container
(`docker-compose.dev.yml` + copy `docker-compose.dev.local.yml` for ttyUSB) and drive at
`http://localhost:8080`. Exercise:
1. **Poll updates** — nodes/channels/telemetry badges update live on the 1s cycle (memoization
   must not freeze updates).
2. **Message flow** — send a test message on the `gauntlet` channel (never Primary); confirm
   optimistic send + reconciliation still works (messages state untouched by this PR, but it's
   the highest-risk regression surface if a memo dep is wrong).
3. **Settings save** — change a setting, save, reload; confirm persistence (SettingsContext memo).
4. **Source switching** — switch sources; confirm SourceContext memo doesn't stick stale
   `sourceId`/`sourceName`.
5. **Version banner** — if a version-check response is mockable, confirm the update banner still
   renders + dismiss works (Work Item A).
   Use a real-mouse / isolated-context drive (per memory: synthetic dispatchEvent hides bugs).

---

## 5. PR shape

**ONE PR** (`feature/3962-p51-datacontext-memo`), titled e.g.
`refactor(frontend): memoize context provider values + fold version-check into TanStack (#3962 Phase 5.1/5.2)`.

PR body MUST state the premise corrections explicitly:
- 5.1's headline (delete DataContext nodes/channels/messages copies) is **deferred to 5.4**
  (App.tsx dissolution) because those are not pure cache mirrors and are entangled with App
  prop-drilling; this PR does the *bounded* 5.1 remnants (version-check interval fold, dead-hook
  deletion, optional telemetry-Set selector swap).
- `useTelemetry` interval fold was already complete (no work).
- All 10 provider values were unmemoized; this PR memoizes them.

**Split only if census surprises during implementation:** if Work Item C (telemetry Sets) turns
out to require deep App untangling, drop it from this PR (defer to 5.4) rather than splitting —
keeps this a single clean PR. The memoization (B) + version-check (A) are independent and small
enough to co-ship.

Update the Phase 5 checklist in `docs/internal/dev-notes/REMEDIATION_EPIC.md`: mark 5.1
partially done (interval fold + memo landed; full DataContext state deletion moved under 5.4) and
5.2 done.
