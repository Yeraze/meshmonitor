# NodeInfo Enrichment — Phase 2 (Frontend) Implementation Spec

Epic: #3837. Branch: `feature/nodeinfo-enrichment-report`. Phase 1 backend is merged
to `origin/main` (analysis + apply endpoints live). This phase adds the
**"NodeInfo Enrichment"** card to the Analysis & Reports grid and its report
component. No backend changes are in scope.

Authoritative Phase 1 contract (verified against the merged code, not just the P1 spec):

- **Legacy surface used by the frontend** (`src/server/routes/nodesRoutes.ts:156-157`,
  `optionalAuth()`):
  - `GET  /api/nodes/enrichment/analysis`
  - `POST /api/nodes/enrichment/apply`
- Both return the envelope `{ success: true, data: {...} }`. **`ApiService.request()`
  returns the raw body and does NOT unwrap `data`** (CLAUDE.md gotcha) → the report
  must read `body.data`.
- Analysis is permission-narrowed and **never 403s**: an anonymous/limited caller gets
  `200 { success:true, data:{ nodes:[], summary:{ nodeCount:0, targetCount:0, fieldCount:0 } } }`
  (`enrichmentHandlers.ts` `handleEnrichmentAnalysis`).
- Apply is fail-closed: `400 INVALID_REQUEST` (empty items), `400 INVALID_ITEM`
  (malformed item / donor==target), `403 FORBIDDEN { missing:[{sourceId,action}] }`
  (missing read on a donor or write on a target), `500 ENRICHMENT_APPLY_FAILED`.

### Response shapes (exact)

```jsonc
// GET /api/nodes/enrichment/analysis  → 200
{ "success": true, "data": {
  "nodes": [
    { "nodeNum": 123456, "nodeId": "!0001e240", "displayName": "Base Station",
      "targets": [
        { "targetSourceId": "src-b", "targetSourceName": "MQTT",
          "fillableFields": ["longName","hwModel","role"],   // hasPKC never appears (P1 decision)
          "donorSourceId": "src-a", "donorSourceName": "Primary TCP" }
      ] }
  ],
  "summary": { "nodeCount": 1, "targetCount": 1, "fieldCount": 3 }
} }

// POST /api/nodes/enrichment/apply  body
{ "items": [ { "nodeNum": 123456, "targetSourceId": "src-b", "donorSourceId": "src-a" } ],
  "pushToNodeDb": false }
// → 200
{ "success": true, "data": {
  "applied": [
    { "nodeNum": 123456, "targetSourceId": "src-b", "donorSourceId": "src-a",
      "copiedFields": ["longName","hwModel","role"], "pushedToDevice": false }
  ],
  "totalFieldsCopied": 3
} }
```

The report's **row unit is one `(node, target)` pair**: flatten every
`node.targets[]` into table rows. Each row already carries its own
`nodeNum`/`targetSourceId`/`donorSourceId`, which is exactly the apply item shape —
per-row **Fix** posts `{ items:[thatRow], pushToNodeDb }`; **Fix All** posts every
row's item in one call.

---

## 1. Reuse Inventory

| Mechanism | Location (file:line) | Use in Phase 2 |
|-----------|----------------------|----------------|
| Card-grid pattern: `AnalysisType` union + `AnalysisCard` + `reports[]` + selected-branch | `src/components/Analysis/AnalysisTab.tsx:16,29,58` | Extend, don't rewrite. Add `'nodeinfo-enrichment'` to the union, one `reports[]` entry, one selected-branch. No `VALID_TABS` change (this is a router route, not an app tab). |
| Structural template (report layout, `useQuery`, `UiIcon`, i18n, states) | `src/components/Analysis/SolarMonitoringReport.tsx` | Copy the **shape** (`reports-section__title`, banners, `useQuery`), NOT its data layer. **Do NOT reuse its local `fetchJson` raw-`fetch` helper (`SolarMonitoringReport.tsx:107`)** — raw `fetch()` is ESLint-banned in `src/components/**`; that file is a pre-existing baselined exception. New code uses `ApiService`. |
| `ApiService` singleton (default export `api`) with `.get<T>(endpoint)` / `.post<T>(endpoint, body)` | `src/services/api.ts` (`get` / `post` methods; `request()` auto-injects CSRF for POST, `credentials:'include'`, throws `ApiError{status,code,body}`) | **The blessed data + mutation layer.** `api.get('/api/nodes/enrichment/analysis')` and `api.post('/api/nodes/enrichment/apply', body)`. baseUrl is resolved internally (set from `appBasename` in `main.tsx`); the component does **not** need a `baseUrl` prop for calls. CSRF handled by `request()` — do **not** hand-roll `useCsrfFetch`/`csrfFetch` (that's the legacy path CopyNodeInfoModal uses). |
| `ApiError` (typed error with `.status` / `.code` / `.message`) | `src/services/api.ts` (`export class ApiError`) | Discriminate apply failures (e.g. 403 `FORBIDDEN`) for the error toast. `useQuery`/`useMutation` surface the thrown `ApiError` as `error`. |
| TanStack Query provider | mounted app-wide in `src/main.tsx:129` (`<QueryClientProvider client={queryClient}>` wraps the whole router) | `ReportsPage` is a route inside it → `useQuery`/`useMutation`/`useQueryClient` work in production with no extra provider. Tests must supply their own (see §3). |
| `useToast()` → `{ showToast(message, type, duration?) }`, `type` = `ToastProps['type']` | `src/components/ToastContainer.tsx:11,22`; `ToastProvider` wraps `ReportsPage` (`src/pages/ReportsPage.tsx`) | Success/error feedback after apply. Confirm the exact `type` union in `src/components/Toast.tsx` (`'success' \| 'error' \| ...`). |
| `UiIcon` + `UiIconName` | `src/components/icons/index.ts`; registry in `src/components/icons/UiIcon.tsx:142-242` | All icons. Valid names available include `identity` (IdCard — "node identifiers"), `copy`, `database`, `sparkles`, `refresh`, `check`, `wrench`, `link`, `info`. **No hardcoded emoji/Unicode** (CLAUDE.md hard rule). |
| Shared analysis CSS | `src/styles/analysis-reports.css` (imported by `ReportsPage.tsx`) — classes incl. `.reports-section__title/__subtitle`, `.reports-panel`, `.reports-stats/.reports-stat/__label/__value`, `.reports-table/.reports-table-wrap`, `.reports-btn/--ghost`, `.reports-banner/--error/--empty`, `.reports-pill/--ok/--warn` | Reuse for the whole layout. Add only the few enrichment-specific classes named in §2d to this same file. |
| Field display-name labels: local `DISPLAY_FIELDS` (`longName→"Long Name"`, etc.) | `src/components/CopyNodeInfoModal/CopyNodeInfoModal.tsx` (`const DISPLAY_FIELDS = [...] as const`) — **not exported** | **Reuse-over-duplication:** extract to a shared module (§2a) and have BOTH CopyNodeInfoModal and the new report import it, rather than the report redefining a second label map. The 8 keys match `NODE_INFO_FIELDS` in `nodeInfoCopyService.ts`. |
| Backend-provided display name / id | analysis response fields `node.displayName`, `node.nodeId` | Render directly. **No** `nodeHelpers`/`formatNodeId` call is needed on the frontend — Phase 1 already computed these. |

### New code (justified)
- `src/components/Analysis/NodeInfoEnrichmentReport.tsx` — the report itself. No
  existing component renders a cross-source enrichment table; SolarMonitoringReport is
  chart-shaped and not adaptable.
- `src/utils/nodeInfoFields.ts` — shared field-label map extracted from
  CopyNodeInfoModal (see §2a). Justified by the reuse rule: two consumers now need it.
- `src/components/Analysis/NodeInfoEnrichmentReport.test.tsx` — component tests.

---

## 2. File-by-File Changes

### 2a. `src/utils/nodeInfoFields.ts` (NEW — extract shared labels)

Move the label list out of CopyNodeInfoModal so both components share one source of truth.

```ts
// One label per NodeInfo field. Keys match NODE_INFO_FIELDS in nodeInfoCopyService.
// Plain strings (matching the existing modal, which does not i18n these) — keep parity;
// i18n of field labels is out of scope for this phase.
export const NODE_INFO_DISPLAY_FIELDS = [
  { key: 'longName',        label: 'Long Name' },
  { key: 'shortName',       label: 'Short Name' },
  { key: 'hwModel',         label: 'Hardware Model' },
  { key: 'role',            label: 'Role' },
  { key: 'macaddr',         label: 'MAC Address' },
  { key: 'publicKey',       label: 'Public Key' },
  { key: 'hasPKC',          label: 'Has PKC' },
  { key: 'firmwareVersion', label: 'Firmware' },
] as const;

export type NodeInfoFieldKey = typeof NODE_INFO_DISPLAY_FIELDS[number]['key'];

export const NODE_INFO_FIELD_LABELS: Record<NodeInfoFieldKey, string> =
  Object.fromEntries(NODE_INFO_DISPLAY_FIELDS.map(f => [f.key, f.label])) as Record<NodeInfoFieldKey, string>;

/** Map a fillableFields key to its human label, falling back to the raw key. */
export function nodeInfoFieldLabel(key: string): string {
  return (NODE_INFO_FIELD_LABELS as Record<string, string>)[key] ?? key;
}
```

Then refactor **`CopyNodeInfoModal.tsx`**: delete its local `const DISPLAY_FIELDS`
and `import { NODE_INFO_DISPLAY_FIELDS as DISPLAY_FIELDS } from '../../utils/nodeInfoFields'`
(alias to minimize the diff). Leave `formatFieldValue`/`formatTimestamp` in the modal
(report doesn't need them; the analysis endpoint reports field *names*, not values).

> `hasPKC` never appears in `fillableFields` (Phase 1 excludes it from analysis), so the
> report will only ever render 7 of these labels — but the map stays complete for the modal.

### 2b. `src/components/Analysis/NodeInfoEnrichmentReport.tsx` (NEW)

**Imports:** `useMemo, useState` (react); `useQuery, useMutation, useQueryClient` (@tanstack/react-query);
`useTranslation` (react-i18next); `api, { ApiError }` (`../../services/api`); `useToast`
(`../ToastContainer`); `UiIcon` (`../icons`); `nodeInfoFieldLabel` (`../../utils/nodeInfoFields`).

**Types (local):**
```ts
interface EnrichmentTarget { targetSourceId: string; targetSourceName: string;
  fillableFields: string[]; donorSourceId: string; donorSourceName: string; }
interface EnrichmentNode { nodeNum: number; nodeId: string; displayName: string;
  targets: EnrichmentTarget[]; }
interface EnrichmentSummary { nodeCount: number; targetCount: number; fieldCount: number; }
interface EnrichmentAnalysis { nodes: EnrichmentNode[]; summary: EnrichmentSummary; }
interface ApplyItem { nodeNum: number; targetSourceId: string; donorSourceId: string; }
interface ApplyResult {
  applied: Array<ApplyItem & { copiedFields: string[]; pushedToDevice: boolean }>;
  totalFieldsCopied: number; }
```

**Query key constant:** `const ANALYSIS_KEY = ['nodeinfo-enrichment-analysis'] as const;`

**Data fetch (envelope-aware):**
```ts
const { data, isLoading, error, isFetching } = useQuery<EnrichmentAnalysis>({
  queryKey: ANALYSIS_KEY,
  queryFn: async () => {
    const body = await api.get<{ success: boolean; data: EnrichmentAnalysis }>(
      '/api/nodes/enrichment/analysis');
    return body.data;              // <-- unwrap the envelope (ApiService does NOT)
  },
});
```
Fetch on mount (no `enabled` gate — unlike Solar, this report has no input params and
is safe/cheap for any caller). A `.reports-btn--ghost` "Refresh" button calls
`queryClient.invalidateQueries({ queryKey: ANALYSIS_KEY })`.

**State:** `const [pushToNodeDb, setPushToNodeDb] = useState(false);` (toggle DEFAULT OFF).

**Mutation (shared by Fix and Fix All):**
```ts
const qc = useQueryClient();
const { showToast } = useToast();
const applyMutation = useMutation<ApplyResult, ApiError, ApplyItem[]>({
  mutationFn: async (items) => {
    const body = await api.post<{ success: boolean; data: ApplyResult }>(
      '/api/nodes/enrichment/apply', { items, pushToNodeDb });
    return body.data;
  },
  onSuccess: (result) => {
    const errored = result.applied.filter(a => a.copiedFields.length === 0);
    showToast(
      t('analysis.enrichment.apply_success',
        'Copied {{fields}} field(s) across {{targets}} target(s)',
        { fields: result.totalFieldsCopied, targets: result.applied.length }),
      'success');
    void qc.invalidateQueries({ queryKey: ANALYSIS_KEY }); // refresh → fixed rows drop out
  },
  onError: (err) => {
    showToast(err?.message
      ?? t('analysis.enrichment.apply_error', 'Failed to apply enrichment'), 'error');
  },
});
```
- **Fix (per row):** `applyMutation.mutate([row])`. Disable that row's button while
  `applyMutation.isPending` (and track which row is in flight via a `useState<string|null>`
  keyed by `${nodeNum}:${targetSourceId}` so only the clicked row shows a spinner label).
- **Fix All:** `applyMutation.mutate(allRows.map(toItem))`. Disable while pending or when
  `rows.length === 0`.

> Per-item results: after success the analysis is invalidated and re-fetched, so
> successfully-filled `(node,target)` rows disappear (their fields are no longer blank).
> The toast reports `totalFieldsCopied` + count. A row that copied 0 fields (raced/already
> filled) simply remains — no destructive UI needed. This satisfies "show per-item
> results + refresh + toast" without a bespoke results panel.

**Derived rows:**
```ts
const rows = useMemo(() =>
  (data?.nodes ?? []).flatMap(n =>
    n.targets.map(tg => ({ ...tg, nodeNum: n.nodeNum, nodeId: n.nodeId,
      displayName: n.displayName,
      rowKey: `${n.nodeNum}:${tg.targetSourceId}` }))), [data]);
```

**Render branches (in order):**
1. **Loading** (`isLoading`): `.reports-banner` "Analyzing NodeInfo across sources…".
2. **Error** (`error`): `.reports-banner reports-banner--error` with `(error as Error).message`.
3. **Empty** (`rows.length === 0`): `.reports-banner reports-banner--empty` —
   primary line `t('analysis.enrichment.empty','No nodes need enrichment.')`, plus a muted
   secondary line covering the anonymous/limited case (see §Anonymous below).
4. **Populated:** summary stats + push toggle + Fix All + table.

**Header/summary** (reuse `reports-section__title/__subtitle`, `reports-stats`):
```
<h2 className="reports-section__title"><UiIcon name="identity" size={22}/> NodeInfo Enrichment</h2>
<p className="reports-section__subtitle">Fill blank NodeInfo fields for nodes seen on
   multiple sources, copying from the source that already has the data.</p>
<div className="reports-stats">
  reports-stat: summary.nodeCount  "Nodes"
  reports-stat: summary.targetCount "Targets"
  reports-stat: summary.fieldCount  "Fillable fields"
</div>
```

**Controls row** (`.reports-panel` / `.reports-controls`):
- Push toggle: `<label><input type="checkbox" checked={pushToNodeDb}
  onChange={e=>setPushToNodeDb(e.target.checked)} disabled={applyMutation.isPending}/>
  Also push to device NodeDB</label>` + muted help text. (Mirrors CopyNodeInfoModal's
  `copy-nodeinfo-push-option`.)
- Fix All button (`.reports-btn`), `<UiIcon name="sparkles"/>`, disabled when
  `applyMutation.isPending || rows.length===0`.
- Refresh button (`.reports-btn--ghost`), `<UiIcon name="refresh"/>`, disabled while
  `isFetching`.

**Table** (`.reports-table-wrap` > `<table className="reports-table">`): columns
| Node | Target source | Fillable fields | Donor source | Action |. Per row:
- Node cell: `{displayName}` bold + `{nodeId}` in a muted `<span>` (reuse
  `.reports-node__name` / a muted class or inline `.reports-node__meta`).
- Fillable fields: map `fillableFields` to `<span className="reports-pill">` per
  `nodeInfoFieldLabel(f)`.
- Action: Fix button (`.reports-btn`), `<UiIcon name="copy"/>`, label switches to
  "Fixing…" when that row is the in-flight one; `disabled={applyMutation.isPending}`.

**Props:** none. AnalysisTab renders `<NodeInfoEnrichmentReport />` (no `baseUrl` prop —
ApiService owns the base path). This avoids an unused-var lint hit.

**exhaustive-deps:** the only `useMemo` dep is `data`; `mutationFn`/callbacks close over
`pushToNodeDb`/`t`/`qc`/`showToast` which are stable or intentionally captured — keep
deps honest, do NOT add an `eslint-disable`. (react-hooks/exhaustive-deps is a frozen
ratchet rule; new violations fail CI.)

### 2c. `src/components/Analysis/AnalysisTab.tsx` (MODIFY — register the card)

- `import NodeInfoEnrichmentReport from './NodeInfoEnrichmentReport';`
- Union: `type AnalysisType = 'solar-monitoring' | 'nodeinfo-enrichment' | null;`
- Add to `reports[]`:
  ```ts
  { id: 'nodeinfo-enrichment',
    title: t('analysis.enrichment.title', 'NodeInfo Enrichment'),
    description: t('analysis.enrichment.description',
      'Fill blank NodeInfo fields (name, hardware, role, …) for nodes seen on multiple sources by copying from a source that already has the data.'),
    icon: 'identity' },
  ```
- Add selected-branch (mirror the solar branch, `.reports-section` + back button):
  ```tsx
  if (selected === 'nodeinfo-enrichment') {
    return (
      <div className="reports-section">
        <button type="button" className="reports-section__back" onClick={() => setSelected(null)}>
          <UiIcon name="back" size={16} /> {t('analysis.back_to_reports', 'Back to reports')}
        </button>
        <NodeInfoEnrichmentReport />
      </div>
    );
  }
  ```
  (`baseUrl` prop stays on `AnalysisTab` for Solar; the new report ignores it.)

### 2d. `src/styles/analysis-reports.css` (MODIFY — additive only)

Most styling reuses existing classes. Add only what's missing (append near the other
`.reports-*` rules):
- `.reports-enrichment__push` — inline-flex label + help text for the push toggle (or
  reuse the layout of `.reports-controls__field`; prefer reuse and skip this if it fits).
- Ensure `.reports-pill` is legible as a field chip (it already exists for solar); if a
  tighter chip is wanted, add `.reports-field-pill` (small, muted background). Keep new
  classes to a minimum — reuse `.reports-pill` if acceptable.
No new CSS file; everything lands in `analysis-reports.css` (the file ReportsPage imports).

### Anonymous / no-permission presentation (decision)

`ReportsPage` is a **public route** and analysis **never 403s** — anonymous and
permission-limited callers both get an empty `nodes:[]`. There is no reliable signal on
this endpoint to distinguish "nothing to enrich" from "you can't see enough sources".
**Decision:** a single empty state (branch 3 above) with two lines:
- Primary: `No nodes need enrichment.`
- Muted secondary (`analysis.enrichment.empty_hint`): `Enrichment compares NodeInfo
  across the sources you can read. If you're signed out or only have access to one
  source, sign in to see more.`

This is honest without over-engineering (no extra auth probe, no new endpoint). Do NOT
special-case a "403/unauthorized" branch — the endpoint contract makes it unreachable
for analysis; apply-time 403s surface via the error toast.

---

## 3. Test Plan

**File:** `src/components/Analysis/NodeInfoEnrichmentReport.test.tsx` (NEW). Vitest +
`@testing-library/react`. No existing Analysis component test exists; follow the
QueryClient-wrapper pattern from `src/hooks/useElevationEnabled.test.tsx:18-19` and the
`vi.mock('../../services/api')` pattern from
`src/components/configuration/BackupManagementSection.test.tsx`.

**Mocking the API layer** — mock the default export `api` (and `ApiError`):
```ts
vi.mock('../../services/api', async (orig) => {
  const actual = await orig<typeof import('../../services/api')>();
  return { __esModule: true, default: { get: vi.fn(), post: vi.fn() }, ApiError: actual.ApiError };
});
import api from '../../services/api';
```
Return the **enveloped** shape from the mock (`{ success:true, data:{...} }`) so the test
also guards the `body.data` unwrap.

**Render harness** — wrap in a fresh `QueryClient` (retry:false) + `ToastProvider`
(component calls `useToast`), because the app-level providers from `main.tsx` aren't
present in a unit test:
```tsx
function renderReport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider><NodeInfoEnrichmentReport /></ToastProvider>
    </QueryClientProvider>);
}
```

**Cases:**
1. **Loading** → mock `get` to a pending promise; assert the loading banner renders.
2. **Empty** → `get` resolves `{success:true,data:{nodes:[],summary:{0,0,0}}}`; assert
   the empty banner + the muted hint line render; no table.
3. **Populated + summary** → resolve one node / one target with
   `fillableFields:['longName','hwModel','role']`; assert `displayName`, `nodeId`, the
   readable field labels ("Long Name","Hardware Model","Role") via `nodeInfoFieldLabel`,
   donor + target source names, and summary counts (1/1/3) render.
4. **Fix (single row)** → `post` resolves the applied result; click the row's Fix button;
   assert `api.post` called once with
   `{ items:[{nodeNum,targetSourceId,donorSourceId}], pushToNodeDb:false }`; assert a
   success toast text appears; assert `api.get` re-invoked (invalidation → refetch).
5. **Push toggle wiring** → toggle the checkbox on, click Fix; assert `post` body has
   `pushToNodeDb:true`. Assert default is `false` (case 4 already covers off).
6. **Fix All** → two rows across ≥1 node; click Fix All; assert `post` called once with
   an `items` array of length 2 (order-independent) containing both rows' items.
7. **Apply error** → `post` rejects with `new ApiError('Insufficient permission',403,{code:'FORBIDDEN'})`;
   click Fix; assert an error toast surfaces the message and the table stays intact.
8. **Error state** → `get` rejects; assert the error banner renders the message.

Use `await screen.findBy…` / `waitFor` for the async query/mutation settles; use
`userEvent` for clicks/toggles. Keep to gauntlet-safe, no-network unit tests (all IO
mocked).

**Regression guard for the extraction (2a):** the existing CopyNodeInfoModal test suite
(if present) must still pass after the `DISPLAY_FIELDS` import swap; run it. No new modal
test is required — the labels are identical, only their definition site moved.

---

## 4. Work Packages (Sonnet implementers)

### WP-1 — Shared field labels + CSS foundation
**Scope:** `src/utils/nodeInfoFields.ts` (new, §2a); refactor
`src/components/CopyNodeInfoModal/CopyNodeInfoModal.tsx` to import it (delete local
`DISPLAY_FIELDS`); additive CSS in `src/styles/analysis-reports.css` (§2d).
**Depends on:** nothing.
**Acceptance:**
- `nodeInfoFields.ts` exports `NODE_INFO_DISPLAY_FIELDS`, `NODE_INFO_FIELD_LABELS`,
  `nodeInfoFieldLabel`, `NodeInfoFieldKey`.
- CopyNodeInfoModal renders identically (same labels, same order); its existing tests
  (and `tsc`) pass.
- No raw-`fetch`/raw-SQL/lint-ratchet regressions (`npm run lint:ci` clean for touched
  files; see CLAUDE.md worktree caveat).

### WP-2 — NodeInfoEnrichmentReport + registration + tests
**Scope:** `src/components/Analysis/NodeInfoEnrichmentReport.tsx` (§2b),
`AnalysisTab.tsx` registration (§2c), `NodeInfoEnrichmentReport.test.tsx` (§3).
**Depends on:** WP-1 (imports `nodeInfoFieldLabel`).
**Acceptance:**
- Card appears in the Analysis & Reports grid with the `identity` icon; selecting it
  renders the report with a working Back button.
- Report fetches via `api.get`, unwraps `body.data`, and mutates via `api.post` (no raw
  `fetch`, no `csrfFetch`); CSRF is handled by ApiService.
- Loading / error / empty (with anonymous hint) / populated states all render per §2b.
- Per-row **Fix** posts a single-item batch; **Fix All** posts all items; push toggle
  defaults OFF and controls `pushToNodeDb`; success invalidates the analysis query and
  toasts; apply errors toast the message.
- All 8 test cases (§3) pass; full Vitest suite green (0 failures); `tsc` clean;
  `npm run lint:ci` clean for touched files (exhaustive-deps honest, no new
  `no-explicit-any`/raw-`fetch` baseline growth).

**Out of scope (all packages):** scheduler, settings keys, any backend/route/service
change, i18n of the field-label strings, browser/dev-container validation (done later by
the epic runner).
