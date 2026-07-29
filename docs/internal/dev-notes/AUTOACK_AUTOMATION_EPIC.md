# Epic — Auto-Acknowledge on the Automation Engine

**Issue:** #4340 (per-channel Auto-Acknowledge message body)
**Status:** Complete — all four phases shipped (2026-07-28)
**Owner:** orchestrated via `/epic`

## Goal

Issue #4340 asks for a per-channel Auto-Acknowledge body so a base station can
tell range-testers on the primary channel to move to a secondary channel,
without telling users *already on* the secondary channel to go somewhere else.

Rather than growing Auto-Acknowledge a second configuration axis, we answer it
in the **Automation Engine**, which was built for exactly this kind of
branching. A user writes one rule per channel: filter on channel + trigger
word, then respond with a hop-count tapback and/or a channel-appropriate text
body.

The epic then goes one step further and makes the Automation Engine a genuine
superset of Auto-Acknowledge, ending in a converter that turns an existing
Auto-Ack config into an editable automation.

## What already existed (survey, 2026-07-28)

Most of the #4340 scenario is expressible today:

| Piece | Status |
|---|---|
| Trigger on message, filter by channel | `trigger.message` `channels` filter — `triggerContext.ts:322` |
| Filter by trigger word | `textContains` / `regex` — `triggerContext.ts:335-338` |
| Branch on hop count | `condition.numeric` on field `hops` — `catalog.ts:138` |
| Respond with text | `action.sendMessage`, `{{ trigger.hops }}` available |
| Send a tapback | `action.tapback` — **fixed emoji only**, `actionExecutor.ts:319` |

The one real gap: a tapback cannot derive its emoji from hop count. AutoAck's
table is an un-exported inline constant at `meshtasticManager.ts:10183`:

```ts
const HOP_COUNT_EMOJIS = ['*️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
```

Reproducing it in an automation today needs eight near-identical rules.

Fidelity gaps for a converter, found in the same survey:

- **Cooldown granularity.** AutoAck cools down **per node**
  (`meshtasticManager.ts:10090`); the engine cools down **per automation**
  (`automationEngineService.ts:119`, `lastFired: Map<automationId, ms>`). On a
  busy channel the engine's version would swallow acks to every other sender.
- **No engine equivalent** for `autoAckSkipIncompleteNodes`,
  `autoAckIgnoredNodes`, or `autoAckMaxAttempts`.
- `autoAckPreSendDelaySeconds` **does** map — onto `action.delay`.

## Decisions (interview, 2026-07-28)

1. **Scope:** hop-count tapback *and* an AutoAck → Automation converter.
2. **Design:** extend the existing `action.tapback` with an
   `emojiMode: 'fixed' | 'hopCount'` select rather than adding a separate
   action type — reuses its source loop, MeshCore skip, and TX-disabled
   handling. Absent `emojiMode` means `fixed`, so existing automations are
   untouched.
3. **Token:** also expose `{{ trigger.hopEmoji }}` so message bodies can embed
   the emoji, which is what makes the mixed text+emoji replies in #4340 work.
4. **Issue #4340:** close it in Phase 1 with the concrete recipe.
5. **Cooldown:** add a `cooldownScope` trigger param (`automation | node |
   sourceNode`) rather than a variable-based workaround or accepting the
   behaviour change.
6. **Fidelity gaps:** add real engine conditions rather than warning about
   them, so a converted automation behaves identically.
7. **Converter output:** one automation per source, emitting **only the rules
   whose 2×2 cells are actually enabled** (readable graph over literal 1:1
   mapping).
8. **Handover:** the conversion dialog ends with a checked-by-default "turn off
   Auto-Acknowledge for this source" option — user confirms.

**Out of scope:** MeshCore tapbacks (no such concept on the protocol — the
existing `action.tapback` already records a skip for MeshCore sources). The
`{{ trigger.hopEmoji }}` token is still populated for MeshCore messages, since
`hopCount` exists there and the token is usable in text bodies.

## Phases

### Phase 1 — Hop-count tapback + `{{ trigger.hopEmoji }}` — [x] complete

Extract the hop→emoji table into a shared helper used by both AutoAck and the
engine; add `emojiMode` to `action.tapback`; expose `hopEmoji` as a derived
trigger field and registered token; write the #4340 recipe and close the issue.

**Exit criteria**
- An automation with `emojiMode: hopCount` sends `*️⃣` at 0 hops and `1️⃣`–`7️⃣`
  above, clamping at 7.
- `{{ trigger.hopEmoji }}` resolves in `action.sendMessage` text.
- AutoAck's own tapback behaviour is provably unchanged (existing tests green,
  no new table).
- Recipe documented; #4340 closed with a link to it.

### Phase 2 — Per-node cooldown scope — [x] complete

Add `cooldownScope: 'automation' | 'node' | 'sourceNode'` to trigger params;
key `lastFired` by the composite; make the trace message name the node.

**Exit criteria**
- Two senders on one channel cool down independently under `node` scope.
- Absent `cooldownScope` behaves exactly as today (`automation`).
- Trace output distinguishes which key was cooling down.

### Phase 3 — Fidelity conditions — [x] complete

`condition.nodeComplete`, a node-in-list condition covering ignore lists, and a
`maxAttempts` param on the send/tapback actions.

**Exit criteria**
- Every Auto-Acknowledge setting has an expressible engine equivalent, listed
  explicitly in this doc at phase close.

### Phase 4 — AutoAck → Automation converter — [x] complete

Backend graph builder (minimal rules), a preview + create route, and a button
in `AutoAcknowledgeSection` showing a conversion report plus the
checked-by-default disable option.

**Exit criteria**
- Converting a real config produces an automation that reproduces its
  behaviour.
- Preview shows the graph before anything is written.
- Browser-validated end to end.

## Notes / deviations

_(updated at each phase close)_

### Phase 1 close (2026-07-28)

- **`showIf` is new, general infrastructure, not a reuse of anything.** The original brief assumed
  `FieldDef.advanced` already gated conditional visibility; it turned out to be declared on six
  fields but never read by `AutomationBuilder.tsx` — inert metadata. Phase 1 added the real
  mechanism: a declarative `FieldDef.showIf: { field, equals?, notEquals? }`, a pure exported
  `fieldVisible()` predicate (unit-tested via a full truth table, including the legacy-graph case
  where an absent `emojiMode` must still show the `emoji` field), and one `.filter()` in
  `BlockFields`. `action.tapback`'s `emoji` field is the first (and, as of Phase 1, only) consumer.
  Hidden fields are never cleared — switching `emojiMode` back to `fixed` restores whatever fixed
  emoji was previously configured.
- **"No hop information" is a recorded skip, not a thrown error.** A hop-count tapback whose trigger
  carries no hop data (a Schedule/System trigger wired to it, or a message missing
  `hopStart`/`hopLimit`) returns `{ skipped: true, reason: 'tapback emojiMode=hopCount: the trigger
  carries no hop count' }` and never calls `sendTapback`. Throwing would have marked the whole
  automation run failed and spammed the run log for what is really a benign "nothing to react
  with" case — the same shape already used for the MeshCore-tapback and TX-disabled skips.
- **`deriveHops()` can go negative; the hop-emoji clamp papers over it, deliberately.** AutoAck's own
  `hopsTraveled` calculation guards `hopStart >= hopLimit` before subtracting; the engine's
  `deriveHops()` (used for `{{ trigger.hops }}` and `condition.numeric` on `hops`) has no such guard
  and can render a negative number on a malformed packet. `hopCountEmoji()` clamps negative input to
  `0` (`*️⃣`), so `{{ trigger.hopEmoji }}` and the hop-count tapback are always well-formed even when
  `{{ trigger.hops }}` isn't. `deriveHops()` was deliberately **not** changed to add the guard —
  doing so would silently alter every existing `condition.numeric` comparison on `hops` for anyone
  who already has one. This divergence is intentional and pinned by a unit test.
- **Docs/behaviour mismatch found and *not* fixed in Phase 1:** `docs/features/automation-engine.md`
  claimed the `action.sendMessage` MeshCore **scope** select "reveals a Region picker" when
  `scopeMode` is set to *A specific region…*. In the shipped builder, `scopeName` actually renders
  unconditionally (no `showIf`) — the doc described the intended UX, not the real one. `showIf` now
  makes fixing this trivial; it's a small follow-up (either add `showIf: { field: 'scopeMode',
  equals: 'named' }` to `scopeName`, or correct the doc to say it's always visible), tracked as a
  follow-up rather than folded into this hop-tapback change to keep the diff scoped.
- **Payload-limit finding for the #4340 recipe:** the reporter's 237 bytes is the Meshtastic LoRa
  on-air MTU (total packet, including a 16-byte header), not the usable text payload. The protobuf
  `Constants.DATA_PAYLOAD_LEN = 233` (`protobufs/meshtastic/mesh.proto`) is the actual `Data`
  payload budget. Separately, MeshMonitor's own `MAX_MESSAGE_BYTES = 200`
  (`src/server/constants/meshtastic.ts`) is enforced only by the HTTP compose route
  (`routes/v1/messages.ts`) — the Automation Engine's `action.sendMessage` calls
  `mgr.sendTextMessage()` directly and is subject to **neither** check. Documented in the new
  recipe section rather than left as an assumption.
- **The one-automation/two-rules alternative form is not available today.** Verified against the
  live `condition.string` field picker (`EVENT_STRING['trigger.message']` in
  `src/components/automations/catalog.ts`): it exposes *Message text*, *Sender node id*, *Recipient
  node id*, and *MeshCore scope/region* — no channel name. The recipe ships only the
  two-automation form and documents the gap instead of a workaround that doesn't exist yet.

### Phase 2 close (2026-07-28)

- **`TriggerContext.subjectNodeKey` is new, and deliberately cooldown-only.** `subjectNodeNum`
  already drives node hydration (`getSubjectNode`) and variable scoping, both of which need a real
  Meshtastic node number — widening it to also carry a MeshCore pubkey string would have broken
  both. `subjectNodeKey` is an **optional** protocol-agnostic sibling: `undefined` (the default, and
  what every existing Meshtastic builder and test-literal construction site leaves it as) means
  "derive it from `subjectNodeNum`"; an explicit `null` means "this event has no stable per-subject
  identity at all"; a set string is the identity to key cooldown off directly. `subjectKeyOf(ctx)`
  resolves it. This kept every non-MeshCore builder, `automationSimulator.ts`, and every existing
  `TriggerContext` test-literal untouched.
- **MeshCore is only *half* scopable, and the failure mode is subtle enough to spell out.**
  `buildMeshCoreMessageContext` sets `subjectNodeKey` to the sender's `fromPublicKey` for a **DM or
  room post** — the same identity `meshcoreManager`'s own per-sender auto-ack cooldown already uses
  — but to `null` for a **channel** post. The naive fix (key off `ctx.fields.from` unconditionally)
  would have kept working for DMs while silently keying a channel automation off the synthetic
  `channel-<idx>` slot string that *every sender on that channel shares* — a per-channel cooldown
  wearing a per-node label, indistinguishable from correct behaviour until two different senders on
  the same channel failed to cool down independently. `isChannel` (already computed for
  `parseMeshCoreChannelIdx`) gates it explicitly.
- **No subject ⇒ degrade to the automation-wide key, not "never fire" or "never cool down."**
  `cooldownKeyFor` falls back to the automation-wide key (and marks the verdict `degraded`) for
  Schedule triggers, System triggers, and MeshCore channel messages — every case with no stable
  per-subject identity. *Never fire* would be a silent breakage (a Schedule automation with
  `cooldownScope: 'node'`, reachable via JSON import, would stop firing with no visible cause) —
  exactly the class of bug this phase exists to prevent. *Never cool down* would turn a throttle
  into a spam faucet on a MeshCore channel and grow the map unbounded. *Automation-wide fallback* is
  provably no worse than pre-Phase-2 behaviour, costs exactly one map entry, and the live trace names
  it out loud (`cooldown active — Ns remaining (automation-wide (this event has no subject node))`).
- **`showIf` gained a `truthy` operator.** Phase 1's `equals`/`notEquals` can't express "a number
  field that is set" — `cooldownSeconds` can legitimately be `undefined` (never touched), `''`
  (cleared — the `number` renderer emits `''`), or `0`, and `notEquals: 0` would show the field in
  the first two cases. `truthy` covers all three uniformly via `Boolean(v)`. Known, harmless wart:
  the string `'0'` is truthy, so it would show an extra select — not reachable through the number
  renderer today. **Phase 1 semantics are preserved verbatim: hidden ≠ cleared.** Setting the
  cooldown back to `0` hides *Cooldown applies to* but keeps `params.cooldownScope`, and the engine
  ignores it anyway (`cooldownGate` returns early when `cooldownSeconds <= 0`) — the value survives a
  hide/show round-trip, browser-validated.
- **Eviction: an exact expiry pass, with a hard backstop.** `lastFired` is now
  `Map<automationId, Map<cooldownKey, ms>>` — one inner map per automation, one entry per distinct
  subject under `node`/`sourceNode` scope. Unlike a packet-dedup set, a cooldown entry has a provable
  expiry: once `now - ts >= cooldownSeconds * 1000` it can never suppress anything again, so deleting
  it is behaviour-neutral. `markFired` prunes only past a high watermark
  (`COOLDOWN_KEYS_MAX = 4096`, mirroring `autoAckProcessedPackets`'s `> 1000` trim), first doing the
  exact expiry pass, then — only if still over `COOLDOWN_KEYS_TRIM_TO = 2048` (the pathological case
  of more than 2048 distinct subjects firing inside a single cooldown window) — dropping the oldest
  entries as a backstop. Deliberately **not** modelled on `meshtasticManager.autoAckCooldowns`
  (`Map<nodeNum, ms>`), which is never evicted at all — it gets away with that because it's
  per-manager and bounded in practice by one radio's NodeDB, while the engine's map is per
  (automation × node) across every source including MQTT firehoses, so the same choice would be a
  real leak here. Also: `lastFired` is no longer written unconditionally — `markFired` returns
  immediately when `cooldownSeconds <= 0`, since a timestamp that's never read is memory spent for
  nothing, keeping the common cooldown-less automation at exactly zero cooldown-map entries.
- **Validation is a pre-switch guard, not a per-trigger-type `case`.** `cooldownScope` is a
  trigger-level param shared by all seven trigger types; duplicating it into seven `case` labels
  inside `validateAutomationGraph`'s `switch (n.type)` would silently miss the eighth trigger type
  someone adds later. It's checked once via `categoryOf(n.type) === 'trigger'` immediately before the
  switch. Orchestrator-approved deviation from the brief's per-`case` precedent (`action.tapback`'s
  `emojiMode`, which is right for a *single-block* param but wrong for a param seven blocks share).
- **Finding beyond the brief: the validation guard makes `parseCooldownScope`'s runtime leniency
  unreachable via the normal load path.** `parseCooldownScope` is documented as "deliberately lenient
  at runtime" (absent/unrecognised → `'automation'`) on the theory that graphs written before
  validation existed must still run — but `validateAutomationGraph` now rejects an unrecognised
  `cooldownScope` **at save/import time**, so a stored automation can never reach `load()` with a
  bogus value in the first place; the automation is rejected wholesale, not silently downgraded to
  `'automation'` scope. The runtime leniency is real defence-in-depth (it protects against a graph
  written directly to the DB, bypassing validation), but it is not exercised by any path a normal
  user can trigger. The engine test for this case (§6, case (e)) asserts the **actual** observed
  behaviour — the automation is rejected and never loads — rather than the spec's original wording of
  "`'bogus'` behaves as `'automation'`" at runtime, which describes `parseCooldownScope` in isolation,
  not the end-to-end load path.
- **Lint ratchet caught a new `no-explicit-any` (baseline 6 → 7) in `automationEngineService.ts`.**
  The `cooldownScope` lookup at `load()` originally cast through `(triggerNode.params as any)`,
  copying the existing `cooldownSeconds` line it sits beside. `params` is already typed
  `Record<string, unknown>`, so the cast was unnecessary — dropped it (`triggerNode.params?.cooldownScope`)
  rather than growing the baseline. `npm run lint:ci` confirmed the ratchet holds at 6 with the cast
  removed.
- **The disable → re-enable edge case, restated precisely.** `load()` now drops `lastFired` state for
  any automation id no longer present in `this.index` (deleted or disabled), since a dead id is
  unreachable from any dispatch site and would otherwise strand up to `COOLDOWN_KEYS_MAX` entries
  forever for a node-scoped automation on a churny mesh. Observable edge, accepted: disabling and
  re-enabling a rule **inside its own cooldown window** now lets it fire immediately instead of
  waiting out the remainder, whereas before this phase the cooldown map was keyed only by
  `automationId` and survived a disable/enable cycle. Erring toward firing is the safer direction of
  the two available (the alternative — leaking cooldown state for automations that no longer exist —
  is strictly worse), and it is pinned by a regression test (§6 case (j)).
- **Two out-of-scope follow-ups still need issues filed (spec §8).** `geofenceState`
  (`Map<'${automationId}:${nodeNum}', boolean>`, `automationEngineService.ts:121-122, :514-516`) and
  `meshtasticManager.autoAckCooldowns` (`Map<nodeNum, ms>`, `meshtasticManager.ts:825`) have the same
  unbounded-growth shape this phase just fixed for `lastFired`, and neither was touched here.
  `geofenceState` in particular can't reuse this phase's "delete once expired" eviction verbatim —
  deleting an entry there is *not* behaviour-neutral, since it resets the enter/exit dwell baseline
  for that node, so it needs its own design decision rather than a copy-paste of `pruneCooldownKeys`.
  Both need a follow-up issue; neither has one yet as of this close.

### Phase 3 close (2026-07-28)

**The parity mapping table** (pasted verbatim from
`docs/internal/dev-notes/AUTOACK_PARITY_PHASE3_SPEC.md` §2 — the phase's exit criterion. It is
mechanically enforced by `src/server/services/automation/autoAckParity.test.ts`, which fails if a
row here is removed while its key is still in `VALID_SETTINGS_KEYS`, or if a new `autoAck*` key is
added without a corresponding row):

Every key in `VALID_SETTINGS_KEYS` beginning `autoAck` — 33 of them (`src/server/constants/settings.ts:20-60`). "Per-source?" is membership in `PER_SOURCE_SETTINGS_KEYS` (`:338-370`).

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
4. Tri-state is required for fidelity: AutoAck skips only when the node row **exists and is incomplete** (`if (fromNode && !isNodeComplete(fromNode))`, `:10084`). `complete, unknown` reproduces that exactly. See spec §9.1.
5. `in`/`notIn` split on `/[\s,]+/` and compare case-insensitively — the same separators and casing as AutoAck's own parser (`:10040-10043`). The converter normalises each entry to canonical `!xxxxxxxx` (AutoAck accepts a bare 8-hex token; `trigger.fromId` always carries the `!`). An **empty** value makes `notIn` always true, matching an unset ignore list — but the converter should simply omit the condition.
6. AutoAck's default is **60s** when unset (`:10092`); the engine's is **0**. The converter must emit `60` explicitly. `cooldownScope: 'node'` is mandatory — AutoAck's map is keyed by `fromNum` (`:10094`).
7. Two semantic differences: AutoAck's delay is a non-blocking `setTimeout` (`:10172-10178`) while `action.delay` blocks its own run and caps at `AUTOMATION_DELAY_MAX_SECONDS = 300`; and AutoAck applies the same delay independently to the tapback and the reply, so a converted linear chain needs the `action.delay` once, before the first send.
8. **Read this row carefully.** `checkAutoAcknowledge` never reads `autoAckMaxAttempts`. `MessageQueueService.resolveDmMaxAttempts()` reads it per-source and applies it to **every queued DM** on that source (auto-responder, welcome, mailbox, auto-ack reply). It therefore affects the AutoAck **reply, and only when that reply is a DM**: the AutoAck **tapback** hardcodes `1` ("tapbacks are best-effort, don't retry", `:10207`) and **channel** sends hardcode `1` (`messageQueueService.ts:112`). Consequently `maxAttempts` goes on `action.sendMessage` **only** — see spec §9.2. The setting also keeps governing the source's other queued DMs after conversion, so disabling AutoAck does not retire it.
9. `isDM` and `viaMqtt` already resolve at runtime (`triggerContext.ts:113,120` + `asNumber()` boolean coercion) but were **not** offered by the builder's field picker, and `fieldselect` is a plain `<select>` (`AutomationBuilder.tsx:89-99`) — a converter-written value would render blank and be overwritten on the first edit. Phase 3 adds both options so a converted automation is **editable**, not merely runnable. `viaMqtt` is load-bearing: `isZeroHop = hopsTraveled === 0 && !viaMqtt` (`AUTOACK_2X2_PLAN.md`, `:10141`). **Phase 4 adds a third field, `zeroHop`** (1 = arrived direct over RF with 0 hops; 0 = relayed or via MQTT), computed via `autoAckIsZeroHop()` on the floored hop count (`triggerContext.ts`). It exists because the mechanism this note originally implied — a *branch* on a single `condition.numeric hops > 0` node's true/false ports — makes `decompile()` return `null` for the resulting graph (`compile.ts:128`), which forces the automation into the raw-JSON editor on first open; `zeroHop` is a flat, `NaN`-safe field with identical behaviour and no such penalty. The four ZeroHop/MultiHop cell rows above (22/25/28/31) are built from `isDM` + `zeroHop` in the shipped converter, not from `hops`/`viaMqtt` directly. See the Phase 4 close below and `docs/internal/dev-notes/AUTOACK_CONVERTER_PHASE4_SPEC.md` §3.1/§9.1.

**Adjacent behaviour not in the table** (not `autoAck*` keys, recorded so Phase 4 does not rediscover them): the per-packet dedup guard (`:9967-9978`) has no engine analogue and needs none; the TX-disabled skip (`:10001`) is already mirrored by `pushOrSkipTxDisabled`; the airtime cutoff (`isAutomationAirtimeGated`, `automationAirtimeCutoff*`) is shared infrastructure both paths already honour; the local-node skip (`:10065-10070`) is already covered by the engine's self-drop (`getLocalNodeNum`, #3914). **MeshCore auto-ack is a separate `meshcoreAutoAck*` namespace** (`meshcoreManager.ts:6873-6925`) and is out of scope for this table.

**Decisions and findings recorded at close (spec §7 WP5 / §9):**

- **No new `ConditionType`, no new node-in-list block.** The two "new conditions" the epic
  originally named (`condition.nodeComplete`, a node-in-list condition) shipped instead as a
  computed `node.completeness` field on the existing `node.*` mechanism, plus generic `in`/`notIn`
  operators on `condition.string`. The tri-state argument is decisive, not just a reuse call: AutoAck
  skips a sender only when its node row **exists and is incomplete**
  (`if (fromNode && !isNodeComplete(fromNode))`, `meshtasticManager.ts:10084`), so a faithful
  conversion needs three states — a boolean field collapses "row missing" and "row incomplete" into
  the same falsy value, and `condition.numeric`'s `NaN` handling would make *both* `== 1` and `== 0`
  read false for an unknown sender, so neither "complete" nor "not complete" could be expressed for
  it. `node.completeness in (complete, unknown)` is the correct, and only, faithful expression.
- **`in`/`notIn` is deliberately generic, not a node-list-only block.** A single-purpose
  `condition.nodeInList` would cover only the ignore-list case; the generic string operator covers it
  *and* every other string field (node names, `roleName`, `channelName`, `telemetryType`, system
  `event`) for the same implementation cost — a `default:` branch inside the existing `stringCompare`
  switch, no new `ConditionType`.
- **`autoAckMaxAttempts` is a queue setting, not an Auto-Ack setting — the load-bearing discovery of
  this phase.** `checkAutoAcknowledge` never reads it. It is
  `MessageQueueService.resolveDmMaxAttempts()`, applied to **every** queued DM on the source
  (auto-responder, welcome, mailbox, and the AutoAck reply — but only when that reply is a DM;
  AutoAck's own tapback and channel sends both hardcode `1` attempt). This means `maxAttempts` on
  `action.sendMessage` was **not required for converter fidelity** — Phase 3 could have shipped
  without it and row 21 would simply read *not convertible — it is a per-source queue setting that
  survives conversion and keeps governing the source's other automated DMs*. The user was shown that
  trade-off explicitly and chose to ship `maxAttempts` anyway, as a capability in its own right, not
  a parity gap-filler.
- **`ActionDeps.sendMessage` grew an optional field, and `automationSimulator.ts` needed no edit.**
  Wiring `maxAttempts` through to `MessageQueueService.enqueue()` required
  `ActionDeps.sendMessage`'s argument object to gain an optional `maxAttempts` key
  (`actionExecutor.ts`) and a new duck-typed `messageQueue` capability check in `meshActionDeps.ts`.
  The dry-run simulator did **not** need a matching code change: `recordingDeps().sendMessage`
  already spreads its whole argument object (`{ action: 'sendMessage', ...a }`), so the new field
  reaches the Test panel automatically — pinned by a drift-guard test in
  `automationSimulator.test.ts` so a future refactor of `recordingDeps` can't silently drop it.
- **The `isDM`/`viaMqtt` picker gap was real, not hypothetical.** Both fields already resolved at
  runtime (`triggerContext.ts`, `asNumber()`'s boolean coercion), but were absent from the builder's
  field picker. Because `fieldselect` renders a plain `<select>`
  (`AutomationBuilder.tsx:89-99`), a converter-written `condition.numeric` on `isDM` would have shown
  **blank** in the builder and been **silently overwritten the moment a user opened it to look** —
  breaking a converted automation on first touch, not on save. Phase 3 adds both options purely as
  catalog entries (zero engine change) so a converted automation is editable, not just runnable.
- **The queued-send path is a documented behavioral divergence, not a bug.** When `maxAttempts` is
  set, the send becomes fire-and-forget through the source's outgoing queue: it returns a queue id
  rather than a packet id, and a TX-disabled source doesn't produce `pushOrSkipTxDisabled`'s
  `{skipped, reason:'TX_DISABLED'}` run-log entry — instead the queue's own `onFailure` handler logs
  a warning some time later. This exactly mirrors how Auto-Acknowledge's own reply already behaves,
  which is the parity being bought, but it means a TX-disabled source now records the action as
  *queued* rather than *skipped*. Documented in `docs/features/automation-engine.md` under
  **Send a message** so an operator isn't surprised by the run log.
- **Four Phase 4 converter obligations, carried forward from spec §2's footnotes:**
  1. **Regex default** — AutoAck's blank `autoAckRegex` means `^(test|ping)`
     (`meshtasticManager.ts:10102`); the engine's blank `regex` means match-anything. The converter
     must emit the literal default rather than an empty string.
  2. **Cooldown default** — AutoAck's unset cooldown is **60s** (`:10092`); the engine's unset
     cooldown is **0** (no throttle). The converter must emit `60` explicitly, with
     `cooldownScope: 'node'` (AutoAck's map is keyed by `fromNum`).
  3. **Channel index → name** — AutoAck stores channel **indices**; `trigger.message.channels` is
     unified **by name** across sources. The converter must resolve index→name per source at
     conversion time; two same-named channels on one source is a converter edge case to handle
     explicitly.
  4. **`hops > 0` as a branch, not two independent conditions** — a packet with no
     `hopStart`/`hopLimit` yields `hops === undefined` → `NaN`, so `== 0` and `> 0` are **both**
     false; AutoAck instead floors it to `0` and treats it as ZeroHop. The converter must route
     ZeroHop/MultiHop off a single `condition.numeric hops > 0` node's true/false ports, not two
     separate `== 0` / `> 0` conditions, or a hopless packet matches neither branch.
     **Superseded in Phase 4 — see below.** The port-branch mechanism this obligation prescribed
     turned out to be incompatible with a separate hard requirement (a converted automation must be
     editable in the visual builder). Left here unedited, rather than silently rewritten, so this
     document is an honest record of how the plan actually changed between phases.

### Phase 4 close (2026-07-28)

**Delivered:** `src/server/services/automation/autoAckConverter.ts` (pure graph builder, `compile()`
the only emitter), `autoAckConverterService.ts` (settings/channel resolution), two routes
(`POST /api/automations/convert/preview`, `POST /api/automations/convert/create`) in
`autoAckConverterRoutes.ts`, the `zeroHop` trigger field (`triggerContext.ts`, `catalog.ts`,
`SubstitutionsHelp.tsx`), and the **Convert to an Automation…** button + `AutoAckConvertDialog` in
`AutoAcknowledgeSection.tsx`. Full design: `docs/internal/dev-notes/AUTOACK_CONVERTER_PHASE4_SPEC.md`.

- **Obligation 4's prescribed mechanism (Phase 3 note 4 / item 4 above) is incompatible with the
  round-trip requirement, and the fix is a new derived field, `zeroHop`.** Phase 3 called for
  routing ZeroHop/MultiHop off a single `condition.numeric hops > 0` node's true/false **ports**.
  Phase 4 independently requires that a converted automation open in the visual builder, not the
  raw-JSON fallback. `compile.ts:128` makes `decompile()` return `null` for **any** ported edge, and
  `AutomationsPage.tsx` opens the JSON editor whenever `decompile()` returns `null` — the two
  requirements cannot both be met by a ported graph. There is also no port-free expression using
  only post-Phase-3 blocks: `hops` is `undefined` → `NaN` for a hopless packet, and `numericCompare`
  returns `false` for non-finite operands, so `== 0` and `> 0` are **both** false regardless of which
  one is meant to catch the hopless case. The resolution: `zeroHop`, a new numeric trigger field
  (`triggerContext.ts`, computed via AutoAck's own `autoAckIsZeroHop()` on the same floored hop count
  AutoAck itself uses), added the same way Phase 3 added `node.completeness` — one line in the
  context builder, one catalog entry, zero evaluator change. It satisfies obligation 4's
  **behaviour** exactly while keeping the flat AND-chain shape `decompile()` supports. Orchestrator
  sign-off 2026-07-28 (spec §3.1/§9.1). The four cell rows in the parity table above (22/25/28/31)
  were updated to describe `isDM` + `zeroHop`, not `isDM` + `hops` + `viaMqtt`, to match what the
  shipped converter actually emits.
- **Epic decision 7 ("one automation per source") is not always achievable, and shipping two is an
  approved, forced deviation.** `messageMatchesFilter()` applies a trigger's `channels` filter to
  **every** message, DMs included, but Auto-Acknowledge's channel allowlist gates channel messages
  **only** — a DM bypasses it entirely. A single shared trigger would therefore silently gate the
  Direct cells by channel name, a regression invisible until a DM on an unlisted channel slot goes
  unanswered. Phase 1 hit the identical root cause when it designed the #4340 recipe and also shipped
  the two-automation form. The spirit of decision 7 — a readable graph, only the enabled cells
  represented — is preserved: only-Channel or only-Direct configurations still produce exactly one
  automation, and the preview dialog always states up front how many automations it is about to
  create and why. Orchestrator sign-off 2026-07-28 (spec §9.2).
- **The empty-allowlist inversion — the single most valuable catch of the phase.** The original plan
  (spec §4.2, pre-correction) would have emitted a Channel automation with **no** `channels` filter
  whenever `autoAckChannels` was empty, on the theory that "no allowlist" means "no restriction."
  It's the opposite: `meshtasticManager.ts` parses a blank `autoAckChannels` to `[]`, and the runtime
  gate (`if (!enabledChannelsSet.has(channelIndex)) return;`) rejects **every** channel index against
  an empty set — so an empty allowlist means Auto-Acknowledge **never** acknowledges a channel
  message, not that it acknowledges all of them. Emitting an unfiltered Channel automation for that
  case would have been the exact inverse of the source behaviour: a config that silently never fired
  would convert into one that answers on every channel on the mesh. Caught by the implementer during
  WP2 while writing the pure builder against literal test fixtures (not from live traffic), corrected
  mid-phase, and verified against the runtime gate's source line before shipping. The shipped
  behaviour: an empty allowlist emits **no** Channel automation at all (with a `notConvertible` report
  entry explaining why), distinct from `CHANNEL_ALLOWLIST_UNCONVERTIBLE` (the user listed channels
  but none resolved — a config they must fix, not a valid no-op).
- **Three fidelity gaps were reported rather than silently absorbed:**
  1. **The Direct reply template doesn't follow the cell boundary.** `meshtasticManager.ts` selects
     the *Direct*-vs-standard reply **text** on the raw `hopsTraveled === 0` value, not on the same
     `viaMqtt`-aware ZeroHop test its own cell toggles use. So an MQTT-relayed, 0-hop message can be
     routed to the **MultiHop** cell for enable/disable purposes while still getting the **Direct**
     message's wording. No engine expression reproduces that split inside one rule. The converter
     picks `messageDirect` on the ZeroHop rules and `message` on the MultiHop rules — i.e. it follows
     `zeroHop`, not raw `hopsTraveled` — so it faithfully reproduces AutoAck's cell-toggle behaviour
     but not this one text-selection edge case. **Correction to spec §9.3 as written:** the spec text
     says the converter "emits an `approximated` entry naming the exact case." The shipped converter
     does **not** — there is no per-run report entry for this, because it isn't tied to a single
     settings key the way every other report row is; it's a standing characteristic of the
     conversion, documented in `docs/features/automation-engine.md` prose instead of the in-dialog
     report. Recorded here so this document doesn't silently repeat the spec's inaccurate claim.
  2. **A blank-named channel is genuinely inexpressible.** `messageFilterChannelNames()` drops
     entries whose `name` is empty, and if *every* entry drops, `messageMatchesFilter` falls through
     to **no channel constraint at all**. Meshtastic's primary slot commonly has an empty name. The
     converter drops that index with a loud `notConvertible` report entry, and refuses to emit a
     Channel automation whose whole allowlist dropped this way (`CHANNEL_ALLOWLIST_UNCONVERTIBLE`)
     rather than silently widening the trigger to every channel.
  3. **`autoAckMaxAttempts` is never emitted**, confirmed again at conversion time (Phase 3 close
     already found this): it is `MessageQueueService.resolveDmMaxAttempts()`'s per-source queue
     setting, never read by `checkAutoAcknowledge` itself. Emitting it onto `action.sendMessage` would
     not be parity (AutoAck's own tapback and channel sends hardcode `1` attempt) and would change
     TX-disabled run-log behaviour (a queued send records *queued*, not *skipped*). It gets a
     `notConvertible` report entry explaining that the setting survives conversion unchanged and keeps
     governing the source's other automated DMs. The engine's own `maxAttempts` field (Phase 3) is
     available on the converted automation's **Send a message** action if the user wants the same
     capability there — the converter just doesn't infer it.
- **Up to two automations, `zeroHop`, and the converter itself add no new `ConditionType`,
  `ActionType`, block, table, or migration.** `compile()`/`decompile()` are unchanged; the converter
  is a consumer, not an editor, of the builder's existing form→graph pipeline (spec §8).

## Epic close (2026-07-28)

All four phases shipped. Issue #4340 (per-channel Auto-Acknowledge message body) was closed in
Phase 1, and the epic then went further — making the Automation Engine a genuine superset of
Auto-Acknowledge, ending in a converter that turns an existing config into an editable automation
without hand-transcription.

**What shipped, end to end:**

- **Phase 1 — hop-count tapback + `{{ trigger.hopEmoji }}`.** `action.tapback` gained
  `emojiMode: 'fixed' | 'hopCount'` (absent = `fixed`, so every existing automation is unchanged);
  the same hop→emoji table (`*️⃣`, `1️⃣`–`7️⃣`, clamped) is shared between Auto-Acknowledge and the
  engine so they can never drift apart. Closed #4340 with the two-automation per-channel recipe now
  documented in `docs/features/automation-engine.md`.
- **Phase 2 — per-node cooldown scope.** `cooldownScope: 'automation' | 'node' | 'sourceNode'` on
  the trigger, so two senders on one busy channel cool down independently instead of the whole
  automation going quiet after the first reply. Absent behaves exactly as before.
- **Phase 3 — fidelity conditions.** A computed `node.completeness` field (`complete` / `incomplete`
  / `unknown` — the tri-state Auto-Acknowledge's own skip-incomplete-nodes check needs), generic
  `in`/`notIn` string operators (covers the ignore-list case and others for free), `isDM`/`viaMqtt`
  added to the builder's numeric field picker (they resolved at runtime since Phase 1 but weren't
  selectable — a converter-written value would have rendered blank and been clobbered on first
  edit), and an optional `maxAttempts` (1–3) on `action.sendMessage` that opts a Meshtastic DM into
  the source's outgoing queue, the same retry Auto-Acknowledge's own reply uses. Closed with the
  33-row parity table (§2 of `AUTOACK_PARITY_PHASE3_SPEC.md`, mechanically enforced by
  `autoAckParity.test.ts`) proving every `autoAck*` setting has either an engine equivalent or a
  documented, honest reason it doesn't.
- **Phase 4 — the converter.** A pure graph builder (`autoAckConverter.ts`) that reads a source's
  resolved Auto-Acknowledge settings and produces up to two ready-to-edit automations via
  `compile()` — never hand-assembled graphs — plus a four-bucket conversion report
  (converted/approximated/notConvertible/dropped) pinned against the parity table by test. A new
  derived `zeroHop` field made the four ZeroHop/MultiHop cells expressible as a flat AND-chain
  without the condition-port branching that would have broken builder round-tripping. A
  **Convert to an Automation…** button opens a preview-then-confirm dialog with a
  checked-by-default "turn off Auto-Acknowledge for this source" option that touches only
  `autoAckEnabled`, so the original configuration is always one checkbox away from coming back.

**What the epic did *not* do**, by design, and remains true at close: MeshCore's
`meshcoreAutoAck*` namespace was never touched (no Direct/MultiHop split on that protocol to
convert); `deriveHops()` was never guarded to floor negative/undefined hop counts (Phase 1
recorded why — it would silently change every existing `condition.numeric` comparison on `hops`);
and Auto-Acknowledge itself (`checkAutoAcknowledge`, `AutoAcknowledgeSection`'s own settings UI,
`meshtasticManager.ts`) is provably unchanged by every phase — the engine grew a superset around
it, rather than the legacy feature being rewritten or retired. Two smaller follow-ups were
identified but not filed as issues as of this close: `geofenceState` and
`meshtasticManager.autoAckCooldowns` share the unbounded-growth shape Phase 2 fixed for the
engine's own cooldown map, and neither has been touched.

**Documentation:** `docs/features/automation-engine.md` (conditions, actions, the #4340 recipe, and
the converter section), `docs/features/automation.md` (Auto Acknowledge section now points at the
converter), this epic doc, and `docs/internal/dev-notes/AUTOACK_PARITY_PHASE3_SPEC.md` (the parity
table, kept in three agreeing copies: this doc, the spec, and `autoAckParity.test.ts`).
