# Per-Node Cooldown Scope — Phase 2 Implementation Spec

**Epic:** `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md` · **Issue:** #4340 (follow-on)
**Branch:** `feature/cooldown-scope` · **Worktree:** `/home/yeraze/Development/meshmonitor-cooldown-scope`
**Base:** `origin/main` @ `01fbf745` (Phase 1 merged)

> **Orchestrator sign-off (2026-07-28):** the §9.1 deviation — validating
> `cooldownScope` with a pre-switch `categoryOf(n.type) === 'trigger'` guard
> rather than a per-type `case` — is **approved**. `cooldownScope` is shared by
> all seven trigger types; seven duplicated `case` labels would silently miss
> the eighth trigger type someone adds later.

## 1. Reuse inventory (read this before writing any code)

Everything below already exists and **must be used or extended, not
re-implemented**. Verified by symbolic search on 2026-07-28 against this worktree.

| Existing thing | Location | How Phase 2 uses it |
|---|---|---|
| `lastFired: Map<automationId, ms>` | `automationEngineService.ts:119-120` | **Re-keyed** to `Map<automationId, Map<cooldownKey, ms>>`. Name kept. |
| `cooledDown(a, now)` | `automationEngineService.ts:249-253` | **Replaced** by `cooldownGate(a, ctx, now)` — one helper that decides *and* names the key, so the three call sites can't drift. |
| The three cooldown gates | `automationEngineService.ts:205-212` (onSchedule), `:278-285` (runTrigger), `:525-532` (checkGeofences) | All three collapse onto `cooldownGate` + `markFired`. **A fix applied to only one is the bug this phase exists to avoid.** |
| `geofenceState = new Map<\`${a.id}:${nodeNum}\`, boolean>` | `automationEngineService.ts:121-122, :514-516` | **Precedent, not a target.** Proves the `${automationId}:${nodeNum}` composite-key shape is already house style here. Its own unbounded growth is pre-existing — see §8. |
| `AutomationVariablesRepository.buildScopeKey(scope, ctx)` | `src/db/repositories/automationVariables.ts:82-99` | **Key-shape source of truth.** `global → ''`, `node → '<node>'`, `sourceNode → '<source>:<node>'`. Cooldown keys use the *identical* shape, pinned by a cross-check test (§6). Not called directly — see §2.4. |
| `VARIABLE_SCOPES = ['global','source','node','sourceNode']` | `src/types/automation.ts:142-143` | The vocabulary `cooldownScope` deliberately mirrors (`automation` ≙ `global`). |
| `TAPBACK_EMOJI_MODES` + its validation `case` | `src/types/automation.ts:120-122`, `:375-381` | **The exact backward-compat precedent** for `COOLDOWN_SCOPES`: exported const array, union type, validate *only when present*. |
| `varContextFromTrigger(trigger)` | `engineContext.ts:87-89` | The existing TriggerContext → scope-context adapter. `cooldownKeyFor()` lands **next to it, same file** — same concern, no new module. |
| `TriggerContext.subjectNodeNum` | `triggerContext.ts:17, :21` | Sole numeric subject identity. **Not changed** — drives node hydration (`getSubjectNode`) and variable scoping, both of which need a real Meshtastic node number. |
| `buildMeshCoreMessageContext` | `triggerContext.ts:134-195` | The **only** builder that gains an explicit `subjectNodeKey` (MeshCore pubkey). |
| `parseMeshCoreChannelIdx(fromPublicKey)` | `triggerContext.ts:120-123` | Reused to detect the synthetic `channel-<idx>` sender key. Already computed as `isChannel` at `:140-141`. |
| MeshCore per-sender auto-ack cooldown | `meshcoreManager.ts:6905-6918` (`dm:${pk}` / `ch${idx}:${pk}`) | Confirms full `fromPublicKey` is the right MeshCore identity, and that channel messages must be keyed by channel, not sender. |
| AutoAck per-node cooldown `Map<nodeNum, ms>` | `meshtasticManager.ts:825, :10090-10099, :10263` | The behaviour we are porting. Also the **counter-example** for eviction — it is unbounded (§2.5). |
| `autoAckProcessedPackets` high-water trim | `meshtasticManager.ts:9992-9996` (`> 1000 → keep last 500`) | **The eviction pattern we copy**, refined with an exact expiry pass (§2.5). |
| `fieldVisible(field, params)` + `FieldDef.showIf` | `catalog.ts:26-41` (Phase 1) | Extended with **one** operator, `truthy` (§4.1). No new mechanism. |
| `BlockFields` `.filter(fieldVisible)` | `AutomationBuilder.tsx:227` | **Unchanged.** The new field rides the existing filter. |
| `defaultParams(type, triggerType)` | `AutomationBuilder.tsx:48-63` | Already seeds a `select`'s first option → new trigger blocks get `cooldownScope: 'automation'` free. Order options accordingly. |
| `COOLDOWN: FieldDef` shared const | `catalog.ts:51-54` | The new `COOLDOWN_SCOPE` const sits beside it, spliced into the same five blocks. |
| `SUBJECT_NODE_TRIGGERS` | `catalog.ts:149-150` | **Load-bearing coincidence, verified:** the five triggers carrying `COOLDOWN` are *exactly* these five. |
| `automationTraceBus.emit` / `emitTrace` | `automationEngineService.ts:293-304` | **Unchanged.** The key name rides the existing `reason` string, rendered verbatim at `LiveTracePanel.tsx:169`. |
| `createTestDb` / `recorder()` / `engineWith()` | `automationEngineService.test.ts:12, :17-26, :77-79` | All new engine tests use these. Do not invent a new harness. |
| `FieldDef.advanced` | `catalog.ts:23` | **Declared, never read** (Phase 1 finding, re-verified). Set for consistency; do not rely on it. |

### 1.1 Justification: zero new modules

| Candidate new file | Rejected because |
|---|---|
| `src/server/services/automation/cooldownScope.ts` | Splits a 6-line pure function from `varContextFromTrigger()`, the existing trigger→scope-key adapter it is a sibling of. `engineContext.ts` is already imported by both consumers. **Rejected.** |
| `src/types/cooldown.ts` | `src/types/automation.ts` is the canonical home for every other engine vocabulary constant (`REQUEST_OPS`, `TAPBACK_EMOJI_MODES`, `VARIABLE_SCOPES`, `COLLAPSE_MODES`). **Rejected.** |

**Result:** `COOLDOWN_SCOPES` / `CooldownScope` / `parseCooldownScope()` →
`src/types/automation.ts`. `cooldownKeyFor()` → `engineContext.ts`.
`subjectKeyOf()` → `triggerContext.ts`. Nothing else.

## 2. Backend design

### 2.1 The vocabulary — `src/types/automation.ts`

Add next to `TAPBACK_EMOJI_MODES` (`:120-122`):

```ts
/**
 * What a trigger's `cooldownSeconds` window is keyed by (#4340 Phase 2).
 *
 *  - 'automation'  one timer for the whole rule — the pre-4.14 behaviour and
 *                  what an ABSENT/unrecognised value means. Never change this.
 *  - 'node'        one timer per subject node (message sender / telemetry or
 *                  geofence node), so acking one range-tester does not suppress
 *                  the ack to the next one.
 *  - 'sourceNode'  one timer per (source, node), so the same physical node heard
 *                  via two sources cools down independently.
 *
 * Key shapes mirror AutomationVariablesRepository.buildScopeKey exactly
 * ('' / '<node>' / '<source>:<node>') so cooldown keys and variable scope keys
 * read identically in logs and traces.
 */
export const COOLDOWN_SCOPES = ['automation', 'node', 'sourceNode'] as const;
export type CooldownScope = (typeof COOLDOWN_SCOPES)[number];

/**
 * Coerce a stored `params.cooldownScope` to a CooldownScope. Absent, blank, or
 * unrecognised → 'automation'. Deliberately lenient at RUNTIME (graphs written
 * before validation existed must still run) while validateAutomationGraph
 * rejects unrecognised values at SAVE time — the same split Phase 1 used for
 * action.tapback's emojiMode.
 */
export function parseCooldownScope(raw: unknown): CooldownScope {
  return COOLDOWN_SCOPES.includes(raw as CooldownScope) ? (raw as CooldownScope) : 'automation';
}
```

### 2.2 Validation — `src/types/automation.ts` (~:330-334)

`cooldownScope` is a **trigger-level** param shared by all seven trigger types.
Duplicating it into seven `case` labels would silently miss the eighth trigger
type someone adds later, so it is a guard immediately **before** the
`switch (n.type)` inside the same loop, using the existing `categoryOf()` helper
(`:100-105`):

```ts
for (const n of rawNodes as AutomationNode[]) {
  const p = (n.params ?? {}) as Record<string, unknown>;
  // Cooldown scope (#4340 Phase 2) is a trigger-level param every trigger type
  // shares, so it is checked once here rather than duplicated into seven cases
  // (which would silently miss any trigger type added later). Optional:
  // absent/unset = 'automation', the pre-4.14 behaviour every stored automation
  // depends on — same contract as action.tapback's emojiMode.
  if (categoryOf(n.type) === 'trigger'
      && p.cooldownScope != null
      && !COOLDOWN_SCOPES.includes(p.cooldownScope as CooldownScope)) {
    errors.push(`${n.type} "${n.id}" requires params.cooldownScope ∈ {automation,node,sourceNode}`);
  }
  switch (n.type) { /* …unchanged… */ }
}
```

Do **not** add validation for `cooldownSeconds` — it is unvalidated today
(`Number(…) ?? 0 || 0` at `automationEngineService.ts:156`) and tightening it
would reject stored graphs.

### 2.3 Subject identity — `triggerContext.ts`

**The problem.** `subjectNodeNum` is populated for Meshtastic message /
nodeDiscovered / nodeUpdated / telemetry / geofence; is `null` for
`trigger.schedule` (always, `:283-289`); is `null` for
`buildMeshCoreMessageContext` (always, `:190-192`); and is *usually* null for
`trigger.system` (only `connection:status` passes a `nodeNum`).

Add an **optional** protocol-agnostic subject key. Optional so no existing
construction site (including `automationSimulator.ts:271` and every test that
builds a `TriggerContext` literal) needs touching:

```ts
export interface TriggerContext {
  triggerType: TriggerType;
  sourceId: string | null;
  /** Subject node for node/sourceNode variable scope binding. */
  subjectNodeNum: number | null;
  /**
   * Protocol-agnostic subject identity, for cooldown scoping (#4340 Phase 2).
   *
   * `undefined` (the default, and what every Meshtastic builder leaves it as)
   * means "derive it from subjectNodeNum". Set EXPLICITLY only where the
   * subject has an identity that is not a Meshtastic node number — today that
   * is only MeshCore, whose senders are pubkey strings. An explicit `null`
   * means "this event has no stable per-subject identity at all".
   *
   * Deliberately NOT reused for variable scoping or node hydration: both call
   * getNode(sourceId, nodeNum) / buildScopeKey with a NUMBER and must keep
   * doing so. This field is cooldown-only.
   */
  subjectNodeKey?: string | null;
  timestamp: number;
  fields: Record<string, unknown>;
}

/**
 * The subject's cooldown identity, or null when the event has none.
 * Explicit `subjectNodeKey` wins; otherwise derive from `subjectNodeNum`.
 */
export function subjectKeyOf(ctx: TriggerContext): string | null {
  if (ctx.subjectNodeKey !== undefined) return ctx.subjectNodeKey;
  return ctx.subjectNodeNum == null ? null : String(ctx.subjectNodeNum);
}
```

**MeshCore — supported, with one honest limitation.** In
`buildMeshCoreMessageContext` (`:187-194`), beside the existing
`subjectNodeNum: null`:

```ts
// #4340 Phase 2: MeshCore has no node numbers, so per-node cooldown keys off
// the sender pubkey instead — the same identity meshcoreManager's own auto-ack
// cooldown uses (meshcoreManager.ts:6909). A DM/room post carries the real
// sender key. A CHANNEL post does not: `fromPublicKey` is the synthetic
// `channel-<idx>` slot key SHARED by every sender on that channel (see
// parseMeshCoreChannelIdx above), so keying by it would look per-node while
// actually being per-channel. Null there, which degrades to the automation-wide
// key rather than lying.
subjectNodeKey: isChannel ? null : (msg.fromPublicKey ?? null),
```

`isChannel` is already computed at `:141`. No other builder changes.

**Behaviour when there is no subject.** `cooldownKeyFor` **falls back to the
automation-wide key** and marks the verdict `degraded`. Rationale, stated so
nobody "fixes" it later:

- *Never fire* would be a silent breakage — a Schedule or System automation with
  `cooldownScope: 'node'` (reachable via JSON import) would stop working with no
  visible cause. This is exactly the silently-never-fires bug to avoid.
- *Never cool down* would turn a throttle into a spam faucet on a MeshCore
  channel and would grow the map with a fresh key per event.
- *Automation-wide fallback* is exactly today's behaviour, so the degraded path
  is provably no worse than the status quo, costs one map entry, and the trace
  says so out loud.

### 2.4 The key + label — `engineContext.ts`

Beside `varContextFromTrigger` (`:87-89`):

```ts
/** Truncate a long subject id (a 64-char MeshCore pubkey) for trace/log copy. */
function shortSubject(id: string): string {
  return id.length > 16 ? `${id.slice(0, 12)}…` : id;
}

export interface CooldownKeyResolution {
  /** Map key. '' is the automation-wide key (also the degraded fallback). */
  key: string;
  /** Human phrase naming the key, for the cooldown trace reason. */
  label: string;
  /** True when the requested scope could not be honoured and we fell back. */
  degraded: boolean;
}

/**
 * Resolve a trigger context to its cooldown key under `scope` (#4340 Phase 2).
 *
 * Key shapes intentionally match AutomationVariablesRepository.buildScopeKey's
 * global/node/sourceNode shapes ('' / '<node>' / '<source>:<node>') — pinned by
 * a cross-check test — so cooldown keys and variable scope keys read alike.
 * It is NOT called directly: buildScopeKey's ctx.nodeNum is typed `number` and
 * widening it to accept a MeshCore pubkey string would silently let VARIABLE
 * scoping key off pubkeys too, a behaviour change we explicitly do not want.
 *
 * When the requested scope cannot be honoured (no subject node on a schedule /
 * system / MeshCore-channel event, or no sourceId under 'sourceNode'), this
 * degrades to the automation-wide key — today's exact behaviour — rather than
 * never firing or never cooling down. See COOLDOWN_SCOPES for why.
 */
export function cooldownKeyFor(scope: CooldownScope, trigger: TriggerContext): CooldownKeyResolution {
  if (scope === 'automation') return { key: '', label: 'automation-wide', degraded: false };
  const node = subjectKeyOf(trigger);
  if (node == null) {
    return { key: '', label: 'automation-wide (this event has no subject node)', degraded: true };
  }
  if (scope === 'node') return { key: node, label: `node ${shortSubject(node)}`, degraded: false };
  const src = trigger.sourceId;
  if (!src) {
    return { key: '', label: 'automation-wide (this event has no source)', degraded: true };
  }
  return { key: `${src}:${node}`, label: `source ${src} · node ${shortSubject(node)}`, degraded: false };
}
```

### 2.5 The engine — `automationEngineService.ts`

**State (`:117-124`):**

```ts
/** automationId → cooldown key → last fired ms. Inner key shape: cooldownKeyFor(). */
private lastFired = new Map<string, Map<string, number>>();
```

**Bounds (module scope, above the class):**

```ts
/**
 * Per-automation cooldown-key bounds (#4340 Phase 2). Under 'automation' scope
 * an automation holds exactly ONE key, as before. Under 'node'/'sourceNode' it
 * holds one per distinct subject — on a large mesh with MQTT sources that is
 * thousands, so it must be bounded.
 *
 * Shape copied from meshtasticManager's autoAckProcessedPackets high-water trim
 * (`> 1000 → keep last 500`, :9992): prune only when a high watermark is passed,
 * and always bring the size well under it, so pruning is amortised O(1) per fire.
 *
 * Refined with an EXACT first pass: unlike a packet-dedup set, a cooldown entry
 * has a provable expiry — once `now - ts >= cooldownSeconds*1000` it can never
 * suppress anything, so deleting it is behaviour-neutral. The hard trim below is
 * only a backstop for the pathological case of >TRIM_TO distinct subjects firing
 * inside a single cooldown window.
 *
 * Deliberately NOT modelled on meshtasticManager's autoAckCooldowns
 * (Map<nodeNum, ms>, :825) — that map is never evicted at all. It gets away with
 * it because it is per-manager and bounded in practice by one radio's NodeDB;
 * the engine's is per (automation × node) across EVERY source including MQTT
 * firehoses, so the same choice would be a real leak here.
 */
const COOLDOWN_KEYS_MAX = 4096;
const COOLDOWN_KEYS_TRIM_TO = 2048;
```

**`LoadedAutomation` (`:54-61`)** gains `cooldownScope: CooldownScope`.

**`load()` (`:156`)** gains, beside `cooldownSeconds`:

```ts
const cooldownScope = parseCooldownScope((triggerNode.params as any)?.cooldownScope);
```

…and, after `this.index = index;` (`:163`), drops state for automations that are
no longer loaded:

```ts
// Drop cooldown state for automations that are no longer loaded (deleted or
// disabled). They are unreachable — runTrigger/onSchedule/checkGeofences only
// iterate `this.index` — so this is unobservable while they stay out of the
// index. One observable edge, accepted: disabling and re-enabling a rule inside
// its own cooldown window now lets it fire immediately instead of waiting out
// the remainder. Erring toward firing is the safe direction, and without this a
// deleted node-scoped automation would strand up to COOLDOWN_KEYS_MAX entries
// forever.
const liveIds = new Set<string>();
for (const list of index.values()) for (const a of list) liveIds.add(a.id);
for (const id of this.lastFired.keys()) if (!liveIds.has(id)) this.lastFired.delete(id);
```

**Gate + mark — replaces `cooledDown` (`:249-253`):**

```ts
/**
 * Cooldown verdict for one automation against one event. Returns the key to
 * stamp on success, or the trace reason on suppression.
 *
 * This is the ONLY place the cooldown window is evaluated. The three call sites
 * (message/node/telemetry/system dispatch, schedule dispatch, geofence) must all
 * route through it — a scope fix applied to only one of them is the exact bug
 * this phase exists to prevent.
 */
private cooldownGate(
  a: LoadedAutomation,
  ctx: TriggerContext,
  now: number,
): { ok: true; key: string } | { ok: false; reason: string } {
  if (a.cooldownSeconds <= 0) return { ok: true, key: '' };
  const { key, label } = cooldownKeyFor(a.cooldownScope, ctx);
  const last = this.lastFired.get(a.id)?.get(key);
  const windowMs = a.cooldownSeconds * 1000;
  if (last == null || now - last >= windowMs) return { ok: true, key };
  const remainingMs = Math.max(0, windowMs - (now - last));
  return { ok: false, reason: `cooldown active — ${Math.ceil(remainingMs / 1000)}s remaining (${label})` };
}

/** Stamp a fire against its cooldown key, bounding the per-automation key set. */
private markFired(a: LoadedAutomation, key: string, now: number): void {
  // No cooldown ⇒ nothing can ever be suppressed ⇒ never grow the map. (Today
  // the timestamp is written unconditionally, but it is only ever READ inside
  // the `cooldownSeconds > 0` branch, so skipping it is unobservable and keeps
  // memory at zero for the overwhelmingly common cooldown-less automation.)
  if (a.cooldownSeconds <= 0) return;
  let inner = this.lastFired.get(a.id);
  if (!inner) { inner = new Map(); this.lastFired.set(a.id, inner); }
  inner.set(key, now);
  if (inner.size > COOLDOWN_KEYS_MAX) this.pruneCooldownKeys(a, inner, now);
}

private pruneCooldownKeys(a: LoadedAutomation, inner: Map<string, number>, now: number): void {
  const windowMs = a.cooldownSeconds * 1000;
  // Exact pass: an entry older than the window can no longer suppress anything.
  for (const [k, ts] of inner) if (now - ts >= windowMs) inner.delete(k);
  if (inner.size <= COOLDOWN_KEYS_TRIM_TO) return;
  // Backstop: more than COOLDOWN_KEYS_TRIM_TO distinct subjects fired inside one
  // window. Drop the oldest — they expire soonest — accepting that those few
  // subjects may fire once early rather than growing without bound.
  const byAge = [...inner.entries()].sort((x, y) => x[1] - y[1]);
  for (let i = 0; i < byAge.length - COOLDOWN_KEYS_TRIM_TO; i++) inner.delete(byAge[i][0]);
  logger.debug(`[AutomationEngine] "${a.name}" cooldown keys trimmed to ${inner.size} (scope=${a.cooldownScope})`);
}
```

**All three call sites become identical.** `onSchedule` (`:205-212`):

```ts
const gate = this.cooldownGate(a, ctx, now);
if (!gate.ok) {
  if (traced) this.emitTrace(a, ctx, now, { outcome: 'cooldown', reason: gate.reason });
  return 0;
}
this.markFired(a, gate.key, now);
```

`runTrigger` (`:278-285`) and `checkGeofences` (`:525-532`) take the same five
lines with `continue` instead of `return 0`, and `geoCtx` as the context in the
geofence case. **After the change, `this.lastFired.get(a.id)` must not appear
anywhere outside `cooldownGate`/`markFired`/`pruneCooldownKeys`/`load` — that is
a grep-checkable acceptance criterion.**

Also update the class doc comment (`:6`): "enforces a per-automation cooldown" →
"enforces the trigger's cooldown at its configured scope (automation / node /
source+node)".

### 2.6 Worked example — why this closes the #4340 gap

`trigger.message` on channel `Primary`, `cooldownSeconds: 60`,
`cooldownScope: 'node'`.

| t | event | key | verdict |
|---|---|---|---|
| 0s | node 111 sends "test" | `'111'` | fires, `lastFired['a']['111'] = 0` |
| 5s | node 222 sends "test" | `'222'` | **fires** (today: suppressed) |
| 20s | node 111 sends "test" | `'111'` | suppressed — `cooldown active — 40s remaining (node 111)` |
| 70s | node 111 sends "test" | `'111'` | fires |

Under `sourceNode`, node 111 heard on `tcp-1` and `mqtt-1` gets keys
`'tcp-1:111'` and `'mqtt-1:111'` — independent.

## 3. What does **not** change

- **There is no `resetCooldowns` method anywhere in the tree.**
  `grep -rn "resetCooldown" src` returns nothing. Nothing to update; do not add one.
- **The simulator does not model cooldown at all.** `automationSimulator.ts` has
  no `lastFired`, and `simulateAutomation` runs the graph whenever the pre-filter
  matches (`:290-320`). A dry-run therefore ignores `cooldownScope` entirely —
  correct, since a dry-run must always show the operator what *would* happen.
  Pinned by a regression test (§6) so nobody adds cooldown to the tester later
  without a decision.
- **The Test panel (`AutomationTester.tsx`) has no cooldown UI** and gains none.
- **`recordingDeps()` / `ActionDeps` / `meshActionDeps.ts` are untouched** —
  cooldown is a pre-dispatch gate, entirely above the deps boundary.
- **`automationTraceBus` / `LiveTracePanel.tsx` are untouched** — the key name
  rides the existing `reason` string.
- **No route, no envelope work, no new setting** (so no `VALID_SETTINGS_KEYS`
  entry), **no schema change, no migration** — therefore no PostgreSQL/MySQL
  containers are required to verify this phase.
- **`graphEvaluator.ts` is untouched.** The evaluator runs strictly *after* the
  cooldown gate and has no cooldown concept.

## 4. Frontend

### 4.1 `showIf` gains one operator — `catalog.ts:15-41`

The scope select is meaningless while `cooldownSeconds` is unset or `0`, so it
must be gated. `showIf` currently supports only `equals`/`notEquals`, and
`cooldownSeconds` can legitimately be `undefined` (never touched), `''` (cleared
— the `number` renderer emits `''`, `AutomationBuilder.tsx:73-74`), or `0`.
`notEquals: 0` would show the field in the first two cases. So extend `showIf`
with a generic truthiness operator rather than inventing a second mechanism:

```ts
showIf?: {
  field: string;
  equals?: unknown;
  notEquals?: unknown;
  /** Visible only when the sibling param is truthy (`true`) / falsy (`false`).
   *  Covers "a number field that is unset, blank, or 0" in one operator. */
  truthy?: boolean;
};
```

```ts
export function fieldVisible(field: FieldDef, params: Record<string, unknown>): boolean {
  const c = field.showIf;
  if (!c) return true;
  const v = params[c.field];
  if ('equals' in c && v !== c.equals) return false;
  if ('notEquals' in c && v === c.notEquals) return false;
  // Boolean(v) covers undefined / '' / 0 / false uniformly. Known, harmless
  // wart: the string '0' is truthy — it only shows an extra select.
  if (c.truthy !== undefined && Boolean(v) !== c.truthy) return false;
  return true;
}
```

**Phase 1 semantics are preserved verbatim: hidden ≠ cleared.** Setting the
cooldown back to `0` hides the select but keeps `params.cooldownScope`, and the
engine ignores it anyway (`cooldownGate` returns early when
`cooldownSeconds <= 0`), so there is no behaviour risk in either direction.

### 4.2 The field — `catalog.ts`, beside `COOLDOWN` (`:51-54`)

```ts
const COOLDOWN_SCOPE: FieldDef = {
  name: 'cooldownScope', label: 'Cooldown applies to', kind: 'select', advanced: true,
  // Values mirror CooldownScope in src/types/automation.ts. Kept as literals so
  // this frontend catalog keeps its zero dependency on the server-side types
  // module (the same call Phase 1 made for action.tapback's emojiMode).
  // 'automation' MUST be first: defaultParams() seeds a select's first option,
  // so a newly added trigger block gets the pre-4.14 behaviour.
  options: [
    { value: 'automation', label: 'The whole automation (one shared timer)' },
    { value: 'node', label: 'Each node separately' },
    { value: 'sourceNode', label: 'Each node, per source' },
  ],
  // Only meaningful once a cooldown is actually set.
  showIf: { field: 'cooldownSeconds', truthy: true },
  help: 'The whole automation: one timer for the rule — on a busy channel, answering one node suppresses the answer to the next. Each node separately: every sending/subject node gets its own timer, which is what you want for a range-test responder. Each node, per source: the same node heard via two sources cools down independently. Triggers with no subject node (Schedule, System, MeshCore channel messages) fall back to one shared timer.',
};
```

Add `COOLDOWN_SCOPE` immediately after `COOLDOWN` in the `fields` array of the
**five** trigger blocks that carry `COOLDOWN`: `trigger.message` (`:70`),
`trigger.nodeDiscovered` (`:77`), `trigger.nodeUpdated` (`:83`),
`trigger.telemetry` (`:101`), `trigger.geofence` (`:142`). **Do not** add it to
`trigger.schedule` or `trigger.system` — they expose no cooldown field today,
and those two are precisely the trigger types with no subject node.

### 4.3 `AutomationBuilder.tsx` — no change

`BlockFields` already filters through `fieldVisible` (`:227`), and
`defaultParams` (`:48-63`) already seeds selects. **Verify with
`git diff --stat` that this file is unmodified** — if it needed a change, the
design went wrong.

Note for the implementer: legacy stored graphs have `cooldownSeconds: 60` and no
`cooldownScope`, so the `select` renders `value=''` (`:84`) with no matching
option — the browser displays the first option ("The whole automation") while
`params.cooldownScope` stays `undefined`. Display and effective behaviour agree,
and it is byte-identical to how Phase 1's `emojiMode` behaves on legacy graphs.
Do **not** "fix" this by writing a default into stored params.

## 5. Docs

### 5.1 `docs/features/automation-engine.md`

- **`:42`** — "Cooldown / rate-limit **per automation**" → "Cooldown / rate-limit
  per automation, or **per node / per source+node** via the trigger's *Cooldown
  applies to*".
- **`:96`** (schedule section) — note a schedule trigger has no subject node, so
  its cooldown is always automation-wide.
- **New subsection under the trigger docs** — *Cooldown applies to*: the three
  values, the per-node worked example from §2.6, the degraded fallback and
  exactly which triggers hit it (Schedule, System, MeshCore **channel** messages
  — while MeshCore **DMs and room posts** do get real per-sender cooldown), and
  the "hidden until you set a cooldown" UI behaviour.
- **`:296`** (recipe, Automation A) — replace "leave at `0`" with: set `60`, set
  **Cooldown applies to** = *Each node separately*. **This is the user-visible
  payoff of the phase; the recipe must be updated or the phase is not done.**
- **`:332-340`** — **delete** the whole "Cooldown caveat (per-automation, not
  per-node)" section and replace it with a short pointer to the new subsection.
  It documents a limitation that no longer exists.
- **`:509`** (live trace) — note the `cooldown` reason now names the key that was
  cooling down.

### 5.2 `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md`

Flip Phase 2 to `[x] complete`; add a **Phase 2 close** block under *Notes /
deviations* recording: the `subjectNodeKey` addition and why it is cooldown-only;
the MeshCore channel-vs-DM asymmetry; the degraded-to-automation-wide fallback
decision; the `showIf.truthy` extension; the eviction strategy and its two caps;
the pre-switch validation guard; and the disable→re-enable cooldown reset.

## 6. Test plan (mandatory — standard Vitest suite, no standalone scripts)

| File | New / extend | Cases |
|---|---|---|
| `src/types/automation.test.ts` | extend | `cooldownScope` `'automation'`/`'node'`/`'sourceNode'` validate on a `trigger.message`; `'perNode'` produces the `∈ {automation,node,sourceNode}` error; **a trigger node with NO `cooldownScope` still validates**; the guard applies to a non-message trigger too (e.g. `trigger.telemetry`); `parseCooldownScope`: each valid value round-trips, `undefined`/`null`/`''`/`'bogus'`/`0` → `'automation'`. |
| `src/server/services/automation/triggerContext.test.ts` | extend | `subjectKeyOf`: Meshtastic message ctx → `'111'`; schedule ctx → `null`; system ctx with `nodeNum` → that number as a string, without → `null`; explicit `subjectNodeKey: null` beats a non-null `subjectNodeNum`. `buildMeshCoreMessageContext`: a **DM** → `subjectNodeKey === '<pubkey>'`; a **channel** post (`fromPublicKey: 'channel-0'`) → `subjectNodeKey === null`; a **room post** → the author pubkey. Every Meshtastic builder leaves `subjectNodeKey` `undefined`. |
| `src/server/services/automation/engineContext.test.ts` *(create if absent — check first)* | new/extend | `cooldownKeyFor` truth table across all three scopes × {Meshtastic node, MeshCore pubkey, no subject, no sourceId}: keys `''`/`'111'`/`'src:111'`; `degraded` true only on the two fallbacks; labels contain `automation-wide` / `node 111` / `source … · node …`; a 64-char pubkey label truncates to 12 chars + `…` while the **key stays full-length**. **Cross-check test:** for a Meshtastic context, `cooldownKeyFor('node'\|'sourceNode', ctx).key` equals `buildScopeKey('node'\|'sourceNode', varContextFromTrigger(ctx))`. |
| `src/server/services/automation/automationEngineService.test.ts` | extend | **(a) headline:** `cooldownSeconds: 60`, `cooldownScope: 'node'`; node 111 fires, node 222 fires **in the same window**, node 111 suppressed, node 111 fires after the window. **(b) regression:** identical graph with `cooldownScope` **absent** reproduces `:284`'s existing per-automation assertions exactly. **(c)** explicit `'automation'` behaves identically to (b). **(d)** `'sourceNode'`: same node on `'a'` then `'b'` both fire; repeat on `'a'` suppressed. **(e)** `'bogus'` behaves as `'automation'`. **(f) trace, all three sites:** message dispatch under `node` → reason matches `/cooldown active/` **and** `/node 111/`; `onSchedule` under `node` → `/automation-wide/`; `checkGeofences` under `node` → names the moving node. **(g)** MeshCore: two DMs from different pubkeys under `node` both fire; two **channel** messages → second suppressed with `automation-wide`. **(h)** `cooldownSeconds: 0` + `'node'` → every event fires. **(i) eviction:** with `cooldownSeconds: 1` and a fake clock, drive >`COOLDOWN_KEYS_MAX` distinct senders across advancing time; assert *behaviour* (a node inside its window is still suppressed), not map size. **(j) load-prune:** fire, disable, `load()`, re-enable, `load()`, fire same node inside the original window → it fires. |
| `src/server/services/automation/automationSimulator.test.ts` | extend | A dry-run with `cooldownSeconds: 60, cooldownScope: 'node'` fires; running `simulateAutomation` twice with the same subject at the same `now` fires **both** times — the simulator models no cooldown, by design. |
| `src/components/automations/catalog.showIf.test.ts` | extend | `truthy` truth table: `truthy: true` with `undefined`/`''`/`0`/`false` → hidden, with `1`/`60`/`'x'` → visible; `truthy: false` inverts; combined with `equals`. Catalog: all five cooldown-bearing blocks list `cooldownScope` **immediately after** `cooldownSeconds`; options exactly `['automation','node','sourceNode']` with `automation` first; `showIf` exactly `{ field: 'cooldownSeconds', truthy: true }`; `trigger.schedule`/`trigger.system` have **neither** field. |
| `src/components/automations/AutomationBuilder.cooldownScope.test.tsx` | **new** (model on `AutomationBuilder.emojiMode.test.tsx`) | `cooldownSeconds` unset → select **not** rendered; `0` → not rendered; `60` → rendered; changing it writes `params.cooldownScope = 'node'`; clearing the cooldown hides the select but **preserves** `params.cooldownScope`. |

Also required per CLAUDE.md: full `npx vitest run` green (0 failures, confirmed
via `--reporter=json` `success: true`), and
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` empty.
**No schema change ⇒ no migration and no PG/MySQL containers needed.**

## 7. Work packages

All agents share **one worktree**. File ownership is exclusive; the parallel pair
(WP2 ∥ WP3) share no file.

### WP1 — Vocabulary + validation *(must land first; blocks WP2 and WP3)*

**Owns:** `src/types/automation.ts` · `src/types/automation.test.ts`

**Delivers:** §2.1 and §2.2.

**Acceptance:** the three constants/functions exported with documented
semantics; a trigger node with no `cooldownScope` validates unchanged; an
unrecognised value errors with the `∈ {automation,node,sourceNode}` message; the
guard fires for **every** trigger type; `parseCooldownScope` is lenient per §2.1.
`git diff --stat` shows exactly two files. Full suite green.

### WP2 — Engine: keying, gating, trace, eviction *(after WP1; parallel with WP3)*

**Owns:** `src/server/services/automation/triggerContext.ts` ·
`.../triggerContext.test.ts` · `.../engineContext.ts` ·
`.../engineContext.test.ts` (new if absent) · `.../automationEngineService.ts` ·
`.../automationEngineService.test.ts` · `.../automationSimulator.test.ts`

**Delivers:** §2.3, §2.4, §2.5, and the WP2 rows of §6.

**Hard constraints:**
- Must **not** edit `src/types/automation.ts` (WP1) or anything under
  `src/components/` (WP3).
- Must **not** modify `automationSimulator.ts`, `actionExecutor.ts`,
  `meshActionDeps.ts`, `graphEvaluator.ts`, `automationTraceBus.ts`, or
  `LiveTracePanel.tsx`. Verify with `git diff --stat`.
- `subjectNodeNum` semantics must not change; `subjectNodeKey` must stay
  **optional**.
- After the change,
  `grep -n "lastFired" src/server/services/automation/automationEngineService.ts`
  must show hits only inside the declaration, `load()`, `cooldownGate`,
  `markFired`, and `pruneCooldownKeys` — **no `lastFired.get(a.id)` may survive
  at any of the three dispatch sites.**
- Every pre-existing test in `automationEngineService.test.ts` must pass
  **unmodified**, including the two `/cooldown active/` reason assertions at
  `:614` and `:657` — so the reason string must keep that exact prefix and
  append the key phrase in parentheses.

**Acceptance:** two senders on one channel cool down independently under `node`
scope; absent `cooldownScope` is byte-for-byte today's behaviour; all three trace
sites name the key; the eviction behaviour test passes; the simulator is provably
cooldown-free. Full suite green.

### WP3 — Builder: `showIf.truthy` + the catalog field *(after WP1; parallel with WP2)*

**Owns:** `src/components/automations/catalog.ts` · `.../catalog.showIf.test.ts` ·
`.../AutomationBuilder.cooldownScope.test.tsx` (new)

**Hard constraints:**
- Must **not** edit `src/types/automation.ts` (WP1) or `AutomationBuilder.tsx`.
  Use the string literals with a comment pointing at `CooldownScope`, exactly as
  Phase 1 did for `emojiMode`. **`AutomationBuilder.tsx` appearing in
  `git diff --stat` is a design failure — stop and escalate.**
- Do **not** rely on `FieldDef.advanced` for visibility — it is still never read.
- Does **not** deploy or drive the dev container; browser validation is the
  orchestrator's stage.

**Acceptance:** `fieldVisible` handles `truthy` per the truth table and the
existing `equals`/`notEquals` tests still pass unmodified; the select is hidden
until a non-zero cooldown is set and its value survives a hide/show round-trip;
the five-block/two-block split of §4.2 is asserted. Full suite green.

### WP4 — Docs *(after WP2 and WP3 both land)*

**Owns:** `docs/features/automation-engine.md` ·
`docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md`

**Acceptance:** §5 delivered. The "Cooldown caveat" section is **removed**, not
merely amended. The #4340 recipe now instructs a non-zero cooldown with *Each
node separately*. Every field label and option label quoted in the docs matches
the shipped catalog verbatim. The MeshCore channel-vs-DM asymmetry is
documented, not glossed.

**Dependency graph:** `WP1 → (WP2 ∥ WP3) → WP4`

## 8. Explicit non-goals

- **`geofenceState` is not bounded by this phase.** It has the same unbounded
  `${automationId}:${nodeNum}` growth (`automationEngineService.ts:121,
  :514-516`) and predates this work. Deleting an entry is *not* behaviour-neutral
  there — it resets the enter/exit baseline. Needs its own decision.
  **File a follow-up issue.**
- **`meshtasticManager.autoAckCooldowns` is not bounded** by this phase either —
  noted in §2.5 only as the counter-example. Same follow-up issue.
- **No `cooldownScope` for `trigger.schedule` / `trigger.system` in the UI.** The
  engine honours the param if an imported JSON sets it (degrading to
  automation-wide); the builder does not offer it because those triggers expose
  no cooldown field at all today.
- **No `channel` cooldown scope.** Genuinely useful for MeshCore channel messages,
  but not in the epic's decision list, and Meshtastic's `channelName` is not
  resolvable in the trigger context without a DB lookup on the cooldown hot path.
  Note it in the epic as a candidate.
- **`cooldownSeconds` validation** is not added (§2.2).

## 9. Contradictions and findings against the original brief

1. **The validation `switch` is keyed on `n.type`, and `cooldownScope` belongs to
   all seven trigger types.** The brief asked for a `case` following the
   `action.tapback` precedent; `emojiMode` is a *single-block* param, so its
   `case` is right for it, but replicating that here means seven duplicated
   `case` labels that silently miss the eighth trigger type added later. §2.2
   uses a one-line `categoryOf(n.type) === 'trigger'` guard. **Orchestrator
   signed off 2026-07-28.**
2. **`load()` pruning changes one edge case.** Disabling and re-enabling a
   node-scoped automation inside its own cooldown window will now let it fire
   immediately. Every alternative was worse. Documented, tested (§6 case (j)).
3. **`showIf` as shipped in Phase 1 cannot express "a number field that is set".**
   `equals`/`notEquals` cannot distinguish `undefined` / `''` / `0`. §4.1 adds
   one generic `truthy` operator — an extension, not a second mechanism.
4. **`graphEvaluator.test.ts` is not a relevant suite.** The evaluator runs
   strictly downstream of the cooldown gate.
5. **`resetCooldowns` does not exist.** `grep -rn "resetCooldown" src` is empty.
6. **MeshCore is only *half* scopable, and the failure mode is subtle.**
   `buildMeshCoreMessageContext` sets `subjectNodeNum: null` for **all** MeshCore
   messages, so the naive fix (key off `ctx.fields.from`) would key a MeshCore
   **channel** automation off the synthetic `channel-<idx>` slot string that
   *every sender on that channel shares* — a per-channel cooldown wearing a
   per-node label. §2.3 keys off `fromPublicKey` only when it is a real sender
   key and returns `null` for channel posts.
7. **`trigger.schedule` and `trigger.system` already honour a cooldown in the
   engine but expose no cooldown field in the builder** (`catalog.ts:104-124`).
   Pre-existing inconsistency, unchanged here.
8. **The five `COOLDOWN`-bearing trigger blocks are exactly
   `SUBJECT_NODE_TRIGGERS` (`catalog.ts:149`).** Verified, not assumed. WP3's
   catalog test pins the pairing.
9. **`lastFired` is written unconditionally today, even when
   `cooldownSeconds === 0`.** §2.5 stops doing that — unobservable, and keeps
   memory at exactly zero for the common cooldown-less automation.
