# MQTT `ok_to_mqtt` Violation Detection — Phase 3 Implementation Spec

**Epic:** `MQTT_OK_TO_MQTT_VIOLATIONS_EPIC.md` (issue #4114)
**Phase:** 3 — Reports: `ok_to_mqtt` gateway violation report (final phase)
**Branch / worktree:** `feature/mqtt-violation-report` @ `../meshmonitor-mqtt-report`
**Scope:** **frontend only.** Phase 1's API is fixed and complete. **Zero backend files.** One
non-component shared util gains an `export` keyword (§3.3) — that is the only file outside
`src/components/`, `src/pages/`, and `public/locales/` that this phase touches.

Everything below was located and read in *this* worktree; every `file:line` is verified against the
current tree (both prior phases merged). Implementers follow this document literally. Where it says
"reuse", do not hand-roll.

---

## 1. Reuse inventory (MANDATORY — use or extend these; do NOT duplicate)

### 1.1 The report registry — `src/components/Analysis/AnalysisTab.tsx` (103 lines)

| Thing | Location | Notes |
|---|---|---|
| `type AnalysisType` union | `:13` | `'solar-monitoring' \| 'nodeinfo-enrichment' \| null` — add one member. |
| `interface AnalysisCard` | `:15-20` | `{ id, title, description, icon: UiIconName }`. |
| `reports: AnalysisCard[]` | `:26-45` | The card grid array — add one entry. |
| Render block to clone | `:62-75` (nodeinfo-enrichment) | `<div className="reports-section">` + `.reports-section__back` button + `<Report />`. |
| Static import block | `:9-10` | Add the new component import. |
| Selection state | `:24` `useState<AnalysisType>(null)` | **Component-local, not URL-backed, not deep-linkable.** This is a known limitation; **do NOT redesign it in this phase.** The report is reached by clicking its card. |
| Outer chrome | `src/pages/ReportsPage.tsx:19-43` | `ToastProvider` + `SettingsProvider` + `.reports-page/.reports-header/.reports-body`. **No edit.** `useToast()` is therefore available inside the report. |
| `QueryClientProvider` | `src/main.tsx:129` wraps the whole router; `/reports` route at `:168-171` | TanStack `useQuery` works inside the report with no extra provider. Verified. |

**Adding a report is exactly 4 edits in this file: the import, the union, the array entry, the render
block.** Nothing else.

### 1.2 The shell/fetch template — `src/components/Analysis/NodeInfoEnrichmentReport.tsx` (315 lines)

**This is the model to follow.** It is the *correct* i18n-using report; `SolarMonitoringReport.tsx`
hardcodes English in places — **follow enrichment, not solar, for strings.**

| Pattern | Location | Notes |
|---|---|---|
| Envelope-aware `queryFn` | `:78-86` | `api.get<{ success: boolean; data: T }>(url)` then `return body.data;` with the comment `// envelope not unwrapped by ApiService`. **Copy this shape verbatim** — inherited item 4. |
| Query-key constant | `:60` `const ANALYSIS_KEY = [...] as const` | |
| Header block | `:152-163` | `.reports-section__title` (`<h2>` + `<UiIcon>`) + `.reports-section__subtitle`. |
| Loading banner | `:165-169` | `.reports-banner`. |
| Error banner | `:171-175` | `.reports-banner--error` + `(error as Error).message`. |
| Empty banner + hint | `:177-187` | `.reports-banner--empty` + `.reports-banner__hint`, and note the hint already handles the signed-out case ("If you're signed out or only have access to one source, sign in to see more") — the precedent for §2(g)'s permission wording. |
| Stats row | `:191-195` + local `Stat` component `:308-313` | `.reports-stats` / `.reports-stat{,__label,__value}`. **Clone the local `Stat` helper; it is 6 lines and not exported.** |
| Controls row | `:197-237` | `.reports-panel` > `.reports-controls` + `.reports-btn` / `.reports-btn--ghost` with `<UiIcon>`. |
| Table | `:239-291` | `.reports-table-wrap` > `.reports-table`. |
| Clickable row | `:252-257` | `.reports-row--clickable` + `onClick` + `title`. |
| Nested-button `stopPropagation` | `:275-278` | Required whenever a button sits inside a clickable row. |
| `t(key, 'English default')` everywhere | throughout | Two-arg form. Interpolation is the three-arg form `t(key, 'default {{x}}', { x })` (`:99-102`). |

### 1.3 The deferred-run pattern — `src/components/Analysis/SolarMonitoringReport.tsx`

| Pattern | Location |
|---|---|
| `const [run, setRun] = useState(false)` | `:111` |
| `useQuery({ queryKey: [..., lookbackDays], queryFn, enabled: run })` | `:114-121` |
| Button: `if (run) void refetch(); else setRun(true);` | `:167-184` |
| Tri-state button label (`Analyzing…` / `Re-run analysis` / `Run analysis`) | `:179-184` |
| Numeric lookback input feeding the query key | `:110`, `:154-166` (`.reports-controls__field` + `input[type=number]`, clamped in `onChange`) |

**Do not copy its fetch style** — `apiService.get<T>()` at `:117` returns the raw payload because the
solar routes use bare `res.json(...)`. The violation endpoints use `ok()`, so Phase 3 must use the
enrichment `body.data` form.

### 1.4 Filter / pagination / CSV mechanics — `src/components/AuditLogTab.tsx` (532 lines)

| Pattern | Location | Verdict |
|---|---|---|
| Single `filters` state object incl. `limit`/`offset` | `:53-63` | **Adopt the shape** (one object, not 8 `useState`s). |
| `handleFilterChange` resetting `offset` to 0 on any non-offset change | `:130-139` | **Adopt the rule.** |
| `handlePageChange(newPage)` → `offset = (page-1)*itemsPerPage` | `:156-160` | **Adopt.** |
| Date → epoch conversion, `endDate.setHours(23,59,59,999)` end-of-day normalization | `:87-95` | **Adopt for `until`.** |
| `totalPages` | `Math.ceil(total / itemsPerPage)` (rendered further down the file) | **Adopt, but clamp — see §2(c).** |
| `useEffect(() => { void fetchLogs(); ... }, [filters])` | `:69-73` | **DO NOT COPY.** This is the file's single baselined `react-hooks/exhaustive-deps` violation (`eslint-baseline.json`: `src/components/AuditLogTab.tsx → {"react-hooks/exhaustive-deps": 1}`). Reproducing it in a new file is a **new** violation and fails `lint:ci`. Use TanStack `useQuery` with the filters in the `queryKey` instead. |
| `handleExportCSV` | `:162-196` | **DO NOT COPY.** It hand-rolls a `Blob`/`objectURL`, escapes with `(log.details \|\| '').replace(/,/g, ';')` (not RFC 4180 — a `"` or newline still corrupts the file), joins with `\n` not CRLF, and names the file with a raw `toISOString()` whose colons are illegal on Windows. Use §1.5 instead. |

### 1.5 CSV helpers — `src/utils/nodeExport.ts` (217 lines)

| Symbol | Location | Status |
|---|---|---|
| `escapeCsv(value: string): string` | **`:124`** — `/[",\r\n]/` test, doubles `"`, wraps in quotes. RFC 4180. | **MODULE-PRIVATE — not exported.** |
| `nodesToCsv(rows)` | `:132-138` | The composition model: header row + body rows, `join('\r\n')`, CRLF, no BOM. |
| `downloadTextFile(filename, content, mimeType)` | `:207-217` | **Exported.** The isolated DOM side-effect; its doc comment states the rest of the module stays pure and unit-testable — mirror that split. |
| Existing test file | `src/utils/nodeExport.test.ts` | |

> **Correction to the epic plan and the task brief:** both call this helper **`escapeCsvField`**. The
> real name is **`escapeCsv`**, and it is **not exported**. §3.3 exports it (one keyword). Do **not**
> rename it (`nodeExport.test.ts` and `nodesToCsv` use the current name), and do **not** hand-roll a
> second escaper.

### 1.6 Shared report chrome — `src/styles/analysis-reports.css` (571 lines)

Imported once, globally, by `src/pages/ReportsPage.tsx:13`. Verified class inventory relevant here:

`.reports-section`, `.reports-section__title`, `.reports-section__subtitle`, `.reports-section__back`,
`.reports-stats`, `.reports-stat`, `.reports-stat__label`, `.reports-stat__value`,
`.reports-panel`, `.reports-controls`, `.reports-controls__field` (styles nested
`input[type='number']` at `:192-205`),
`.reports-banner`, `.reports-banner--error`, `.reports-banner--empty`, `.reports-banner--warning`
(`:491-495`, yellow), `.reports-banner__hint`,
`.reports-table-wrap` (**`:421-425` already sets `overflow-x: auto`** + border + radius),
`.reports-table` (`:427-463`; **`td { white-space: nowrap }` at `:446-450`** — load-bearing, see §2(i)),
`.reports-table tbody tr.reports-row--clickable { cursor: pointer }` (`:461-463`),
`.reports-btn`, `.reports-btn--ghost`, `.reports-pill`, `.reports-pill--ok`, `.reports-pill--warn`,
`.reports-field-pill`, `.reports-grid`, `.reports-card*`.

There is **no** pagination or sortable-header class in this sheet — those are genuinely new (§3.2).

### 1.7 Phase 2 primitives — `src/components/MQTT/` (inherited item 3)

| Symbol | Location | Contract |
|---|---|---|
| `type OkToMqttState` | `okToMqttState.ts:15-30` | `'violation' \| 'ok' \| 'optedOut' \| 'unknown'`. **Four-valued.** The fourth state is **`optedOut`**, not `self`. |
| `okToMqttState(row: { okToMqttViolation?, bitfield? })` | `okToMqttState.ts:37-41` | `okToMqttViolation === 1` ⇒ `'violation'`; `bitfield == null` ⇒ `'unknown'`; `bitfield & 1` ⇒ `'ok'` else `'optedOut'`. **The browser must NEVER recompute `relayed`** — the server already applied it (file header `:5-11`). |
| `MqttOkToMqttMarker` | `MqttOkToMqttMarker.tsx:28-75` | Props `{ state, scope: 'packet' \| 'gateway' }`. Renders the `violation` badge (`mqpm-badge mqpm-badge-violation` + `UiIcon name="alert"`) or quiet mono text for the other three. Carries its own `title` tooltips and its own i18n keys — **no new strings needed for the state cell.** |
| Styling dependency | `MqttOkToMqttMarker` uses `.mqpm-*` classes from `src/components/MQTT/MqttPacketMonitor.css`, which is imported **only** by `MqttPacketMonitorView.tsx:34` | See §2(a.3) — the report must import that sheet. Verified safe: the sheet's only non-`.mqpm-` top-level selector is `.mqtt-packet-monitor` (`:4`), which the report never uses, so there is no bleed. |
| Capture-off note | `public/locales/en.json:4492` `mqtt.packets.violationsStillRecorded` + inline `t()` defaults at `MqttPacketMonitorView.tsx:341` and `:470` + **three assertions** at `MqttPacketMonitorView.test.tsx:377-410` | Inherited item 1 — §3.7. |

### 1.8 Fetching — `src/services/api.ts`

| Symbol | Location | Notes |
|---|---|---|
| `api.get<T>(endpoint)` | `:168-170` | Returns the **raw JSON body**; does not unwrap `data`. |
| `ApiError` | `:41-55` | `{ status, code?, body?, retryAfterSeconds? }` — `code` is the SCREAMING_SNAKE machine code, so error mapping in §2(g) reads `(err as ApiError).code`. |
| Raw `fetch()` | banned by ESLint in `src/components/**` and `src/pages/**` | Use `api` only. **Do not** copy `MqttPacketMonitorView`'s `useCsrfFetch` either — these are GETs and need no CSRF token. |

### 1.9 Test template — `src/components/Analysis/NodeInfoEnrichmentReport.test.tsx`

Copy its harness wholesale (`:1-69`):
- `/** @vitest-environment jsdom */`.
- A **local `react-i18next` mock** overriding `src/test/setup.ts`'s global mock, because the global
  one does not understand the real `t(key, defaultValue, options)` signature (`:14-34`). Without it,
  every string assertion fails. It interpolates `{{var}}` from the options arg.
- `vi.mock('../../services/api', …)` returning `{ default: { get: vi.fn(), post: vi.fn() }, ApiError: actual.ApiError }` (`:36-43`).
- `renderReport()` wrapping in `QueryClientProvider` (`retry: false`) + `ToastProvider` (`:60-69`).
- Fixture builders returning the **full envelope** `{ success: true, data: {...} }` (`:71-95`).

### 1.10 The API being consumed (Phase 1 — FIXED, read-only for this phase)

`src/server/routes/analysisRoutes.ts` — verified against the live implementation, not just the spec:

| Fact | Location |
|---|---|
| `GET /api/analysis/mqtt-violations/gateways` | `:553-723` |
| `GET /api/analysis/mqtt-violations/packets` | `:733-847` |
| Whitelists | `:104-105` — `VIOLATION_GATEWAY_SORTS = ['violationCount','lastSeen','distinctOriginators','gatewayId']`, `VIOLATION_LIST_SORTS = ['timestamp','fromNode','gatewayId']` |
| `parseLookbackDays` accepts **both** `lookbackDays` and `lookback_days`; clamps 1..365, default 7 | `:94-98`, used at `:560` / `:740` |
| `parseUntilMs` — default `Date.now()` | `:89-92` |
| `since` derived as `until - lookbackDays*86400000` **unless** `req.query.since` is a non-empty string | `:561-564` |
| `clampPageSize` — default 500, **hard max 2000** | `:68-72` |
| `offset` — `parseInt`, `>= 0`, else 0 | `:587-588` |
| `includeUnknown` — `'true'` or `'1'` only | `:100-102`, `:585` |
| Zero permitted sources ⇒ **200** with empty array, `sources: []`, `suspectedAvailable: false` | `:590-604`, `:773-788` |
| `suspectedAvailable` / `suspectedWindowMs` initialised `false`/`0` and **only assigned inside `if (includeUnknown)`** | `:630-663`, `:798-813` — this is the trap of §2(a.2) |
| Confirmed rows fetched with a hardcoded `limit: 2000, offset: 0`; sorting and slicing happen **in the handler** in *both* modes | `:613-614`, `:695-705`; `:793-794`, `:815-828` |
| `total = includeUnknown ? merged.length : confirmedTotal` | `:704`, `:827` |
| Suspected-only gateways appear with `violationCount: 0` | `:680-693` |
| `firstSeen`/`lastSeen` span both signals when a gateway is confirmed *and* suspected | `:675-676` |
| Repo default sort when the handler omits `sort` — gateways `COUNT(*) DESC`, packets `timestamp DESC` | `src/db/repositories/mqttOkToMqttViolations.ts:118-126`, `:193-198` |
| Row shapes | `analysisRoutes.ts:107-130` (`ViolationGatewayRow`, `ViolationPacketRow`); `MqttViolationGateway` at `src/db/repositories/mqttOkToMqttViolations.ts:46-53` |
| Error codes | `INVALID_RANGE` (`:566-569`), `INVALID_SORT_FIELD` (`:572-575`), `INVALID_SORT_DIRECTION` (`:578-582`), `MQTT_VIOLATIONS_FETCH_FAILED` (`:719-722`) |

### 1.11 Baseline headroom (verified per file — `eslint-baseline.json`, 408 entries)

| File this phase edits/creates | Baseline entry | Headroom |
|---|---|---|
| `src/components/Analysis/AnalysisTab.tsx` | **none** | **zero** |
| `src/components/Analysis/MqttViolationsReport.tsx` (new) | none (new file) | **zero** |
| `src/components/Analysis/mqttViolationsCsv.ts` (new) | none | **zero** |
| `src/components/Analysis/mqttViolationTypes.ts` (new) | none | **zero** |
| `src/utils/nodeExport.ts` | **none** | **zero** |
| `src/components/MQTT/MqttPacketMonitorView.tsx` | **none** | **zero** |
| `src/pages/ReportsPage.tsx` (not edited) | none | — |
| `src/components/AuditLogTab.tsx` (**read-only template**) | `{"react-hooks/exhaustive-deps": 1}` | its one violation is the `useEffect([filters])` at `:69-73` — see §1.4 |

**Consequence: zero headroom everywhere this phase writes.** One new `@typescript-eslint/no-explicit-any`
or `react-hooks/exhaustive-deps` violation fails `lint:ci` outright. No `any`. No hand-written
`useEffect` data-fetching. This matches Phase 2's finding — the epic's earlier assumption of
baselined headroom in this area was wrong.

Verify with:
```bash
npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'   # must be empty
```

---

## 2. Design decisions (settled — implementers do not re-decide)

### 2(a) The four items inherited from Phase 2

#### 2(a.1) Extend the capture-off note to point at this report

**Decision: do it, as a pure string change in three places plus three test assertions.**

Canonical new English value (**normative — copy byte-for-byte into all three sites**):

```
ok_to_mqtt violation detection keeps running while capture is off — turning capture on only makes the per-packet violation badge visible here. Confirmed violations are always listed in Analysis & Reports → ok_to_mqtt violations.
```

Sites (all four must agree, or the rendered text and the locale diverge):
1. `public/locales/en.json:4492` — the `mqtt.packets.violationsStillRecorded` value.
2. `src/components/MQTT/MqttPacketMonitorView.tsx:341` — inline `t()` default (banner).
3. `src/components/MQTT/MqttPacketMonitorView.tsx:470` — inline `t()` default (empty-state note).
4. `src/components/MQTT/MqttPacketMonitorView.test.tsx:386`, `:397`, `:410` — three exact-string
   assertions that fail until updated.

The inline default is what renders under every locale that lacks the key (all of them but `en`), and
what the component tests assert — so it is not optional duplication. **No `UiIcon`/emoji in the
string**; the arrow `→` is a text separator inside prose, not an icon stand-in (same usage already
present in this codebase's report prose).

#### 2(a.2) `suspectedAvailable` is a trap — the exact rule for surfacing it

Verified in the live handler (`analysisRoutes.ts:630-631` + `:637-663`): both `suspectedAvailable`
and `suspectedWindowMs` are initialised to `false`/`0` and are **only** assigned inside
`if (includeUnknown)`. On a default-params response they are therefore *always* `false`/`0`, and this
says **nothing** about whether `mqtt_packet_log_enabled` is on.

**Rule (normative):**

```ts
// Read from the RESPONSE echo, never from local toggle state — the response and the
// control can be out of step for one render after the toggle flips.
const unknownRequested = data.includeUnknown === true;
const suspectedUnavailable = unknownRequested && data.suspectedAvailable === false;
const suspectedShown      = unknownRequested && data.suspectedAvailable === true;
```

- The "suspected rows are unavailable / need the packet monitor" banner renders **iff
  `suspectedUnavailable`**.
- The suspected column, the suspected stat tile, and the horizon caveat render **iff
  `suspectedShown`**.
- `suspectedWindowMs` is read **only** when `suspectedShown`.
- With the toggle off, the report renders **no availability text at all** — not "unavailable", not
  "0 suspected".

A dedicated test pins this (§4, test 11).

#### 2(a.3) Reuse `okToMqttState()` / `MqttOkToMqttMarker`, and never recompute `relayed`

The drill-down endpoint returns `kind: 'confirmed' | 'suspected'` and `bitfield`, but **not**
`okToMqttViolation`. The report therefore adapts, and does **not** re-derive:

```ts
import { okToMqttState } from '../MQTT/okToMqttState';
import MqttOkToMqttMarker from '../MQTT/MqttOkToMqttMarker';

// `kind` IS the server's already-relayed-adjudicated verdict: a 'confirmed' row exists in
// mqtt_ok_to_mqtt_violations only when the server evaluated state==='no' && relayed
// (PHASE1 §2(f)). Map it onto the shared four-state derivation; never re-test `relayed`
// (the browser does not know localGatewayNodeNum — okToMqttState.ts:5-11).
const state = okToMqttState({
  okToMqttViolation: row.kind === 'confirmed' ? 1 : 0,
  bitfield: row.bitfield,
});
// => 'violation' for confirmed; 'unknown' for suspected (its query predicate is bitfield IS NULL).
<MqttOkToMqttMarker state={state} scope="gateway" />
```

`scope="gateway"` is correct: each drill-down row is **one gateway's reception**, which is exactly
the semantic the marker's `'gateway'` tooltip describes (`MqttOkToMqttMarker.tsx:24-25`, `:37`).

**Styling consequence, decided:** the report adds
`import '../MQTT/MqttPacketMonitor.css';` with the comment below. Duplicating `.mqpm-badge` into a
CSS module is exactly the duplication the reuse rule forbids, and a module cannot extend a global
class. Verified bleed-safe: the sheet's only non-`.mqpm-` top-level selector is `.mqtt-packet-monitor`.

```ts
// The reused MqttOkToMqttMarker renders .mqpm-* classes from this sheet, which is
// otherwise imported only by MqttPacketMonitorView. Importing it here is cheaper and
// safer than duplicating the badge styles into a module (#4114 Phase 3 §2(a.3)).
```

#### 2(a.4) Read `body.data`

Every `queryFn` in this phase types the envelope and returns `body.data` explicitly, with the
enrichment report's comment form (`NodeInfoEnrichmentReport.tsx:81-85`). `ApiService.request()` does
not unwrap it (`src/server/utils/apiResponse.ts:6-10`).

### 2(b) Drill-down mechanism: **inline expandable row (single-open accordion)**

**Decision: an expandable detail row, not a modal, not a detail panel, not a second standing table.**

Justification against what exists in the reports area:
- `NodeInfoEnrichmentReport` uses a **modal** (`CopyNodeInfoModal`, `:295-303`) because its
  drill-down is an *action* surface — it previews and confirms a mutation, needs focus trapping, and
  benefits from blocking the background.
- `SolarMonitoringReport` uses **expandable per-node detail** because its drill-down is *read-only
  detail* about the row you clicked.
- This drill-down is read-only detail → follow the solar precedent. It also keeps the parent gateway
  row on screen, which matters because the whole point of the summary is comparing gateways.
- A modal would additionally have to re-implement escape/focus handling for zero benefit, and a
  second standing table below would leave the user guessing which gateway it belongs to.

Mechanics:
- State: `const [expandedGateway, setExpandedGateway] = useState<string | null>(null)` — **at most
  one open**, so at most one drill-down query is ever in flight and the DOM cannot grow unboundedly.
- Markup: the gateway `<tr>` is `.reports-row--clickable` with `onClick` toggling; when open, a
  second `<tr>` follows carrying a single `<td colSpan={columnCount}>` (computed, not hardcoded —
  the count changes with the suspected column) that contains the drill-down.
- Affordance: a leading cell with `<UiIcon name={open ? 'chevronUp' : 'chevronDown'} size={14} />`
  and an `aria-expanded` + `aria-label` from `analysis.mqtt_violations.expand` / `.collapse`.
- **Independent pagination and sort.** Own state `drill: { sort, dir, limit, offset }`, defaults
  `{ sort: 'timestamp', dir: 'desc', limit: 100, offset: 0 }`. Changing the *gateway* (collapse or
  open another) **resets `drill.offset` to 0** so re-opening never lands on page 4 of a different
  gateway.
- Query: `enabled: expandedGateway !== null`, keyed on the gateway id, the applied summary filters,
  and the drill state (§3.1). Uses the **same** `since`/`until`/`sources`/`includeUnknown` as the
  summary so the numbers reconcile.
- Its own states, rendered **inside the detail cell**, never replacing the summary table:
  loading `.reports-banner`, error `.reports-banner--error` (same code mapping as §2(g)), empty
  `.reports-banner--empty` with text "No individual rows for this gateway in this window." plus a
  hint when `!unknownRequested` noting that unproven rows are hidden by the toggle.
- The parent row is **not** unmounted while the drill-down loads, so the user never loses context.

### 2(c) Sorting + pagination: **server-side, with the 2000-row cap surfaced honestly**

**Sorting: server-side**, via `sort`/`dir`. Client-side sorting is rejected outright: with server
pagination it would only reorder the current page, which is actively misleading.

**Only whitelisted fields get a sort affordance.** Do not offer a control the API rejects:

| Table | Sortable (API whitelist) | Rendered but **not** sortable |
|---|---|---|
| Gateway summary | `violationCount`, `distinctOriginators`, `lastSeen`, `gatewayId` | `suspectedCount`, `firstSeen`, `sources` — plain `<th>` text, no button, no `aria-sort` |
| Drill-down | `timestamp`, `fromNode`, `gatewayId` | everything else |

`gatewayId` is offered in the drill-down whitelist by the API but is useless there (every row has the
same gateway when filtered) — **omit it from the drill-down's sortable headers** and keep
`timestamp` + `fromNode`.

**Pagination: server-side** `limit`/`offset`. Page-size options `25 / 50 / 100 / 250` (all well under
`clampPageSize`'s 2000 max). Changing page size, any filter, the toggle, or the sort **resets
`offset` to 0** (AuditLogTab's rule, `:130-139`).

**The 2000-row cap and how to be honest about it.** Verified from the live handler, and it is
*broader* than the epic plan's description:

| Mode | `total` | Rows actually reachable |
|---|---|---|
| `includeUnknown=false` | **exact** (`confirmedTotal`, a real `COUNT`) | only the first **2000** groups/rows, because the handler fetches `limit: 2000, offset: 0` (`:613-614`, `:793-794`) and then slices a JS array (`:705`, `:828`). `offset >= 2000` returns an **empty page while `total` says more exist**. |
| `includeUnknown=true` | `merged.length`, itself ≤ 2000 confirmed + ≤ 2000 suspected ⇒ an **undercount** when either side saturates | same 2000-ish ceiling |

Additional subtlety: the handler does **not** pass `sort`/`dir` down to SQL, so the 2000 rows it keeps
are the top 2000 by the repository default — `COUNT(*) DESC` for gateways, `timestamp DESC` for
packets (`mqttOkToMqttViolations.ts:125-126`, `:198`). So an **ascending** sort under a saturated
scan sorts *within the worst 2000*, not the whole window.

**Normative UI rules:**

```ts
const API_SCAN_CAP = 2000;                       // clampPageSize max === handler pre-merge cap
const capReached  = data.total >= API_SCAN_CAP;
const reachable   = Math.min(data.total, API_SCAN_CAP);
const totalPages  = Math.max(1, Math.ceil(reachable / data.limit));   // never offer a dead page
```

1. Pager is clamped to `totalPages` computed from `reachable`, so the UI never offers a page it knows
   will be empty.
2. The row count renders as `2,000+ gateways` (key `.total_rows_capped`) whenever `capReached`,
   never as a number the UI knows may be wrong. Otherwise `{{total}} gateways`.
3. When `capReached`, a persistent `.reports-banner--warning` (key `.cap_warning`) states: showing
   the first 2,000 rows; the API caps one scan at 2,000, so the total and later pages are
   incomplete; narrow the lookback or select fewer sources.
4. When `capReached && dir === 'asc'`, append `.cap_warning_asc`: an ascending sort inside a capped
   scan ranks only the 2,000 worst rows, not the whole window.
5. Same four rules apply to the drill-down table independently.

No workaround is attempted client-side — a smaller window is the honest fix, and changing the cap is
a backend change (out of phase scope).

### 2(d) CSV export scope: **the whole filtered result set, capped at 2000, cap visible**

**Decision: export the full current filtered result set, not the current page.** A page-only export
is a footgun for an analytical report — the user asks "give me the offenders", not "give me rows
26-50".

Mechanism: on click, an imperative one-shot fetch (`queryClient.fetchQuery`, not a second live
`useQuery`) with **the same filters and sort** but `limit=2000, offset=0`. `2000` is not a chosen
number — it is the API's hard ceiling (`clampPageSize`, `:68-72`) and equals the handler's internal
pre-merge cap, so no larger export is obtainable without a backend change.

**The cap must be visible, never silent.** After the fetch, if `exported >= API_SCAN_CAP` **or**
`body.data.total > exported`, show a warning `showToast(..., 'error'|'success')` **and** set a
dismissable `.reports-banner--warning` using key `.export_capped`:
"Exported 2,000 of 3,412 matching rows — the API caps one scan at 2,000 rows. Narrow the lookback to
export the rest." Otherwise `.export_done` ("Exported {{count}} rows"). On failure, `.export_failed`
via `showToast(..., 'error')`.

**Two exports, one per table.** Justified: different columns answering different questions; a single
merged export would either drop the summary aggregates or become a denormalised join nobody asked
for.

| Export | Trigger | Columns (in order) |
|---|---|---|
| Gateway summary | `.reports-btn--ghost` + `<UiIcon name="download" size={16} />` in the controls row | `gatewayId, gatewayNodeNum, violationCount, suspectedCount, distinctOriginators, sourceIds, firstSeen, lastSeen` |
| Drill-down | same button inside the expanded detail cell | `kind, timestamp, sourceId, packetId, fromNode, fromNodeId, gatewayId, gatewayNodeNum, channelId, portnum, portnumName, bitfield, topic, rxTime` |

Formatting rules (normative, implemented in the pure builders of §3.1):
- Every field passes through `escapeCsv` (§3.3). Header labels too, as `nodesToCsv` does.
- Rows joined with `\r\n`; no BOM. Matches `nodesToCsv:132-138`.
- `sourceIds` joined with `; ` (never `,` — escaping would handle it, but a semicolon keeps the cell
  readable in a spreadsheet).
- `firstSeen` / `lastSeen` / `timestamp` / `rxTime` → ISO-8601 UTC via `new Date(ms).toISOString()`;
  `null`/`0` → empty string.
- `suspectedCount` column is always present in the header; it is `0` when the toggle is off (that is
  what the API returned — do not omit the column, that would make two exports structurally
  different).
- Filenames: `mqtt-oktomqtt-violations-gateways-<stamp>.csv` and
  `mqtt-oktomqtt-violations-<gatewaySlug>-<stamp>.csv`, where
  `stamp = new Date().toISOString().replace(/[:.]/g, '-')` (colons are illegal in Windows filenames —
  AuditLogTab's raw `toISOString()` at `:187` is a latent bug; do not copy it) and
  `gatewaySlug = gatewayId.replace(/[^a-zA-Z0-9]/g, '')` (strips the leading `!`).
- Download via `downloadTextFile(filename, csv, 'text/csv')`. **No hand-rolled Blob/objectURL.**

### 2(e) Lookback / date-range control: **presets + optional explicit range, behind a deferred run**

**Decision: four preset lookback buttons — 24 h / 7 days / 30 days / 90 days — plus an optional
explicit From/To date pair.**

Justification:
- The meaningful values are few and bounded: confirmed history is capped by
  `mqtt_oktomqtt_violation_retention_days` (default **90**), so `90 days` *is* "everything". Presets
  make the common case one click and communicate that ceiling.
- Explicit dates are still required ("what happened last Tuesday"), and the API already accepts
  `since`/`until` ms.
- A bare numeric spinner (solar's control, `:154-166`) is rejected as the *primary* control because
  it invites a pointless 365-day scan; but the same 1..365 clamp is applied to whatever the controls
  produce, mirroring `parseLookbackDays`.

Param emission (normative):
- No explicit dates → send **`lookbackDays`** only. Use the camelCase spelling; the handler also
  accepts `lookback_days` (`:560`), but do not introduce a second convention in new code.
- Explicit dates set → send **`since`** and **`until`**, and omit `lookbackDays` (the handler ignores
  it once `since` is a non-empty string, `:561-564`). `since = new Date(from).getTime()`;
  `until = (d => (d.setHours(23,59,59,999), d.getTime()))(new Date(to))` — end-of-day normalization
  exactly as AuditLogTab `:91-95`, otherwise "to = today" silently excludes today.
- Client-side guard: if `since > until`, the Run button is `disabled` and an inline
  `.reports-banner--error` shows `.range_error`. The `INVALID_RANGE` server error is still mapped
  (§2(g)) for URL/clock-skew edge cases.

**Deferred run (mandatory — this is a multi-source scan).** Solar's pattern, with a draft/applied
split so a keystroke can never fire a query:

```ts
const [draft, setDraft]   = useState<Filters>(DEFAULT_FILTERS);  // what the controls edit
const [applied, setApplied] = useState<Filters>(DEFAULT_FILTERS); // what the queryKey reads
const [run, setRun] = useState(false);

const { data, isLoading, isFetching, error, refetch } = useQuery({
  queryKey: ['mqtt-violations-gateways', applied],
  queryFn: …,
  enabled: run,
});

const onRun = () => { setApplied(draft); if (run) void refetch(); else setRun(true); };
```

Note the ordering nuance: `setApplied(draft)` changes the `queryKey`, so when `applied` actually
differs TanStack refetches on its own and the `refetch()` is a harmless no-op; when only a
re-run of the *same* window is wanted, `refetch()` is what does the work. Both paths are covered by
one handler. Sort changes, page changes, and page-size changes update `applied` **directly** (they
are cheap, already-run refinements — not a new scan the user must opt into) and therefore refetch
immediately; only the window and the `includeUnknown` toggle are draft-gated. *(Rationale: the user
has already consented to scanning this window; re-paginating it is the same query.)*

Horizon note beside the control (`.reports-controls__field` sibling, `.reports-banner__hint`-styled
text via the CSS module): confirmed history reaches back about 90 days, suspected rows only reach
back the packet log's window — so "90 days + suspected" is 90 days of confirmed plus roughly one day
of suspected. Rendered only when `suspectedShown` (§2(a.2)).

### 2(f) The `includeUnknown` toggle: presenting two data sources honestly

Off by default (`includeUnknown: false` in `DEFAULT_FILTERS`). A `<label><input type="checkbox">`
in `.reports-controls`, draft-gated (§2(e)), labelled `.include_unknown` with a `.include_unknown_help`
sibling — the enrichment report's `push_to_device` + `push_to_device_help` shape
(`NodeInfoEnrichmentReport.tsx:199-215`).

When `suspectedShown`:

1. **Two separate count columns, visually distinct.**
   - `Confirmed` = `violationCount`, rendered in a `.reports-pill--warn` pill. This is the proven
     signal.
   - `Suspected` = `suspectedCount`, rendered as **quiet muted mono text** (module class
     `.suspectedCell`) — deliberately borrowing the visual language of the marker's `unknown` state,
     not a warn pill. A suspected count must never look like an accusation.
   - Both cells carry a `title`: confirmed = "bit was explicitly 0 and a third party relayed it";
     suspected = "the bit could not be read — usually no channel key. Not proven."
2. **Horizon caveat**, `.reports-banner--warning`, key `.suspected_caveat`, interpolating a formatted
   `suspectedWindowMs` (`.window_hours` when `< 48 h`, else `.window_days`): suspected rows come from
   the MQTT packet monitor's log and only reach back that window, while confirmed reach back ~90
   days. This is why a 90-day view can show a large confirmed count and a tiny suspected count — say
   so rather than letting the user infer a bug.
3. **Suspected-only gateways** (`violationCount === 0 && suspectedCount > 0`, produced by
   `analysisRoutes.ts:680-693`) get a `data-suspected-only="true"` attribute and a module class that
   de-emphasises the row (muted text, no warn colour), and their Confirmed cell renders a muted `0`.
   They are *candidates*, not offenders. Row `title` = `.suspected_only_title`.
4. **Sort honesty:** `suspectedCount` is not in the API whitelist, so its header is not sortable, and
   under the default `violationCount desc` sort suspected-only rows sort to the bottom. The header
   `title` says exactly that.
5. **Stat tiles** become `Offending gateways / Confirmed violations / Suspected / Originators
   affected`; the `Suspected` tile is only rendered when `suspectedShown`.

When `!unknownRequested`: no suspected column, no suspected tile, no caveat, **no availability text
of any kind** (§2(a.2)).

### 2(g) Empty, pre-run, loading, error, and zero-permission states

Precedence order in the render (first match wins):

| # | Condition | Render |
|---|---|---|
| 1 | `!run` | **Pre-run**: `.reports-banner` with `.prerun` — what the report does, that it scans every MQTT source you can read, and that it does not run until you press Run. **No request is fired** (asserted in §4 test 1). |
| 2 | `isLoading` | `.reports-banner` `.loading` — "Scanning MQTT violation history…". Button label switches to `.running`. |
| 3 | `error` | `.reports-banner--error`, message from the code map below. |
| 4 | `data.sources.length === 0` | **Nothing readable**: `.reports-banner--empty` `.no_sources` + `.reports-banner__hint` `.no_sources_hint`. |
| 5 | `data.gateways.length === 0` | **Good news** (below). |
| 6 | otherwise | stats + controls + table. |

**Error code map** (`(err as ApiError).code`, `src/services/api.ts:41-55`):

| `code` | Key | Notes |
|---|---|---|
| `INVALID_RANGE` | `.error_invalid_range` | Should be unreachable — the client guards it (§2(e)). |
| `INVALID_SORT_FIELD` | `.error_invalid_sort` | Unreachable by construction (whitelisted headers). |
| `INVALID_SORT_DIRECTION` | `.error_invalid_sort` | Same key; the distinction is meaningless to a user. |
| `MQTT_VIOLATIONS_FETCH_FAILED` | `.error_fetch_failed` | Server-side failure. |
| anything else / no code | `(error as Error).message` | Enrichment's fallback (`:173`). |

**The good-news empty state (the most important one).** A default install has violation recording
**ON** (`mqtt_oktomqtt_violation_log_enabled` defaults to on) and the packet monitor **OFF** — so the
report works out of the box and an empty result is the *expected* outcome on a healthy network. It
must not read as a broken screen:

- `.reports-banner--empty` primary line `.empty`: "No ok_to_mqtt violations in the selected window."
- `.reports-banner__hint` `.empty_good_news`: "On a healthy network that is the expected result — it
  means every MQTT gateway that relayed another node's packet respected the sender's opt-out."
- Second hint `.empty_forward_only`: "Detection is forward-only: packets captured before this feature
  shipped cannot be classified, so a freshly upgraded install starts empty and fills as new MQTT
  traffic arrives."
- The packet-monitor opt-in hint (`.suspected_unavailable`) appears here **only when
  `suspectedUnavailable`** — i.e. only when the user actually asked for suspected rows. Never off a
  default-params response (§2(a.2)).

**Zero-permission case — decision: distinguish it, but do not overclaim.** The endpoints return
**200 with empty arrays** for an unpermitted or anonymous user (`analysisRoutes.ts:590-604`), so
"no data" and "not permitted" are the same HTTP response. However the response **echoes
`sources`**, and `sources: []` means "there are zero enabled sources you may read". That is enough to
branch (state #4 above) without any backend change.

Wording must cover both real causes, because `resolvePermittedSourceIds` returns *all* enabled
sources the user can read — not only MQTT ones — so `sources: []` also occurs on an install with no
enabled sources at all:

> `.no_sources` — "No sources available to you."
> `.no_sources_hint` — "This report reads the MQTT sources you have packet-monitor read access to.
> If you are signed out or have no source permissions, sign in or ask an administrator. If this
> install has no sources configured yet, there is nothing to scan."

This is accepted as sufficient. Turning the 200 into a 403 is a backend change and out of scope; the
`sources` echo already carries the information, so no endpoint change is warranted.

### 2(h) Node naming: **raw `!hexid`, resolved nowhere**

**Decision: render `gatewayId` (`!aabbccdd`) as the primary identity with `gatewayNodeNum` as muted
secondary text. No client-side name resolution. No new endpoint. No backend change.**

Justification against cost:
- There is **no cross-source node-name source on the client.** The only frontend node fetch is
  `api.getNodes(sourceId?)` (`src/services/api.ts:375-385`) → `GET /api/nodes[?sourceId=]`, which is
  **single-source** (no `sourceId` ⇒ the primary source) and returns full `DeviceInfo` objects.
  Grep confirms no `useNodeNames` hook, no `/api/nodes/names` endpoint, and no frontend consumer of a
  unified node list.
- Resolving names for gateways that live on non-primary MQTT sources would therefore mean **one
  request per source** with full node payloads, for a cosmetic label — precisely the N-source node
  scan Phase 1 §3.17 deliberately kept out of the handler. Moving that cost to the browser does not
  make it cheaper; it makes it slower and racy.
- **Consistency:** the surfaces a user cross-references already show raw ids — the Packet Monitor's
  gateway multi-select is built from `MqttGateway` (`MqttPacketMonitorView.tsx:99`, `:188-196`,
  `:354-393`), which carries `gatewayId`/`gatewayNodeNum` and **no name**, and the receptions table
  in the detail modal does the same. Raw ids keep the report copy-pasteable straight into that
  filter.
- Same treatment in the drill-down for the originator: `fromNodeId` when present, else
  `'!' + (fromNode >>> 0).toString(16).padStart(8, '0')` (the formatting already used server-side at
  `src/server/services/solarAnalysis.ts:576`).

Both cells carry a `title` with both the hex and the decimal form so the value is legible either way.
No clipboard affordance (not requested; keeps the row click unambiguous).

### 2(i) Styling

- **Reuse `.reports-*` for all shared chrome** — the full list in §1.6. No additions to
  `src/styles/analysis-reports.css` (a frozen global sheet per CLAUDE.md).
- **New report-specific styling lives in `src/components/Analysis/MqttViolationsReport.module.css`**
  (CSS module, per CLAUDE.md §CSS containment). This becomes the tree's second `*.module.css`
  (the first is `src/components/map/layers/AtakContactsLayer.module.css`).
- Plus `import '../MQTT/MqttPacketMonitor.css';` for the reused marker (§2(a.3)).
- **No hardcoded hex colours** — `var(--ctp-*)` only, `color-mix(in srgb, var(--ctp-*) N%, var(--ctp-mantle))`
  where a tint is needed (the idiom already used at `analysis-reports.css:492`).
- **Wide tables are a layout change — specify the container up front** (Phase 2's lesson: a new column
  overflowed the modal by ~78 px and every jsdom test still passed):
  - The gateway table is **8–9 columns**; the drill-down is **11**. `.reports-table td` sets
    `white-space: nowrap` (`:446-450`), so overflow is guaranteed, not hypothetical.
  - Both tables are wrapped in `.reports-table-wrap`, which already provides `overflow-x: auto`
    (`:421-425`). **The nested drill-down table gets its own `.reports-table-wrap` inside the
    `colSpan` cell** — reusing the parent's does not help, because the parent row itself would be
    forced wide.
  - The module **must** neutralise the inherited cell styling on the detail `<td>`, or the nested
    wrap can never scroll:
    ```css
    .detailCell { padding: 0; white-space: normal; }
    ```
  - Acceptance: at 1280×800 **and** 390×844, both tables scroll inside their own containers and
    `document.documentElement.scrollWidth <= clientWidth` (no horizontal page scroll). Verified in
    §5, not discovered there.

---

## 3. File-by-file changes

**No backend files.** If an implementer concludes a backend change is needed, **STOP and escalate** —
Phase 1's API is fixed.

### 3.1 `src/components/Analysis/mqttViolationTypes.ts` — **NEW**

Response and row types mirroring `analysisRoutes.ts:107-130` exactly, plus the filter shape. No
`any`. Exported so the component, the CSV builders, and both test files share one definition.

```ts
/**
 * Wire types for the /api/analysis/mqtt-violations/* endpoints (#4114 Phase 1 §2(e)).
 * Mirrors src/server/routes/analysisRoutes.ts:107-130 — keep in step if that changes.
 */
export type ViolationGatewaySortField = 'violationCount' | 'lastSeen' | 'distinctOriginators' | 'gatewayId';
export type ViolationPacketSortField = 'timestamp' | 'fromNode' | 'gatewayId';
export type SortDir = 'asc' | 'desc';

export interface ViolationGatewayRow {
  gatewayId: string | null;
  gatewayNodeNum: number | null;
  violationCount: number;
  suspectedCount: number;
  distinctOriginators: number;
  sourceIds: string[];
  firstSeen: number;
  lastSeen: number;
}

export interface ViolationPacketRow {
  id: number | undefined;
  kind: 'confirmed' | 'suspected';
  sourceId: string;
  packetId: number | null;
  fromNode: number | null;
  fromNodeId: string | null;
  gatewayId: string | null;
  gatewayNodeNum: number | null;
  channelId: string | null;
  portnum: number | null;
  portnumName: string | null;
  bitfield: number | null;
  topic: string | null;
  rxTime: number | null;
  timestamp: number;
}

/** Common tail present on BOTH responses. */
export interface ViolationResponseMeta {
  total: number;
  limit: number;
  offset: number;
  since: number;
  until: number;
  includeUnknown: boolean;
  /** MEANINGLESS unless includeUnknown === true — see PHASE3 §2(a.2). */
  suspectedAvailable: boolean;
  /** MEANINGLESS unless includeUnknown === true. */
  suspectedWindowMs: number;
  sources: string[];
}

export interface ViolationGatewaysResponse extends ViolationResponseMeta {
  gateways: ViolationGatewayRow[];
}

export interface ViolationPacketsResponse extends ViolationResponseMeta {
  violations: ViolationPacketRow[];
  gateway: string | null;
}

/** The report's window/scope filters. Draft-gated; see PHASE3 §2(e). */
export interface ViolationFilters {
  /** Used only when `from`/`to` are empty. Clamped 1..365 to mirror parseLookbackDays. */
  lookbackDays: number;
  /** 'YYYY-MM-DD' or '' */
  from: string;
  /** 'YYYY-MM-DD' or '' */
  to: string;
  includeUnknown: boolean;
  sort: ViolationGatewaySortField;
  dir: SortDir;
  limit: number;
  offset: number;
}

/** clampPageSize's hard maximum AND the handler's internal pre-merge cap (analysisRoutes.ts:68-72, :613). */
export const API_SCAN_CAP = 2000;

export const DEFAULT_VIOLATION_FILTERS: ViolationFilters = {
  lookbackDays: 7, from: '', to: '', includeUnknown: false,
  sort: 'violationCount', dir: 'desc', limit: 50, offset: 0,
};
```

Also exported from this file (pure, unit-tested, used by both the component and the CSV builders):

```ts
/** Build the query string shared by both endpoints. Emits `lookbackDays` OR `since`+`until`, never both. */
export function buildViolationParams(f: ViolationFilters, extra?: {
  gateway?: string; sort?: string; dir?: SortDir; limit?: number; offset?: number;
}): string;   // returns e.g. "lookbackDays=7&sort=violationCount&dir=desc&limit=50&offset=0"

/** '!aabbccdd' passthrough, or hex-format a nodeNum, or '' — PHASE3 §2(h). */
export function formatNodeRef(id: string | null | undefined, num: number | null | undefined): string;

/** suspectedWindowMs -> { key: 'window_hours' | 'window_days', value: number } — PHASE3 §2(f). */
export function formatSuspectedWindow(ms: number): { hours?: number; days?: number };
```

`buildViolationParams` rules (normative): `URLSearchParams`; `includeUnknown` emitted **only when
true** (as `'true'`); `since`/`until` emitted only when both `from` and `to` are non-empty, with
end-of-day normalization on `to`; otherwise `lookbackDays` clamped to 1..365.

### 3.2 `src/components/Analysis/MqttViolationsReport.tsx` — **NEW**

Structure (single default-exported component + two small local sub-components; no exported
sub-components, so `react-refresh/only-export-components` stays clean):

```
MqttViolationsReport (default export)
├─ imports: useMemo/useState, useQuery + useQueryClient, useTranslation,
│           api + ApiError, useToast, UiIcon,
│           okToMqttState + MqttOkToMqttMarker, '../MQTT/MqttPacketMonitor.css',
│           types/helpers from ./mqttViolationTypes, builders from ./mqttViolationsCsv,
│           downloadTextFile from '../../utils/nodeExport', styles from './MqttViolationsReport.module.css'
├─ state: draft, applied, run, expandedGateway, drill{sort,dir,limit,offset}, exportNotice
├─ gatewaysQuery  = useQuery({ queryKey: ['mqtt-violations-gateways', applied], enabled: run })
├─ packetsQuery   = useQuery({ queryKey: ['mqtt-violations-packets', expandedGateway, applied, drill],
│                              enabled: run && expandedGateway !== null })
├─ header (.reports-section__title / __subtitle)
├─ controls panel (.reports-panel > .reports-controls)
│    ├─ preset lookback buttons (24h / 7d / 30d / 90d)  → draft
│    ├─ From / To date inputs                            → draft
│    ├─ includeUnknown checkbox + help                   → draft
│    ├─ Run / Re-run / Scanning… button                  → setApplied(draft) + run/refetch
│    └─ Export CSV (.reports-btn--ghost + UiIcon download)
├─ banners: prerun | loading | error | no_sources | empty(good news) | cap_warning | suspected_caveat | suspected_unavailable | export_capped
├─ stats (.reports-stats + local <Stat/>)
├─ gateway table (.reports-table-wrap > .reports-table)
│    ├─ <SortableTh> local sub-component for the 4 whitelisted columns
│    ├─ gateway rows (.reports-row--clickable, aria-expanded)
│    └─ detail row: <td colSpan={cols} className={styles.detailCell}> DrillDown </td>
└─ pager (module classes)
```

Rules:
- Both `queryFn`s: `const body = await api.get<{ success: boolean; data: T }>(url); return body.data;`
- No `useEffect` for data fetching anywhere in this file. Derived values via `useMemo` with complete
  dep arrays (zero `exhaustive-deps` headroom).
- Every user-visible string via `t('analysis.mqtt_violations.<key>', 'English default')`.
- Every icon via `UiIcon` — verified available names: `securityAlert`, `alert`, `download`,
  `chevronDown`, `chevronUp`, `refresh`, `sortAscending`, `sortDescending`, `filter`, `reports`.
  No emoji, no Unicode icon stand-ins.
- `columnCount` computed from `suspectedShown` — never a hardcoded `colSpan`.
- CSV click handler: `queryClient.fetchQuery` with the export params, then
  `buildGatewaysCsv(...)` / `buildPacketsCsv(...)` → `downloadTextFile(...)`, then the cap check of
  §2(d).

### 3.3 `src/utils/nodeExport.ts` — **EDIT (one keyword)**

```diff
-/** Escape a single CSV field per RFC 4180. */
-function escapeCsv(value: string): string {
+/**
+ * Escape a single CSV field per RFC 4180.
+ * Exported for reuse by other CSV builders (#4114 Phase 3) — do not fork it.
+ */
+export function escapeCsv(value: string): string {
```

Nothing else in this file changes. `nodesToCsv` and `src/utils/nodeExport.test.ts` keep working
unchanged. **Do not rename** to `escapeCsvField` despite the epic's wording.

### 3.4 `src/components/Analysis/mqttViolationsCsv.ts` — **NEW (pure, no DOM)**

```ts
export const GATEWAY_CSV_COLUMNS: ReadonlyArray<{ key: string; label: string }>;
export const PACKET_CSV_COLUMNS:  ReadonlyArray<{ key: string; label: string }>;

/** RFC 4180, CRLF, no BOM. Column order per PHASE3 §2(d). */
export function buildGatewaysCsv(rows: ViolationGatewayRow[]): string;
export function buildPacketsCsv(rows: ViolationPacketRow[]): string;

/** `mqtt-oktomqtt-violations-gateways-2026-07-24T18-05-00-000Z.csv` */
export function gatewaysCsvFilename(now?: Date): string;
/** `mqtt-oktomqtt-violations-433e0f28-<stamp>.csv` */
export function packetsCsvFilename(gatewayId: string, now?: Date): string;
```

Both builders use `escapeCsv` from `../../utils/nodeExport`. `now` is injectable so filename tests are
deterministic. **No `Blob`, no `document`, no `URL` in this file** — the download side-effect stays in
`downloadTextFile`, mirroring `nodeExport.ts:203-206`'s stated split.

### 3.5 `src/components/Analysis/MqttViolationsReport.module.css` — **NEW**

Only genuinely-new styling; everything shared comes from `.reports-*`.

| Class | Purpose |
|---|---|
| `.sortHeader` | the `<button>` inside a sortable `<th>` — transparent background, `cursor: pointer`, `var(--ctp-subtext0)`, inherits the `th`'s uppercase/letter-spacing |
| `.sortHeaderActive` | active sort column — `var(--ctp-text)` |
| `.sortIcon` | inline sort-direction glyph spacing |
| `.pager` | flex row, gap, `justify-content: space-between`, wraps |
| `.pagerInfo` | muted row-count / page text, `var(--ctp-subtext0)` |
| `.detailCell` | **`padding: 0; white-space: normal;`** — see §2(i); mandatory |
| `.detailInner` | padding + `background: var(--ctp-mantle)` for the drill-down region |
| `.detailHeader` | drill-down title row (gateway id + its export button) |
| `.suspectedCell` | muted monospace suspected count; `var(--ctp-subtext0)` |
| `.suspectedOnlyRow` | de-emphasised row for `violationCount === 0 && suspectedCount > 0` |
| `.mutedZero` | muted `0` in the confirmed cell of a suspected-only row |
| `.sourcesCell` | `white-space: normal; max-width: 18rem` for the source-id list |
| `.topicCell` | `max-width: 22rem; overflow: hidden; text-overflow: ellipsis` with a full `title` |
| `.hint` | the horizon note beside the controls, `font-size: 12px; color: var(--ctp-subtext0)` |
| `.expandButton` | chevron affordance cell |

Catppuccin custom properties only. No hex literals.

### 3.6 `src/components/Analysis/AnalysisTab.tsx` — **EDIT (4 spots)**

1. Import (after `:10`): `import MqttViolationsReport from './MqttViolationsReport';`
2. Union (`:13`): add `| 'mqtt-oktomqtt-violations'`.
3. Registry entry (append inside `:26-45`):
   ```tsx
   {
     id: 'mqtt-oktomqtt-violations',
     title: t('analysis.mqtt_violations.title', 'ok_to_mqtt Violations'),
     description: t(
       'analysis.mqtt_violations.description',
       "Find MQTT gateways that uplinked other nodes' packets even though the sender did not opt in to MQTT (ok_to_mqtt = 0).",
     ),
     icon: 'securityAlert',
   },
   ```
4. Render block cloned from `:62-75`, `selected === 'mqtt-oktomqtt-violations'`.

### 3.7 `public/locales/en.json` — **EDIT (new key block + one amended value)**

**English only.** Other locales carry none of this namespace and fall back to the inline `t()`
defaults — which is why every default must match these values byte-for-byte.

Amend the existing key (§2(a.1)):

```jsonc
"mqtt.packets.violationsStillRecorded": "ok_to_mqtt violation detection keeps running while capture is off — turning capture on only makes the per-packet violation badge visible here. Confirmed violations are always listed in Analysis & Reports → ok_to_mqtt violations.",
```

New flat dotted keys (add near the existing `analysis.*` block):

```jsonc
"analysis.mqtt_violations.title": "ok_to_mqtt Violations",
"analysis.mqtt_violations.description": "Find MQTT gateways that uplinked other nodes' packets even though the sender did not opt in to MQTT (ok_to_mqtt = 0).",

"analysis.mqtt_violations.window": "Window",
"analysis.mqtt_violations.lookback_1d": "24 h",
"analysis.mqtt_violations.lookback_7d": "7 days",
"analysis.mqtt_violations.lookback_30d": "30 days",
"analysis.mqtt_violations.lookback_90d": "90 days",
"analysis.mqtt_violations.from": "From",
"analysis.mqtt_violations.to": "To",
"analysis.mqtt_violations.clear_range": "Clear dates",
"analysis.mqtt_violations.range_error": "The start date must be on or before the end date.",
"analysis.mqtt_violations.horizon_hint": "Confirmed violations are kept for about 90 days. Suspected rows come from the MQTT packet monitor and only reach back {{window}}.",

"analysis.mqtt_violations.include_unknown": "Include unproven (unreadable bit)",
"analysis.mqtt_violations.include_unknown_help": "Also count receptions where the ok_to_mqtt bit could not be read. These are not proven violations and come from a much shorter retention window.",

"analysis.mqtt_violations.run": "Run report",
"analysis.mqtt_violations.rerun": "Re-run report",
"analysis.mqtt_violations.running": "Scanning…",
"analysis.mqtt_violations.prerun": "This report scans every MQTT source you can read for gateways that relayed another node's packet despite ok_to_mqtt = 0. Choose a window and press Run report — nothing is queried until you do.",
"analysis.mqtt_violations.loading": "Scanning MQTT violation history…",

"analysis.mqtt_violations.empty": "No ok_to_mqtt violations in the selected window.",
"analysis.mqtt_violations.empty_good_news": "On a healthy network that is the expected result — it means every MQTT gateway that relayed another node's packet respected the sender's opt-out.",
"analysis.mqtt_violations.empty_forward_only": "Detection is forward-only: packets captured before this feature shipped cannot be classified, so a freshly upgraded install starts empty and fills as new MQTT traffic arrives.",
"analysis.mqtt_violations.no_sources": "No sources available to you.",
"analysis.mqtt_violations.no_sources_hint": "This report reads the MQTT sources you have packet-monitor read access to. If you are signed out or have no source permissions, sign in or ask an administrator. If this install has no sources configured yet, there is nothing to scan.",

"analysis.mqtt_violations.error_invalid_range": "The selected date range is invalid.",
"analysis.mqtt_violations.error_invalid_sort": "That column cannot be sorted.",
"analysis.mqtt_violations.error_fetch_failed": "Failed to read ok_to_mqtt violation history.",

"analysis.mqtt_violations.stat_gateways": "Gateways",
"analysis.mqtt_violations.stat_confirmed": "Confirmed violations",
"analysis.mqtt_violations.stat_suspected": "Suspected",
"analysis.mqtt_violations.stat_originators": "Originators affected",

"analysis.mqtt_violations.col_gateway": "Gateway",
"analysis.mqtt_violations.col_confirmed": "Confirmed",
"analysis.mqtt_violations.col_confirmed_title": "Receptions where the sender's ok_to_mqtt bit was explicitly 0 and a different node published the packet to MQTT. Proven.",
"analysis.mqtt_violations.col_suspected": "Suspected",
"analysis.mqtt_violations.col_suspected_title": "Receptions where the ok_to_mqtt bit could not be read — usually because MeshMonitor has no key for the channel. Not proven, and not sortable.",
"analysis.mqtt_violations.col_originators": "Originators",
"analysis.mqtt_violations.col_sources": "Sources",
"analysis.mqtt_violations.col_first_seen": "First seen",
"analysis.mqtt_violations.col_last_seen": "Last seen",
"analysis.mqtt_violations.sort_by": "Sort by {{column}}",
"analysis.mqtt_violations.suspected_only_title": "No confirmed violations from this gateway in this window — only unproven ones.",

"analysis.mqtt_violations.suspected_caveat": "Suspected rows are not proven violations — the ok_to_mqtt bit could not be read. They come from the MQTT packet monitor's log and only reach back {{window}}, while confirmed violations reach back about 90 days.",
"analysis.mqtt_violations.suspected_unavailable": "Suspected rows need the MQTT packet monitor's capture enabled. The confirmed violations shown here are unaffected.",
"analysis.mqtt_violations.window_hours": "{{hours}} h",
"analysis.mqtt_violations.window_days": "{{days}} days",

"analysis.mqtt_violations.cap_warning": "Showing the first {{cap}} rows. The API caps a single scan at {{cap}} rows, so the total and any later pages are incomplete — narrow the window or select fewer sources.",
"analysis.mqtt_violations.cap_warning_asc": "Sorting ascending inside a capped scan orders only those {{cap}} rows, not the whole window.",

"analysis.mqtt_violations.export_csv": "Export CSV",
"analysis.mqtt_violations.export_done": "Exported {{count}} rows",
"analysis.mqtt_violations.export_capped": "Exported {{exported}} of {{total}} matching rows — the API caps a single scan at {{cap}} rows. Narrow the window to export the rest.",
"analysis.mqtt_violations.export_failed": "Export failed",

"analysis.mqtt_violations.total_rows": "{{total}} gateways",
"analysis.mqtt_violations.total_rows_capped": "{{cap}}+ gateways",
"analysis.mqtt_violations.page": "Page {{page}} of {{pages}}",
"analysis.mqtt_violations.prev": "Previous",
"analysis.mqtt_violations.next": "Next",
"analysis.mqtt_violations.page_size": "Rows per page",

"analysis.mqtt_violations.expand": "Show violating packets",
"analysis.mqtt_violations.collapse": "Hide violating packets",
"analysis.mqtt_violations.drill_title": "Violating packets published by {{gateway}}",
"analysis.mqtt_violations.drill_loading": "Loading packets…",
"analysis.mqtt_violations.drill_empty": "No individual rows for this gateway in this window.",
"analysis.mqtt_violations.drill_empty_hint": "Unproven receptions are hidden — turn on \"Include unproven\" to see them.",
"analysis.mqtt_violations.dcol_state": "ok_to_mqtt",
"analysis.mqtt_violations.dcol_time": "Time",
"analysis.mqtt_violations.dcol_source": "Source",
"analysis.mqtt_violations.dcol_from": "From",
"analysis.mqtt_violations.dcol_channel": "Channel",
"analysis.mqtt_violations.dcol_port": "Port",
"analysis.mqtt_violations.dcol_packet_id": "Packet ID",
"analysis.mqtt_violations.dcol_bitfield": "Bitfield",
"analysis.mqtt_violations.dcol_topic": "Topic",
"analysis.mqtt_violations.dcol_rx_time": "RX time"
```

**No new `VALID_SETTINGS_KEYS` entry and no `SettingsTab` field** in this phase — so the
`server.settings-persistence.test.ts` allowlist trap (Phase 1 note 4) is avoided by construction, as
in Phase 2.

### 3.8 `src/components/MQTT/MqttPacketMonitorView.tsx` — **EDIT (2 inline defaults)**

Replace the `t()` default at `:341` and at `:470` with the canonical string from §2(a.1). **String
only** — no logic, no new hooks, no `any`. (Zero baseline headroom on this file.)

### 3.9 Tests — see §4 for content

- `src/components/Analysis/MqttViolationsReport.test.tsx` — **NEW**
- `src/components/Analysis/mqttViolationsCsv.test.ts` — **NEW**
- `src/components/MQTT/MqttPacketMonitorView.test.tsx` — **EDIT** (three exact-string assertions at
  `:386`, `:397`, `:410`)

---

## 4. Test plan

Standard Vitest + Testing Library. **No standalone scripts.** Harness copied from
`NodeInfoEnrichmentReport.test.tsx:1-69` (§1.9) — including the local `react-i18next` mock, without
which every string assertion fails.

### 4.1 `mqttViolationsCsv.test.ts` (pure, no jsdom needed)

| # | Test |
|---|---|
| C1 | `buildGatewaysCsv` emits the header in `GATEWAY_CSV_COLUMNS` order and one row per input, joined with `\r\n`, no BOM. |
| C2 | **Escaping**: a `gatewayId`/`sourceIds` value containing `,`, `"`, and `\n` is quoted with doubled quotes per RFC 4180 (proves `escapeCsv` is actually applied, and that AuditLogTab's comma-swap was not copied). |
| C3 | `sourceIds` joins with `'; '`; a single-source row has no separator. |
| C4 | `firstSeen`/`lastSeen`/`timestamp`/`rxTime` render as ISO-8601 UTC; `null`/`0` render as an empty field. |
| C5 | `buildPacketsCsv` includes `kind` as the first column and renders `bitfield: 0` as `0` (not blank — `0` is meaningful here). |
| C6 | `gatewaysCsvFilename(new Date('2026-07-24T18:05:00Z'))` contains no `:` or `.` in the stamp; `packetsCsvFilename('!433e0f28', d)` contains `433e0f28` and no `!`. |
| C7 | `buildViolationParams` (from `mqttViolationTypes.ts`): emits `lookbackDays` and **no** `since`/`until` when dates are empty; emits `since`+`until` and **no** `lookbackDays` when both dates are set, with `until` normalized to 23:59:59.999; omits `includeUnknown` entirely when false and emits `includeUnknown=true` when true; clamps `lookbackDays` to 1..365. |

### 4.2 `MqttViolationsReport.test.tsx` (jsdom)

| # | Test | Assertion |
|---|---|---|
| 1 | **Pre-run defers** | On mount, `.prerun` text is present and `api.get` has **not** been called (`expect(api.get).not.toHaveBeenCalled()`). |
| 2 | **Run fires one request with default params** | Click Run → exactly one `api.get` call whose URL is `/api/analysis/mqtt-violations/gateways?...` containing `lookbackDays=7`, `sort=violationCount`, `dir=desc`, `limit=50`, `offset=0`, and **no** `includeUnknown`. |
| 3 | **Gateway summary renders from `body.data`** | Mocked envelope `{ success: true, data: { gateways: [2 rows], total: 2, … } }` → both `gatewayId`s and their `violationCount`s appear; the stats tiles show the derived totals. Proves the envelope is unwrapped (a mock returning the bare payload must make this test fail). |
| 4 | **Sorting issues the right params** | Click the "Confirmed" header → new request with `sort=violationCount&dir=asc`; click "Last seen" → `sort=lastSeen&dir=desc`; `offset` resets to 0. |
| 5 | **No unsupported sort offered** | The `Suspected`, `First seen`, and `Sources` headers render **no** `button` (query by role within the header cell) — the API has no whitelist entry for them. |
| 6 | **Pagination** | With `total: 130, limit: 50`, the pager reads "Page 1 of 3"; Next → request with `offset=50`; changing page size to 25 → `limit=25&offset=0`. |
| 7 | **Cap honesty** | With `total: 5000`, the row count renders `2,000+ gateways`, the `.cap_warning` banner is present, and the pager offers at most `ceil(2000/limit)` pages (Next is disabled on the last reachable page). With `dir: 'asc'` also asserts `.cap_warning_asc`. |
| 8 | **`includeUnknown` changes request and rendering** | Toggle on → Run → request contains `includeUnknown=true`; a `Suspected` column header appears; a row with `violationCount: 0, suspectedCount: 5` renders a muted `0`, the suspected count, and `data-suspected-only="true"`; the `.suspected_caveat` banner shows the formatted window (`24 h` for `86400000`). Toggling off and re-running removes all of it. |
| 9 | **Drill-down fetch + render** | Click a gateway row → a second `api.get` to `/mqtt-violations/packets?...gateway=%21433e0f28...` with `sort=timestamp&dir=desc&limit=100&offset=0`; the returned rows render inside the expanded detail; the reused marker shows `violation` for `kind: 'confirmed'` and `unknown` for `kind: 'suspected'` (asserted via the marker's own English text). Clicking again collapses and no third request fires. |
| 10 | **Drill-down states** | Separate cases: pending → `.drill_loading`; rejected → `.drill_error` message; `{ violations: [], total: 0 }` → `.drill_empty` (plus `.drill_empty_hint` only when the toggle is off). The summary table remains rendered in all three. |
| 11 | **`suspectedAvailable` trap** | A **default-params** response with `includeUnknown: false, suspectedAvailable: false, suspectedWindowMs: 0` renders **no** `.suspected_unavailable` text and **no** `.suspected_caveat` — asserted with `queryByText(...)` being `null`. A response with `includeUnknown: true, suspectedAvailable: false` **does** render `.suspected_unavailable`. |
| 12 | **Empty = good news** | `{ gateways: [], total: 0, sources: ['mqtt-a'] }` → `.empty` + `.empty_good_news` + `.empty_forward_only`; **no** error styling; and (with the toggle off) no packet-monitor hint. |
| 13 | **Zero permission is distinguished** | `{ gateways: [], total: 0, sources: [] }` → `.no_sources` + `.no_sources_hint`, and **not** `.empty_good_news`. |
| 14 | **Error mapping** | `api.get` rejecting with `new ApiError('boom', 500, { code: 'MQTT_VIOLATIONS_FETCH_FAILED' })` → `.error_fetch_failed`; with `code: 'INVALID_SORT_FIELD'` → `.error_invalid_sort`; with no code → the raw `message`. |
| 15 | **Client-side range guard** | Setting From later than To disables the Run button and shows `.range_error`; no request is fired. |
| 16 | **CSV export re-fetches the full set and reports the cap** | Click Export → an `api.get` (or `fetchQuery`) with `limit=2000&offset=0` and the same filters/sort. With `total: 3412` the `.export_capped` message names `2000`, `3412`, and the cap. Assert **the generated string** via a spy on `downloadTextFile` (mock `../../utils/nodeExport`) — the DOM side-effect itself is out of scope (already covered by `nodeExport.test.ts`). |
| 17 | **Filters are draft-gated** | Changing the window preset or the toggle without pressing Run fires **no** request (call count unchanged), proving a multi-source scan cannot be triggered by fiddling. |

### 4.3 `MqttPacketMonitorView.test.tsx` — EDIT

Update the three exact-string assertions at `:386`, `:397`, `:410` to the §2(a.1) canonical string.
The test title at `:377` stays accurate; optionally extend it to `…and points at Reports`.

### 4.4 Suite / gate expectations

- Full Vitest run, `success: true` from `--reporter=json` (not the summary line — `rtk`'s
  `PASS/FAIL` summary counts only assertion failures).
- This phase touches no schema and no migration, so the PostgreSQL/MySQL containers are **not**
  required for a meaningful run.
- `npx tsc --noEmit` clean.
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → **empty**. Do **not** run
  `npm run lint:baseline`; no rule count may grow (§1.11).

---

## 5. Browser validation plan

Deploy the branch to the dev container (`docker-compose.dev.yml` **+** `docker-compose.dev.local.yml`,
built from this worktree, `--no-cache`), then drive `http://localhost:8081/meshmonitor`.

Login `admin` / `changeme`. **Login is rate-limited — do not brute-force.** If it locks, wait it out
or query the DB rather than retrying.

**Real data exists:** Phase 2 validation found **7 offending gateways** in the durable table across
**3 MQTT sources**, the worst with **22 confirmed violations**. No staging is required. The MQTT
packet monitor is expected to be **enabled** on this box (Phase 2 used it), so `includeUnknown=true`
should return real suspected rows too — if it does not, check `mqtt_packet_log_enabled` before
assuming a bug.

| # | Step | Assert |
|---|---|---|
| V1 | Navigate to Reports (`/reports`) | An `ok_to_mqtt Violations` card is present with the `securityAlert` icon; click it. |
| V2 | Landing on the report | The pre-run banner shows; **DevTools Network shows no `mqtt-violations` request**. This is the deferral proof — take the network log, not a screenshot alone. |
| V3 | Press **Run report** | Exactly one `GET /api/analysis/mqtt-violations/gateways?lookbackDays=7&…` (200). The table lists real gateways; cross-check the top row's `violationCount` against the Packet Monitor's badge counts / a direct `scripts/api-test.sh get` call on the same endpoint. |
| V4 | Sort | Click **Confirmed** → request repeats with `dir=asc`; the first row becomes the *lowest* count and the header shows the ascending indicator. Click **Last seen** → `sort=lastSeen`; row order changes and matches the rendered timestamps. |
| V5 | Paginate | Set rows-per-page to 25; if `total > 25`, Next issues `offset=25` and the row set changes; the pager label tracks. With only 7 gateways, confirm the pager is correctly disabled instead of offering a dead page. |
| V6 | Drill-down | Click the worst gateway's row → one `GET …/packets?…gateway=!…`; the expanded region lists that gateway's packets, **every** `Gateway` value in it equals the parent row's id, and each row's ok_to_mqtt cell renders the reused `violation` badge (visually identical to the Packet Monitor's). Click again → collapses, no new request. |
| V7 | **Include unproven** | Toggle on, Run. The request carries `includeUnknown=true`; a `Suspected` column appears; **counts change** vs V3 (expect suspected ≫ confirmed on a public broker — Phase 2 measured 258/500 packets as `unknown`); the horizon caveat shows a real window (`24 h`); at least one suspected-only row (`violationCount 0`) renders de-emphasised. Toggle off + Run → the column, caveat, and those rows disappear and **no** "unavailable" text appears (the `suspectedAvailable` trap, verified in the live app). |
| V8 | Window control | Switch to **90 days** → `lookbackDays=90` and counts are ≥ the 7-day counts. Set explicit From/To covering a single past day → request carries `since`/`until` (not `lookbackDays`) and `until` ends at 23:59:59.999 of the chosen day. Set From after To → Run is disabled and the inline range error shows. |
| V9 | CSV — gateway summary | Click Export CSV → a file downloads named `mqtt-oktomqtt-violations-gateways-<stamp>.csv` with no `:` in the name. Open it: header matches §2(d), row count matches the on-screen total, a `sourceIds` cell with several sources is `; `-joined, and timestamps are ISO-8601. |
| V10 | CSV — drill-down | Inside an expanded gateway, click its Export → filename contains the gateway hex, every row's `gatewayId` is that gateway, and `kind` is present. |
| V11 | **Wide-table containment** (the Phase 2 lesson) | At **1280×800** and again at **390×844**: both the summary and the expanded drill-down scroll horizontally **inside their own `.reports-table-wrap`**, and `document.documentElement.scrollWidth <= document.documentElement.clientWidth` (evaluate it, don't eyeball it) — the page itself never scrolls sideways. Also confirm the expanded detail cell is not squashed by the inherited `white-space: nowrap`. |
| V12 | Empty / good-news path | Pick a window with no data (e.g. explicit From/To in the far past, before the feature shipped) → the good-news + forward-only banners show, not an error, and no "unavailable" text. |
| V13 | Anonymous view | In a fresh incognito context, open `/reports` → the report card is visible (the route is public); running it shows either real data (if anonymous has `packetmonitor` read) or the **No sources available to you** banner — never a raw error and never the good-news text. |
| V14 | Capture-off note (inherited item 1) | Confirm the amended string is in the served bundle and points at Reports. **Do not toggle `mqtt_packet_log_enabled` off on this live box** — it is global and would interrupt real capture; Phase 2 made the same call. Bundle-grep + the component tests are the coverage. |
| V15 | Console | No React key warnings, no `exhaustive-deps` dev warnings, no uncaught errors across V1–V13. |

---

## 6. Work packages

Four packages. Parallelism: **WP1 ∥ WP4** first, then **WP2**, then **WP3**.

> **Concurrency note for parallel agents in one worktree:** commit with
> `git commit -- <paths>` or `rtk proxy git commit`. The `rtk` git wrapper auto-stages and will
> otherwise sweep another agent's in-progress files into your commit.

### WP1 — Types, param builder, CSV core

**Depends on:** nothing. **Parallel with:** WP4.
**Owns:** `src/components/Analysis/mqttViolationTypes.ts` (new),
`src/components/Analysis/mqttViolationsCsv.ts` (new),
`src/components/Analysis/mqttViolationsCsv.test.ts` (new),
`src/utils/nodeExport.ts` (one-keyword edit, §3.3).

Scope: §3.1, §3.3, §3.4, and tests C1–C7 of §4.1.

Acceptance:
- `escapeCsv` exported; `nodeExport.test.ts` still green; no rename.
- Both CSV builders are pure (no `Blob`/`document`/`URL` anywhere in the file) and RFC 4180 correct
  including `"`/`,`/newline cases.
- `buildViolationParams` obeys the `lookbackDays` XOR `since`+`until` rule, the end-of-day
  normalization, the `includeUnknown`-only-when-true rule, and the 1..365 clamp.
- `tsc --noEmit` clean; no `any`; `lint:ci` in-repo `FAIL` count unchanged.

### WP2 — Report shell: filters, deferred run, summary table, all states, registration

**Depends on:** WP1 (imports its types). **Blocks:** WP3.
**Owns:** `src/components/Analysis/MqttViolationsReport.tsx` (new),
`src/components/Analysis/MqttViolationsReport.module.css` (new),
`src/components/Analysis/AnalysisTab.tsx` (4 edits),
`src/components/Analysis/MqttViolationsReport.test.tsx` (new).

Scope: §2(a.2), §2(c), §2(e), §2(f), §2(g), §2(h), §2(i), §3.2, §3.5, §3.6; tests 1–8, 11–15, 17 of
§4.2. Leaves two clearly-commented seams for WP3: `// WP3: drill-down detail row` inside the table
body and `// WP3: CSV export` on the (rendered but disabled) Export button.

Acceptance:
- Report reachable from the Reports card grid; pre-run fires no request.
- Only the 4 whitelisted gateway columns are sortable; server-side `sort`/`dir`/`limit`/`offset`.
- Cap rules of §2(c) implemented (`2,000+` label, clamped pager, both warning variants).
- All six render states of §2(g) plus the error-code map.
- `suspectedAvailable` read only under `includeUnknown` (test 11 green).
- Uses `api` only (no raw `fetch`), no `useEffect` fetching, no `any`, `UiIcon` for every icon, no
  hex colours, `.reports-table-wrap` around the table.
- `lint:ci` in-repo `FAIL` count unchanged; `tsc --noEmit` clean.

### WP3 — Drill-down + CSV wiring

**Depends on:** WP1 (builders) **and** WP2 (owns the component file — WP3 edits it **after** WP2 has
landed its version; do not run them concurrently).
**Owns (shared, sequential):** `MqttViolationsReport.tsx`, `MqttViolationsReport.module.css`,
`MqttViolationsReport.test.tsx`.

Scope: §2(b), §2(d); tests 9, 10, 16 of §4.2, plus the drill-down's own cap handling.

Acceptance:
- Single-open accordion; independent `sort`/`dir`/`limit`/`offset`; offset resets on
  collapse/gateway-change; its loading/error/empty states render inside the detail cell without
  unmounting the summary.
- Reuses `okToMqttState()` + `MqttOkToMqttMarker` with the `kind`→fields adapter of §2(a.3); imports
  `MqttPacketMonitor.css`; **never** recomputes `relayed`.
- `.detailCell { padding: 0; white-space: normal }` present, and the nested table has its **own**
  `.reports-table-wrap`.
- Both exports call `downloadTextFile` with WP1's builders, request `limit=2000&offset=0`, and
  surface the cap visibly (never silently truncate).

### WP4 — i18n strings + capture-off note pointing at the report

**Depends on:** nothing. **Parallel with:** WP1/WP2/WP3 (sole owner of every file it touches).
**Owns:** `public/locales/en.json`, `src/components/MQTT/MqttPacketMonitorView.tsx`,
`src/components/MQTT/MqttPacketMonitorView.test.tsx`.

Scope: §2(a.1), §3.7, §3.8, §4.3.

Acceptance:
- The full `analysis.mqtt_violations.*` block from §3.7 is present, valid JSON, `en` only.
- `mqtt.packets.violationsStillRecorded` and **both** inline `t()` defaults (`:341`, `:470`) carry the
  §2(a.1) canonical string **byte-for-byte identical**, and the three test assertions are updated.
- No `VALID_SETTINGS_KEYS` change, no `SettingsTab` field (avoids the settings-persistence allowlist
  trap by construction).
- `MqttPacketMonitorView.test.tsx` green; `lint:ci` unchanged (this file has zero headroom, but the
  change is string-only).

### Cross-package exit criteria (whole phase)

1. Full Vitest suite `success: true` via `--reporter=json`.
2. `npx tsc --noEmit` clean.
3. `npm run lint:ci` → no in-repo `FAIL`; `eslint-baseline.json` **unchanged**.
4. §5 browser validation performed on the live dev container against real violation data, including
   V11 (wide-table containment at both viewports) and V7 (the `suspectedAvailable` trap in the real
   app).
5. Epic doc updated with a Phase 3 "Deviations / notes" section — at minimum: the `escapeCsv` naming
   correction, the 2000-cap semantics in *both* modes, and the zero-headroom baseline finding.
6. PR merged; **issue #4114 closed**.
