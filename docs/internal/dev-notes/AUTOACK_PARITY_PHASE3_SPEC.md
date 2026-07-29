# Auto-Acknowledge Parity Conditions — Phase 3 Implementation Spec

**Epic:** `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md` · **Issue:** #4340 (follow-on)
**Branch:** `feature/autoack-parity-conditions` · **Worktree:** `/home/yeraze/Development/meshmonitor-autoack-parity`
**Base:** `origin/main` @ `1e61ee07` (Phases 1 and 2 merged)

> **Orchestrator sign-off (2026-07-28):**
> **(a) APPROVED** — Phase 3 adds no new `ConditionType`. The two conditions the epic
> named become a computed `node.completeness` field plus `in`/`notIn` operators on
> `condition.string`. The tri-state argument is decisive: AutoAck skips on
> `fromNode && !isNodeComplete(fromNode)`, so a MISSING node row must not skip, and a
> boolean field cannot distinguish that from an incomplete node.
> **(b) APPROVED by the user (2026-07-28)** — WP3 proceeds and ships in Phase 3.
> The finding stands and must be documented honestly: `autoAckMaxAttempts` is NOT an
> Auto-Ack setting (it is `MessageQueueService.resolveDmMaxAttempts`, applied to every
> queued DM on the source), so `maxAttempts` on `action.sendMessage` is **not** required
> for converter fidelity — it is delivered as a capability in its own right. The user
> was shown that trade-off explicitly and chose to keep it in this phase.
>
> WP3's hard constraints in §7 are therefore load-bearing, not advisory: the unset call
> shape must stay byte-identical so every existing automation keeps today's fire-once
> behaviour, `automationSimulator.ts` (source) must not be edited, and the queue must be
> reached via the existing `resolveManager` duck-typing — no `instanceof`, no `as any`.

## 1. Reuse inventory (read this before writing any code)

Everything below already exists and **must be used or extended, not re-implemented**. Verified by symbolic search on 2026-07-28 against this worktree.

| Existing thing | Location | How Phase 3 uses it |
|---|---|---|
| `resolveFieldValue(ctx, field)`'s `node.` branch | `engineContext.ts:204-224` | **Extended** with one computed prop, `node.completeness`, joining the existing `ageMinutes` (`:215`) and `roleName` (`:220`). This is the entire "nodeComplete condition". |
| `ROLE_NAMES` | `engineContext.ts:83-86` | **Precedent** for a server-side value vocabulary living in `engineContext.ts` rather than `types/automation.ts`. `NODE_COMPLETENESS` lands beside it. |
| `isNodeComplete(node)` + `DbNodeLike` | `src/utils/nodeHelpers.ts:375-426` | **Called verbatim.** `NodeFacts` (`engineContext.ts:19-38`) already carries `longName`/`shortName`/`hwModel` — structurally a `DbNodeLike`. **Do not re-implement the "Node !xxxxxxxx" default-name check.** |
| `getSubjectNode(ctx)` | `engineContext.ts:136-142` | Unchanged. Its `null` return is what makes `unknown` a distinguishable third state. |
| `createMeshNodeDataProvider().getNode` | `meshNodeData.ts:19-26` → `NodesRepository.getNode` (`src/db/repositories/nodes.ts:130-150`) | Returns the **full row** (`.select()`), so `hwModel` is populated for real traffic without any repository change. |
| `stringCompare(op, a, b)` | `conditionEvaluator.ts:32-46` | **Extended** with two cases, `in` / `notIn`. `condition.string` has **no** `op` validation in `validateAutomationGraph` today, so no types change is needed for them. |
| `STRING_OP_OPTIONS` | `catalog.ts:251-255` | **Extended** with the two operators, and **exported** (one word) so the §6 parity test can cross-check it against the evaluator. |
| `EVENT_NUMERIC['trigger.message']` | `catalog.ts:183-186` | **Extended** with `isDM` and `viaMqtt`. Both are already in `ctx.trigger.fields` (`triggerContext.ts:113,120`) and `asNumber()` (`conditionEvaluator.ts:49-54`) already coerces `boolean → 1/0`. **Catalog-only change; zero engine change.** |
| `NODE_STRING` | `catalog.ts:214-217` | **Extended** with `node.completeness`. Label carries the legal values, exactly as `node.roleName` carries `(e.g. ROUTER)`. |
| `autoAckIgnoredNodes` parser | `meshtasticManager.ts:10037-10051` (`split(/[\s,]+/)`, lowercase, optional `!`) | **Separator/casing source of truth** for the `in`/`notIn` operator, so a converted list pastes across verbatim. Not called — the operator stays a generic string op. |
| `condition.meshcoreScope`'s `mode` + `includeUnscoped` | `types/automation.ts` `MESHCORE_SCOPE_MODES`, validation at the `case`, `conditionEvaluator.ts:96-115` | **Precedent considered and rejected** for node-completeness (§9.1) — it is the house shape for a *narrow* block whose data is unreachable generically. `node.completeness` **is** reachable generically. |
| `parseCooldownScope` / `COOLDOWN_SCOPES` (Phase 2) | `types/automation.ts` | **Exact template** for `parseSendMaxAttempts` / `SEND_MAX_ATTEMPTS_MIN|MAX`: exported const, lenient runtime parser, validate *only when present*. |
| `case 'action.delay'` param validation | `types/automation.ts` (`AUTOMATION_DELAY_MAX_SECONDS` bound check) | **Exact template** for the new `case 'action.sendMessage'` range check on `maxAttempts`. |
| `MessageQueueService.enqueue(..., maxAttemptsOverride, emoji)` | `src/server/messageQueueService.ts:101-114` | **The only DM retry/ACK mechanism in the app.** WP3 calls it; it is not modified. |
| `MessageQueueService.resolveDmMaxAttempts()` | `src/server/messageQueueService.ts:75-85` (clamp `[1,3]`, `MAX_ATTEMPTS = 3`) | **Bound source of truth** for `SEND_MAX_ATTEMPTS_MIN|MAX`. Not modified (§8). |
| `MeshtasticManager.messageQueue` | `meshtasticManager.ts:1107` — `public readonly` | Already public and per-source. WP3 reaches it through the existing `resolveManager(sourceId)` duck-typing in `meshActionDeps.ts:49-52`, **never** `instanceof` (CLAUDE.md). |
| `scopeArg` "only forward the key when set" trick | `actionExecutor.ts:305-306`, used at `:296`/`:304` | **Copied verbatim** for `maxAttempts`, so the default call shape — and every existing `actionExecutor.test.ts` assertion — is byte-identical. |
| `pushOrSkipTxDisabled(results, fn)` | `actionExecutor.ts:127-140` | Unchanged; both send call sites keep it. Its TX-disabled catch does **not** cover the queued path (§2.4 caveat, deliberate). |
| `recordingDeps()` | `automationSimulator.ts:110-124` | **No edit needed.** `async sendMessage(a) { return { action:'sendMessage', ...a } }` spreads the new optional field into the dry-run automatically. Pinned by a test so it cannot drift (§6). |
| `fieldVisible()` + `FieldDef.showIf.truthy` | `catalog.ts:31-52` (Phase 1 + Phase 2) | **Reused unchanged** to gate the new `maxAttempts` field on `to` being set. No new operator this phase. |
| `defaultParams(type, triggerType)` | `AutomationBuilder.tsx:48-63` | Seeds only `select`/`fieldselect`. `maxAttempts` is `kind: 'number'` ⇒ **absent by default** ⇒ today's behaviour. No change. |
| `clean(params)` in the compiler | `src/components/automations/compile.ts:34-41` | Drops `''`/`null`/`undefined`, so clearing the number field removes the param. `compile`/`decompile` are generic over block types ⇒ **`compile.ts` needs no change** for any of this phase. |
| `AutomationTester.tsx` fact builder + headline | `AutomationTester.tsx:96-99`, `:261-293` | `numFact('hwModel')` + one `<Field>`; one clause on the `sendMessage` headline. Both one-liners. |
| `createTestDb` / `recorder()` / `engineWith()` | `automationEngineService.test.ts:12,17-26,77-79` | Any engine-level test uses these. Do not invent a harness. |
| `VALID_SETTINGS_KEYS` / `PER_SOURCE_SETTINGS_KEYS` | `src/server/constants/settings.ts:9`, `:338` | **Read-only inputs** to the §6 parity test. **Phase 3 adds no setting**, so neither list is edited. |

### 1.1 Justification: zero new modules, zero new block types

| Candidate | Rejected because |
|---|---|
| `condition.nodeComplete` (a new `ConditionType`) | The predicate is a pure function of the already-hydrated subject node, reachable through the existing `node.*` field mechanism. A new type costs a union member, a `CONDITION_TYPES` entry, a validation `case`, an evaluator `case`, a catalog block, and a `fieldsFor` exemption — to express what `condition.string` on `node.completeness` expresses with **one computed prop**. See §9.1 for the tri-state argument that also makes it *more* correct. **Rejected.** |
| `condition.nodeInList` / `condition.nodeIgnored` | The list is a literal baked into the graph by the converter, not a lookup. A `notIn` operator on `condition.string` covers it *and* every other string field (node names, `roleName`, `channelName`, `telemetryType`, system `event`). A single-purpose block would be strictly less capable and strictly more code. **Rejected.** |
| `condition.boolean` (a generic true/false block) | Would be the third way to compare a field, alongside `numeric` and `string`. `asNumber()` already coerces `boolean → 1/0`, so `condition.numeric` on `isDM` `== 1` works today with **zero** engine change. **Rejected**; revisit only if the `== 1` idiom proves confusing in the wild. |
| `src/server/services/automation/nodeCompleteness.ts` | Would split a 4-line computed prop from `resolveFieldValue`, its only caller, next to two identical siblings. **Rejected.** |
| `src/types/sendAttempts.ts` | `types/automation.ts` is the canonical home for every engine vocabulary constant (`REQUEST_OPS`, `TAPBACK_EMOJI_MODES`, `COOLDOWN_SCOPES`, `COLLAPSE_MODES`). **Rejected.** |
| Adding `in`/`notIn` to `NUMERIC_OPS` | `condition.numeric`'s `op` **is** validated against `NUMERIC_OPS`, so this would widen a validated union for a case `fromId` already covers in its native `!xxxxxxxx` form. **Rejected** (§8). |

**Result:** `SEND_MAX_ATTEMPTS_MIN|MAX` + `parseSendMaxAttempts()` + one validation `case` → `src/types/automation.ts`. `NODE_COMPLETENESS` + the `node.completeness` branch → `engineContext.ts`. Two `case`s → `conditionEvaluator.ts`. One optional field + two forwardings → `actionExecutor.ts`. One queued branch → `meshActionDeps.ts`. Field options → `catalog.ts`. **No new source module.**

## 2. The parity mapping table (phase exit criterion; Phase 4's input)

Every key in `VALID_SETTINGS_KEYS` beginning `autoAck` — 33 of them (`src/server/constants/settings.ts:20-60`). "Per-source?" is membership in `PER_SOURCE_SETTINGS_KEYS` (`:338-370`). This table is mirrored by an in-code constant asserted against `VALID_SETTINGS_KEYS` in **both** directions (§6, `autoAckParity.test.ts`) — a future `autoAck*` key fails the suite until this table is updated.

| # | Setting | Per-source? | Engine equivalent | Status |
|---|---|---|---|---|
| 1 | `autoAckEnabled` | yes | The automation's own `enabled` column + `condition.sourceFilter` bound to that source | **exists** |
| 2 | `autoAckRegex` | yes | `trigger.message` param `regex` | **exists** ¹ |
| 3 | `autoAckMessage` | yes | `action.sendMessage` param `text` | **exists** ² |
| 4 | `autoAckMessageDirect` | yes | A second `action.sendMessage` on the ZeroHop branch | **exists** ² |
| 5 | `autoAckChannels` | yes | `trigger.message` param `channels` (unified, by name) | **exists** ³ |
| 6 | `autoAckDirectMessages` | yes | — *(deprecated; migration 093 folds it into the Direct\* cells)* | **n/a — deprecated** |
| 7 | `autoAckUseDM` | yes | — *(deprecated; folded into the `*ReplyDmEnabled` cells)* | **n/a — deprecated** |
| 8 | `autoAckSkipIncompleteNodes` | yes | `condition.string` · field `node.completeness` · op `in` · value `complete, unknown` | **Phase 3 adds** (field + operators) ⁴ |
| 9 | `autoAckIgnoredNodes` | yes | `condition.string` · field `fromId` · op `notIn` · value = the list verbatim | **Phase 3 adds** (operators) ⁵ |
| 10 | `autoAckTapbackEnabled` | **no** (global-only) | — *(deprecated)* | **n/a — deprecated** |
| 11 | `autoAckReplyEnabled` | **no** (global-only) | — *(deprecated)* | **n/a — deprecated** |
| 12 | `autoAckDirectEnabled` | yes | — *(deprecated)* | **n/a — deprecated** |
| 13 | `autoAckDirectTapbackEnabled` | yes | — *(deprecated)* | **n/a — deprecated** |
| 14 | `autoAckDirectReplyEnabled` | yes | — *(deprecated)* | **n/a — deprecated** |
| 15 | `autoAckMultihopEnabled` | yes | — *(deprecated)* | **n/a — deprecated** |
| 16 | `autoAckMultihopTapbackEnabled` | yes | — *(deprecated)* | **n/a — deprecated** |
| 17 | `autoAckMultihopReplyEnabled` | yes | — *(deprecated)* | **n/a — deprecated** |
| 18 | `autoAckTestMessages` | **no** (global) | **Not convertible, and does not need to be.** No server code reads it — it is a UI scratchpad on `AutoAcknowledgeSection.tsx` for pasting sample text. Its engine analogue is the Test panel (`AutomationTester.tsx`), a mechanism, not a setting. | **not convertible (by design)** |
| 19 | `autoAckCooldownSeconds` | yes | `trigger.message` `cooldownSeconds` + `cooldownScope: 'node'` | **exists** (Phase 2) ⁶ |
| 20 | `autoAckPreSendDelaySeconds` | yes | `action.delay` before the first send in the chain | **exists** ⁷ |
| 21 | `autoAckMaxAttempts` | yes | `action.sendMessage` param `maxAttempts` | **Phase 3 adds** ⁸ |
| 22 | `autoAckChannelZeroHopReplyEnabled` | yes | Cell rule emits `action.sendMessage`; cell = `isDM == 0` ∧ `zeroHop == 1` (the derived ZeroHop field — see note 9) | **exists + Phase 3 adds `isDM`/`viaMqtt` to the picker** ⁹ |
| 23 | `autoAckChannelZeroHopTapbackEnabled` | yes | Same cell → `action.tapback` `emojiMode: 'hopCount'` | **exists** (Phase 1) |
| 24 | `autoAckChannelZeroHopReplyDmEnabled` | yes | That cell's `action.sendMessage` gets `to: {{ trigger.from }}` | **exists** |
| 25 | `autoAckChannelMultiHopReplyEnabled` | yes | Cell = `isDM == 0` ∧ `zeroHop == 0` (the derived field's MultiHop reading — see note 9) → `action.sendMessage` | **exists + picker** ⁹ |
| 26 | `autoAckChannelMultiHopTapbackEnabled` | yes | Same cell → `action.tapback` `emojiMode: 'hopCount'` | **exists** |
| 27 | `autoAckChannelMultiHopReplyDmEnabled` | yes | `to: {{ trigger.from }}` on that cell's send | **exists** |
| 28 | `autoAckDirectZeroHopReplyEnabled` | yes | Cell = `isDM == 1` ∧ `zeroHop == 1` (the derived ZeroHop field — see note 9) → `action.sendMessage` | **exists + picker** ⁹ |
| 29 | `autoAckDirectZeroHopTapbackEnabled` | yes | Same cell → `action.tapback` `emojiMode: 'hopCount'` | **exists** |
| 30 | `autoAckDirectZeroHopReplyDmEnabled` | yes | No-op for Direct cells (a DM reply is inherently a DM); converter emits `to: {{ trigger.from }}` regardless | **exists** |
| 31 | `autoAckDirectMultiHopReplyEnabled` | yes | Cell = `isDM == 1` ∧ `zeroHop == 0` (the derived field's MultiHop reading — see note 9) → `action.sendMessage` | **exists + picker** ⁹ |
| 32 | `autoAckDirectMultiHopTapbackEnabled` | yes | Same cell → `action.tapback` `emojiMode: 'hopCount'` | **exists** |
| 33 | `autoAckDirectMultiHopReplyDmEnabled` | yes | No-op for Direct cells | **exists** |

**Notes (each is a Phase 4 converter obligation, not a Phase 3 gap):**

1. AutoAck defaults to `^(test|ping)` when the setting is blank (`meshtasticManager.ts:10102`); the engine's blank `regex` means **match anything**. The converter must emit the literal default.
2. Token dialects differ: AutoAck uses `{NUMBER_HOPS}`/`{TIME}`/`{NODE_NAME}`; the engine uses `{{ trigger.hops }}`/`{{ NOW }}`/`{{ trigger.fromName }}`. Translation is Phase 4 work. `{{ trigger.hopEmoji }}` (Phase 1) has no AutoAck equivalent — a superset, not a gap.
3. AutoAck stores channel **indices**; `trigger.message.channels` is unified **by name**. The converter resolves index→name per source. A source with two same-named channels is a converter edge case, not an engine one.
4. Tri-state is required for fidelity: AutoAck skips only when the node row **exists and is incomplete** (`if (fromNode && !isNodeComplete(fromNode))`, `:10084`). `complete, unknown` reproduces that exactly. See §9.1.
5. `in`/`notIn` split on `/[\s,]+/` and compare case-insensitively — the same separators and casing as AutoAck's own parser (`:10040-10043`). The converter normalises each entry to canonical `!xxxxxxxx` (AutoAck accepts a bare 8-hex token; `trigger.fromId` always carries the `!`). An **empty** value makes `notIn` always true, matching an unset ignore list — but the converter should simply omit the condition.
6. AutoAck's default is **60s** when unset (`:10092`); the engine's is **0**. The converter must emit `60` explicitly. `cooldownScope: 'node'` is mandatory — AutoAck's map is keyed by `fromNum` (`:10094`).
7. Two semantic differences: AutoAck's delay is a non-blocking `setTimeout` (`:10172-10178`) while `action.delay` blocks its own run and caps at `AUTOMATION_DELAY_MAX_SECONDS = 300`; and AutoAck applies the same delay independently to the tapback and the reply, so a converted linear chain needs the `action.delay` once, before the first send.
8. **Read this row carefully.** `checkAutoAcknowledge` never reads `autoAckMaxAttempts`. `MessageQueueService.resolveDmMaxAttempts()` reads it per-source and applies it to **every queued DM** on that source (auto-responder, welcome, mailbox, auto-ack reply). It therefore affects the AutoAck **reply, and only when that reply is a DM**: the AutoAck **tapback** hardcodes `1` ("tapbacks are best-effort, don't retry", `:10207`) and **channel** sends hardcode `1` (`messageQueueService.ts:112`). Consequently `maxAttempts` goes on `action.sendMessage` **only** — see §9.2. The setting also keeps governing the source's other queued DMs after conversion, so disabling AutoAck does not retire it.
9. `isDM` and `viaMqtt` already resolve at runtime (`triggerContext.ts:113,120` + `asNumber()` boolean coercion) but are **not offered by the builder's field picker**, and `fieldselect` is a plain `<select>` (`AutomationBuilder.tsx:89-99`) — a converter-written value renders blank and is overwritten on the first edit. Phase 3 adds both options so a converted automation is **editable**, not merely runnable. `viaMqtt` is load-bearing: `isZeroHop = hopsTraveled === 0 && !viaMqtt` (`AUTOACK_2X2_PLAN.md`, `:10141`). **Phase 4 adds a third field, `zeroHop`** (1 = arrived direct over RF with 0 hops; 0 = relayed or via MQTT), computed via `autoAckIsZeroHop()` on the floored hop count (`triggerContext.ts`). It exists because the mechanism this note originally implied — a *branch* on a single `condition.numeric hops > 0` node's true/false ports (§3.6 below) — makes `decompile()` return `null` for the resulting graph (`compile.ts:128`), which forces the automation into the raw-JSON editor on first open; `zeroHop` is a flat, `NaN`-safe field with identical behaviour and no such penalty. The four ZeroHop/MultiHop cell rows above (22/25/28/31) are built from `isDM` + `zeroHop` in the shipped converter, not from `hops`/`viaMqtt` directly. See `docs/internal/dev-notes/AUTOACK_CONVERTER_PHASE4_SPEC.md` §3.1 and §9.1.

**Adjacent behaviour not in the table** (not `autoAck*` keys, recorded so Phase 4 does not rediscover them): the per-packet dedup guard (`:9967-9978`) has no engine analogue and needs none; the TX-disabled skip (`:10001`) is already mirrored by `pushOrSkipTxDisabled`; the airtime cutoff (`isAutomationAirtimeGated`, `automationAirtimeCutoff*`) is shared infrastructure both paths already honour; the local-node skip (`:10065-10070`) is already covered by the engine's self-drop (`getLocalNodeNum`, #3914). **MeshCore auto-ack is a separate `meshcoreAutoAck*` namespace** (`meshcoreManager.ts:6873-6925`) and is out of scope for this table.

## 3. Backend design

### 3.1 `node.completeness` — `engineContext.ts`

Beside `ROLE_NAMES` (`:83-86`):

```ts
/**
 * The three states of `node.completeness` (#4340 Phase 3).
 *
 *  - 'complete'    the subject node's row exists and isNodeComplete() passes
 *                  (real longName, a shortName, and an hwModel from NODEINFO).
 *  - 'incomplete'  the row exists but NODEINFO has not arrived.
 *  - 'unknown'     there is NO row for the subject, or the event has no subject
 *                  node at all (Schedule / System / MeshCore).
 *
 * The third state is the point. Auto-Acknowledge skips a sender only when the
 * row EXISTS and is incomplete (`if (fromNode && !isNodeComplete(fromNode))`,
 * meshtasticManager.ts:10084) — an unknown sender is NOT skipped. A boolean
 * field cannot express that: a missing row and an incomplete row both resolve
 * to a falsy/undefined value. So the AutoAck rule is
 * `node.completeness in (complete, unknown)`.
 */
export const NODE_COMPLETENESS = ['complete', 'incomplete', 'unknown'] as const;
export type NodeCompleteness = (typeof NODE_COMPLETENESS)[number];
```

In `resolveFieldValue`'s `node.` branch (`:206-224`), **before** the existing `if (!node) return undefined;` guard:

```ts
if (field.startsWith('node.')) {
  const node = await getSubjectNode(ctx);
  const prop = field.slice('node.'.length);
  // #4340 Phase 3: resolved BEFORE the `!node` guard below, because "there is no
  // node row" is a meaningful VALUE here ('unknown'), not a missing field.
  if (prop === 'completeness') {
    return node ? (isNodeComplete(node) ? 'complete' : 'incomplete') : 'unknown';
  }
  if (!node) return undefined;
  // …ageMinutes / roleName / passthrough unchanged…
}
```

Import: `import { isNodeComplete } from '../../../utils/nodeHelpers.js';`. `NodeFacts` is structurally a `DbNodeLike` (`longName?`, `shortName?`, `hwModel?`) — no cast, no shim, no new type. `nodeHelpers.ts` is framework-free and already imported by server code.

**`getSubjectNode` is memoised** (`ctx.__nodeP`), so a graph using both `node.completeness` and `node.batteryLevel` still performs one DB read.

### 3.2 `in` / `notIn` — `conditionEvaluator.ts`

In `stringCompare` (`:32-46`), before `default`:

```ts
    // #4340 Phase 3: membership in a literal list. Separators and casing mirror
    // Auto-Acknowledge's own autoAckIgnoredNodes parser (meshtasticManager.ts:
    // 10040-10043) — comma OR whitespace, case-insensitive — so a converted
    // ignore list pastes across verbatim. Deliberately generic: no node-id
    // normalisation happens here (the converter emits canonical !xxxxxxxx
    // tokens, which is exactly the shape trigger.fromId carries).
    // An EMPTY list makes `in` never match and `notIn` always match — which is
    // the correct reading of "an unset ignore list ignores nobody".
    case 'in':
    case 'notIn': {
      const hit = b.toLowerCase().split(/[\s,]+/).filter(Boolean).includes(al);
      return op === 'in' ? hit : !hit;
    }
```

`al` is the already-lowercased left operand (`:33`). **No `validateAutomationGraph` change** — `condition.string` has no `op` validation today, and adding one would reject stored graphs (same reasoning as Phase 2's `cooldownSeconds`).

### 3.3 `maxAttempts` vocabulary + validation — `types/automation.ts`

Beside `COOLDOWN_SCOPES`:

```ts
/**
 * App-level DM resend cap for `action.sendMessage` (#4340 Phase 3).
 *
 * Mirrors MessageQueueService's own bound (src/server/messageQueueService.ts:
 * 75-85, `Math.min(3, Math.max(1, …))`, #4266) — an unbounded value would let an
 * automation be abused as a repeat-broadcast mechanism. The duplication is
 * deliberate: this module must stay dependency-free (the frontend imports it),
 * and the queue's clamp is load-bearing for #4266 and must not be refactored
 * from here. autoAckParity.test.ts pins the two to the same numbers.
 */
export const SEND_MAX_ATTEMPTS_MIN = 1;
export const SEND_MAX_ATTEMPTS_MAX = 3;

/**
 * Coerce a stored `params.maxAttempts` to an integer in [1,3], or `undefined`
 * for absent / blank / unparseable — `undefined` means "one direct send", the
 * pre-4.14 behaviour every stored automation depends on. Lenient at RUNTIME
 * while validateAutomationGraph rejects an out-of-range value at SAVE time —
 * the same split Phase 1 used for emojiMode and Phase 2 for cooldownScope.
 */
export function parseSendMaxAttempts(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) return undefined;
  return Math.min(SEND_MAX_ATTEMPTS_MAX, Math.max(SEND_MAX_ATTEMPTS_MIN, n));
}
```

New `case` in the per-block param switch, modelled on `case 'action.delay'`:

```ts
        case 'action.sendMessage':
          // Optional. Absent/blank = one direct send — every pre-existing stored
          // automation must keep validating and behaving exactly as before.
          if (p.maxAttempts != null && p.maxAttempts !== '') {
            const n = Number(p.maxAttempts);
            if (!Number.isInteger(n) || n < SEND_MAX_ATTEMPTS_MIN || n > SEND_MAX_ATTEMPTS_MAX) {
              errors.push(`action.sendMessage "${n2.id}" requires params.maxAttempts ∈ [${SEND_MAX_ATTEMPTS_MIN}, ${SEND_MAX_ATTEMPTS_MAX}]`);
            }
          }
          break;
```

*(The loop variable is `n`; rename the local to avoid shadowing — implementer's choice, e.g. `attempts`.)*

### 3.4 `maxAttempts` through the deps boundary — `actionExecutor.ts`

`ActionDeps.sendMessage`'s argument object (`:21-33`) gains:

```ts
    /**
     * App-level DM resend cap (#4340 Phase 3), 1–3. Absent = one direct send —
     * today's behaviour for every existing automation. Honoured ONLY for a
     * Meshtastic DM: the retry machinery is MessageQueueService, which hardcodes
     * maxAttempts=1 for channel sends, and MeshCore has no queue at all. See
     * meshActionDeps.sendTextVia.
     */
    maxAttempts?: number;
```

In `case 'action.sendMessage'`, beside the `scopeArg` computation:

```ts
      // Only forward the key when set, so the default (unset) call shape — and
      // thus the run-log resolvedParams and every existing test — is unchanged.
      // Same trick as scopeArg above.
      const attempts = parseSendMaxAttempts(p.maxAttempts);
      const attemptsArg = attempts !== undefined ? { maxAttempts: attempts } : {};
```

…spread into **both** `deps.sendMessage(…)` call sites (`:296` and `:304`). The channel-loop site (`:304`) can only be reached with `destination == null`, so the value is inert there; forwarding it anyway keeps one rule ("the deps decide whether it applies") and keeps the dry-run's resolved params honest about what the user configured.

### 3.5 The queued path — `meshActionDeps.ts`

Add a duck-typed capability interface beside `MeshSendManager` (`:19-32`):

```ts
/**
 * A Meshtastic manager's per-source outgoing queue (meshtasticManager.ts:1107,
 * `public readonly`). The ONLY thing in the app that retries a DM until it is
 * ACKed — the same path Auto-Acknowledge's reply takes (meshtasticManager.ts:
 * 10248). Duck-typed like every other capability check in this file; never
 * `instanceof` (CLAUDE.md).
 */
interface QueuedSendManager {
  messageQueue?: {
    enqueue(
      text: string, destination: number, replyId?: number,
      onSuccess?: () => void, onFailure?: (reason: string) => void,
      channel?: number, maxAttemptsOverride?: number, emoji?: number,
    ): string;
  };
}
```

`sendTextVia` gains a `maxAttempts?: number` parameter and, inside the existing Meshtastic branch (`:79-84`), **before** the direct `sendTextMessage` call:

```ts
    const dest = typeof destination === 'number' ? destination : undefined;
    // #4340 Phase 3. Opt-in ONLY: absent maxAttempts, a channel send, or a
    // MeshCore source all take the unchanged direct path below.
    //   * Channel sends are excluded because the queue hardcodes maxAttempts=1
    //     for them (messageQueueService.ts:112) — the parameter would buy
    //     nothing while silently imposing the queue's 30s inter-send throttle
    //     on every channel automation that set it.
    //   * The queue is fire-and-forget: it returns a queue id synchronously, so
    //     this returns a descriptive object instead of a packet id, and a
    //     TX-disabled throw surfaces later in the queue's onFailure rather than
    //     through actionExecutor's pushOrSkipTxDisabled. Both are exactly how
    //     Auto-Acknowledge itself behaves — that IS the parity.
    const q = (raw as QueuedSendManager).messageQueue;
    if (maxAttempts != null && dest != null && typeof q?.enqueue === 'function') {
      const id = q.enqueue(
        text, dest, replyId,
        () => logger.debug(`[Automation] queued DM to !${dest.toString(16).padStart(8, '0')} delivered`),
        (reason: string) => logger.warn(`[Automation] queued DM to !${dest.toString(16).padStart(8, '0')} failed: ${reason}`),
        undefined,             // channel: undefined ⇒ this is a DM
        maxAttempts,
        emoji || undefined,
      );
      return { queued: true, messageId: id, maxAttempts };
    }
    return raw.sendTextMessage(text, channel, dest, replyId, emoji);
```

`createMeshActionDeps().sendMessage` (`:107-109`) destructures and forwards `maxAttempts`. `sendTapback` (`:111-113`) is **unchanged** — see §9.2. Add `import { logger } from '../../../utils/logger.js';`.

### 3.6 Worked example — the converted AutoAck rule

Source `tcp-1`; AutoAck config: regex `^(test|ping)`, channels `[0]`, cooldown 60s, skip-incomplete on, ignore list `!aabbccdd, 11223344`, max attempts 3, ChannelZeroHop = Reply+Tapback with Respond-via-DM.

```
trigger.message   { channels:[{protocol:'meshtastic',name:'Primary'}],
                    regex:'^(test|ping)', cooldownSeconds:60, cooldownScope:'node' }
  → condition.sourceFilter { sourceIds:['tcp-1'] }
  → condition.string  { field:'fromId',           op:'notIn', value:'!aabbccdd, !11223344' }
  → condition.string  { field:'node.completeness', op:'in',    value:'complete, unknown' }
  → condition.numeric { field:'isDM',    op:'==', value:0 }
  → condition.numeric { field:'viaMqtt', op:'==', value:0 }
  → condition.numeric { field:'hops',    op:'>',  value:0 }        // ← MultiHop on `true`,
                                                                   //   ZeroHop on `false`
  ─false→ action.tapback     { emojiMode:'hopCount' }
       →  action.sendMessage { text:'…', to:'{{ trigger.from }}', maxAttempts:3 }
```

The `hops > 0` **branch**, rather than two independent `== 0` / `> 0` conditions, is deliberate: a packet with no `hopStart`/`hopLimit` yields `hops === undefined` → `NaN` → **both** comparisons false, whereas AutoAck floors it to `0` and treats it as ZeroHop (`:10127-10134`). Routing ZeroHop onto the `false` port reproduces AutoAck exactly at zero code cost. **Record this in the epic; it is a Phase 4 converter obligation.**

## 4. What does **not** change

- **No new `ConditionType`, no new `ActionType`, no new `TriggerType`.** `CONDITION_TYPES` / `ACTION_TYPES` / `TRIGGER_TYPES` and their unions are untouched.
- **`automationEngineService.ts` is untouched.** No trigger param, no cooldown interaction, no dispatch change. Verify with `git diff --stat`.
- **`automationSimulator.ts` is untouched.** `recordingDeps().sendMessage` spreads its argument object, so the new optional field reaches the dry-run for free (§6 pins this).
- **`triggerContext.ts` is untouched.** `isDM` / `viaMqtt` / `fromId` / `hops` are already in `fields`; Phase 3 only makes them *selectable*.
- **`graphEvaluator.ts`, `automationTraceBus.ts`, `LiveTracePanel.tsx`, `variableResolver.ts`, `meshNodeData.ts` are untouched.**
- **`compile.ts` / `decompile()` are untouched** — generic over `{type, params}`.
- **`AutomationBuilder.tsx` is untouched.** New field options ride the existing `fieldselect`/`number` renderers and the existing `fieldVisible` filter (`:227-228`). **Its appearance in `git diff --stat` is a design failure — stop and escalate.**
- **`MessageQueueService` is untouched** — no signature, clamp, or interval change. WP3 is a caller only.
- **`meshtasticManager.ts` / `checkAutoAcknowledge` / `AutoAcknowledgeSection.tsx` / `AutomationContext.tsx` are untouched.** AutoAck's own behaviour must be provably unchanged this phase.
- **`meshcoreManager.ts` is untouched.** MeshCore's `meshcoreAutoAck*` namespace is out of scope.
- **No new setting** ⇒ no `VALID_SETTINGS_KEYS` / `PER_SOURCE_SETTINGS_KEYS` edit. **No schema change, no migration** ⇒ no PostgreSQL/MySQL containers required to verify this phase.
- **No route, no response envelope work.** Phase 3 adds no HTTP surface. (Phase 4's preview/create route is where the envelope rules land.)
- **Per-source scoping:** all three new conditions are evaluated from `TriggerContext.sourceId` + `subjectNodeNum` through the existing `NodeDataProvider.getNode(sourceId, nodeNum)`. **No new query, no new repository method, no raw SQL.** The ignore list is a literal in the graph, and the graph is scoped by the existing `condition.sourceFilter`.

## 5. Frontend

### 5.1 `catalog.ts` — field pickers and operators

```ts
const EVENT_NUMERIC: Record<string, FieldOpt[]> = {
  'trigger.message': [
    { value: 'hops', label: 'Hop count' }, { value: 'from', label: 'Sender node #' },
    { value: 'channel', label: 'Channel #' }, { value: 'snr', label: 'SNR' }, { value: 'rssi', label: 'RSSI' },
    // #4340 Phase 3: booleans compared as 1/0 (the engine's asNumber() coerces
    // them). Needed to express Auto-Acknowledge's {Channel,Direct} ×
    // {ZeroHop,MultiHop} matrix, where ZeroHop means hops == 0 AND NOT viaMqtt.
    { value: 'isDM', label: 'Is a direct message (1 = yes, 0 = channel)' },
    { value: 'viaMqtt', label: 'Arrived via MQTT (1 = yes, 0 = RF)' },
  ],
  …
};

const NODE_STRING: FieldOpt[] = [
  …,
  // #4340 Phase 3 — see NODE_COMPLETENESS in engineContext.ts. Three states, so
  // "complete or not yet known" is expressible with the `is one of` operator.
  { value: 'node.completeness', label: 'Node info completeness (complete / incomplete / unknown)' },
];

export const STRING_OP_OPTIONS = [   // ← now exported, for the parity cross-check test
  …,
  { value: 'in', label: 'is one of (comma list)' },
  { value: 'notIn', label: "isn't one of (comma list)" },
];
```

### 5.2 `catalog.ts` — the `maxAttempts` field on `action.sendMessage`

Appended to that block's `fields`, after `replyToTrigger`:

```ts
      {
        name: 'maxAttempts', label: 'DM resend attempts', kind: 'number', advanced: true,
        placeholder: '1', // 1–3; mirrors SEND_MAX_ATTEMPTS_* in src/types/automation.ts.
        // Only meaningful for a DM — the queue hardcodes 1 attempt for channel
        // sends. Reuses Phase 2's showIf.truthy so an unset/blank/0 `to` hides it.
        showIf: { field: 'to', truthy: true },
        help: 'Resend this DM (1–3) until the recipient ACKs it — the same retry Auto-Acknowledge uses. Leave blank for a single send. Setting it routes the DM through the source’s outgoing queue, which also spaces sends 30 seconds apart. Meshtastic DMs only: ignored for channel messages and MeshCore.',
      },
```

`showIf: { field: 'to', truthy: true }` is a **direct reuse** of Phase 2's operator; no new `showIf` mechanism this phase.

### 5.3 `AutomationTester.tsx` — two one-liners

- **`hwModel` subject-node fact.** `numFact('hwModel');` at `:96` plus `<Field label="HW model (#)" value={facts.hwModel} onChange={(v) => setFact('hwModel', v)} type="number" />` beside Long/Short name (`:166-167`). Without it a dry-run of `node.completeness` reports `incomplete` for any synthetic node, because `isNodeComplete` requires an `hwModel` — a confusing false negative. (`stubData` merges `{ nodeNum, ...liveNode, ...node }`, so a *real* node's `hwModel` already survives.)
- **Headline.** At `:264`, append the cap when it is set and the send is a DM:
  `headline = \`Send message → ${p.destination != null ? \`DM to node ${p.destination}${p.maxAttempts ? \` (up to ${p.maxAttempts} attempts)\` : ''}\` : \`channel ${p.channel ?? 0}\`}\`;`
  This is the visible proof that the param crossed the deps boundary.

### 5.4 No change

`AutomationBuilder.tsx`, `compile.ts`, `tokenHints.ts`, `SubstitutionsHelp.tsx` (no new `{{ }}` token this phase), `AutomationsPage.tsx`, `LiveTracePanel.tsx`.

## 6. Test plan (mandatory — standard Vitest suite, no standalone scripts)

| File | New / extend | Cases |
|---|---|---|
| `src/types/automation.test.ts` | extend | `parseSendMaxAttempts`: `1`/`2`/`3` round-trip; `'2'` → `2`; `undefined`/`null`/`''`/`'x'`/`1.5` → `undefined`; `0` → `1`, `9` → `3` (clamp). Validation: `action.sendMessage` with **no** `maxAttempts` validates unchanged; `''` validates; `2` validates; `0`, `4`, `'x'`, `2.5` each produce the `∈ [1, 3]` error. A graph with only `text` still validates (regression: the new `case` must not require anything). |
| `src/server/services/automation/engineContext.test.ts` | extend | `resolveFieldValue(ctx, 'node.completeness')` truth table: full node → `'complete'`; `longName: 'Node !aabbccdd'` → `'incomplete'`; missing `hwModel` → `'incomplete'`; missing `shortName` → `'incomplete'`; provider returns `null` → `'unknown'`; `subjectNodeNum: null` (schedule ctx) → `'unknown'`. **Cross-check:** for every case, the value equals `isNodeComplete(row) ? 'complete' : 'incomplete'` where the row exists — i.e. the condition never re-implements the helper. `NODE_COMPLETENESS` contains exactly those three strings. Existing `ageMinutes`/`roleName`/passthrough tests pass **unmodified** (the new branch must not shadow them), and `node.<missing prop>` still returns `undefined`. `getSubjectNode` is called **once** for a ctx that reads both `node.completeness` and `node.batteryLevel` (memoisation regression). |
| `src/server/services/automation/conditionEvaluator.test.ts` | extend | `in`/`notIn`: comma list, whitespace list, mixed `a, b  c`; case-insensitive both sides; exact-token (not substring) — `'!aabbccdd'` is **not** `in` `'!aabbccddee'`; empty value → `in` false, `notIn` true; left operand missing → `in` false, `notIn` true; every pre-existing `stringCompare` op behaves unchanged. End-to-end `condition.string` nodes: `{field:'fromId', op:'notIn', value:'!aabbccdd'}` false for that sender, true for another; `{field:'node.completeness', op:'in', value:'complete, unknown'}` true for complete **and** for a null node, false for incomplete. `condition.numeric` on `isDM`/`viaMqtt` with `== 1` / `== 0` for both boolean values **and** for `undefined` (→ `NaN` → both false, pinning the documented behaviour). |
| `src/server/services/automation/actionExecutor.test.ts` | extend | `action.sendMessage` with **no** `maxAttempts` calls `deps.sendMessage` with an argument object that has **no `maxAttempts` key** (`expect(arg).not.toHaveProperty('maxAttempts')` — the "unchanged call shape" contract); with `maxAttempts: 2` forwards `2`; with `'3'` forwards `3`; with `9` forwards `3` (clamped by `parseSendMaxAttempts`); with `''` forwards nothing. Forwarded on the channel-multi path too. `action.tapback` **never** receives `maxAttempts` (`sendTapback` arg has no such key) — pins §9.2. |
| `src/server/services/automation/meshActionDeps.test.ts` | extend | With a fake manager exposing `sendTextMessage` **and** `messageQueue.enqueue`: no `maxAttempts` → `sendTextMessage` called, `enqueue` **not**; `maxAttempts: 3` + numeric `destination` → `enqueue` called with `(text, dest, replyId, fn, fn, undefined, 3, undefined)` and `sendTextMessage` **not**, return value `{ queued: true, messageId, maxAttempts: 3 }`; `maxAttempts: 3` + **no** destination (channel send) → `sendTextMessage`; a manager with **no** `messageQueue` → `sendTextMessage` (graceful degrade); a MeshCore manager (only `sendMessage`) → MeshCore path, `maxAttempts` ignored, no throw. |
| `src/server/services/automation/automationSimulator.test.ts` | extend | **Drift guard (no production change in this file):** a dry-run of `action.sendMessage` with `to` + `maxAttempts: 2` returns `resolvedParams.maxAttempts === 2`, proving `recordingDeps()`'s spread carries new deps fields; and the dry-run performs **no** real send (no `messageQueue` reachable from the simulator). |
| `src/components/automations/catalog.showIf.test.ts` | extend | `EVENT_NUMERIC['trigger.message']` contains `isDM` and `viaMqtt`; `NODE_STRING` contains `node.completeness`; `STRING_OP_OPTIONS` contains `in` and `notIn` and is exported; `action.sendMessage`'s `maxAttempts` field is `kind: 'number'`, `advanced: true`, `showIf` exactly `{ field: 'to', truthy: true }`; `fieldVisible(maxAttemptsField, {})`/`{to: ''}`/`{to: 0}` → false, `{to: '{{ trigger.from }}'}`/`{to: 123}` → true. Existing `truthy`/`equals`/`notEquals` tests pass **unmodified**. |
| `src/components/automations/AutomationTester.parity.test.tsx` | **new** (model on `AutomationBuilder.emojiMode.test.tsx`) | The Subject-node facts form renders an **HW model** input and writes `facts.hwModel`; a `sendMessage` result with `destination` + `maxAttempts: 3` renders a headline containing `up to 3 attempts`; the same result **without** `maxAttempts`, and a channel result **with** it, do not. |
| `src/server/services/automation/autoAckParity.test.ts` | **new — the phase's exit criterion** | Holds the §2 table as an in-code `const AUTOACK_PARITY: Record<string, {status: 'exists'\|'phase3'\|'deprecated'\|'notConvertible'; engine: string[]}>`, and asserts: **(a)** its key set equals `VALID_SETTINGS_KEYS.filter(k => k.startsWith('autoAck'))` in **both directions** — a new `autoAck*` key fails this suite until the table is updated; **(b)** every `type:` reference resolves in `TRIGGER_TYPES`/`CONDITION_TYPES`/`ACTION_TYPES`; **(c)** every `param:` reference is a real `FieldDef.name` in that block's `BLOCK_BY_TYPE` entry; **(d)** every `field:` reference appears in `numericFields('trigger.message')`/`stringFields('trigger.message')` flattened; **(e)** every `op:` reference appears in `STRING_OP_OPTIONS` or `NUMERIC_OPS`; **(f)** exactly the rows the table marks `deprecated` are the ten keys migration 093 lists (`src/server/migrations/093_autoack_matrix.ts:29-36` + the two DM-routing keys); **(g)** `SEND_MAX_ATTEMPTS_MIN/MAX === 1/3`, pinning the duplication of `MessageQueueService`'s clamp; **(h)** every key the table marks `phase3` or `exists` names at least one engine reference (no empty promises). |

Also required per CLAUDE.md: full `npx vitest run` green (0 failures, confirmed via `--reporter=json` `success: true`), and `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` empty. **No schema change ⇒ no migration and no PG/MySQL containers needed.** Watch the ratchet: `automationEngineService.ts`'s `no-explicit-any` baseline is 6 — do not add casts; `p.maxAttempts` on a `Record<string, unknown>` needs none.

## 7. Work packages

All agents share **one worktree**. File ownership is exclusive; the parallel trio (WP2 ∥ WP3 ∥ WP4) share no file.

### WP1 — Vocabulary + validation *(must land first; blocks WP2/WP3/WP4)*

**Owns:** `src/types/automation.ts` · `src/types/automation.test.ts`
**Delivers:** §3.3 and the WP1 row of §6.
**Hard constraints:** do **not** add a `ConditionType`/`ActionType`; do **not** validate `condition.string`'s `op`. `git diff --stat` shows exactly two files.
**Acceptance:** an `action.sendMessage` node with no `maxAttempts` validates byte-identically to today; out-of-range errors carry the `∈ [1, 3]` message; `parseSendMaxAttempts` is lenient per §3.3. Full suite green.

### WP2 — Engine conditions: `node.completeness` + `in`/`notIn` *(after WP1; ∥ WP3, WP4)*

**Owns:** `src/server/services/automation/engineContext.ts` · `.../engineContext.test.ts` · `.../conditionEvaluator.ts` · `.../conditionEvaluator.test.ts`
**Delivers:** §3.1, §3.2, and the WP2 rows of §6.
**Hard constraints:**
- Must **not** edit `src/types/automation.ts` (WP1), anything under `src/components/` (WP4), `actionExecutor.ts` / `meshActionDeps.ts` (WP3), `triggerContext.ts`, `automationEngineService.ts`, `meshNodeData.ts`, or any repository.
- **Must not re-implement `isNodeComplete`** — import it from `src/utils/nodeHelpers.ts`. A local copy of the `'Node !'` prefix check is an automatic reject.
- The `node.completeness` branch must sit **before** the `if (!node)` guard; every existing `node.*` test must pass unmodified.
- `in`/`notIn` must be added to `stringCompare` only — no new `case` in `evaluateCondition`, no validation change.

**Acceptance:** the §3.1 tri-state truth table holds including `unknown`; `notIn` on `fromId` reproduces AutoAck's ignore-list semantics for canonical `!xxxxxxxx` tokens with either separator; existing `conditionEvaluator.test.ts` passes unmodified. Full suite green.

### WP3 — `maxAttempts` through the deps boundary *(after WP1; ∥ WP2, WP4)* — **independently droppable, see §9.2**

**Owns:** `src/server/services/automation/actionExecutor.ts` · `.../actionExecutor.test.ts` · `.../meshActionDeps.ts` · `.../meshActionDeps.test.ts` · `.../automationSimulator.test.ts`
**Delivers:** §3.4, §3.5, and the WP3 rows of §6 (including the simulator drift guard).
**Hard constraints:**
- **`automationSimulator.ts` (the source file) must NOT be edited** — only its test. `recordingDeps()`'s spread already carries the field; if the implementer finds themselves editing `recordingDeps`, the design went wrong — stop and escalate.
- Must **not** edit `src/server/messageQueueService.ts` or `src/server/meshtasticManager.ts`.
- Must **not** add `maxAttempts` to `ActionDeps.sendTapback` (§9.2).
- Reach the queue only via the existing `resolveManager(sourceId)` duck-typing. **No `instanceof`, no `as any`** (CLAUDE.md + the `no-explicit-any` ratchet).
- The unset call shape must be byte-identical: every existing `actionExecutor.test.ts` assertion on `deps.sendMessage`'s argument passes unmodified.

**Acceptance:** a DM with `maxAttempts` enqueues (and only then); everything else takes today's direct path; the dry-run surfaces the param without a simulator source change. Full suite green.

### WP4 — Builder catalog + Test panel *(after WP1; ∥ WP2, WP3)*

**Owns:** `src/components/automations/catalog.ts` · `.../catalog.showIf.test.ts` · `.../AutomationTester.tsx` · `.../AutomationTester.parity.test.tsx` (new)
**Delivers:** §5 and the WP4 rows of §6.
**Hard constraints:**
- Must **not** edit `AutomationBuilder.tsx`, `compile.ts`, `tokenHints.ts`, or anything under `src/server/` or `src/types/`. Use string literals with a comment pointing at the server-side constant, exactly as Phase 1 did for `emojiMode` and Phase 2 for `cooldownScope`. **`AutomationBuilder.tsx` in `git diff --stat` is a design failure — stop and escalate.**
- Do **not** add a new `showIf` operator; reuse `truthy`.
- Do **not** rely on `FieldDef.advanced` for visibility — it is still never read.
- Does **not** deploy or drive the dev container; browser validation is the orchestrator's stage.

**Acceptance:** the four new picker options and two new operators are present and asserted; the `maxAttempts` field hides until `to` is set; the Tester exposes `hwModel` and reports the attempt cap. Full suite green.

### WP5 — Parity table, docs, epic close *(after WP2, WP3, WP4 all land)*

**Owns:** `src/server/services/automation/autoAckParity.test.ts` (new) · `docs/features/automation-engine.md` · `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md`

**Delivers:**
- The §6 `autoAckParity.test.ts` file — the phase's exit criterion. Its in-code table **must** be a faithful copy of §2, with a comment in each file pointing at the other.
- `docs/features/automation-engine.md`: under **Conditions** (`:162`) document `node.completeness` (the three states, why `unknown` exists, the `in complete, unknown` idiom) and the `is one of` / `isn't one of` operators (separators, case-insensitivity, exact-token matching, empty-list semantics); note the new `isDM` / `viaMqtt` numeric fields and the `1/0` idiom; under **Send a message** (`:216`) document `maxAttempts` including the Meshtastic-DM-only restriction and the 30s queue throttle it opts into.
- `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md`: flip Phase 3 to `[x] complete`; **paste §2's mapping table verbatim** (the exit criterion says it lives in the epic doc); add a **Phase 3 close** block under *Notes / deviations* recording: the no-new-condition-type decision and the tri-state argument; the `in`/`notIn` genericity choice; the `autoAckMaxAttempts` discovery (it is a queue setting, not an AutoAck setting) and the `ActionDeps` growth with the reason `recordingDeps()` needed no edit; the `isDM`/`viaMqtt` picker gap and the `fieldselect` clobbering it prevents; and the four Phase 4 converter obligations (regex default, cooldown default 60, channel index→name, `hops > 0` as a **branch** so no-hop-info lands in ZeroHop).

**Acceptance:** §2's table appears in the epic doc; `autoAckParity.test.ts` fails if a row is removed or an `autoAck*` key is added; every field label, option label, and operator label quoted in the docs matches the shipped catalog verbatim; the `autoAckTestMessages` and `autoAckMaxAttempts` rows are documented honestly, not glossed.

**Dependency graph:** `WP1 → (WP2 ∥ WP3 ∥ WP4) → WP5`

## 8. Explicit non-goals

- **No `maxAttempts` on `action.tapback`.** AutoAck's own tapback hardcodes `1` (`:10207`). Adding it would give the engine a capability AutoAck deliberately lacks — anti-parity — and grow `ActionDeps.sendTapback` for nothing.
- **No queueing of channel sends.** AutoAck's channel reply *does* go through the queue (rate-limited, `maxAttempts` forced to 1), so a converted channel-reply automation still sends without the 30s throttle. A documented divergence, in the direction of promptness, and not something `autoAckMaxAttempts` expresses. Note it in the epic as a candidate.
- **`MessageQueueService`'s clamp is not refactored** to import `SEND_MAX_ATTEMPTS_*`. It is load-bearing for #4266 and reads its setting synchronously; the duplication is pinned by a test instead.
- **No `in`/`notIn` on `condition.numeric`.** `NUMERIC_OPS` is a validated union and `fromId` covers the node case in AutoAck's own notation.
- **No `condition.string` `op` validation.** Unvalidated today; adding it would reject stored graphs (same call Phase 2 made for `cooldownSeconds`).
- **The `ignored_nodes` table is not exposed as a condition.** It is the #4115 geo-ignore/manual blocklist, a different feature that AutoAck never consults (§9.3). `node.isIgnored` *does* resolve today through `resolveFieldValue`'s raw-row passthrough (`NodesRepository.getNode` does a full `.select()`), but it is not in the picker and is not pinned by any test — a candidate follow-up, not this phase.
- **`deriveHops()` is still not guarded.** Phase 1 recorded why; the `hops > 0` **branch** in §3.6 is the conversion answer, not an engine change.
- **MeshCore auto-ack parity** (`meshcoreAutoAck*`) remains out of scope, per the 2×2 plan.
- **The engine's missing payload-length check** (`MAX_MESSAGE_BYTES`, Phase 1 close) is unchanged here.
- **`geofenceState` / `autoAckCooldowns` unbounded growth** — still the Phase 2 follow-up, still without an issue filed as of this spec.

## 9. Contradictions and findings against the original brief

1. **The two "new conditions" the epic named should not be new conditions.** *(Sign-off requested.)* `condition.nodeComplete` becomes a `node.completeness` computed field, and the node-in-list condition becomes `in`/`notIn` operators on `condition.string`. Beyond the reuse argument, the field version is **more correct**: AutoAck skips only when the node row exists *and* is incomplete (`:10084`), so a faithful conversion needs three states. A boolean `node.isComplete` collapses "row missing" and "row incomplete" into the same `undefined`/`NaN`, and `condition.numeric` returns **false for both `== 1` and `== 0`** on `NaN` — meaning neither "is complete" nor "is not complete" could be expressed for an unknown sender. The generic operators additionally serve node names, `roleName`, `channelName`, `telemetryType`, and system `event` at no extra cost. Precedent acknowledged: `condition.meshcoreScope` **is** a narrow block — but its data (`scopeCode`/`scopeName` semantics) is not reachable generically; `node.completeness` is.
2. **`maxAttempts` forces `ActionDeps` to change, breaking Phases 1 and 2's rule.** *(Sign-off requested.)* `ActionDeps.sendMessage`'s argument object gains an optional `maxAttempts`. **However, `automationSimulator.ts` needs no code change** — `recordingDeps()` returns `{ action: 'sendMessage', ...a }` (`:112`), so the field reaches the dry-run automatically; WP3 adds a test pinning that so it cannot silently drift. The deeper finding is that the brief's premise was wrong twice over: `autoAckMaxAttempts` is a `MessageQueueService` per-source setting that `checkAutoAcknowledge` never reads, and the engine has never used the queue at all (`meshActionDeps` calls `sendTextMessage` directly). Making the param real therefore means opting a Meshtastic **DM** send into the queue — which also opts it into the queue's 30s inter-send interval and turns the run-log entry from a packet id into `{ queued: true, … }`. All three are exactly how AutoAck already behaves, which is the parity being bought, but they are behaviour, not plumbing. **WP3 is therefore scoped so it can be dropped whole:** if the orchestrator declines, drop WP3 + WP1's `sendMessage` validation case + WP4's `maxAttempts` field, and row 21 of §2 flips to *not convertible — it is a per-source queue setting that survives conversion and keeps governing the source's other automated DMs*.
3. **The two ignore lists are unrelated, confirmed.** `autoAckIgnoredNodes` is a per-source *setting string* parsed inline at `:10037-10051`, used only by auto-ack. The #4115 list is the `ignored_nodes` *table* (`src/db/schema/ignoredNodes.ts`, migration 048, PK `(nodeNum, sourceId)`, `reason ∈ {'manual','geo'}`, `IgnoredNodesRepository`, `ignoredNodeRoutes.ts`), mirrored to `nodes.isIgnored` — the app-wide blocklist. **`checkAutoAcknowledge` never consults it.** Converting the setting therefore means baking a literal list into the graph, which is precisely what `notIn` does.
4. **The 2×2 matrix is *not* fully expressible today, contradicting "already covered".** `isDM` and `viaMqtt` resolve at runtime but are absent from the builder's field picker (`catalog.ts:183-186`), and `fieldselect` renders a plain `<select>` (`AutomationBuilder.tsx:89-99`) — a converter-written `condition.numeric` on `isDM` would show blank and be **overwritten on the first edit**, which would silently break a converted automation the moment a user opened it. `viaMqtt` is required, not optional: `isZeroHop = hopsTraveled === 0 && !viaMqtt` (`:10141`).
5. **`autoAckMaxAttempts` never reaches `messageQueue.enqueue` from the auto-ack path.** The reply enqueue (`:10248-10259`) passes six arguments and no override; the tapback enqueue (`:10196-10209`) passes an explicit `1`. The clamp lives in `MessageQueueService.resolveDmMaxAttempts()` (`:75-85`) and fires for any DM enqueued on that source with no override.
6. **`autoAckTestMessages` has no server reader.** Only `AutoAcknowledgeSection.tsx`, `AutomationTab.tsx`, `AutomationContext.tsx`, and `App.tsx` touch it, and it is **not** in `PER_SOURCE_SETTINGS_KEYS`. It is a UI scratchpad. The only honest table entry is *not convertible, and does not need to be*.
7. **Two deprecated keys are global-only.** `autoAckTapbackEnabled` and `autoAckReplyEnabled` are in `VALID_SETTINGS_KEYS` but **not** in `PER_SOURCE_SETTINGS_KEYS`, unlike the other eight deprecated keys. Migration 093 reads the per-source ones; these two are pure legacy globals. Recorded so the Phase 4 converter does not go looking for per-source values that were never written.
8. **A no-hop-info packet converts wrong unless the ZeroHop rule is a `false` branch.** AutoAck floors `hopsTraveled` to `0` when `hopStart`/`hopLimit` are absent or inverted (`:10127-10134`) and treats it as **ZeroHop**; the engine's `hops` is `undefined` there, so `== 0` and `> 0` are **both** false and the message would match no cell at all. §3.6's single `condition.numeric hops > 0` with `true`/`false` ports fixes this with no engine change. Phase 4 obligation.
9. **`condition.string`'s `eq`/`neq` are case-*sensitive* while every other operator lowercases** (`conditionEvaluator.ts:35-41`). Pre-existing, not changed here. Harmless for `node.completeness` (lowercase constants) and for `fromId` (lowercase hex), but the new `in`/`notIn` deliberately follow the *majority* (case-insensitive) behaviour, and the docs must say so.
10. **`meshNodeData.getNode` passes `sourceId ?? undefined`**, which becomes an **unscoped** lookup under the composite `(nodeNum, sourceId)` PK when `sourceId` is null — the exact hazard `:10081-10082` warns about in AutoAck. Not reachable for `trigger.message` (its `sourceId` is always set) and pre-existing, so **not changed** here; recorded because `node.completeness` inherits it and a future source-less trigger with a subject node would expose it.

### Critical Files for Implementation

- `/home/yeraze/Development/meshmonitor-autoack-parity/src/server/services/automation/engineContext.ts`
- `/home/yeraze/Development/meshmonitor-autoack-parity/src/server/services/automation/conditionEvaluator.ts`
- `/home/yeraze/Development/meshmonitor-autoack-parity/src/server/services/automation/meshActionDeps.ts`
- `/home/yeraze/Development/meshmonitor-autoack-parity/src/components/automations/catalog.ts`
- `/home/yeraze/Development/meshmonitor-autoack-parity/src/types/automation.ts`