# Epic — Auto-Acknowledge on the Automation Engine

**Issue:** #4340 (per-channel Auto-Acknowledge message body)
**Status:** Phase 1 in progress
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

### Phase 2 — Per-node cooldown scope — [ ] not started

Add `cooldownScope: 'automation' | 'node' | 'sourceNode'` to trigger params;
key `lastFired` by the composite; make the trace message name the node.

**Exit criteria**
- Two senders on one channel cool down independently under `node` scope.
- Absent `cooldownScope` behaves exactly as today (`automation`).
- Trace output distinguishes which key was cooling down.

### Phase 3 — Fidelity conditions — [ ] not started

`condition.nodeComplete`, a node-in-list condition covering ignore lists, and a
`maxAttempts` param on the send/tapback actions.

**Exit criteria**
- Every Auto-Acknowledge setting has an expressible engine equivalent, listed
  explicitly in this doc at phase close.

### Phase 4 — AutoAck → Automation converter — [ ] not started

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
