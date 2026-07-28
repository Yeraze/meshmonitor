# Hop-Count Tapback — Phase 1 Implementation Spec

**Epic:** `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md` · **Issue:** #4340
**Branch:** `feature/hop-count-tapback` · **Worktree:** `/home/yeraze/Development/meshmonitor-hop-tapback`

## 1. Reuse inventory (read this before writing any code)

Everything below already exists and **must be used or extended, not
re-implemented**. Verified by symbolic search on 2026-07-28.

| Existing thing | Location | How Phase 1 uses it |
|---|---|---|
| `HOP_COUNT_EMOJIS` inline table | `src/server/meshtasticManager.ts:10184` | **Deleted**; becomes the body of the new shared helper. AutoAck imports it back. |
| Hop-emoji glyphs (2nd copy!) | `src/components/EmojiPickerModal/EmojiPickerModal.tsx:32-40` | **De-duplicated** against the same helper. This is the "no second copy anywhere" requirement — it is not hypothetical, it exists today. |
| `deriveHops(msg)` | `src/server/services/automation/triggerContext.ts:28` | Sole source of `hops` for Meshtastic; `hopEmoji` derives from its result. **Do not change it.** |
| `msg.hopCount` (MeshCore) | `triggerContext.ts:162` | Sole source of `hops` for MeshCore; `hopEmoji` derives from it identically. |
| `targetSource(node, ctx)` | `actionExecutor.ts` (private) | Unchanged — still resolves the tapback's source. |
| `isMeshCoreSource(ctx, sid)` | `actionExecutor.ts` (private) | Unchanged — MeshCore skip stays exactly where it is, inside the per-source loop. |
| `pushOrSkipTxDisabled(results, fn)` | `actionExecutor.ts` (private) | Unchanged — the `deps.sendTapback` call still goes through it. |
| `interpolateAsync(text, ctx)` | `engineContext.ts` | Used only by `action.sendMessage`. **Do NOT start interpolating `p.emoji`** — that is a behaviour change out of scope. |
| Recorded-skip shape `{ skipped: true, reason }` | `actionExecutor.ts` (tapback/MeshCore, nodeManage, requestData) | The **exact** shape the new "no hop information" outcome must use. |
| `REQUEST_OPS` + its optional-param validation | `src/types/automation.ts` validation switch (`switch (n.type)` at :330) | The template for `emojiMode` validation: validate only when present. |
| `BLOCK_BY_TYPE`, `fieldsFor`, `FieldDef`, `BlockDef` | `src/components/automations/catalog.ts:1-40` | `emojiMode` is a plain `kind: 'select'` `FieldDef` — no new `FieldKind` needed. |
| `FieldInput` switch + `BlockFields` | `AutomationBuilder.tsx:65` / `:225-235` | `BlockFields` gains one `.filter()`; the `FieldInput` switch is **not** touched. |
| `defaultParams(type, triggerType)` | `AutomationBuilder.tsx:48` | Already seeds a `select`'s first option — this gives new tapback blocks `emojiMode: 'fixed'` for free. |
| `TRIGGER_TOKENS` / `UNIVERSAL_TOKENS` | `SubstitutionsHelp.tsx:12-40` | Source of truth that `tokenHints.ts` validates against. `hopEmoji` **must** be registered here or the builder flags it red. |
| `ActionView` | `AutomationTester.tsx:~265` | Already renders `resolvedParams.emoji`; needs only a headline hint + skip handling. |
| `recorder()` / `ctx()` / `node()` | `actionExecutor.test.ts:9-80` | All new executor tests use these. Do not invent new harnesses. |
| `recordingDeps()` | `automationSimulator.ts:~106` | **Unchanged.** No new dep ⇒ no drift risk. |
| `meshActionDeps.sendTapback` | `meshActionDeps.ts:~105` | **Unchanged.** The emoji is fully resolved before the dep is called. |
| `getUtf8ByteLength` | `src/utils/text.ts:8` | Used by the docs author to compute the recipe's byte counts. |
| `MAX_MESSAGE_BYTES = 200` | `src/server/constants/meshtastic.ts:336` | The real MeshMonitor cap. See §7 note on the reporter's "237". |

### Justification for the one new module

`src/utils/hopEmoji.ts` (~25 lines) is the only new file. Closest existing
candidates and why they lose:

- **`src/server/constants/meshtastic.ts`** — CLAUDE.md reserves it for
  *protocol values* (PortNum, RoutingError). A hop→emoji table is presentation,
  not protocol; and it is server-only, so `EmojiPickerModal.tsx` would keep its
  duplicate. **Rejected.**
- **`src/server/utils/autoAckDecision.ts`** — genuinely the closest (pure,
  testable AutoAck decision helpers). But the Automation Engine importing an
  `autoAck*` module makes the name a lie, and it is server-only ⇒ the frontend
  duplicate survives. **Rejected.**
- **`src/utils/autoAckMatrix.ts`** — shared, but models the 2×2 toggle matrix,
  an unrelated concern, and is again AutoAck-named. **Rejected.**
- **`src/utils/hopEmoji.ts`** — `src/utils/**` is the established shared tier
  (`meshtasticManager.ts` already imports `../utils/distance.js`,
  `../utils/nullIsland.js`, `../utils/positionIngestConfig.js`). Reachable by
  all four consumers. **Chosen.**

## 2. Deliverable 1 — shared hop→emoji helper

### 2.1 New file `src/utils/hopEmoji.ts`

```ts
/**
 * Hop-count → emoji mapping, shared by Auto-Acknowledge (meshtasticManager) and
 * the Automation Engine (action.tapback emojiMode=hopCount, {{ trigger.hopEmoji }}).
 *
 * Presentation, not protocol — hence src/utils/ rather than
 * src/server/constants/meshtastic.ts, and shared rather than server-only so the
 * tapback emoji picker uses the same glyphs. There must be exactly ONE copy of
 * this table in the repo.
 *
 * 0 hops is *️⃣ (asterisk keycap = "direct"), NOT 0️⃣. 7 and above clamp to 7️⃣
 * (Meshtastic's hop_limit maxes at 7).
 */
export const HOP_COUNT_EMOJIS = ['*️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'] as const;

/** Highest hop count with a distinct glyph; anything above clamps to it. */
export const HOP_EMOJI_MAX = 7;

/**
 * Emoji for a hop count, or `undefined` when the hop count is unknown.
 *
 * - null / undefined / non-finite → `undefined` (caller decides)
 * - negative (a malformed hopStart < hopLimit packet) → clamped to 0 → `*️⃣`
 * - fractional → truncated toward zero
 * - >= HOP_EMOJI_MAX → `7️⃣`
 *
 * Returning `undefined` rather than `*️⃣` for "unknown" is deliberate: telling a
 * range-tester they were direct when we do not know the hop count is a lie, and
 * both engine call sites have a meaningful "unknown" branch.
 */
export function hopCountEmoji(hops: number | null | undefined): string | undefined {
  if (hops == null || !Number.isFinite(hops)) return undefined;
  return HOP_COUNT_EMOJIS[Math.min(Math.max(Math.trunc(hops), 0), HOP_EMOJI_MAX)];
}
```

The signature is deliberately `number | null | undefined` rather than `unknown`:
it removes the `Number('') === 0` / `Number(null) === 0` foot-gun entirely and
matches both call sites' real types (`deriveHops` returns `number | undefined`,
`msg.hopCount ?? undefined`).

### 2.2 AutoAck consumes it — `src/server/meshtasticManager.ts:10183-10185`

Replace the three lines with:

```ts
// Hop count emojis: *️⃣ for 0 (direct), 1️⃣-7️⃣ for 1-7+ hops. Shared with the
// Automation Engine's action.tapback emojiMode=hopCount (src/utils/hopEmoji.ts).
// `hopsTraveled` is already floored at 0 above, so the fallback is unreachable.
const hopEmoji = hopCountEmoji(hopsTraveled) ?? HOP_COUNT_EMOJIS[0];
```

Import: `import { hopCountEmoji, HOP_COUNT_EMOJIS } from '../utils/hopEmoji.js';`
(note the `.js` extension — matches the file's existing `../utils/*.js` imports).

**Behaviour is provably identical:** `hopsTraveled` at `:10126-10133` is
`hopStart - hopLimit` only when both are non-null *and* `hopStart >= hopLimit`,
else `0` — i.e. always a finite integer ≥ 0. `hopCountEmoji` on such a value
reduces to `HOP_COUNT_EMOJIS[Math.min(hopsTraveled, 7)]`, byte-for-byte the old
expression. Everything downstream (`tapbackTarget`, `logger.debug`,
`messageQueue.enqueue(hopEmoji, …, 1)`) is untouched.

### 2.3 De-duplicate the frontend copy — `EmojiPickerModal.tsx:32-40`

Replace the eight literal hop entries with a mapped block over
`HOP_COUNT_EMOJIS`:

```ts
// Hop count emojis (for ping/test responses) — glyphs come from the single
// shared table so they can never drift from Auto-Acknowledge / automations.
...HOP_COUNT_EMOJIS.map((emoji, hops) => ({
  emoji,
  title: hops === 0 ? 'Direct (0 hops)' : hops === HOP_EMOJI_MAX ? '7+ hops' : `${hops} hop${hops === 1 ? '' : 's'}`,
})),
```

The resulting `DEFAULT_TAPBACK_EMOJIS` array must be **element-for-element
identical** to today (same order, same glyphs, same titles) — pinned by test.

## 3. Deliverable 2 — `emojiMode` on `action.tapback`

### 3.1 Checklist walk-through (all ten items, confirmed against the tree)

| # | Item | Phase 1 action |
|---|---|---|
| 1 | `src/types/automation.ts:36` `ActionType` union | **No change** — extending `action.tapback`, not adding a type. |
| 2 | `src/types/automation.ts:82` `ACTION_TYPES` | **No change.** |
| 3 | Param-validation switch (`switch (n.type)` at `:330`) | **Add a `case 'action.tapback'`** — see §3.2. |
| 4 | `ActionDeps` | **No change.** The emoji is computed *before* `deps.sendTapback`. |
| 5 | `actionExecutor.ts` dispatch switch (`case 'action.tapback'` at `:318`) | **Change** — see §3.3. |
| 6 | `meshActionDeps.ts:~105` | **No change** (deps did not grow). |
| 7 | `automationSimulator.ts:~106 recordingDeps()` | **No change** (deps did not grow) — this is why the design resolves the emoji before the dep boundary. |
| 8 | `catalog.ts:307` ACTIONS BlockDef | **Change** — see §3.4. |
| 9 | `FieldKind` + `AutomationBuilder.tsx` switch | **No new kind.** `emojiMode` is `kind: 'select'`, already rendered. |
| 10 | `AutomationTester.tsx ActionView` | **Change (small)** — see §3.6. |

### 3.2 Type + validation — `src/types/automation.ts`

Add next to the other operand unions (near `REQUEST_OPS`):

```ts
/** Where action.tapback's emoji comes from. Absent = 'fixed' (pre-4.14 behaviour). */
export type TapbackEmojiMode = 'fixed' | 'hopCount';
export const TAPBACK_EMOJI_MODES: readonly TapbackEmojiMode[] = ['fixed', 'hopCount'];
```

In the `switch (n.type)` param-check block, mirroring `action.requestData`:

```ts
case 'action.tapback':
  // Optional. Absent/unset = 'fixed' — every pre-existing stored automation
  // must keep validating and behaving exactly as before.
  if (p.emojiMode != null && !TAPBACK_EMOJI_MODES.includes(p.emojiMode as TapbackEmojiMode)) {
    errors.push(`action.tapback "${n.id}" requires params.emojiMode ∈ {fixed,hopCount}`);
  }
  break;
```

**Do not** add a required-`emoji` check — `p.emoji` has always been optional
(defaults `'👍'`), and requiring it would reject stored graphs.

### 3.3 Executor — `src/server/services/automation/actionExecutor.ts:318`

```ts
case 'action.tapback': {
  // emojiMode (#4340): 'fixed' (default, and what an absent param means) uses the
  // configured emoji; 'hopCount' derives it from the triggering message's hop
  // count via the table AutoAcknowledge uses (src/utils/hopEmoji.ts).
  const hopMode = p.emojiMode === 'hopCount';
  let emoji: string;
  if (hopMode) {
    const derived = hopCountEmoji(ctx.trigger.fields.hops as number | null | undefined);
    if (derived === undefined) {
      // No hop information: a schedule/system trigger wired to a tapback, or a
      // message whose hopStart/hopLimit were absent. Record a no-op skip in the
      // same shape as the MeshCore/TX-disabled skips rather than throwing — a
      // throw would mark the whole run failed and spam the run log.
      return { skipped: true, reason: 'tapback emojiMode=hopCount: the trigger carries no hop count' };
    }
    emoji = derived;
  } else {
    emoji = String(p.emoji ?? '👍');
  }
  // …everything below is UNCHANGED: replyId / destination / channel resolution,
  //   the sourceIds loop, isMeshCoreSource skip, pushOrSkipTxDisabled, unwrap.
}
```

Explicit ordering decision (test-visible, so pin it): the hop-count resolution
happens **before** the per-source loop. Consequences —

- MeshCore trigger **with** `hopCount` + a Meshtastic target source → hop emoji
  sent normally.
- MeshCore trigger **with** `hopCount` + a MeshCore target source → existing
  `'tapback is not supported on MeshCore'` skip (unchanged).
- Any trigger **without** hop info → the single `'…carries no hop count'` skip,
  returned before any source is examined.
- `emojiMode: 'fixed'`, absent, or any unrecognised value → the existing
  `String(p.emoji ?? '👍')` path, bit-identical to today. (Server-side
  validation rejects unrecognised values at save time; the executor is
  deliberately lenient for graphs written before validation.)

Import: `import { hopCountEmoji } from '../../../utils/hopEmoji.js';`

### 3.4 Catalog — `src/components/automations/catalog.ts:307-315`

```ts
{
  type: 'action.tapback',
  label: 'Send a tapback (reaction)',
  description: 'React to the triggering message.',
  fields: [
    {
      name: 'emojiMode', label: 'Emoji source', kind: 'select',
      options: [
        { value: 'fixed', label: 'A fixed emoji' },
        { value: 'hopCount', label: `The message's hop count (${HOP_COUNT_EMOJIS[0]} direct, ${HOP_COUNT_EMOJIS[1]}–${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]})` },
      ],
      help: `Hop count reacts with ${HOP_COUNT_EMOJIS[0]} for a direct (0-hop) message and ${HOP_COUNT_EMOJIS[1]}–${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]} above, clamping at ${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]} — the same table Auto-Acknowledge uses. Triggers with no hop information (Schedule, System) record a skipped no-op.`,
    },
    { name: 'emoji', label: 'Emoji', kind: 'emoji', placeholder: '👍', showIf: { field: 'emojiMode', notEquals: 'hopCount' } },
    { name: 'sourceIds', /* …unchanged… */ },
  ],
},
```

Import `HOP_COUNT_EMOJIS`/`HOP_EMOJI_MAX` from `../../utils/hopEmoji` (no `.js`
— this is a Vite frontend module; match the file's neighbours' style).

**ORCHESTRATOR CORRECTION (C1):** every emoji glyph in this file's labels and
`help` copy MUST be interpolated from `HOP_COUNT_EMOJIS`, never typed as a
literal. CLAUDE.md bans hardcoded emoji in JSX and locale UI copy; interpolating
the shared constant satisfies it and keeps the single-source-of-truth property.
Add above the block:
`// #4340: protocol/content emoji (the glyphs actually sent over the mesh), not UI iconography — UiIcon does not apply. Glyphs are interpolated from the shared table so they cannot drift.`

**Ordering matters twice:**
1. `emojiMode` is listed *first* so the mode drives the field below it visually.
2. `defaultParams()` (`AutomationBuilder.tsx:48`) seeds a `select`'s first
   option when it is non-empty, so a **newly added** tapback block gets
   `params.emojiMode = 'fixed'`. This equals today's behaviour and is safe.
   **Existing stored graphs have no `emojiMode` at all and are never rewritten**
   — the executor's default carries them.

**Do NOT** put `emojiMode` behind `advanced: true` (see §3.5 — `advanced` is
currently inert).

### 3.5 Conditional field visibility — the general mechanism

**Finding: no such mechanism exists today.** `FieldDef.advanced` is declared at
`catalog.ts:23` and set on six fields, but `AutomationBuilder.tsx` never reads
it — `BlockFields` maps over `def.fields` unconditionally. So there is nothing
to reuse and a real (small) gap to close.

Smallest general mechanism — **one optional declarative field on `FieldDef` +
one pure predicate + one `.filter()`**:

`catalog.ts`:
```ts
export interface FieldDef {
  // …existing…
  /**
   * Render this field only when a sibling param matches. Omitted = always shown.
   * Declarative (not a predicate function) so the catalog stays serialisable data.
   */
  showIf?: { field: string; equals?: unknown; notEquals?: unknown };
}

/** Should this field render, given the block's current params? Pure — unit-tested without React. */
export function fieldVisible(field: FieldDef, params: Record<string, unknown>): boolean {
  const c = field.showIf;
  if (!c) return true;
  const v = params[c.field];
  if ('equals' in c && v !== c.equals) return false;
  if ('notEquals' in c && v === c.notEquals) return false;
  return true;
}
```

`AutomationBuilder.tsx` `BlockFields` (~:227) — one-line change:
```ts
{def.fields.filter((f) => fieldVisible(f, block.params)).map((f) => { /* unchanged */ })}
```

Semantics to honour:
- Hidden ≠ cleared. **Never delete `params.emoji` when the field is hidden** —
  the user's fixed emoji is preserved across a `hopCount` → `fixed` round-trip,
  and the executor already ignores it in `hopCount` mode.
- A legacy graph with no `emojiMode` yields `params.emojiMode === undefined`,
  which `!== 'hopCount'` ⇒ the Emoji field is shown. Correct.

**Explicit non-goal:** do not retrofit `showIf` onto `scopeMode`/`scopeName` in
this phase. File a follow-up issue instead ("docs claim `scopeName` is
conditionally revealed; it is not — now fixable with `showIf`").

### 3.6 Dry-run headline — `AutomationTester.tsx ActionView`

```ts
} else if (a.type === 'action.tapback') {
  if (p.skipped) { headline = `Tapback → skipped (${String(p.reason ?? '')})`; }
  else {
    headline = `Tapback → ${p.destination != null ? `DM to node ${p.destination}` : `channel ${p.channel ?? 0}`}`;
    sent = <div className="ae-test-sent">{String(p.emoji ?? '')}</div>;
  }
}
```

No simulator change is needed: `SimEventInput` already carries
`hopStart`/`hopLimit` (`automationSimulator.ts:65-66, 208-209`) and the Test
panel already renders **Hop start** / **Hop limit** inputs
(`AutomationTester.tsx:235`), so the dry-run exercises `emojiMode: hopCount`
end-to-end today.

## 4. Deliverable 3 — `{{ trigger.hopEmoji }}`

### 4.1 Meshtastic — `triggerContext.ts:68-96`

`deriveHops(msg)` is currently called inline at `:80`. Hoist it so it is
computed once:

```ts
const hops = deriveHops(msg);
// …
hops,
hopEmoji: hopCountEmoji(hops),
```

### 4.2 MeshCore — `triggerContext.ts:~162`

```ts
const hops = msg.hopCount ?? undefined;
// …
hops,
hopEmoji: hopCountEmoji(hops),
```

MeshCore has no tapback, but the token is usable in `action.sendMessage` bodies
— that is the point (per the epic's out-of-scope note).

### 4.3 Documented divergence (do not "fix" it)

`deriveHops` has **no `hopStart >= hopLimit` guard** — unlike AutoAck's
`hopsTraveled` at `meshtasticManager.ts:10126`. So on a malformed packet
`{{ trigger.hops }}` can render a negative number while
`{{ trigger.hopEmoji }}` renders `*️⃣` (clamped). **Leave `deriveHops` alone** —
changing it would silently alter every existing `condition.numeric` on field
`hops`. Add a comment at the `hopEmoji` line recording the divergence, and a
unit test pinning it.

Unknown hops ⇒ the field is `undefined` ⇒ `interpolate` renders blank, matching
the documented "An unknown or empty value renders blank" contract. Confirm
against `interpolate.test.ts` rather than assuming.

### 4.4 UI token registry — `SubstitutionsHelp.tsx:24`

Add to `TRIGGER_TOKENS['trigger.message']`, immediately after the existing
`['hops', …]` entry:

```ts
// #4340: these are protocol/content emoji (the actual glyphs sent over the mesh),
// not UI iconography — UiIcon does not apply. See CLAUDE.md "App-owned interface icons".
['hopEmoji', `Hop count as an emoji — ${HOP_COUNT_EMOJIS[0]} direct, ${HOP_COUNT_EMOJIS[1]}–${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]} (${HOP_COUNT_EMOJIS[HOP_EMOJI_MAX]} = 7 or more); blank when the hop count is unknown`],
```

**The comment and the interpolation are both mandatory** (orchestrator
correction C1 applies here too).

Registering here automatically makes `tokenHints.ts`
(`validTokenSet` / `anyTriggerTokenSet`) accept the token — no change to
`tokenHints.ts` itself.

**Do not** add `hopEmoji` to `fieldsFor`'s condition field lists. It is a
string; comparing hop *emoji* is strictly worse than the existing
`condition.numeric` on `hops`, and it would clutter the picker.

## 5. Deliverable 4 — docs + the #4340 recipe

### 5.1 `docs/features/automation-engine.md`

**§ Actions → "Send a tapback (reaction)"** (`:153`) — replace the two-line stub:

- **Emoji source** — *A fixed emoji* (default; what every existing automation
  does) or *The message's hop count*.
- Hop-count mode: `*️⃣` for a direct 0-hop message, `1️⃣`–`7️⃣` above, clamping at
  `7️⃣`. Same table Auto-Acknowledge uses.
- Triggers with no hop information (Schedule, System, or a message with no
  `hopStart`/`hopLimit`) record a **skipped no-op**, not a failure.
- MeshCore sources are still skipped — MeshCore has no tapback concept.
- The **Emoji** field is hidden while hop-count mode is selected; your fixed
  emoji is remembered if you switch back.

**§ Tokens** (`:306`) — add a `{{ trigger.hopEmoji }}` row to the
message-trigger token list, noting it renders blank when hop count is unknown.

### 5.2 New section: `## Recipe — per-channel range-test acks (issue #4340)`

Place it after `## Actions`. It must be followable verbatim.

**The scenario (from the issue):** a base station on a busy primary community
channel plus a secondary community channel. Range-testers ping on the primary;
the operator wants the primary-channel ack to redirect them to the secondary
channel, while the secondary-channel ack says something appropriate for people
already there. One global Auto-Acknowledge body cannot be true in both places.

**The key insight to state up front:** the hop-count reaction is a **separate
packet** whose entire payload is the emoji. Moving the signal report into a
hop-count tapback frees the whole text body for channel-specific wording —
exactly the byte pressure the reporter describes.

**Primary form — two automations (uses only blocks that provably exist today):**

*Automation A — "Range-test ack — Primary"*
- **WHEN** `A message is received`
  - *Text contains:* `test`. Use *Text matches regex* `\b(test|ping)\b` for word
    boundaries.
  - *On channels:* `Primary`.
  - *Cooldown (seconds):* leave `0`. **Call this out honestly:** the engine's
    cooldown is currently per-automation, so a non-zero cooldown on a busy
    channel swallows acks to *other* senders. Per-node cooldown scope lands in
    Phase 2 of this epic.
- **THEN**
  1. `Send a tapback (reaction)` → **Emoji source: The message's hop count**
  2. `Send a message` → leave *On channels* empty (replies on the triggering
     channel), body:
     `{{ trigger.hopEmoji }} {{ trigger.senderLabel }} {{ trigger.hops }}h {{ trigger.snr }}dB · range tests → #RangeTest`

*Automation B — "Range-test ack — RangeTest"*
- Identical trigger, but *On channels:* `RangeTest`.
- **THEN** the same hop-count tapback, plus:
  `{{ trigger.hopEmoji }} {{ trigger.senderLabel }} {{ trigger.hops }}h SNR {{ trigger.snr }} RSSI {{ trigger.rssi }}`

*Tapback-only variant:* delete the `Send a message` action from A and B. The
hop-count reaction alone carries the full range-test answer at ~7 bytes and zero
channel noise.

**Alternative form — one automation, two rules.** Same trigger with *On
channels:* `Primary, RangeTest`, then two rules each gated by a `Text/String
check` condition on the `channelName` field. **The docs author must verify in
the builder that `channelName` is selectable in the condition field picker
before publishing this variant** — if not, ship only the two-automation form and
note the limitation.

**Byte budget — must be numerically correct in the published doc.** Compute each
example body with `getUtf8ByteLength` (`src/utils/text.ts:8`) and state the
numbers. Non-obvious facts to include:
- Keycap sequences are **7 bytes each** in UTF-8 (base char + U+FE0F +
  U+20E3 = 1 + 3 + 3). `{{ trigger.hopEmoji }}` therefore costs 7 bytes in a
  text body — which is precisely why putting it in the *tapback* is the win.
- The reporter's **237 bytes** is the Meshtastic `TEXT_MESSAGE_APP` on-wire
  payload maximum. **MeshMonitor's own constant is `MAX_MESSAGE_BYTES = 200`**
  (`src/server/constants/meshtastic.ts:336`). The docs author **must trace**
  whether an automation `sendMessage` is subject to that path (it routes through
  `mgr.sendTextMessage`, while the 200-byte check lives in
  `routes/v1/messages.ts:482`) and document the number that actually applies.
  Do not publish "237" unverified.

**Closing paragraph** — why this answers #4340 without per-channel
Auto-Acknowledge fields, plus a drafted issue comment linking to the new doc
section.

**ORCHESTRATOR CORRECTION (C3):** WP4 drafts the closing comment into the PR
description only. **Do not post to or close issue #4340** — the orchestrator
does that after the PR merges.

### 5.3 `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md`

Flip Phase 1 to `[x] complete`, and record under **Notes / deviations**: the
`showIf` mechanism, the "no hop info → recorded skip" decision, the
`deriveHops`-can-go-negative divergence, and the `scopeName` docs/behaviour
mismatch follow-up.

## 6. Test plan (mandatory — standard Vitest suite, no standalone scripts)

| File | New / extend | Cases |
|---|---|---|
| `src/utils/hopEmoji.test.ts` | **new** | All 8 glyphs by index, pinned as exact string literals (catches a copy-paste of `0️⃣` for `*️⃣`); `0 → *️⃣`; `7 → 7️⃣`; `8`, `99` → `7️⃣`; `-1`, `-99` → `*️⃣`; `2.9 → 2️⃣`; `undefined`/`null`/`NaN`/`Infinity` → `undefined`; `HOP_COUNT_EMOJIS.length === 8`; `HOP_EMOJI_MAX === 7`. |
| `src/server/meshtasticManager.autoAckTapbackEmoji.test.ts` | **new** — the "provably unchanged" regression | Drive `checkAutoAcknowledge` with `hopStart/hopLimit` pairs; assert the **first argument to `messageQueue.enqueue`** is `*️⃣` (0 hops), `3️⃣` (3), `7️⃣` (9, clamped), `*️⃣` when `hopStart < hopLimit` or either is absent. Model on `meshtasticManager.autoAckTokens.perSource.test.ts`. Also assert the tapback enqueue still passes `maxAttempts = 1` and `emoji flag = 1`. |
| `src/components/EmojiPickerModal/EmojiPickerModal.hopEmojis.test.ts` | **new** | `DEFAULT_TAPBACK_EMOJIS` still contains exactly the 8 hop entries, in order, with the original titles (`'Direct (0 hops)'`, `'1 hop'`, `'2 hops'` … `'7+ hops'`); array length/order otherwise unchanged. |
| `src/types/automation.test.ts` | extend | `emojiMode: 'fixed'`/`'hopCount'` validate; `'random'` produces the `∈ {fixed,hopCount}` error; a tapback node with **no** `emojiMode` still validates. |
| `src/server/services/automation/actionExecutor.test.ts` | extend | `emojiMode` absent → `👍`; `'fixed'` → configured emoji; `'hopCount'` + `hops: 0` → `*️⃣`; `3` → `3️⃣`; `9` → `7️⃣`; `-2` → `*️⃣`; `undefined` → `{ skipped: true, reason: /no hop count/ }` **and `sendTapback` never called**; `'hopCount'` on a MeshCore source with hops present → existing MeshCore skip; multi-source → same emoji on every source; `'hopCount'` ignores a stale `p.emoji`. |
| `src/server/services/automation/triggerContext.test.ts` | extend | `buildMessageContext` sets `hopEmoji` from `hopStart/hopLimit` (`3/1 → 2️⃣`); `undefined` when either absent; negative derived hops → `*️⃣` while `hops` stays negative (the documented divergence); MeshCore context sets `hopEmoji` from `msg.hopCount`, `undefined` when absent. |
| `src/server/services/automation/automationSimulator.test.ts` | extend | Dry-run a `hopCount` tapback with `hopStart/hopLimit` → `resolvedParams.emoji === '3️⃣'`; no hop fields → recorded skip surfaces in `actions[0]`; `recordingDeps()` still satisfies `ActionDeps`. |
| `src/server/services/automation/interpolate.test.ts` *(or `engineContext`)* | extend | `{{ trigger.hopEmoji }}` interpolates the glyph; blank when the field is `undefined`. |
| `src/components/automations/catalog.showIf.test.ts` | **new** | `fieldVisible` truth table: no `showIf` → true; `equals` match/mismatch; `notEquals` match/mismatch; both together; `undefined` param vs `notEquals: 'hopCount'` → **true** (legacy-graph case). Plus: `action.tapback` has `emojiMode` before `emoji`, and `emoji` carries `showIf`. |
| `src/components/automations/AutomationBuilder.emojiMode.test.tsx` | **new** (model on `AutomationBuilder.txWarning.test.tsx`) | `emojiMode: 'hopCount'` does **not** render the Emoji input; `'fixed'`/absent does; switching to `hopCount` **preserves** `params.emoji`. |
| `src/components/automations/tokenHints.test.ts` | extend | `{{ trigger.hopEmoji }}` classifies as `'ok'` for `trigger.message`. |

Also required per CLAUDE.md: full `npx vitest run` green (0 failures, confirmed
via `--reporter=json` `success: true`) and
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` empty. No
new route ⇒ no envelope work; no schema change ⇒ no migration, no PG/MySQL
containers required.

## 7. Work packages

All agents share **one worktree**. File ownership is exclusive — two packages
never edit the same file, and the parallel pair (WP2/WP3) share no file.

### WP1 — Shared helper + AutoAck extraction *(must land first; blocks everything)*

**Owns:** `src/utils/hopEmoji.ts` (new) · `src/utils/hopEmoji.test.ts` (new) ·
`src/server/meshtasticManager.ts` ·
`src/server/meshtasticManager.autoAckTapbackEmoji.test.ts` (new) ·
`src/components/EmojiPickerModal/EmojiPickerModal.tsx` ·
`src/components/EmojiPickerModal/EmojiPickerModal.hopEmojis.test.ts` (new)

**Acceptance:** `grep -rn "'\*️⃣'" src` returns exactly one non-test hit —
`src/utils/hopEmoji.ts`. `hopCountEmoji` matches the §2.1 contract. AutoAck's
emitted emoji is byte-identical for every hop value. `DEFAULT_TAPBACK_EMOJIS`
unchanged element-for-element. Full suite green.

### WP2 — Engine: `emojiMode` + `hopEmoji` field *(after WP1; parallel with WP3)*

**Owns:** `src/types/automation.ts` · `src/types/automation.test.ts` ·
`src/server/services/automation/actionExecutor.ts` · `.../actionExecutor.test.ts` ·
`.../triggerContext.ts` · `.../triggerContext.test.ts` ·
`.../automationSimulator.test.ts` · `.../interpolate.test.ts`

**Acceptance:** §3.2/§3.3/§4 implemented exactly. `ActionDeps`,
`meshActionDeps.ts`, `recordingDeps()` **not modified** (verify with
`git diff --stat`). Every pre-existing tapback test passes **unmodified**. The
no-hop path returns the recorded-skip shape and never calls `sendTapback`. Full
suite green.

### WP3 — Builder: `showIf`, catalog entry, token registry, tester *(after WP1; parallel with WP2)*

**Owns:** `src/components/automations/catalog.ts` · `.../AutomationBuilder.tsx` ·
`.../SubstitutionsHelp.tsx` · `.../AutomationTester.tsx` ·
`.../catalog.showIf.test.ts` (new) ·
`.../AutomationBuilder.emojiMode.test.tsx` (new) · `.../tokenHints.test.ts`

**Hard constraint:** WP3 must **not** edit `src/types/automation.ts` (WP2 owns
it). Use the string literals `'fixed'`/`'hopCount'` directly in the catalog
`options`, with a comment pointing at `TapbackEmojiMode`. The token name is
exactly `hopEmoji`; WP2 populates it.

**ORCHESTRATOR CORRECTION (C2):** WP3 does **not** deploy or drive the dev
container. Only one dev container may run at a time and the orchestrator manages
it — WP3 delivers unit/component tests only; browser validation is the
orchestrator's Stage 5.

**Acceptance:** `fieldVisible` is a pure exported function with a full
truth-table test; `BlockFields` filters through it; the Emoji field is hidden in
`hopCount` mode and its stored value is preserved across a mode round-trip;
`{{ trigger.hopEmoji }}` classifies as `'ok'`; `ActionView` shows the mode/skip.

### WP4 — Docs + #4340 recipe *(after WP2 and WP3 both land)*

**Owns:** `docs/features/automation-engine.md` ·
`docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md`

**Acceptance:** §5 delivered. Byte counts computed with `getUtf8ByteLength`, not
estimated. The applicable payload limit is **traced in code** before publishing
(200 vs 237). Every field name, block label, and token in the recipe matches the
shipped builder verbatim. A draft #4340 closing comment goes in the PR
description — the issue itself is **not** touched (C3).

**Dependency graph:** `WP1 → (WP2 ∥ WP3) → WP4`

## 8. Contradictions found against the original brief

1. **`catalog.ts`/`AutomationBuilder.tsx` have no conditional-visibility support
   at all.** `FieldDef.advanced` is declared and set on six fields but **never
   read** by the builder — inert metadata, not a precedent. `showIf` (§3.5) is
   the new minimal general mechanism.
2. **`docs/features/automation-engine.md` already documents behaviour that does
   not exist:** it says the `action.sendMessage` MeshCore scope select "reveals a
   Region picker", but `scopeName` renders unconditionally. Flagged as a
   follow-up that `showIf` now makes trivial.
3. **The hop-emoji table already has a second copy** at
   `EmojiPickerModal.tsx:32-40`. The brief framed this as extracting one inline
   constant; it is a two-site de-duplication — which is why the helper lands in
   shared `src/utils/` rather than `src/server/**`.
4. **The `emoji` `FieldKind` has no renderer.** `'emoji'` is in the `FieldKind`
   union but `FieldInput` has no `case 'emoji'` — it falls through to `default`
   and renders a plain text input.
5. **`deriveHops()` can return a negative number** — it lacks the
   `hopStart >= hopLimit` guard AutoAck has. The helper clamps; `deriveHops` is
   deliberately left alone.
6. **The 237-byte figure is the reporter's, not MeshMonitor's.** The codebase
   constant is `MAX_MESSAGE_BYTES = 200`, referenced only from
   `routes/v1/messages.ts`; the automation path goes to `mgr.sendTextMessage`
   directly. WP4 must trace which limit applies.
7. **Checklist items 4, 6 and 7 are confirmed no-ops** — the design resolves the
   emoji before the `ActionDeps` boundary, so `meshActionDeps.ts` and
   `recordingDeps()` cannot drift.
8. **`AutomationTester` already supports hop input**, so the dry-run needs no new
   UI to exercise `hopCount`.
