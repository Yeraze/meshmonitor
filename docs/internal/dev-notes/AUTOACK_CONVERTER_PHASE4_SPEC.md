# Auto-Acknowledge → Automation Converter — Phase 4 Implementation Spec

**Epic:** #4340 · **Phase:** 4 (final) · **Branch:** `feature/autoack-converter`
**Worktree:** `/home/yeraze/Development/meshmonitor-autoack-converter`
**Base:** `origin/main` @ `3404905a` (Phases 1–3 merged)

> **Orchestrator sign-off (2026-07-28) — both blocking decisions APPROVED:**
>
> **(1) The new derived `zeroHop` numeric field (§3.1) is approved.** Obligation 4's
> prescribed mechanism — port-branching off `condition.numeric hops > 0` — is
> provably incompatible with the mandatory builder round-trip: `compile.ts:128`
> makes `decompile()` return `null` for ANY ported edge, and
> `AutomationsPage.tsx:169` then opens the raw-JSON editor. That is precisely the
> "a converted automation the user cannot open and edit is a failure" condition.
> The architect verified no port-free, editable alternative exists using only
> post-Phase-3 blocks. `zeroHop` satisfies obligation 4's *behaviour* exactly (it
> is computed through AutoAck's own `autoAckIsZeroHop()` on AutoAck's own floored
> hop count) while keeping the flat fanout shape `decompile()` supports, and it is
> added the same way Phase 3 added `node.completeness`.
>
> **(2) Up to two automations per source (§9.2) is approved as a forced
> deviation** from epic decision 7 ("one automation per source"). It is not a
> preference: `messageMatchesFilter` applies the `channels` filter to DMs too,
> while AutoAck's channel allowlist gates channel messages only — so a single
> shared trigger would silently gate the Direct cells by channel name, a fidelity
> regression invisible until a DM on an unlisted slot goes unanswered. Phase 1 hit
> the identical root cause and shipped the two-automation form for the #4340
> recipe. The spirit of decision 7 (a readable graph, only enabled cells) is
> preserved, and only-Channel or only-Direct configs still yield exactly one
> automation. **The preview must always state how many will be created and why.**

## 0. Summary of decisions

1. The converter **does not hand-assemble a graph.** It builds a `WorkflowForm` and
   runs it through `compile()` (`src/components/automations/compile.ts`). Round-trip
   through `decompile()` is then true *by construction*, not by test luck.
2. **One new engine field, `zeroHop`** — see the sign-off above and §3.1.
3. **Up to two automations per source** — see the sign-off above and §9.2.
4. Preview and create are **two POST endpoints** on a new router; preview writes
   nothing.
5. The report is a first-class typed artifact with four buckets (`converted` /
   `approximated` / `notConvertible` / `dropped`), pinned against the parity table
   by test.
6. Re-conversion is detected by a machine-readable **description marker**, surfaced
   in preview, and refused by create unless `replaceExisting: true`.

## 1. Reuse inventory (read this before writing any code)

Everything below already exists and **must** be imported, not reimplemented.

| Need | Existing symbol | File | Use |
|---|---|---|---|
| Form → graph | `compile(form: WorkflowForm): AutomationGraph` | `src/components/automations/compile.ts:45` | The converter's *only* graph emitter |
| Graph → form (the round-trip bar) | `decompile()` | `compile.ts:120` | Test assertion, and the builder's own load path |
| Graph validation | `validateAutomationGraph()` | `src/types/automation.ts:254` | Test assertion + the create path |
| The 2×2 model | `AutoAckMatrix`, `AUTOACK_CELLS`, `settingsToMatrix()`, `cellServerKeyPrefix()` | `src/utils/autoAckMatrix.ts` | Reads the 12 cell keys — do **not** re-derive key names |
| ZeroHop semantics | `autoAckIsZeroHop(hopsTraveled, viaMqtt)` | `src/server/utils/autoAckDecision.ts:16` | Powers the new `zeroHop` trigger field (§3.1) |
| Reply routing | `resolveAutoAckReplyRouting()` | `src/server/utils/autoAckDecision.ts:49` | Its `replyViaDm` / `replyId` logic is the spec for `to` / `replyToTrigger` (§4.4) |
| Pre-send delay | `resolveAutoAckPreSendDelaySeconds()`, `AUTO_ACK_PRESEND_DELAY_MAX_SECONDS = 120` | `src/server/autoAckDelay.ts` | Parse the setting; 120 < `AUTOMATION_DELAY_MAX_SECONDS` (300) so **no clamp needed** |
| Legacy-key translation | `computeMatrixValues(legacy)` (exported, pure) | `src/server/migrations/093_autoack_matrix.ts:86` | Legacy fallback (§2.2) — do not write a second translator |
| Per-source read | `settings.getSettingForSource(sourceId, key)` | `src/db/repositories/settings.ts:201` | The only settings accessor the converter uses |
| Channel index → name | `databaseService.channels.getAllChannels(sourceId)`; `isConfiguredChannel()`, `sourceProtocol()` | `src/db/repositories/channels.ts`, `src/server/services/automation/channelUnify.ts` | Obligation 3 |
| Channel-filter semantics | `messageFilterChannelNames()`, `messageMatchesFilter()` | `triggerContext.ts` | **Blank names are dropped** — the converter must not emit them (§4.2) |
| Node completeness | `node.completeness` (`complete`/`incomplete`/`unknown`) | `engineContext.ts:236`, catalog `NODE_STRING` | Parity row 8 |
| List membership | `in` / `notIn` on `condition.string` (splits `/[\s,]+/`, case-insensitive) | `conditionEvaluator.ts:53` | Parity row 9 |
| Hop tapback | `action.tapback` `emojiMode: 'hopCount'` | Phase 1 | Parity rows 23/26/29/32 |
| Cooldown scope | `cooldownScope: 'node'` | Phase 2 | Parity row 19 |
| Response envelope | `ok()` / `fail()` | `src/server/utils/apiResponse.ts` | Mandatory on both new routes |
| Permission middleware | `requirePermission(resource, action, { sourceIdFrom, requireSourceId })` | `src/server/auth/authMiddleware.ts:351` | §5.1 |
| Route tests | `createRouteTestApp()` | `src/server/test-helpers/routeTestApp.ts` | Mandatory (CLAUDE.md) |
| CSRF + source query in UI | `useCsrfFetch()`, `useSourceQuery()`, `useSource()` | `src/hooks/`, `src/contexts/SourceContext.tsx` | Same plumbing as the existing save |
| Parity contract | `AUTOACK_PARITY` table | `src/server/services/automation/autoAckParity.test.ts` | The report test keys off the same 33 rows |

### 1.1 Justification for new modules

Three new source files, each justified against the closest existing thing:

- **`src/server/services/automation/autoAckConverter.ts` (pure).** Closest are
  `autoAckDecision.ts` (pure AutoAck decisions, knows nothing about automations)
  and `compile.ts` (form→graph, knows nothing about AutoAck). The converter is
  precisely the bridge; neither file should grow the other's vocabulary. It lives
  beside the other pure automation helpers and imports `compile.ts` — the same
  cross-tree import `autoAckParity.test.ts` already makes for `catalog.ts`, legal
  because `compile.ts` depends only on `src/types/automation.ts`.
- **`src/server/services/automation/autoAckConverterService.ts` (DB-facing).**
  Does the `getSettingForSource` / `getAllChannels` / `getSource` reads and hands a
  plain object to the pure builder, so the builder stays unit-testable with
  literals. Mirrors the existing `meshNodeData.ts` ↔ `engineContext.ts` split.
- **`src/server/routes/autoAckConverterRoutes.ts`.** `automationRoutes.ts` is 352
  lines of pre-envelope handlers; adding envelope-using handlers there would create
  a mixed-convention file and collide with WP ownership. A sibling router matches
  the `meshcorePacketRoutes.ts` / `meshcoreRoutes.ts` precedent.

No new `ConditionType`, no new `ActionType`, no new block, no new table, no
migration, no new `VALID_SETTINGS_KEYS` entry.

## 2. Resolved settings — exactly what is read

### 2.1 The keys

`resolveAutoAckSettings(sourceId)` calls `getSettingForSource(sourceId, key)` for
**21 keys** and nothing else. `getSettingForSource` prefixes `source:<id>:` and has
**no global fallback** — correct, since AutoAck reads the same way.

| Read | Default when absent/blank |
|---|---|
| `autoAckEnabled` | `false` |
| `autoAckRegex` | **`^(test\|ping)`** — obligation 1 |
| `autoAckMessage` | `🤖 Copy, {NUMBER_HOPS} hops at {TIME}` (`meshtasticManager.ts:10254`) |
| `autoAckMessageDirect` | `''` → falls back to `autoAckMessage` |
| `autoAckChannels` | `[]` (comma-separated indices) |
| `autoAckSkipIncompleteNodes` | `false` |
| `autoAckIgnoredNodes` | `''` |
| `autoAckCooldownSeconds` | **`60`** — obligation 2 |
| `autoAckPreSendDelaySeconds` | `0`, via `resolveAutoAckPreSendDelaySeconds` |
| `autoAckMaxAttempts` | read for the **report only**; never emitted (parity note 8) |
| the 12 `autoAck{Cell}{Reply,Tapback,ReplyDm}Enabled` keys | `false` each, via `settingsToMatrix()` |

`autoAckTestMessages` is **not read** — no server code reads it, and reading it
would imply a claim the report explicitly denies.

Plus, not settings: `sources.getSource(sourceId)` (name, type) and
`channels.getAllChannels(sourceId)` (index → name/role).

### 2.2 A source that still has legacy values

Migration 093 already translated every legacy prefix into the 12 matrix keys at
boot, insert-if-absent. Three residual cases:

1. **Matrix keys present** (normal): use them; ignore legacy entirely.
2. **All 12 matrix keys absent AND ≥1 legacy key present** (a pre-093 dump restored
   into a process that has not re-run migrations, or hand-edited rows): call
   `computeMatrixValues()` — the exported pure function from migration 093 — and
   use its output. Emit a `legacy-matrix-derived` report entry naming the legacy
   keys used. **Never persist** the derived values; the converter is read-only with
   respect to AutoAck settings except the one explicit disable step (§5.3).
3. **All matrix keys absent and no legacy keys**: matrix is all-off → zero rules →
   `preview` returns `automations: []` and `blocking: 'NO_CELLS_ENABLED'`; the UI
   disables the Convert button.

`autoAckEnabled === 'false'` is **not** blocking — a user may reasonably convert a
disabled config. It is reported, and seeds the "Enable the new automation now"
checkbox to unchecked.

## 3. Engine change — the one new field

### 3.1 `zeroHop` on the message trigger context

`triggerContext.ts`, inside `buildMessageContext`, beside `hops` / `hopEmoji`:

```ts
// #4340 Phase 4. AutoAck floors a missing/malformed hop count to 0 and treats it
// as ZeroHop (meshtasticManager.ts:10170-10178). `hops` above deliberately keeps
// deriveHops' raw value (undefined / possibly negative) — see the Phase 1 note.
// `zeroHop` is the AutoAck-faithful, TOTAL 1/0 form: it is never NaN, so a rule
// can branch on it inside a flat AND-chain instead of needing condition ports.
const hopsFloored = typeof hops === 'number' && hops > 0 ? hops : 0;
zeroHop: autoAckIsZeroHop(hopsFloored, msg.viaMqtt) ? 1 : 0,
```

Same line in `buildMeshCoreMessageContext` (`viaMqtt` absent → `undefined` →
treated as not-MQTT). Adding it to both is not scope creep: a numeric field that
silently becomes `NaN` on one protocol is the exact trap Phase 3 documented for
`isDM`/`viaMqtt`.

Catalog (`EVENT_NUMERIC['trigger.message']`, immediately after `viaMqtt`):

```ts
{ value: 'zeroHop', label: 'Direct RF, 0 hops (1 = yes; 0 = relayed or via MQTT)' },
```

`SubstitutionsHelp.tsx` `TRIGGER_TOKENS['trigger.message']` gains
`['zeroHop', '1 when the message arrived over RF with 0 hops; 0 when relayed or received via MQTT']`.

`autoAckParity.test.ts` rows 22/25/28/31 gain `'field:zeroHop'` alongside the
existing entries. Additive; the 33 keys and every assertion are untouched.

**Why not a new block.** Same shape Phase 3 chose for `node.completeness`: a
computed field on the existing `condition.numeric` mechanism — one line in the
context builder, one catalog entry, zero evaluator change. `viaMqtt` and `isDM`
stay in the picker; this does not replace them.

**Verified, not assumed:** `viaMqtt` is a real boolean on every inbound message
emitted to the engine (`meshtasticManager.ts:6208, 6421, 6553`), so `asNumber`
yields 0/1 rather than NaN. It is `null` in the *DB row*, but the engine sees the
in-memory object. `hopStart` however is genuinely `?? null` (`:6170, :6385,
:6517`) → `deriveHops` returns `undefined` → `hops` is NaN. Obligation 4's concern
is real, not hypothetical.

## 4. The graph builder

`src/server/services/automation/autoAckConverter.ts` — pure, no imports from
`services/database.js`.

```ts
export interface AutoAckConverterInput {
  sourceId: string;
  sourceName: string;
  settings: ResolvedAutoAck;              // §2.1
  channels: Array<{ index: number; name: string; role: number | null }>;
}
export interface ConvertedAutomation {
  key: 'channel' | 'direct';
  name: string;
  description: string;
  enabled: boolean;
  form: WorkflowForm;                     // for the preview UI
  config: AutomationGraph;                // compile(form)
}
export interface ConversionReport {
  converted:      ReportEntry[];  // setting key → what it became
  approximated:   ReportEntry[];  // converted, but not byte-identical behaviour
  notConvertible: ReportEntry[];  // honestly dropped, with the reason
  dropped:        ReportEntry[];  // deprecated keys, nothing to convert
}
export interface ReportEntry { key: string; label: string; detail: string; }
export function buildAutoAckAutomations(input): {
  automations: ConvertedAutomation[]; report: ConversionReport; blocking?: string;
}
```

### 4.1 Trigger params

Identical on both automations except `channels`:

```ts
{
  regex:           settings.regex,            // never blank — obligation 1
  cooldownSeconds: settings.cooldownSeconds,  // never 0-by-omission — obligation 2
  cooldownScope:   'node',                    // mandatory — AutoAck keys by fromNum
  channels:        <channel automation only>, // §4.2
}
```

`textContains` is never emitted (AutoAck has no such concept). `from` / `channel` /
`channelName` are never emitted.

### 4.2 Channel index → name (obligation 3)

For each index in `autoAckChannels`, look up the source's channel row:

- **Row missing** → `notConvertible` entry `channel-<i>-missing`; index dropped.
- **`role === 0`** (Disabled slot, per `isConfiguredChannel`) → `notConvertible`; dropped.
- **Name blank or whitespace-only** → `notConvertible` entry `channel-<i>-unnamed`,
  **with the loud detail**: *"`messageFilterChannelNames()` drops blank names, and
  if every entry is blank the whole filter falls away and the automation would
  answer on every channel."* Dropped.
- **Two indices resolving to the same name (case-insensitively)** → emit the name
  once, add an `approximated` entry `channel-name-collision` naming both indices:
  the converted rule answers on **both** slots.
- Otherwise emit `{ name: <exact db name>, protocol: 'meshtastic' }` — the exact
  shape `channelMulti` renders and `messageFilterChannelNames` reads.

**If the allowlist is non-empty but *every* entry was dropped**, the channel
automation is not emitted and `blocking: 'CHANNEL_ALLOWLIST_UNCONVERTIBLE'` is
returned — silently emitting a trigger with no `channels` would widen the rule to
every channel, a behaviour change dressed as a success.

**CORRECTION (orchestrator, 2026-07-28) — an EMPTY allowlist means NO channel
acks, not "all channels".** Found by WP2 during implementation and verified in
code: `meshtasticManager.ts:10071-10073` parses a blank `autoAckChannels` to `[]`,
and the gate at `:10096-10099` is

```ts
if (!isDirectMessage) {
  const enabledChannelsSet = new Set(enabledChannels);
  if (!enabledChannelsSet.has(channelIndex)) return;   // [] ⇒ every channel returns
}
```

So with an empty allowlist Auto-Acknowledge **never acks any channel message** —
the Channel cells are dead regardless of their toggles. Emitting a Channel
automation with no `channels` filter would therefore be the exact inverse of the
source behaviour and would answer on every channel on the mesh.

Required behaviour:

- `autoAckChannels` empty/absent → **do not emit the Channel automation at all**,
  regardless of which Channel cells are toggled on. Add a `notConvertible` report
  entry `channel-allowlist-empty` with the detail: *"Auto-Acknowledge's channel
  allowlist was empty, so it never acknowledged channel messages — only the Direct
  cells were live. No channel automation was created."*
- If that leaves **no** automations at all (empty allowlist AND no Direct cell with
  `reply || tapback`), return `blocking: 'NO_CELLS_ENABLED'`.
- This is distinct from `CHANNEL_ALLOWLIST_UNCONVERTIBLE`, which means "the user
  listed channels but none could be resolved" — a different situation the user
  must fix. An empty allowlist is a valid, working config that simply has no
  channel behaviour to convert, so it must not block a Direct-only conversion.

### 4.2a CORRECTION 2 (orchestrator, 2026-07-28) — unnamed channels must fall back to the index filter

Found during browser validation against a real source, and it invalidates §9.4's
"drop it and report" handling for the **most common configuration there is**.

Meshtastic's **primary channel (index 0, role 1) normally has a blank name.** On
the live test source, `getAllChannels` returns
`[{id:0, name:"", role:1}, {id:1, name:"meshmonitor", role:2}, …]`. So a config
that acks on the primary — the default setup, and precisely the #4340 reporter's
own scenario — resolves to zero usable names, returns
`blocking: 'CHANNEL_ALLOWLIST_UNCONVERTIBLE'`, and (per WP3's create handler,
which refuses the whole operation when `blocking` is set) **cannot be converted at
all.** A converter that cannot convert the default configuration is not shippable.

The escape hatch already exists and is fully editable in the builder: the message
trigger's **`channel`** param — "On channel #", `kind: 'number'`, `advanced: true`
in `catalog.ts:95` — enforced at `triggerContext.ts:381`
(`Number(msg.channel) !== Number(params.channel)`). Its own help text records the
precedence rule: *"Ignored when 'On channels' above is set."* So `channels` and
`channel` must never both be emitted.

Required behaviour, replacing the blank-name handling in §4.2:

1. Resolve every allowlisted index. Missing rows and `role === 0` slots are dropped
   with their existing report entries — unchanged.
2. **If at least one surviving channel has a usable name** → emit
   `channels: [names]` as today. Any surviving-but-unnamed index is dropped with a
   `notConvertible` entry `channel-<i>-unnamed`, noting this **narrows** behaviour
   (the automation will not answer there). Narrowing is the safe direction; do not
   silently widen.
3. **Else if exactly one index survives and it is unnamed** → emit
   `channel: <index>` and **omit `channels` entirely**. Add an `approximated`
   entry `channel-<i>-by-index`: *"Channel #\<i\> has no name, so the automation
   matches it by index instead. Index-based matching is per-radio — if you later
   add this automation to another source, check the channel order there."*
4. **Else** (nothing survives, or multiple survive and all are unnamed) →
   `blocking: 'CHANNEL_ALLOWLIST_UNCONVERTIBLE'` as today. Multiple unnamed
   channels genuinely cannot be expressed: `channel` takes a single index, and
   `channels` would take precedence over it.

Rule 3 is what makes the default primary-channel config convertible. Add tests for
each of the four branches, and one asserting `channels` and `channel` are never
both present on the same trigger.

### 4.3 The 2×2 → rules mapping

Every rule is `conditions[] → actions[]`, an AND-chain, in this fixed order. All
condition params use **string** values (`'0'`, `'1'`, `'complete, unknown'`) —
what the builder's `text` renderer round-trips and what `asNumber()` coerces.

**Shared prefix, repeated verbatim in every rule** (the form has no shared-prefix
concept; `compile()` fans the trigger out to independent rules):

| # | Block | Params | Emitted when |
|---|---|---|---|
| S1 | `condition.sourceFilter` | `{ sourceIds: [sourceId] }` | always — parity row 1 |
| S2 | `condition.string` | `{ field: 'node.completeness', op: 'in', value: 'complete, unknown' }` | `autoAckSkipIncompleteNodes` — parity row 8 |
| S3 | `condition.string` | `{ field: 'fromId', op: 'notIn', value: <normalised list> }` | normalised list non-empty — parity row 9 |

S3 normalisation reproduces `meshtasticManager.ts:10040-10043`: split on
`/[\s,]+/`, lowercase, strip a leading `!`, keep only `/^[0-9a-f]{8}$/`, re-emit as
`!xxxxxxxx`, join with `', '`. Tokens failing the hex test are **discarded and
reported** (`approximated`, `ignored-node-unparseable`) — AutoAck discards them
too, so this is fidelity, not loss. An empty result omits S3 entirely.

**Cell conditions:**

| # | Block | Params |
|---|---|---|
| C1 | `condition.numeric` | `{ field: 'isDM', op: '==', value: '0' }` (Channel) or `'1'` (Direct) |
| C2 | `condition.numeric` | `{ field: 'zeroHop', op: '==', value: '1' }` (ZeroHop) or `'0'` (MultiHop) |

**The four cells:**

| Cell | C1 `isDM` | C2 `zeroHop` | Reply text source | Rule emitted when |
|---|---|---|---|---|
| `channelZeroHop` | `== 0` | `== 1` | `messageDirect \|\| message` | `reply \|\| tapback` |
| `channelMultiHop` | `== 0` | `== 0` | `message` | `reply \|\| tapback` |
| `directZeroHop` | `== 1` | `== 1` | `messageDirect \|\| message` | `reply \|\| tapback` |
| `directMultiHop` | `== 1` | `== 0` | `message` | `reply \|\| tapback` |

`reply || tapback` mirrors AutoAck's own early-out (`:10195`): a cell with only
`replyDm` set does nothing and produces no rule. This is the "emit only the enabled
cells" decision, made mechanical.

### 4.4 Actions, in AutoAck's own execution order

| Order | Block | Params | Emitted when |
|---|---|---|---|
| A0 | `action.delay` | `{ seconds: preSendDelaySeconds }` | `preSendDelaySeconds > 0` |
| A1 | `action.tapback` | `{ emojiMode: 'hopCount' }` | `cell.tapback` |
| A2 | `action.sendMessage` | see below | `cell.reply` |

A2 params, derived from `resolveAutoAckReplyRouting()`:

```ts
{
  text: <token-translated template>,        // §4.5
  ...(replyViaDm ? { to: '{{ trigger.from }}' } : {}),
  ...(canThread  ? { replyToTrigger: true }  : {}),
}
```

where `replyViaDm = isDirectCell || cell.replyDm` and
`canThread = !(cell.replyDm && !isDirectCell)` — exactly
`resolveAutoAckReplyRouting`'s `replyId` clearing rule. `channels` is **omitted**
so the reply inherits the triggering channel. `sourceIds` is **omitted** on both A1
and A2 so they inherit the triggering source; S1 is what binds the automation to
the source. `maxAttempts` is **never emitted** — parity note 8: it is
`MessageQueueService.resolveDmMaxAttempts()`'s per-source queue setting, it keeps
governing this source's other queued DMs after conversion, and AutoAck's own
tapback and channel sends hardcode 1 anyway. It gets a `notConvertible` entry
saying so.

Exactly one rule can fire per event (the four cells are mutually exclusive on
`isDM` × `zeroHop`), so exactly one `action.delay` executes per message.

### 4.5 Token translation

| AutoAck | Engine | Bucket |
|---|---|---|
| `{NUMBER_HOPS}`, `{HOPS}` | `{{ trigger.hops }}` | `approximated` — the engine's `hops` is unfloored, so a hopless packet renders blank and a malformed one can render negative (Phase 1 close, deliberate) |
| `{NODE_ID}` | `{{ trigger.fromId }}` | `converted` |
| `{LONG_NAME}` | `{{ trigger.fromName }}` | `approximated` — degrades long → short → id |
| `{SNR}` / `{RSSI}` | `{{ trigger.snr }}` / `{{ trigger.rssi }}` | `approximated` — AutoAck substitutes the literal `N/A`; the engine renders blank |
| `{CHANNEL}` | `{{ trigger.channelName }}` | `approximated` — AutoAck emits `DM` on a direct message and the raw index when unnamed |
| `{DATE}`, `{TIME}` | `{{ NOW }}` | `approximated` — `{{ NOW }}` is *send* time in fixed `YYYY-MM-DD HH:MM:SS` (`interpolate.ts:29`), not rx time in the user's format |
| `{SHORT_NAME}`, `{RABBIT_HOPS}`, `{LAST_HOP}`, `{TRANSPORT}`, `{VERSION}`, `{DURATION}`, `{FEATURES}`, `{NODECOUNT}`, `{DIRECTCOUNT}`, `{IP}`, `{PORT}` | — | `notConvertible` — **left in the text verbatim** so the user can see and fix them, each named individually |

Only tokens actually present in the user's templates produce report entries.

### 4.6 Naming and discoverability

- One automation: `Auto-Ack — <Source Name>`
- Two: `Auto-Ack — <Source Name> (Channels)` and `Auto-Ack — <Source Name> (Direct messages)`

Description, first line, machine-readable and stable across renames:

```
Converted from Auto-Acknowledge (source <sourceId>) on <YYYY-MM-DD>.
```

followed by a human line listing the cells. `automations.name` has **no unique
constraint** on any backend (`src/db/schema/automations.ts:17/29/41`), so the name
is a label, not a key.

### 4.7 Idempotency / re-conversion

Detection: `listAutomations()` filtered on `description` starting with
`Converted from Auto-Acknowledge (source <sourceId>)`.

- `preview` always returns `existing: [{ id, name, updatedAt, enabled }]`.
- `create` with existing matches and **no** `replaceExisting` →
  `fail(res, 409, 'AUTOACK_ALREADY_CONVERTED', …, { existing })`. Nothing written.
- `create` with `replaceExisting: true` → `updateAutomation()` in place for a
  matched pair (matching on the `(channel|direct)` key in the description's cell
  line), `createAutomation()` for a newly-needed one, `deleteAutomation()` for a
  previously-converted one this run no longer needs. One `reloadAutomations()` at
  the end.
- A user who renamed or rewrote the description is treated as un-converted; the
  dialog says so and creates a second automation. Best-effort by design — silently
  overwriting a hand-edited automation is worse than a duplicate the user can
  delete.

## 5. API surface

New file `src/server/routes/autoAckConverterRoutes.ts`, mounted in
`src/server/server.ts` **immediately before** the existing `/automations` mount
(line 824), so `/:id` cannot swallow it:

```ts
apiRouter.use('/automations/convert', autoAckConverterRoutes);
```

Both handlers use `ok()` / `fail()` exclusively. Both take `sourceId` in the body.

### 5.1 Permissions

`automations` is a **global** resource; `automation` is a **per-source** resource
(`src/types/permission.ts:67-73`). Both matter, so both are checked:

```ts
const canPreview = [
  requirePermission('automations', 'read'),
  requirePermission('automation', 'read', { sourceIdFrom: 'body', requireSourceId: true }),
];
const canCreate = [
  requirePermission('automations', 'write'),
  requirePermission('automation', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
];
```

Additionally, `create` with `disableAutoAck: true` needs `settings:write` (what
`POST /api/settings` itself requires). Checked **in-handler, before any write**;
failure → `fail(res, 403, 'SETTINGS_WRITE_REQUIRED', 'Turning off
Auto-Acknowledge requires settings write permission — nothing was created.')`. The
whole operation is refused rather than half-applied.

### 5.2 `POST /api/automations/convert/preview`

Body: `{ sourceId }`. Writes nothing.

```jsonc
ok(res, {
  sourceId, sourceName,
  autoAckEnabled: true,
  automations: [ { key, name, description, enabled, config, form, ruleSummaries: [...] } ],
  report: { converted: [...], approximated: [...], notConvertible: [...], dropped: [...] },
  existing: [ { id, name, updatedAt, enabled } ],
  blocking: null            // or 'NO_CELLS_ENABLED' | 'CHANNEL_ALLOWLIST_UNCONVERTIBLE'
})
```

Errors: `404 SOURCE_NOT_FOUND`; `400 SOURCE_NOT_MESHTASTIC` when
`sourceProtocol(source.type) !== 'meshtastic'` (MeshCore is out of scope by the
epic — its Auto-Ack is a flat template with no Direct/Multi-hop split).

The handler **calls `validateAutomationGraph()` on every produced config** and
returns `500 CONVERTER_PRODUCED_INVALID_GRAPH` with the errors if it fails. A
converter that can emit an invalid graph should fail loudly in preview, not at
create.

### 5.3 `POST /api/automations/convert/create`

Body: `{ sourceId, enable? = true, disableAutoAck? = true, replaceExisting? = false }`.

Sequence — **re-runs the conversion server-side from current settings**; never
trusts a client-supplied graph:

1. Resolve + build + `validateAutomationGraph`. Failure → `400
   INVALID_AUTOMATION_CONFIG` with `details`.
2. Existing-marker check → `409 AUTOACK_ALREADY_CONVERTED` unless `replaceExisting`.
3. `settings:write` check when `disableAutoAck`.
4. `createAutomation` / `updateAutomation` / `deleteAutomation` per §4.7, with
   `createdByUserId: req.user?.id ?? null` and `enabled: !!enable`.
5. If `disableAutoAck`: `settings.setSourceSetting(sourceId, 'autoAckEnabled',
   'false')`. **Only that one key.** Every other AutoAck setting is left intact so
   the user can re-enable and get exactly their old config back.
6. `await reloadAutomations()`.
7. `ok(res, { created: [...], updated: [...], deleted: [...], autoAckDisabled, report })`.

Step 4 is not transactional across three repository calls. Ordering is chosen so
the failure mode is safe: automations are written **before** AutoAck is disabled,
so a crash between them leaves both mechanisms armed (double-ack, visible and
fixable) rather than neither (silent loss of a range-test responder). Document this
in the handler.

## 6. UI

### 6.1 The button — `src/components/AutoAcknowledgeSection.tsx`

One button in the section header row, beside the existing enable toggle: **"Convert
to an Automation…"**, `UiIcon` only (no literal emoji). Disabled with a tooltip
when `hasChanges` is true — converting with unsaved edits would convert the *saved*
config and confuse the user. Opens `AutoAckConvertDialog`.

### 6.2 `src/components/autoack/AutoAckConvertDialog.tsx` + `.module.css`

New CSS module (CLAUDE.md containment rule — nothing added to the frozen global
sheets). Three states:

1. **Loading** — POSTs `preview` on open via `useCsrfFetch`, `sourceId` from
   `useSource()`.
2. **Preview** —
   - One card per produced automation: name, and its rules rendered from `form` as
     readable English. Rendering from `form.rules` rather than raw nodes is why the
     builder returns `form` as well as `config`.
   - **Conversion report**, four labelled groups, `notConvertible` first and
     visually distinct. Every entry shows the setting key, a friendly label, and the
     reason. Empty groups hidden except `notConvertible`, which always renders.
   - `existing` banner when re-converting, with a "Replace them" checkbox setting
     `replaceExisting`.
   - Two checkboxes: **"Enable the new automation now"** (checked iff
     `autoAckEnabled`) and **"Turn off Auto-Acknowledge for this source"** —
     **checked by default**, per epic decision 8, with helper text: *"Your
     Auto-Acknowledge settings are kept — only the on/off switch is turned off, so
     you can switch back at any time."*
   - When two automations will be created, say so explicitly and why.
   - `blocking` renders as an error state with Convert disabled.
3. **Result** — created/updated/deleted names linking to `/automations`, plus a
   toast. On success call `onEnabledChange(false)` when `autoAckDisabled` so the
   parent's state matches the server without a refetch.

No raw `fetch()` (banned in `src/components/**`); `useCsrfFetch` throughout.

## 7. Test plan (mandatory — standard Vitest, no standalone scripts)

**`autoAckConverter.test.ts`** (pure, literals only, no DB):

- (a) All-off matrix → `automations: []`, `blocking: 'NO_CELLS_ENABLED'`.
- (b) Each of the four cells alone → one automation, one rule, correct
  `isDM`/`zeroHop`, correct action sequence.
- (c) A cell with `replyDm` only → no rule.
- (d) All four cells → **two** automations; the channel one has `channels`, the
  direct one does not.
- (e) Blank `autoAckRegex` → `regex === '^(test|ping)'` (obligation 1).
- (f) Blank `autoAckCooldownSeconds` → `60` and `cooldownScope === 'node'` (obligation 2).
- (g) Channel index→name: happy path, missing row, `role === 0`, blank name,
  duplicate names — each asserted for both the emitted `channels` array and its
  report entry (obligation 3).
- (h) Every allowlisted channel unconvertible → channel automation not emitted,
  `blocking: 'CHANNEL_ALLOWLIST_UNCONVERTIBLE'`.
- (i) `replyDm` matrix asserted **against `resolveAutoAckReplyRouting()` called with
  the same inputs**, so the two cannot drift.
- (j) Ignore-list normalisation: `!DEADBEEF, deadbee1 nothex` → `'!deadbeef,
  !deadbee1'` + one `approximated` entry; empty list → S3 omitted.
- (k) `skipIncompleteNodes` → S2 present with `op: 'in'`, `value: 'complete,
  unknown'`; off → absent.
- (l) Pre-send delay 0 → no `action.delay`; 45 → `action.delay` first in every rule.
- (m) Token translation table, one case per row of §4.5, including untranslatable
  tokens left verbatim.
- (n) `messageDirect` empty → ZeroHop rules use `message`.
- (o) Legacy fallback: matrix matches `computeMatrixValues()` on the same input,
  plus the `legacy-matrix-derived` entry.

**`autoAckConverter.roundTrip.test.ts`** — *the phase's exit criterion*. For each of
8 fixtures spanning 1..4 enabled cells × delay/no-delay × skipIncomplete/ignoreList:

1. `validateAutomationGraph(config).valid === true`;
2. `decompile(config)` is **not null** — with an assertion message naming
   `compile.ts:128` and stating that a null here means the automation opens in the
   raw-JSON editor, which is a failure not a partial success;
3. `decompile(compile(form))` deep-equals `form` modulo `clean()`;
4. every `condition.numeric` / `condition.string` `field` value is present in
   `numericFields('trigger.message')` / `stringFields('trigger.message')` — this is
   what stops a converter-written value from rendering blank in `fieldselect` and
   being clobbered on first edit (Phase 3 finding 4);
5. every emitted block `type` is a key of `BLOCK_BY_TYPE`, and every emitted param
   name is a `FieldDef.name` on that block.

**`autoAckConverter.report.test.ts`** — imports the same 33-key list the parity test
uses and asserts that for a *maximal* config every parity row with `status ===
'notConvertible'` appears by key in `report.notConvertible`, and every
`status === 'deprecated'` row appears in `report.dropped`. Specifically pins
`autoAckTestMessages` (reason: no server code reads it) and `autoAckMaxAttempts`
(queue-setting reason).

**`triggerContext.zeroHop.test.ts`** — `zeroHop` is 1 for `hopStart===hopLimit,
viaMqtt:false`; 0 for hops>0; 0 for hops===0 with `viaMqtt:true`; **1** for
`hopStart: null` (the obligation-4 case); 1 for malformed `hopStart < hopLimit`;
matches `autoAckIsZeroHop(flooredHops, viaMqtt)` across a table; never `NaN` after
`asNumber`. Plus the MeshCore builder case.

**`autoAckConverterRoutes.test.ts`** — `createRouteTestApp()`, per CLAUDE.md.
Covers: preview requires both `automations:read` and per-source `automation:read`
(403 when either is missing, including when granted on a *different* source);
create likewise for write; `disableAutoAck: true` without `settings:write` → 403 and
**no automation row created**; envelope shape on every branch; `409` and the
`replaceExisting` path; `400 SOURCE_NOT_MESHTASTIC`; preview writes nothing.

**`AutoAckConvertDialog.test.tsx`** — the disable checkbox is **checked on first
render**; unchecking sends `disableAutoAck: false`; the `notConvertible` group
renders every entry; `blocking` disables Convert.

**`AutoAcknowledgeSection`** — a focused test that the button renders and is disabled
while `hasChanges`. (The existing `AutoAcknowledgeSection.test.tsx` is
`describe.skip`'d; do not un-skip it — out of scope.)

Also required before PR: `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v
'.claude/worktrees'` empty, and the full Vitest suite green.

## 8. What does **not** change

- `checkAutoAcknowledge` and every other line of `meshtasticManager.ts`. The
  converter reads settings; it does not touch the AutoAck runtime.
- `meshcoreManager.ts` / the `meshcoreAutoAck*` namespace — out of scope.
- `deriveHops()` and the `hops` field. Phase 1 deliberately left `hops` unfloored;
  `zeroHop` is added *beside* it, so no existing `condition.numeric` on `hops`
  changes meaning.
- `isDM` / `viaMqtt` catalog entries — kept, still the documented way to hand-write
  these cells.
- `compile()` / `decompile()` — **no change**. A work package editing `compile.ts`
  has taken a wrong turn; see §9.1.
- `validateAutomationGraph` — no new per-block checks.
- `VALID_SETTINGS_KEYS`, `PER_SOURCE_SETTINGS_KEYS` — no new settings, so no
  migration and no `SettingsDraft` change.
- `automationRoutes.ts` — untouched.
- No new DB table, column, or migration.

## 9. Contradictions and findings against the brief

### 9.1 Obligation 4's *mechanism* is incompatible with the round-trip requirement

Phase 3's obligation 4 prescribes routing ZeroHop/MultiHop off a single
`condition.numeric hops > 0` node's true/false ports. The Phase 4 brief
independently requires a converted automation open in the builder.

`compile.ts:128`:

```ts
if ((e as any).port) return null; // condition-port branching → not the simple shape
```

`decompile()` returns `null` for **any** ported edge, and
`AutomationsPage.tsx:169-170` opens the raw-JSON editor when it is null. The two
requirements cannot both be met by a ported graph.

There is no port-free expression using only post-Phase-3 blocks: `numericCompare`
returns `false` whenever either operand is non-finite
(`conditionEvaluator.ts:20`), and `hops` is `undefined` → `NaN` when the packet
carries no `hopStart` — so *every* `condition.numeric` on `hops` is false for a
hopless packet, `== 0` and `> 0` alike. `condition.logical`'s `NOT` exists in the
evaluator but is **not in the builder's `CONDITIONS` catalog**. `condition.string`
on `hops` works at runtime but `hops` is not in `stringFields('trigger.message')`,
so `fieldselect` renders blank and clobbers it on first edit.

Rejected alternatives, for the record: extending `decompile()` to understand an
if/else shape (changes the builder's core form model in the epic's last phase);
shipping ported graphs and accepting the JSON editor (violates a hard
requirement); flooring `deriveHops()` (explicitly rejected in the Phase 1 close);
two rules OR-ed via the fanout (cannot cover the hopless ZeroHop case, and doubles
the rule count).

The resolution (§3.1) satisfies obligation 4's **behavioural** requirement exactly
while keeping the flat fanout shape. **Orchestrator signed off 2026-07-28.**

### 9.2 "One automation per source" is not always achievable

`messageMatchesFilter()` (`triggerContext.ts:365-372`) applies the `channels`
filter to **every** message, DMs included. AutoAck's channel allowlist gates
channel messages only; DMs bypass it entirely
(`meshtasticManager.ts:10085-10093`). A shared trigger would therefore silently
gate the Direct cells by channel name — a fidelity regression invisible until a DM
on an unlisted slot goes unanswered.

The only single-automation alternative is a per-rule `condition.string` on
`channelName`, which would need a new catalog entry *and* would break on any
channel name containing whitespace or a comma (the `in` operator splits on
`/[\s,]+/`). Worse trade than a second automation.

This is the same root cause the **Phase 1 close already recorded** when it shipped
the two-automation form for the #4340 recipe. **Orchestrator signed off
2026-07-28.** Mitigation: only-Channel or only-Direct configs still yield exactly
one automation, and the preview always states how many will be created and why.

### 9.3 The Direct-template selector does not follow the cell boundary

`meshtasticManager.ts:10256` selects the reply template on `hopsTraveled === 0`,
**not** on `isZeroHop`. So an MQTT-relayed 0-hop message falls into the *MultiHop*
cell for toggles but uses the *Direct* template for text. No engine expression
reproduces that split inside one rule. The converter uses `messageDirect` on
ZeroHop rules and `message` on MultiHop rules, and emits an `approximated` entry
naming the exact case.

### 9.4 A blank-named channel is genuinely inexpressible

`messageFilterChannelNames()` drops entries whose `name` is empty — and if *every*
entry drops, `messageMatchesFilter` falls through to **no channel constraint at
all**. Meshtastic's primary slot commonly has an empty name. Handled in §4.2 by
dropping the index with a loud report entry, and by refusing to emit a channel
automation whose whole allowlist dropped.

### 9.5 `autoAckMaxAttempts` is deliberately **not** emitted

Parity note 8 and the Phase 3 close establish that `checkAutoAcknowledge` never
reads it. Emitting it onto `action.sendMessage` would (a) not be parity, and (b)
change TX-disabled behaviour — a queued send records *queued*, not
`pushOrSkipTxDisabled`'s `{skipped}`. It gets a `notConvertible` entry explaining
that the setting survives conversion and keeps governing the source's other
automated DMs.

### 9.6 Smaller confirmations

- `viaMqtt` is a real boolean on the engine's message path (not the nullable DB
  value), so `viaMqtt == 0` does work for RF.
- `action.delay` blocks its own run (AutoAck's is a non-blocking `setTimeout`), but
  the cap is 300s and `resolveAutoAckPreSendDelaySeconds` already clamps to 120s,
  so no converter-side clamp is needed. Reported as `approximated`.
- The per-packet dedup guard, the TX-disabled skip, the airtime cutoff, and the
  local-node skip all have engine equivalents or need none. No converter work; a
  single informational report line.

## 10. Work packages

Sized for one Sonnet agent each. **Exclusive file ownership** — no file appears in
two packages.

### WP1 — the `zeroHop` field *(must land first; blocks WP2)*

**Owns:** `src/server/services/automation/triggerContext.ts`,
`src/components/automations/catalog.ts`,
`src/components/automations/SubstitutionsHelp.tsx`,
`src/server/services/automation/autoAckParity.test.ts`,
new `src/server/services/automation/triggerContext.zeroHop.test.ts`.

Deliver §3.1 exactly. Do not touch `deriveHops`. Do not remove `isDM`/`viaMqtt`
from the picker. Confirm `npm run lint:ci` holds the baseline.

### WP2 — the pure graph builder *(after WP1)*

**Owns:** new `src/server/services/automation/autoAckConverter.ts`,
`autoAckConverter.test.ts`, `autoAckConverter.roundTrip.test.ts`,
`autoAckConverter.report.test.ts`.

Deliver §4 and the first four test files of §7. **`compile()` is the only graph
emitter** — building `nodes`/`edges` by hand is an automatic reject. Reuse
`settingsToMatrix`, `AUTOACK_CELLS`, `resolveAutoAckReplyRouting`,
`isConfiguredChannel`.

### WP3 — settings resolution + routes *(after WP2)*

**Owns:** new `src/server/services/automation/autoAckConverterService.ts`, new
`src/server/routes/autoAckConverterRoutes.ts`, new
`src/server/routes/autoAckConverterRoutes.test.ts`, and **one line** in
`src/server/server.ts` (the mount).

Deliver §2 and §5. Use `ok`/`fail` on every branch. Use `createRouteTestApp()`.
Reuse `computeMatrixValues` from migration 093 rather than writing a second legacy
translator.

### WP4 — UI *(after WP3; may scaffold against the §5 contract)*

**Owns:** new `src/components/autoack/AutoAckConvertDialog.tsx`,
`AutoAckConvertDialog.module.css`, `AutoAckConvertDialog.test.tsx`, and
`src/components/AutoAcknowledgeSection.tsx`.

Deliver §6. CSS module only. `useCsrfFetch`, no raw `fetch`. `UiIcon`, no hardcoded
interface emoji (hop-count glyphs shown *inside a preview of message text* are
protocol/content emoji and are fine).

### WP5 — docs + epic close *(after WP3 and WP4)*

**Owns:** `docs/features/automation-engine.md`, `docs/features/auto-acknowledge.md`
(if present), `docs/internal/dev-notes/AUTOACK_PARITY_PHASE3_SPEC.md` (§2 footnote
updates for `zeroHop`), `docs/internal/dev-notes/AUTOACK_AUTOMATION_EPIC.md` (Phase
3 close table's `engine` column + the new Phase 4 close block, and the **epic-level
close** since this is the final phase).

The parity table's **33 keys must not change** — only the `engine` descriptions
gain `zeroHop`. All three copies (spec §2, epic close, `autoAckParity.test.ts`)
must agree; WP1 does the test file, WP5 does the two markdown copies.

**Ordering:** WP1 → WP2 → WP3 → WP4 → WP5.

## 11. Exit criteria

- Converting a real config produces automations whose rules reproduce its behaviour
  cell-for-cell.
- `decompile()` returns non-null for every produced graph, and opening one in the
  builder shows populated (not blank) field selectors.
- Preview shows the graph, the rules in English, and the full report before anything
  is written.
- The conversion report names `autoAckTestMessages`, `autoAckMaxAttempts`, every
  deprecated key, and every dropped channel/token — asserted by test against the
  parity table.
- Auto-Acknowledge is disabled for the source only after explicit confirmation, and
  only `autoAckEnabled` is touched.
- Browser-validated end to end; full Vitest suite green; `lint:ci` clean.
