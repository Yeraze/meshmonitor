# NodeInfo Enrichment — Phase 1 (Backend) Implementation Spec

**Epic:** #3837 (NodeInfo Enrichment)
**Branch:** `feature/nodeinfo-enrichment-backend`
**Scope:** Backend only — cross-source enrichment service + API routes + tests. No scheduler, no settings keys, no frontend. Never overwrite non-blank fields.

> **Note on the epic doc:** `docs/internal/dev-notes/NODEINFO_ENRICHMENT_EPIC.md` does **not** exist on this branch (it was branched from `origin/main` before the epic plan was committed). This spec encodes the approved interview decisions directly: **fill-blanks-only**, **optional `pushToNodeDb` toggle default off**, **all-incomplete-sources are targets**, **no scheduler**. If the epic doc lands later, reconcile against it.

---

## 1. Reuse Inventory

Everything below already exists and MUST be reused. New code is justified against the closest existing mechanism.

### Must reuse as-is

| Mechanism | Location | Use |
|-----------|----------|-----|
| `copyNodeInfo(nodeNum, fromSourceId, toSourceId, pushToNodeDb?, fields?)` | `src/server/services/nodeInfoCopyService.ts:99` | **The single write primitive.** Call it **without** the `fields` argument. The legacy no-`fields` path (`nodeInfoCopyService.ts:130-133`) is exactly fill-blanks-only: it skips any field where the target value is `!= null && !== ''`. This makes "never overwrite non-blank" an invariant enforced by the primitive itself — and it is TOCTOU-safe because it re-reads current DB state on every call. **Do NOT pass `fields`** — that flips to #4244 overwrite mode. |
| `pushNodeInfoToDevice(...)` | `src/server/services/nodeInfoCopyService.ts` (private) | Not called directly. `copyNodeInfo` already invokes it internally when `pushToNodeDb === true` (`nodeInfoCopyService.ts:145`). The enrichment `pushToNodeDb` flag is a straight passthrough into `copyNodeInfo`. No new export needed. |
| `NODE_INFO_FIELDS` / `NodeInfoField` | `src/server/services/nodeInfoCopyService.ts:6`, exported at `:81` and `export type` | The field allowlist. `['longName','shortName','hwModel','role','macaddr','publicKey','hasPKC','firmwareVersion']`. |
| `databaseService.nodes.getAllNodes(sourceId: SourceScope)` | `src/db/repositories/nodes.ts:233` | Cross-source node fetch. Pass `ALL_SOURCES` to get every row (each carries `sourceId`). `normalizeBigInts` runs inside, but still coerce `Number(node.nodeNum)` for grouping/compare (BIGINT on PG/MySQL — CLAUDE.md hard rule). |
| `ALL_SOURCES` | `src/db/repositories/index.js` (re-exported from `base.ts`) | Cross-source scope sentinel for `getAllNodes`. |
| `databaseService.sources.getAllSources()` | `src/db/repositories/sources.ts:35` | Returns `Source[]` (`{ id, name, type, ... }`) — used for `sourceName` lookup and the source universe. |
| `databaseService.checkPermissionAsync(userId, resource, action, sourceId)` | `src/services/database.ts` | Per-source permission check. `isAdmin` bypasses. Same call the existing copy routes use (`v1/nodes.ts:108`). |
| `ok()` / `fail()` envelope | `src/server/utils/apiResponse.ts` | **Mandatory for all new handlers.** `ok(res, data)` → `{ success:true, data }`. `fail(res, status, code, msg, extra?)`. |
| `createRouteTestApp()` harness | `src/server/test-helpers/routeTestApp.ts` | **Mandatory** for the new route permission test. Provides `sourceA`, `sourceB`, `admin`, `limited`, `grant()`, `loginAs()`, real session + real auth + real SQL permission enforcement. |
| `optionalAuth()` | `src/server/auth/authMiddleware.js` | Populates `req.user` without hard-gating. Used on the new routes because per-source permission is checked manually in-handler (the batch spans multiple sources, so a single `requirePermission(...)` middleware cannot express it — same reason `v1/nodes.ts` copy-nodeinfo does manual checks). |

### Must extend (small, additive exports on the copy service)

To avoid re-implementing the blank/filled predicate and the donor ranking (both currently **private** in `nodeInfoCopyService.ts`), export them so the enrichment service reuses identical logic instead of duplicating it (CLAUDE.md: reuse over duplication):

- **Export `isNodeInfoFieldBlank(value: unknown): boolean`** — the canonical predicate `value == null || value === ''`. Refactor the existing `countFilledFields` (`nodeInfoCopyService.ts:27`) to call it, so there is one definition.
- **Export `countFilledNodeInfoFields(node): number`** — rename/expose the existing private `countFilledFields`. Used for donor ranking (most-fields-filled).
- **Export `ANALYZE_NODE_INFO_FIELDS`** = `NODE_INFO_FIELDS.filter(f => f !== 'hasPKC')` (see hasPKC handling below).

No behavioral change to `copyNodeInfo` / `findCopyCandidates`; these are pure additive exports + one internal refactor.

### New code (justified)

- **`src/server/services/nodeInfoEnrichmentService.ts`** — no existing service does cross-source, all-node analysis; `findCopyCandidates` (`nodeInfoCopyService.ts:41`) is single-node/single-target and gates donors on `longName||shortName`. The enrichment service is the batch, cross-source generalization. It **reuses** `copyNodeInfo` for every write and the exported predicates for analysis.
- **`src/server/routes/shared/enrichmentHandlers.ts`** — one shared handler pair mounted in both routers, rather than duplicating handler bodies across `nodesRoutes.ts` and `v1/nodes.ts` (the copy routes are duplicated today; this is the deliberately better pattern). Justified by the DRY hard rule.

### hasPKC handling (decision)

`hasPKC` is a derived boolean (`src/db/schema/nodes.ts:54`, `mode:'boolean'`) that means "a public key is present" — it carries no information beyond `publicKey`. Decisions:

1. **Excluded from analysis.** `analyzeEnrichment` computes blanks/fillables over `ANALYZE_NODE_INFO_FIELDS` (NODE_INFO_FIELDS **minus** `hasPKC`). It is never reported as a fillable field and never counted in `fieldCount`. Surfacing "fill hasPKC" would be confusing UI and redundant with `publicKey`.
2. **Still copied by the write primitive.** `applyEnrichment` delegates to `copyNodeInfo` with **no `fields`**, whose legacy path will copy `hasPKC` iff the target's `hasPKC` is `null` and the donor's is set (`nodeInfoCopyService.ts:130-136`; a `false`/`0` target is treated as filled and skipped, so it is never overwritten). We deliberately do **not** strip `hasPKC` from the write — doing so would require passing `fields`, which flips `copyNodeInfo` into overwrite mode and breaks the fill-blanks-only invariant. So: **report without hasPKC, write via the unchanged primitive.** Document this asymmetry in code comments.

---

## 2. File-by-File Changes

### 2a. `src/server/services/nodeInfoCopyService.ts` (modify — additive)

Add exports (refactor `countFilledFields` to use the new predicate):

```ts
/** Canonical "this NodeInfo field is empty" predicate. */
export function isNodeInfoFieldBlank(value: unknown): boolean {
  return value == null || value === '';
}

/** Count of NODE_INFO_FIELDS that are non-blank on a node. Used for donor ranking. */
export function countFilledNodeInfoFields(node: Partial<DbNode>): number {
  return NODE_INFO_FIELDS.filter(f => !isNodeInfoFieldBlank((node as any)[f])).length;
}

/** Analysis field set — NODE_INFO_FIELDS minus the derived hasPKC flag. */
export const ANALYZE_NODE_INFO_FIELDS =
  NODE_INFO_FIELDS.filter(f => f !== 'hasPKC') as readonly NodeInfoField[];
```

Refactor existing private `countFilledFields` to delegate to `countFilledNodeInfoFields` (or just export the existing one under the new name). No other changes.

### 2b. `src/server/services/nodeInfoEnrichmentService.ts` (new)

```ts
import databaseService from '../../services/database.js';
import { DbNode } from '../../db/types.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { logger } from '../../utils/logger.js';
import {
  copyNodeInfo,
  isNodeInfoFieldBlank,
  countFilledNodeInfoFields,
  ANALYZE_NODE_INFO_FIELDS,
  type NodeInfoField,
} from './nodeInfoCopyService.js';

export interface EnrichmentTarget {
  targetSourceId: string;
  targetSourceName: string;
  fillableFields: NodeInfoField[];   // excludes hasPKC
  donorSourceId: string;
  donorSourceName: string;
}
export interface EnrichmentNode {
  nodeNum: number;
  nodeId: string;
  displayName: string;               // longName || shortName || nodeId
  targets: EnrichmentTarget[];
}
export interface EnrichmentAnalysis {
  nodes: EnrichmentNode[];
  summary: { nodeCount: number; targetCount: number; fieldCount: number };
}

export interface EnrichmentApplyItem {
  nodeNum: number;
  targetSourceId: string;
  donorSourceId: string;
}
export interface EnrichmentApplyItemResult extends EnrichmentApplyItem {
  copiedFields: string[];
  pushedToDevice: boolean;
  error?: string;                    // per-item failure; does NOT abort the batch
}
export interface EnrichmentApplyResult {
  applied: EnrichmentApplyItemResult[];
  totalFieldsCopied: number;
}

/**
 * @param allowedSourceIds  restrict the source universe (used for permission
 *   filtering by the route). `undefined` = all sources (admin path).
 */
export async function analyzeEnrichment(
  allowedSourceIds?: readonly string[],
): Promise<EnrichmentAnalysis> { ... }

export async function applyEnrichment(
  items: readonly EnrichmentApplyItem[],
  options: { pushToNodeDb: boolean },
): Promise<EnrichmentApplyResult> { ... }
```

**`analyzeEnrichment` algorithm:**
1. `sources = await databaseService.sources.getAllSources()`. Build `sourceName` map. If `allowedSourceIds` given, drop sources not in it. If the allowed set is empty → return `{ nodes: [], summary: { nodeCount:0, targetCount:0, fieldCount:0 } }`.
2. `allNodes = await databaseService.nodes.getAllNodes(ALL_SOURCES)`. Group rows by `Number(row.nodeNum)` into `Map<number, DbNode[]>`, keeping only rows whose `sourceId` is in the allowed set.
3. For each `nodeNum` group with ≥2 source rows:
   - For each **target** row: `blanks = ANALYZE_NODE_INFO_FIELDS.filter(f => isNodeInfoFieldBlank(target[f]))`. If none, skip this target.
   - **Donor selection:** among the *other* source rows for this nodeNum (`donorSourceId !== targetSourceId`), keep those that can fill ≥1 of the target's blanks (`donor[f]` non-blank for some `f in blanks`). Rank by `countFilledNodeInfoFields(donor)` desc, tie-break `Number(donor.updatedAt)` desc (identical comparator to `findCopyCandidates` at `nodeInfoCopyService.ts:72`). Pick the top donor.
   - `fillableFields = blanks.filter(f => !isNodeInfoFieldBlank(donor[f]))`. If empty, skip.
   - Emit an `EnrichmentTarget`.
   - Wrap targets into an `EnrichmentNode` (`nodeId` and `displayName` from the highest-`countFilledNodeInfoFields` row in the group: `longName || shortName || nodeId`). Only include nodes with ≥1 target.
4. `summary`: `nodeCount = nodes.length`; `targetCount = Σ targets`; `fieldCount = Σ fillableFields.length`.

Divergence from `findCopyCandidates` (document in comments): donor validity here is "can fill ≥1 target blank", **not** the `longName||shortName` gate — the enrichment definition is field-driven.

**`applyEnrichment` algorithm:**
For each item, in a per-item `try/catch` (partial success — one bad item never aborts the batch):
```ts
const { copiedFields, pushedToDevice } =
  await copyNodeInfo(Number(item.nodeNum), item.donorSourceId, item.targetSourceId, options.pushToNodeDb);
// NOTE: no `fields` arg → legacy fill-blanks-only path (never overwrites non-blank).
```
Collect `EnrichmentApplyItemResult` (on throw, set `error: String(err)`, `copiedFields: []`, `pushedToDevice: false`). `totalFieldsCopied = Σ copiedFields.length`. **Permission is enforced in the route, not here** (the service is permission-agnostic and unit-testable).

### 2c. `src/server/routes/shared/enrichmentHandlers.ts` (new)

Two exported handlers, imported by both routers. Both use `ok()`/`fail()`.

```ts
export async function handleEnrichmentAnalysis(req, res) { ... }
export async function handleEnrichmentApply(req, res) { ... }
```

**`handleEnrichmentAnalysis`** (read-only):
- `user = req.user; userId = user?.id ?? null; isAdmin = user?.isAdmin ?? false`.
- Compute readable source set: if `isAdmin` → `undefined` (all). Else for each `source` in `getAllSources()`, keep `source.id` where `await checkPermissionAsync(userId, 'nodes', 'read', source.id)` is true (userId null → none). This is the **permission-filtering approach**: analysis only ever computes over sources the caller can read (both as donor and target), so no cross-source leak.
- `analysis = await analyzeEnrichment(readableSet)`.
- `return ok(res, analysis)` → `{ success:true, data:{ nodes:[...], summary:{...} } }`.
- On unexpected error → `fail(res, 500, 'ENRICHMENT_ANALYSIS_FAILED', 'Failed to analyze enrichment')`.

**`handleEnrichmentApply`** (write, fail-closed batch):
- Parse `{ items, pushToNodeDb }` from `req.body`. Validate:
  - `items` non-empty array → else `fail(res, 400, 'INVALID_REQUEST', 'items must be a non-empty array')`.
  - Each item has numeric `nodeNum` and string `targetSourceId`/`donorSourceId`, and `donorSourceId !== targetSourceId` → else `fail(res, 400, 'INVALID_ITEM', '...')`.
- Permission (fail-closed over the whole batch):
  - `donorSources = distinct donorSourceId`; `targetSources = distinct targetSourceId`.
  - Non-admin: require `checkPermissionAsync(userId, 'nodes','read', s)` for every donor source AND `checkPermissionAsync(userId, 'nodes','write', s)` for every target source. If any fails → `fail(res, 403, 'FORBIDDEN', 'Insufficient permission', { missing: [...] })`. (Reject the entire batch — matches copy-nodeinfo's single-op 403 semantics, extended to a set.)
- `result = await applyEnrichment(items, { pushToNodeDb: pushToNodeDb === true })`.
- `return ok(res, result)`.
- On unexpected error → `fail(res, 500, 'ENRICHMENT_APPLY_FAILED', 'Failed to apply enrichment')`.

> **ApiService gotcha (CLAUDE.md):** `ApiService.request()` returns the raw body and does **not** unwrap `data`. These are brand-new endpoints with no existing consumer, so `ok(res, x)` is correct — the Phase 2 frontend must read `body.data` (same lesson as MQTT packet monitor #4138). Do not "flatten" the envelope.

### 2d. `src/server/routes/nodesRoutes.ts` (modify)

Register **before** the parametric `/nodes/:nodeNum/...` routes as defense-in-depth (the literal 2-segment paths below do not collide with `/nodes/:nodeNum/copy-candidates` etc., but placing them first removes all doubt). Both use `optionalAuth()`:

```ts
import { handleEnrichmentAnalysis, handleEnrichmentApply } from './shared/enrichmentHandlers.js';

router.get('/nodes/enrichment/analysis', optionalAuth(), handleEnrichmentAnalysis);
router.post('/nodes/enrichment/apply', optionalAuth(), handleEnrichmentApply);
```

Mounted at `apiRouter.use('/', nodesRoutes)` (`server.ts:833`) →
`GET /api/nodes/enrichment/analysis`, `POST /api/nodes/enrichment/apply`.

**Route-ordering note:** `nodesRoutes` has no bare `GET /nodes/:nodeNum`; its param routes are all `/nodes/:nodeNum/<literal>` or `/nodes/:nodeId/<literal>`. `/nodes/enrichment/analysis` (segment `analysis` ≠ `copy-candidates`/`positions`/…) cannot be shadowed. Still register first.

### 2e. `src/server/routes/v1/nodes.ts` (modify)

**Ordering is load-bearing here:** this file has a bare `router.get('/:nodeId', ...)` at `v1/nodes.ts:127`. A single-segment `/enrichment` would be captured by it. The enrichment paths are 2-segment (`/enrichment/analysis`), so `/:nodeId` (one segment) will not match — **but** register them **above** `/:nodeId` (line 127) anyway to be safe:

```ts
import { handleEnrichmentAnalysis, handleEnrichmentApply } from '../shared/enrichmentHandlers.js';

router.get('/enrichment/analysis', handleEnrichmentAnalysis);
router.post('/enrichment/apply', handleEnrichmentApply);
```

The v1 router already sits behind the v1 auth chain that populates `req.user`; if it does not apply `optionalAuth` globally, wrap these two with `optionalAuth()` to match `nodesRoutes`. Mounted at `/api/v1/nodes` (root) and `/api/v1/sources/:sourceId/nodes` (mergeParams) → canonical path `GET /api/v1/nodes/enrichment/analysis`, `POST /api/v1/nodes/enrichment/apply`. (The `:sourceId` path param is ignored by these cross-source handlers — they compute their own source universe from permissions.)

### Response shapes (exact JSON)

`GET .../enrichment/analysis` → 200:
```json
{ "success": true, "data": {
  "nodes": [
    { "nodeNum": 123456, "nodeId": "!0001e240", "displayName": "Base Station",
      "targets": [
        { "targetSourceId": "src-b", "targetSourceName": "MQTT",
          "fillableFields": ["longName","hwModel","role"],
          "donorSourceId": "src-a", "donorSourceName": "Primary TCP" }
      ] }
  ],
  "summary": { "nodeCount": 1, "targetCount": 1, "fieldCount": 3 }
} }
```

`POST .../enrichment/apply` body:
```json
{ "items": [ { "nodeNum": 123456, "targetSourceId": "src-b", "donorSourceId": "src-a" } ],
  "pushToNodeDb": false }
```
→ 200:
```json
{ "success": true, "data": {
  "applied": [
    { "nodeNum": 123456, "targetSourceId": "src-b", "donorSourceId": "src-a",
      "copiedFields": ["longName","hwModel","role"], "pushedToDevice": false }
  ],
  "totalFieldsCopied": 3
} }
```

Error codes: `ENRICHMENT_ANALYSIS_FAILED` (500), `INVALID_REQUEST` (400), `INVALID_ITEM` (400), `FORBIDDEN` (403, `{ missing }`), `ENRICHMENT_APPLY_FAILED` (500).

### Apply input shape (decision)

**Explicit item list from the client** — `{ items: [{nodeNum, targetSourceId, donorSourceId}], pushToNodeDb? }` — chosen over server-side re-scan because it directly serves both Phase 2 UI needs: per-row **Fix** posts one item; **Fix All** posts every item from the analysis response. Each item names its own donor+target, so permission checks and the `copyNodeInfo` call are unambiguous. Fill-blanks-only is still enforced by the primitive (no `fields`), so a stale item can never overwrite a field filled since analysis.

---

## 3. Test Plan

All in the standard Vitest suite (SQLite default; PG/MySQL covered by CI service containers).

### 3a. `src/server/services/nodeInfoEnrichmentService.test.ts` (new — service unit)

Mock `databaseService.sources.getAllSources`, `databaseService.nodes.getAllNodes`, and either `databaseService.nodes.getNode`/`upsertNode` **or** `vi.mock('./nodeInfoCopyService.js')` to spy on `copyNodeInfo`. Prefer spying on `copyNodeInfo` for apply tests and mocking the repo for analyze tests. Cases:
- **analyze — fillable detection:** node in src-A (full) + src-B (blank longName/hwModel) → target src-B lists exactly those fillable fields, donor src-A.
- **analyze — best donor ranking:** two donors; higher `countFilledNodeInfoFields` wins; on tie, newer `updatedAt` wins.
- **analyze — hasPKC excluded:** donor has `publicKey`+`hasPKC`, target blank both → `fillableFields` contains `publicKey` but **never** `hasPKC`; `fieldCount` excludes it.
- **analyze — no blanks:** node identical across sources → not in results.
- **analyze — single-source node:** appears in only one source → not in results.
- **analyze — allowedSourceIds filter:** restricting to `['src-A']` drops src-B as both donor and target; empty allowed set → empty result.
- **analyze — BIGINT nodeNum:** `getAllNodes` returns `nodeNum` as string/bigint-like → grouping via `Number()` still matches rows across sources.
- **apply — delegates fill-blanks-only:** asserts `copyNodeInfo` called with `(nodeNum, donorSourceId, targetSourceId, false)` and **no 5th `fields` arg**.
- **apply — pushToNodeDb passthrough:** `{ pushToNodeDb: true }` → 4th arg `true`.
- **apply — per-item error isolation:** first item's `copyNodeInfo` throws → its result has `error`, second item still applied; batch does not reject.
- **apply — totalFieldsCopied** sums `copiedFields`.

### 3b. `src/server/services/nodeInfoEnrichmentService.perSource.test.ts` (new — source isolation)

Real singleton `:memory:` SQLite (no repo mock). Seed source rows `src-A`/`src-B` (via `databaseService.sources.createSource`) and a node present in both (donor full in src-A, blank in src-B) plus an unrelated node in a third source. Then:
- `applyEnrichment([{nodeNum, targetSourceId:'src-B', donorSourceId:'src-A'}], {pushToNodeDb:false})`.
- Assert: src-B row now has the donor's values; **src-A donor row is unchanged**; the unrelated third-source row is untouched. Proves writes are scoped to `targetSourceId` only.
- `analyzeEnrichment(['src-A'])` excludes src-B entirely (isolation of the read path).

### 3c. `src/server/routes/nodeInfoEnrichment.permissions.test.ts` (new — route harness)

**Mandatory `createRouteTestApp()`** (CLAUDE.md). Mount a minimal router that registers the two shared handlers behind `optionalAuth()`. Ensure `sourceA`/`sourceB` exist as rows in the `sources` table (seed in `beforeEach` if the harness does not) and seed a node in both. Cases:
- **analysis filters to readable sources:** grant `limited` `nodes:read` on `sourceA` only → analysis results reference only `sourceA` (never `sourceB` as donor or target). `admin` sees both.
- **analysis anonymous:** no login → `nodes: []` (200, empty — no readable sources).
- **apply requires write on target:** `limited` has `nodes:read` on both but `nodes:write` only on `sourceB`; apply with `targetSourceId:sourceA` → 403 `FORBIDDEN`; with `targetSourceId:sourceB` (read on donor `sourceA` granted) → 200.
- **apply requires read on donor:** write on target but no read on donor source → 403.
- **admin bypass:** admin applies across both → 200.
- **validation:** empty `items` → 400 `INVALID_REQUEST`; `donorSourceId === targetSourceId` → 400 `INVALID_ITEM`.

Use `harness.grant(harness.limited.id, 'nodes', 'read'|'write', harness.sourceX)` and `harness.loginAs(...)`. No `checkPermissionAsync` mocking — real SQL enforces (harness template: `sourceRoutes.permissions.test.ts`).

---

## 4. Work Packages

Two packages. **WP-B depends on WP-A** (imports the service + exports). Within WP-A the three test files and the service can be written together; the copy-service export edit is the only shared prerequisite and lives at the top of WP-A.

### WP-A — Enrichment service + copy-service exports (foundation)

**Scope:** additive exports on `nodeInfoCopyService.ts`; new `nodeInfoEnrichmentService.ts`; service unit test; perSource isolation test.
**Files:**
- `src/server/services/nodeInfoCopyService.ts` (modify — export `isNodeInfoFieldBlank`, `countFilledNodeInfoFields`, `ANALYZE_NODE_INFO_FIELDS`; refactor `countFilledFields`).
- `src/server/services/nodeInfoEnrichmentService.ts` (new).
- `src/server/services/nodeInfoEnrichmentService.test.ts` (new).
- `src/server/services/nodeInfoEnrichmentService.perSource.test.ts` (new).
**Parallelism:** none external; can run first. The two test files can be authored in parallel once the service signatures are fixed.
**Acceptance:**
- `copyNodeInfo`/`findCopyCandidates` behavior unchanged; new exports typecheck.
- `analyzeEnrichment`/`applyEnrichment` implemented per §2b; apply calls `copyNodeInfo` with **no `fields`** arg (assert in test).
- hasPKC never in `fillableFields`/`fieldCount`.
- `Number(nodeNum)` used for all grouping/compare.
- Both new test files green; perSource test proves target-only writes and read-path isolation.

### WP-B — API routes + permission harness test

**Scope:** shared handler module; register in both routers; route permission test.
**Files:**
- `src/server/routes/shared/enrichmentHandlers.ts` (new).
- `src/server/routes/nodesRoutes.ts` (modify — two routes, registered before param routes).
- `src/server/routes/v1/nodes.ts` (modify — two routes, registered **above** `/:nodeId` at line 127).
- `src/server/routes/nodeInfoEnrichment.permissions.test.ts` (new).
**Depends on:** WP-A (imports `analyzeEnrichment`/`applyEnrichment` and their types).
**Acceptance:**
- Both endpoints reachable at `/api/nodes/enrichment/*` and `/api/v1/nodes/enrichment/*`; no shadowing by `/:nodeNum`/`/:nodeId` (verified by the harness test hitting them).
- Handlers use `ok()`/`fail()` exclusively with the documented codes.
- Analysis filters to readable sources; apply is fail-closed on missing read(donor)/write(target); admin bypass works — all asserted via `createRouteTestApp` with real permission rows.
- Full `npm test` green; `npm run lint:ci` clean (ignoring `.claude/worktrees`).

### Out of scope (all packages)
Scheduler, settings keys, frontend, overwriting non-blank fields, exporting `pushNodeInfoToDevice`.
