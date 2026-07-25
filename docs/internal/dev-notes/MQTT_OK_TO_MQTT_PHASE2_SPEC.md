# MQTT `ok_to_mqtt` Violation Detection — Phase 2 Implementation Spec

**Epic:** `MQTT_OK_TO_MQTT_VIOLATIONS_EPIC.md` (issue #4114) · **Phase:** 2 of 3
**Branch:** `feature/mqtt-violation-badge` (worktree `../meshmonitor-mqtt-badge`, branched from
`origin/main` after Phase 1 merged)
**Depends on:** `MQTT_OK_TO_MQTT_PHASE1_SPEC.md` (merged — schema, detection, and the
`getGroupedPackets` aggregate are already in this tree)
**Written:** 2026-07-24

## Scope

Surface Phase 1's violation flag in the **existing** MQTT Packet Monitor UI. Two surfaces:

1. A violation **badge on grouped rows** in `MqttPacketMonitorView.tsx`.
2. A **violation row in the packet section** + a **per-gateway `ok_to_mqtt` column in the receptions
   table** of `MqttPacketDetailModal.tsx`, so a packet with N gateways names *which* gateway
   violated.

Plus the availability note required by the epic's cross-phase note 2 (§2(c) below).

**Explicitly out of scope** (considered and declined by the user): a "violations only" toolbar
filter; violation counts in the gateway multi-select. The searchable/analytical surface is Phase 3's
Reports view.

**Zero backend files change in this phase.** Phase 1's API surface is fixed and already carries
everything needed (proven in §1.3). If an implementer believes a backend change is required, STOP
and escalate — that would mean the phase boundary was drawn wrong.

---

## 1. Reuse inventory (MANDATORY — use or extend these; do NOT duplicate)

### 1.1 The badge system to reuse

| Symbol | Location | Notes |
|---|---|---|
| `outcomeBadgeClass(outcome)` | `src/components/MQTT/MqttPacketMonitorView.tsx:59-75` **and** `src/components/MQTT/MqttPacketDetailModal.tsx:28-44` | Already duplicated across the two files. **Do not touch it, do not refactor it, and do not add a third copy.** The new violation marker is a *separate* concern and gets one shared module (§1.6). |
| `.mqpm-badge` (base) | `src/components/MQTT/MqttPacketMonitor.css:203-211` | `inline-block`, `--radius-sm`, `--ctp-crust` bg, `--ctp-blue` fg, mono 12px. |
| `.mqpm-badge-encrypted` / `-ignored` / `-geo-ignored` / `-distance` / `-error` | `MqttPacketMonitor.css:214-237` | Colour variants, all `color: var(--ctp-X)` + `background: color-mix(in srgb, var(--ctp-X) 15%, transparent)`. **The violation badge is a sixth sibling in this family** (`.mqpm-badge-violation`, §3.4) — not a parallel system. |
| `ENCRYPTED_OUTCOME_BADGES` | `MqttPacketMonitorView.tsx:57`, `MqttPacketDetailModal.tsx:26` | Unchanged. |
| `renderType(p)` | `MqttPacketMonitorView.tsx:280-285` | The only badge-rendering cell in the grouped table (rendered at `:487`). Extended in §3.3. |
| `Row` (label/value dl row) | `MqttPacketDetailModal.tsx:46-51` | Reuse verbatim for the new packet-section row. |
| `.mqpm-recv-table` th/td | `MqttPacketMonitor.css:421-441` | The receptions table gets one more column; no new table styling needed. |
| `.mqpm-disabled-banner` | `MqttPacketMonitor.css:79-92`, rendered at `MqttPacketMonitorView.tsx:324-335` | The capture-off banner. Extended in §3.3. |
| `.mqpm-empty` | rendered at `MqttPacketMonitorView.tsx:448-453` | The empty state, with its existing `enabled`/`!enabled` branch. Extended in §3.3. |
| `.mqpm-decode-note` | `MqttPacketMonitor.css:443-450` | Yellow inline note box. Not used by this phase (the availability note is subtler — §2(c)) but listed so nobody reinvents it. |

### 1.2 Frontend view-model mirrors — `src/components/MQTT/mqttPacketTypes.ts`

The file is a hand-maintained mirror of the server repository types; its own header says "Keep these
structurally identical to the repo interfaces".

| Frontend type | Location | Server counterpart | Drift introduced by Phase 1 |
|---|---|---|---|
| `MqttGroupedPacket` | `mqttPacketTypes.ts:22-40` (18 fields) | `src/db/repositories/mqttPacketLog.ts:70-90` (20 fields) | **Missing `bitfield` (`:84`) and `okToMqttViolation` (`:85`).** |
| `MqttGateway` | `mqttPacketTypes.ts:42-47` | `mqttPacketLog.ts:92-97` | in sync — no change. |
| `MqttReception` | `mqttPacketTypes.ts:50-59` (8 fields) | subset of `DbMqttPacket`, `mqttPacketLog.ts:24-56` | **Missing `bitfield` (`:50`) and `okToMqttViolation` (`:52`).** `topic` (`:54`) is also returned but is deliberately NOT added — see below. |

**Exactly four field additions are required** (§3.1). `topic` is available on every reception row
(the bare `.select()` returns it) but is **not** added or rendered in this phase: it is the
analytical/diagnostic surface, which belongs to Phase 3's report. Adding an unrendered field to a
hand-maintained mirror is dead weight.

### 1.3 The data path — proof that no backend change is needed

- `getGroupedPackets` projects `bitfield: MAX(...)` and `okToMqttViolation: MAX(...)`
  (`src/db/repositories/mqttPacketLog.ts:165-166`).
- The list route returns them untouched: `ok(res, { packets, total, offset, limit, enabled,
  maxCount, maxAgeHours })` — `src/server/routes/mqttPacketRoutes.ts:97`, where `packets` is the
  `getGroupedPackets` result verbatim.
- `getReceptions` is a bare `.select()` (`mqttPacketLog.ts:200-214`), and
  `mqttPacketLogService.getReceptions` (`src/server/services/mqttPacketLogService.ts:222-224`) is a
  pure pass-through; the route returns `ok(res, { receptions })`
  (`mqttPacketRoutes.ts:146`). **All three new columns already reach the browser.**
- The view unwraps the envelope at `MqttPacketMonitorView.tsx:170` (`body.data ?? body`); the modal
  at `MqttPacketDetailModal.tsx:87`. Unchanged.

**Conclusion: `okToMqttViolation` reaches the frontend today and is silently discarded only because
the TypeScript mirror does not declare it.** Confirm this in the browser during §5 step 5.

### 1.4 Icons — `UiIcon` (`src/components/icons/UiIcon.tsx`, barrel `src/components/icons/index.ts`)

CLAUDE.md: *"App-owned interface icons use `UiIcon`. Do not hardcode emoji or Unicode icon stand-ins
in JSX or locale UI copy."* This is enforced twice: by the `no-hardcoded-ui-glyph` ESLint rule and by
`scripts/check-ui-locale-glyphs.mjs`, which runs as the **first step of `npm run lint:ci`**
(`package.json:17`). A ⚠️ in a locale string fails CI.

Registry: `UI_ICON_DEFINITIONS`, `UiIcon.tsx:130-248`. Relevant candidates:

| Name | Lucide | Emoji | Declared usage |
|---|---|---|---|
| `alert` (`:136`) | `AlertTriangle` | ⚠️ | "warnings and security risks" |
| `securityAlert` (`:216`) | `ShieldAlert` | ⚠️ | "security alerts" |
| `blocked` (`:144`) | `Ban` | 🚫 | "ignored and blocked state" |
| `help` (`:171`) | `CircleHelp` | ❓ | "help and unknown state" |

**Decision: `alert`.** An `ok_to_mqtt` violation is a policy/privacy warning about a third party's
behaviour, not a MeshMonitor security incident (`securityAlert`) and not a blocked-state marker
(`blocked`). `alert`'s declared usage — "warnings and security risks" — is the exact fit, and its
emoji fallback (⚠️) reads correctly for emoji-mode users.

A **text-only badge would also be defensible**, but is rejected: the badge sits inside a table cell
next to a same-family badge, so the icon is what makes it scannable at a glance. The icon is
`aria-hidden` (automatic when no `title` prop is passed to `UiIcon` — `UiIcon.tsx:283, 312`) and is
**additive** to a visible text label, never a replacement (§2(f)).

`UiIcon` is imported from the barrel: `import { UiIcon } from '../icons';`.

`BrandIcon` is not applicable — there is no Simple Icons brand mark involved.

### 1.5 i18n — flat dotted keys, `public/locales/en.json` only

- The namespace is **flat dotted keys**, not nested objects: `"mqtt.packets.title": "Packet Monitor"`.
- The existing `mqtt.packets.*` block is **`public/locales/en.json:4443-4480` — 38 contiguous keys**.
- **Verified: every other locale has zero `mqtt.packets.*` keys** (`de, es, fr, nb_NO, pl, pt_BR, ru,
  sv, zh_Hans` — all `grep -c` = 0). They rely entirely on the inline English default passed as the
  second argument to `t()`.
- **Follow that pattern:** append new keys to the `en.json` block only, and always pass the same
  English string as the inline default at the call site. **Do not touch any other locale file.**
- Reusable `common.*` keys already present: `common.yes` (`:189`), `common.no` (`:190`),
  `common.all` (`:191`), `common.none` (`:192`), `common.broadcast` (`:193`), `common.unknown`
  (`:241`), `common.close` (`:157`), `common.loading` (`:158`). `common.unknown` is
  **deliberately not reused** for the unknown `ok_to_mqtt` state — that state needs a lowercase
  badge-family word plus its own explanatory `title`, so it gets a namespaced key (§3.5).

### 1.6 The one genuinely new thing, and why it is not duplication

Three call sites need the same marker: the grouped row's Type cell, the modal's packet section, and
the modal's per-gateway cell. `outcomeBadgeClass` is already copy-pasted into two files; **do not
repeat that mistake.** Two small new files:

- `src/components/MQTT/okToMqttState.ts` — the pure derivation (no JSX).
- `src/components/MQTT/MqttOkToMqttMarker.tsx` — the presentational component (JSX only).

They are split so that the module exporting the component exports *only* components —
`react-refresh/only-export-components` is enabled (`eslint.config.mjs:64-67`) and a mixed module
would need an `eslint-disable`, exactly as `UiIcon.tsx:129` was forced to do.

### 1.7 Tests to extend (do NOT create parallel files)

| File | Lines | What to extend |
|---|---|---|
| `src/components/MQTT/MqttPacketMonitorView.test.tsx` | 333 | `basePacket` fixture at `:45-64` gains the new fields; new cases per §4.2. Existing `react-i18next` mock at `:14-19` returns the inline English default verbatim — assert against those strings. |
| `src/components/MQTT/MqttPacketDetailModal.test.tsx` | 225 | `basePacket` at `:30-49` and `baseReception` at `:51-61` gain the new fields; new cases per §4.3. |
| `src/components/MQTT/okToMqttState.test.ts` | — | **New file** — a new module with no existing test. Not a parallel file. |

### 1.8 Fetching — leave it exactly as it is

`MqttPacketMonitorView.tsx:79` uses `useCsrfFetch()`; the modal receives it as a prop
(`MqttPacketDetailModal.tsx:19`). **Do not migrate either to `ApiService` in this phase** — it is
unrelated churn in a UI phase and would need its own regression pass.

**Correction to the epic plan:** the epic describes `MqttPacketMonitorView.tsx`'s `useCsrfFetch` as
"a baselined legacy site". It is not baselined at all — `eslint-baseline.json` contains **no entry**
for `MqttPacketMonitorView.tsx` or `MqttPacketDetailModal.tsx` (the only `src/components/MQTT/`
entries are `MqttBridgeConfigurationView.tsx` and `mqttBridgeConfig.ts`, `eslint-baseline.json:127`
and `:130`). The raw-`fetch` ban targets `CallExpression[callee.name='fetch']`
(`eslint.config.mjs:161`); `csrfFetch(...)` is a different callee, so it never was a violation.

**Consequence, and it is the strict reading:** both files you are editing are **zero-violation
files**. Any new `@typescript-eslint/no-explicit-any` or `react-hooks/exhaustive-deps` violation
fails `lint:ci` immediately — there is no baseline headroom. Note the existing test files cast with
`csrfFetch as any`; that is fine, `**/*.test.tsx` is exempt from the type-aware rules that matter
here and those casts are pre-existing.

Do **not** introduce a raw `fetch()` into any new file under `src/components/**`.

---

## 2. Design decisions (settled — implementers do not re-decide)

### 2(a) Grouped-row badge: semantics and placement

**What the flag means.** `getGroupedPackets` groups by
`(sourceId, fromNode, COALESCE(NULLIF(packetId,0), -id))` and projects
`okToMqttViolation: MAX(...)` (`mqttPacketLog.ts:166`). A `1` therefore means **"at least one of
this packet's gateways violated the bit"** — not "all did", and it does not say *which*. The badge's
`title` must carry that exact semantic, and must tell the user where to find the attribution.

**Decision: render the badge inside the existing Type cell, appended after the portnum/outcome
badge.** Rationale:

1. The Type cell (`renderType`, `MqttPacketMonitorView.tsx:280-285`, rendered at `:487`) is the only
   cell with badge-rendering precedent and the only place `.mqpm-badge` is already used in the list.
   Putting the sixth badge variant anywhere else splits the badge family across two layout idioms.
2. A **dedicated column** was the alternative and is rejected: the table already has 8 columns
   (`:458-471`); a 9th that is empty on ~100% of rows for ~100% of installs is pure cost, and it
   would need its own header string, its own `title`, and mobile-width consideration.
3. A third option — attaching it to the **Gateways** count cell (`:489-496`), which is arguably where
   the semantic lives — is rejected because that cell is a right-aligned `mqpm-mono` numeric with an
   already-composed conditional `title`; mixing a badge in breaks the numeric column and turns the
   tooltip into a run-on.

**Tooltip (packet scope), verbatim:**

> At least one gateway relayed this packet to MQTT although the sender did not opt in (ok_to_mqtt =
> 0). Open the packet to see which gateway.

The second sentence is load-bearing: it converts the badge from a dead end into a pointer, which is
the entire reason the modal work is in the same phase. The row is already clickable with
`title={t('mqtt.packets.clickToView', …)}` at `:482` — note that the `<td>`'s badge `title` wins over
the `<tr>`'s on hover, which is the desired behaviour here.

**Reachability confirmed:** see §1.3. The flag is already in the JSON response; only the TS mirror
(§3.1) blocks it.

### 2(b) Per-gateway attribution and the tri-state

Phase 1 stores the raw `bitfield` (NULL = unreadable) plus the derived 0/1 `okToMqttViolation`, both
per reception row, and both already returned by `getReceptions`. The state is therefore fully
reconstructible client-side — and it is a **four**-state, not a tri-state, once you account for the
server-side `relayed`/`selfGateway` guard:

```ts
okToMqttViolation === 1              -> 'violation'   // confirmed: server applied the full predicate
bitfield == null                     -> 'unknown'     // bit could not be read (absent, or undecryptable)
(bitfield & 1) === 1                 -> 'ok'          // sender opted in; relaying is permitted
otherwise (bit clear, not flagged)   -> 'self'        // sender opted out, but no third party relayed it
```

The fourth state falls out of Phase 1 §2(f) cases 2/4/15: the bit is explicitly 0 yet the server did
not flag it, which can only mean `gatewayNodeNum === fromNode` (the originator publishing its own
packet — never a violation) or the `selfGateway` guard fired. **Do not try to recompute `relayed`
client-side from `fromNode`/`gatewayNodeNum`** — the browser does not know `localGatewayNodeNum` and
would re-derive the predicate incorrectly. Trust the server's flag; use `bitfield` only to
distinguish the three *non*-violating states.

**Surfacing decision — the noise problem.** "Unknown" is the majority state on any mesh with
encrypted channels MeshMonitor has no PSK for. Rendering it as a badge would turn the receptions
table into a wall of markers and devalue the real one. So:

- **`violation` is the only state rendered as a badge** — coloured, iconned, in the `.mqpm-badge`
  family.
- **`ok` / `self` / `unknown` render as plain low-emphasis mono text** (`allowed` / `opted out` /
  `unknown`) with their own `title`. No icon, no badge chrome, no border.
- The **grouped row** renders the marker **only** when the state is `violation`; the other three
  states render nothing at all there. The list must stay scannable; the full four-state readout is
  the modal's job.
- The **modal** renders the marker in all four states, in both places, because the modal is where the
  user went specifically to understand this packet.

This answers "whether to surface unknown at all": yes, but only in the modal, and only as quiet text.

**Column placement:** the new `ok_to_mqtt` column is appended as the **last** column of the receptions
table (after `Hops`), keeping the four existing numeric columns (`Rx time`, `RSSI`, `SNR`, `Hops`)
adjacent.

**Packet-section row placement:** immediately **after** the `Encrypted` row
(`MqttPacketDetailModal.tsx:144`). The two are causally linked — an encrypted packet MeshMonitor
could not decrypt is exactly why `ok_to_mqtt` reads `unknown` — so they belong side by side.

### 2(c) The empty-state / availability problem — THE MOST IMPORTANT DECISION IN THIS PHASE

**The asymmetry** (epic cross-phase note 2, Phase 1 spec §2(g)):

| Surface | Reads | Gate | Default install |
|---|---|---|---|
| Phase 3 Reports view | `mqtt_ok_to_mqtt_violations` | `mqtt_oktomqtt_violation_log_enabled` — **default ON** | works |
| **This phase's badge** | `mqtt_packet_log` via `getGroupedPackets` | `mqtt_packet_log_enabled` — **default OFF** | **badge never appears** |

So on a default install, violations are being recorded right now and the Packet Monitor shows
nothing. A user must never read "no badge" as "no violations".

**Decision: one new sentence, rendered in both existing capture-off surfaces, and nowhere else.**

Verbatim (key `mqtt.packets.violationsStillRecorded`):

> ok_to_mqtt violation detection keeps running while capture is off — turning capture on only makes
> the per-packet violation badge visible here.

Rendered in:
1. The existing **capture-disabled banner** (`MqttPacketMonitorView.tsx:324-335`), appended to the
   existing sentence inside the same `<span>`, in `--ctp-subtext0`.
2. The existing **`!enabled` empty state** (`:448-453`), as a second line under
   `mqtt.packets.emptyDisabled`.

Both already branch on `enabled`, which the view reads from the list response at `:173`. **No new
state, no new fetch, no new endpoint.**

**Deliberately NOT done, and why:**

- **Do not name the Reports view.** It does not exist until Phase 3 merges. Shipping a pointer to a
  nonexistent screen is a worse bug than the one it fixes. The sentence above is true and useful on
  its own. **Phase 3 follow-up (record this in the epic's Phase 3 deliverables):** once the report
  ships, extend this key to end with "…they are listed in Reports → ok_to_mqtt violations." That is a
  one-line locale edit plus the two inline defaults.
- **Do not add a note to the `enabled` empty state.** "No packets captured yet. Waiting for MQTT
  traffic…" is accurate; a violation caveat there is noise.
- **Do not add a settings toggle for any of Phase 1's three keys.** Beyond being out of scope, the
  epic's cross-phase note 4 is a live trap: `server.settings-persistence.test.ts:405-432` holds a
  local allowlist that guards exactly the keys `SettingsTab` sends, and adding a `SettingsTab` field
  for `mqtt_oktomqtt_violation_log_enabled` / `_retention_days` / the third key fails that test
  unless the key is also loaded by `SettingsContext` or added to that allowlist. **This phase adds no
  `SettingsTab` field and no new `VALID_SETTINGS_KEYS` entry**, so no edit to that test is required.
  The capture toggle this phase renders is the *pre-existing* `mqtt_packet_log_enabled` control at
  `MqttPacketMonitorView.tsx:235-239` / `:411-414`, which is not a `SettingsTab` field.

### 2(d) Forward-only / no-backfill visibility

Pre-Phase-1 rows have `bitfield = NULL` and `okToMqttViolation = 0` (the column default), so they
render as `unknown` — indistinguishable from a genuinely undecryptable reception.

**Decision: no dedicated UI. §2(b)'s handling makes it a non-issue, with one word of insurance in
the `unknown` tooltip.**

Justification:

1. It is *honest*. For those rows the bit genuinely is unknown; the display is not lying.
2. `unknown` is quiet text, not an alarm, so a transitional population of them costs nothing.
3. The population self-clears: `mqtt_packet_log` retention defaults to 24 h
   (`maxAgeHours`, `MqttPacketMonitorView.tsx:175`), and capture is off by default anyway — so on
   most installs there is no pre-migration population at all.
4. Anything more precise would need the migration timestamp, which the frontend has no access to.
   Getting it would require a backend change, which this phase forbids.

The insurance: the `unknown` tooltip names both causes explicitly —

> The ok_to_mqtt bit could not be read for this reception — the payload was not decryptable, or the
> packet was captured before violation detection was added.

That single clause discharges the whole no-backfill concern at zero UI cost.

### 2(e) Styling: extend `MqttPacketMonitor.css`, do not add a CSS module

**Decision: add the new rules to `src/components/MQTT/MqttPacketMonitor.css`, alongside the five
existing `.mqpm-badge-*` siblings.**

Justification against CLAUDE.md's actual wording — *"New components style with CSS modules
(`Component.module.css`) scoped to that component, not the global sheets. The legacy global sheets
(`src/styles/nodes.css` and siblings) are frozen"*:

1. **`MqttPacketMonitor.css` is not one of the frozen sheets.** The rule names `src/styles/nodes.css`
   *and its siblings* — i.e. the sheets under `src/styles/`. `MqttPacketMonitor.css` lives
   **co-located in `src/components/MQTT/`**, is imported by exactly one component
   (`MqttPacketMonitorView.tsx:32`), and is namespaced `mqpm-*` precisely so it stays decoupled
   (see the file's own header comment at `:1-3`). It is already a component-scoped sheet in
   everything but the `.module.css` file extension.
2. **This phase is not adding a new independent component's styling — it is adding a sixth variant to
   an existing badge family.** A module cannot extend `.mqpm-badge` without either duplicating the
   base rule or `composes:`-ing from a global, and CSS Modules `composes: … from global` is not used
   anywhere in this codebase. Either route reintroduces the duplication the rule exists to prevent,
   and the requirement that "the badge must look like it belongs to the existing badge family" would
   then depend on two rules staying in sync by hand.
3. **The policy is aspirational, not established.** The entire tree contains exactly **one**
   `*.module.css`: `src/components/map/layers/AtakContactsLayer.module.css`. CLAUDE.md itself hedges
   with "additions are discouraged … extend a CSS module instead **where practical**". Introducing
   the codebase's second module to hold four colour rules that must visually match five rules in
   another file is not the practical case.
4. The hard ordering hazard CLAUDE.md warns about applies to `src/styles/nodes.css` specifically
   (mobile `@media` shadowed by a later base rule). `MqttPacketMonitor.css` has no such structure;
   the only ordering requirement here is trivially satisfied by appending after `.mqpm-badge-error`
   (`:237`) so the variant follows its base.

If a reviewer disagrees, the fallback is *not* a module — it is to leave the CSS exactly where §3.4
puts it and open a follow-up to modularise the whole `mqpm-*` sheet at once. Do not half-migrate.

### 2(f) Accessibility and colour

The badge conveys a warning; it must never depend on colour.

1. **Visible text label, always.** The badge renders the word `violation` next to the icon. Colour and
   icon are both redundant reinforcement. A screen reader reads "violation" from the badge itself.
2. **`UiIcon` is decorative.** Pass `name` and `size` but **no `title`** — `UiIcon` then sets
   `aria-hidden` automatically (`UiIcon.tsx:283` emoji branch, `:312` lucide branch). Do not give the
   icon its own label; that would double-announce.
3. **`title` for the explanation, and a keyboard-reachable equivalent.** The full semantic ("at least
   one gateway…") lives in the `title` attribute for mouse users. Because `title` is not reliably
   keyboard- or SR-accessible, the *same* information is rendered as **plain text content** in the
   modal — the `ok_to_mqtt` packet row plus the per-gateway column — which is reachable by clicking
   or keyboard-activating the row. **Do not add an `aria-label` to the badge span**: it would
   override the visible "violation" text with a long sentence and desynchronise what sighted and
   unsighted users hear. The modal is the accessible path, and the badge's `title` says so.
4. **Colour tokens: `var(--ctp-*)` only, no hex.** All five sibling variants use them and the palette
   is redefined per theme in `src/App.css` (Latte/Frappé/Macchiato/Mocha/Nord all define
   `--ctp-red`, `--ctp-green`, `--ctp-subtext0`, `--ctp-overlay0`).
   - `violation` → `--ctp-red` (the most severe hue in the family).
   - It shares that hue with `.mqpm-badge-error`, so it is differentiated **structurally**: a
     `1px` border at 45% and a 18% (not 15%) fill, plus the icon and the different word. Introducing
     a sixth hue purely to avoid a collision would weaken the "red = worst" reading.
   - `ok` → `--ctp-green`; `self` → `--ctp-subtext0`; `unknown` → `--ctp-overlay0` (the dimmest, so
     the majority state recedes).
5. No emoji or Unicode icon stand-ins in JSX or in any locale string — enforced by
   `scripts/check-ui-locale-glyphs.mjs` in `lint:ci`. The `—` em-dash already used throughout these
   components (e.g. `MqttPacketDetailModal.tsx:137`) is a text placeholder, not an icon glyph, and is
   unaffected; this phase does not add any new one.

---

## 3. File-by-file changes

**Nine files. Zero backend files. Zero migrations. Zero new settings keys.**

### 3.1 `src/components/MQTT/mqttPacketTypes.ts` — **EDIT**

Add two fields to each of two interfaces, mirroring the server exactly.

In `MqttGroupedPacket` (`:22-40`), insert after `payloadPreview` (`:35`) so field order matches
`mqttPacketLog.ts:83-85`:

```ts
  /** Raw `Data.bitfield` (protobuf field 9), MAX across the packet's gateway
   *  receptions — exact, since the field is the originator's (#4114). NULL =
   *  unreadable on every copy = ok_to_mqtt unknown. */
  bitfield: number | null;
  /** MAX(okToMqttViolation) — 1 means AT LEAST ONE gateway violated the bit for
   *  this packet, not that all did, and not which one (#4114). */
  okToMqttViolation: number;
```

In `MqttReception` (`:50-59`), append after `hopStart` (`:58`):

```ts
  /** Raw `Data.bitfield` for this reception. NULL = ok_to_mqtt unknown (#4114). */
  bitfield?: number | null;
  /** 0 | 1 — server-computed, with the relayed/self-gateway guard already applied.
   *  Never recompute this client-side (#4114, Phase 1 spec §2(f)). */
  okToMqttViolation: number;
```

`topic` is intentionally omitted — see §1.2.

### 3.2 `src/components/MQTT/okToMqttState.ts` — **NEW**

```ts
/**
 * Client-side reconstruction of the `ok_to_mqtt` state for one MQTT packet-log
 * row (#4114 Phase 2).
 *
 * Phase 1 stores the raw `Data.bitfield` (NULL = unreadable) plus a derived 0/1
 * `okToMqttViolation` that already has the relayed / self-gateway predicate
 * applied server-side (MQTT_OK_TO_MQTT_PHASE1_SPEC.md §2(f)). The browser does
 * NOT know `localGatewayNodeNum` and must never re-derive that predicate — it
 * trusts the flag and uses `bitfield` only to tell the three non-violating
 * states apart.
 *
 * See MQTT_OK_TO_MQTT_PHASE2_SPEC.md §2(b).
 */

export type OkToMqttState =
  /** Confirmed: a gateway other than the originator relayed a packet whose bit was explicitly 0. */
  | 'violation'
  /** The originator set ok_to_mqtt; relaying is permitted. */
  | 'ok'
  /** Bit explicitly 0 but no violation recorded — the originator published its own packet. */
  | 'self'
  /** The bit could not be read: absent, undecryptable, or captured before detection existed. */
  | 'unknown';

export interface OkToMqttFields {
  okToMqttViolation?: number | null;
  bitfield?: number | null;
}

export function okToMqttState(row: OkToMqttFields): OkToMqttState {
  if (Number(row.okToMqttViolation ?? 0) === 1) return 'violation';
  if (row.bitfield === null || row.bitfield === undefined) return 'unknown';
  return (Number(row.bitfield) & 1) === 1 ? 'ok' : 'self';
}
```

Notes for the implementer: `Number()` coercion is required because PostgreSQL/MySQL return BIGINT
columns as strings through the driver (same reason Phase 1 normalises); `?? 0` makes the function
safe against a server that predates Phase 1. No `any`.

### 3.3 `src/components/MQTT/MqttOkToMqttMarker.tsx` — **NEW**

```tsx
/**
 * MqttOkToMqttMarker — renders one `ok_to_mqtt` state (#4114 Phase 2).
 *
 * Only `violation` is a badge, and it is a sixth member of the existing
 * `.mqpm-badge` family in MqttPacketMonitor.css — not a parallel system. The
 * three non-violating states render as quiet mono text so that `unknown` (the
 * majority state on encrypted channels) never reads as an alert.
 *
 * `scope` only changes the tooltip: on a grouped row the flag is
 * MAX(okToMqttViolation) across the packet's gateways ("at least one"), while in
 * the receptions table it is that one gateway's own flag.
 *
 * See MQTT_OK_TO_MQTT_PHASE2_SPEC.md §2(a), §2(b), §2(f).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import type { OkToMqttState } from './okToMqttState';

interface Props {
  state: OkToMqttState;
  /** 'packet' = aggregated over the packet's gateways; 'gateway' = one reception. */
  scope: 'packet' | 'gateway';
}

export const MqttOkToMqttMarker: React.FC<Props> = ({ state, scope }) => {
  const { t } = useTranslation();

  if (state === 'violation') {
    return (
      <span
        className="mqpm-badge mqpm-badge-violation"
        title={scope === 'packet'
          ? t('mqtt.packets.violationPacketTitle', 'At least one gateway relayed this packet to MQTT although the sender did not opt in (ok_to_mqtt = 0). Open the packet to see which gateway.')
          : t('mqtt.packets.violationGatewayTitle', 'This gateway relayed the packet to MQTT although the sender did not opt in (ok_to_mqtt = 0).')}
      >
        <UiIcon name="alert" size={12} />
        {t('mqtt.packets.violationBadge', 'violation')}
      </span>
    );
  }

  if (state === 'ok') {
    return (
      <span
        className="mqpm-oktomqtt mqpm-oktomqtt-ok"
        title={t('mqtt.packets.okToMqttAllowedTitle', 'The sender set ok_to_mqtt, so relaying this packet to MQTT is permitted.')}
      >
        {t('mqtt.packets.okToMqttAllowed', 'allowed')}
      </span>
    );
  }

  if (state === 'self') {
    return (
      <span
        className="mqpm-oktomqtt mqpm-oktomqtt-self"
        title={t('mqtt.packets.okToMqttSelfTitle', 'The sender cleared ok_to_mqtt, but no other node was seen relaying this packet, so this is not a violation.')}
      >
        {t('mqtt.packets.okToMqttSelf', 'opted out')}
      </span>
    );
  }

  return (
    <span
      className="mqpm-oktomqtt mqpm-oktomqtt-unknown"
      title={t('mqtt.packets.okToMqttUnknownTitle', 'The ok_to_mqtt bit could not be read for this reception — the payload was not decryptable, or the packet was captured before violation detection was added.')}
    >
      {t('mqtt.packets.okToMqttUnknown', 'unknown')}
    </span>
  );
};

export default MqttOkToMqttMarker;
```

`if`-chain rather than `switch` so TypeScript narrows the final branch to `'unknown'` without a
`default` that could hide a future state. Exports only components → `react-refresh` clean.

### 3.4 `src/components/MQTT/MqttPacketMonitor.css` — **EDIT (append)**

Insert **immediately after `.mqpm-badge-error` (`:234-237`)**, so the new variant follows its base
rule `.mqpm-badge` (`:203-211`) and the cascade is unambiguous:

```css
/* ok_to_mqtt violation (#4114). Sixth member of the badge family above. Shares
   --ctp-red with .mqpm-badge-error deliberately (red = worst); differentiated
   structurally by the border + the alert icon + the word, never by hue alone. */
.mqpm-badge-violation {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ctp-red);
  background: color-mix(in srgb, var(--ctp-red) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--ctp-red) 45%, transparent);
}

/* Non-violating ok_to_mqtt states: quiet mono text, deliberately NOT badges, so
   that `unknown` — the majority state on channels with no PSK — never reads as
   an alert. See MQTT_OK_TO_MQTT_PHASE2_SPEC.md §2(b). */
.mqpm-oktomqtt {
  font-family: var(--font-mono);
  font-size: 12px;
}

.mqpm-oktomqtt-ok {
  color: var(--ctp-green);
}

.mqpm-oktomqtt-self {
  color: var(--ctp-subtext0);
}

.mqpm-oktomqtt-unknown {
  color: var(--ctp-overlay0);
}

/* The Type cell can now hold the portnum/outcome badge plus the violation badge. */
.mqpm-type-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
```

And append at the end of the file (or beside `.mqpm-disabled-banner` at `:79-92`, implementer's
choice — no cascade interaction either way):

```css
/* Capture-off availability note (#4114 Phase 2 §2(c)) — violation detection is
   independent of the packet-log opt-in, so "no badge" must not read as
   "no violations". */
.mqpm-banner-note {
  color: var(--ctp-subtext0);
}

.mqpm-empty-note {
  margin-top: 8px;
  font-size: 12px;
  color: var(--ctp-subtext0);
}
```

No hex colours. No changes to any sheet under `src/styles/`.

### 3.5 `public/locales/en.json` — **EDIT (11 new keys)**

Append immediately after `"mqtt.packets.clearSelection"` (`:4480`), keeping the `mqtt.packets.*`
block contiguous:

```json
  "mqtt.packets.okToMqtt": "ok_to_mqtt",
  "mqtt.packets.violationBadge": "violation",
  "mqtt.packets.violationPacketTitle": "At least one gateway relayed this packet to MQTT although the sender did not opt in (ok_to_mqtt = 0). Open the packet to see which gateway.",
  "mqtt.packets.violationGatewayTitle": "This gateway relayed the packet to MQTT although the sender did not opt in (ok_to_mqtt = 0).",
  "mqtt.packets.okToMqttAllowed": "allowed",
  "mqtt.packets.okToMqttAllowedTitle": "The sender set ok_to_mqtt, so relaying this packet to MQTT is permitted.",
  "mqtt.packets.okToMqttSelf": "opted out",
  "mqtt.packets.okToMqttSelfTitle": "The sender cleared ok_to_mqtt, but no other node was seen relaying this packet, so this is not a violation.",
  "mqtt.packets.okToMqttUnknown": "unknown",
  "mqtt.packets.okToMqttUnknownTitle": "The ok_to_mqtt bit could not be read for this reception — the payload was not decryptable, or the packet was captured before violation detection was added.",
  "mqtt.packets.violationsStillRecorded": "ok_to_mqtt violation detection keeps running while capture is off — turning capture on only makes the per-packet violation badge visible here."
```

**Hard constraints:**
- **`en.json` only.** Do not add these to `de/es/fr/nb_NO/pl/pt_BR/ru/sv/zh_Hans` — none of them
  carries any `mqtt.packets.*` key and the components pass inline English defaults (§1.5).
- Every `t()` call site must pass the **identical** English string as its second argument.
- No emoji or Unicode icon glyphs in any of these strings — `npm run lint:ci` runs
  `scripts/check-ui-locale-glyphs.mjs` first and will fail the build. The `—` em-dash in
  `okToMqttUnknownTitle` is punctuation, not an icon glyph, and is fine.

### 3.6 `src/components/MQTT/MqttPacketMonitorView.tsx` — **EDIT (4 spots)**

**(a) Imports** — after the `MqttPacketDetailModal` import (`:31`):

```ts
import { okToMqttState } from './okToMqttState';
import MqttOkToMqttMarker from './MqttOkToMqttMarker';
```

**(b) `renderType` (`:280-285`)** — append the violation badge. Keep the `useCallback` dependency
array as `[]`; `MqttOkToMqttMarker` resolves its own `t`, so no new dependency is introduced and
`react-hooks/exhaustive-deps` stays clean:

```tsx
  const renderType = useCallback((p: MqttGroupedPacket) => {
    const typeBadge = (p.encrypted && !p.portnumName && ENCRYPTED_OUTCOME_BADGES.has(p.ingestOutcome))
      ? <span className={outcomeBadgeClass(p.ingestOutcome)}>{p.ingestOutcome}</span>
      : <span className="mqpm-badge">{p.portnumName ?? '—'}</span>;
    // MAX(okToMqttViolation) => "at least one gateway violated" (#4114 §2(a)).
    // Only the violation state is surfaced in the list; the full four-state
    // readout lives in the detail modal.
    if (okToMqttState(p) !== 'violation') return typeBadge;
    return (
      <span className="mqpm-type-cell">
        {typeBadge}
        <MqttOkToMqttMarker state="violation" scope="packet" />
      </span>
    );
  }, []);
```

**(c) Capture-disabled banner (`:324-335`)** — add the availability note inside the existing
`<span>`:

```tsx
      {!enabled && (
        <div className="mqpm-disabled-banner">
          <span>
            {t('mqtt.packets.disabled', 'MQTT packet capture is off. No new packets will be recorded until you enable it.')}
            {' '}
            <span className="mqpm-banner-note">
              {t('mqtt.packets.violationsStillRecorded', 'ok_to_mqtt violation detection keeps running while capture is off — turning capture on only makes the per-packet violation badge visible here.')}
            </span>
          </span>
          {canWriteSettings && (
            <button className="mqpm-btn" disabled={savingSettings} onClick={() => void handleToggleEnabled()}>
              {t('mqtt.packets.enable', 'Enable capture')}
            </button>
          )}
        </div>
      )}
```

**(d) Empty state (`:448-453`)** — add the same note on the `!enabled` branch only:

```tsx
        ) : packets.length === 0 ? (
          <div className="mqpm-empty">
            {enabled
              ? t('mqtt.packets.empty', 'No packets captured yet. Waiting for MQTT traffic…')
              : t('mqtt.packets.emptyDisabled', 'No packets captured. Enable capture to start recording.')}
            {!enabled && (
              <div className="mqpm-empty-note">
                {t('mqtt.packets.violationsStillRecorded', 'ok_to_mqtt violation detection keeps running while capture is off — turning capture on only makes the per-packet violation badge visible here.')}
              </div>
            )}
          </div>
        ) : (
```

No other change. Do not touch the fetch layer, the polling, the filters, or the gateway dropdown.

### 3.7 `src/components/MQTT/MqttPacketDetailModal.tsx` — **EDIT (3 spots)**

**(a) Imports** — after `:14`:

```ts
import { okToMqttState } from './okToMqttState';
import MqttOkToMqttMarker from './MqttOkToMqttMarker';
```

**(b) Packet section** — insert one `Row` immediately **after** the `Encrypted` row (`:144`):

```tsx
            <Row label={t('mqtt.packets.okToMqtt', 'ok_to_mqtt')}>
              <MqttOkToMqttMarker state={okToMqttState(packet)} scope="packet" />
            </Row>
```

**(c) Receptions table** — append one header cell after `Hops` (`:176`):

```tsx
                    <th>{t('mqtt.packets.okToMqtt', 'ok_to_mqtt')}</th>
```

and one body cell after the hops `<td>` (`:187`):

```tsx
                      <td><MqttOkToMqttMarker state={okToMqttState(r)} scope="gateway" /></td>
```

No other change. Do not touch the fetch effect, `canFetch`, the a11y hook, or `renderNodeRef`.

### 3.8 Files explicitly **NOT** touched

`src/db/**`, `src/server/**`, `src/services/**`, `src/contexts/SettingsContext.tsx`,
`src/components/Settings/SettingsTab.tsx`, `src/server/constants/settings.ts`,
`src/server/server.settings-persistence.test.ts`, every locale other than `en.json`, every sheet
under `src/styles/`, `eslint-baseline.json` (the baseline must not grow — §1.8).

---

## 4. Test plan

Standard Vitest + Testing Library, in the existing suite. **No standalone scripts.** Every new
assertion targets the inline English default, because both component test files mock `react-i18next`
with `t: (key, fallback) => typeof fallback === 'string' ? fallback : key`
(`MqttPacketMonitorView.test.tsx:14-19`, `MqttPacketDetailModal.test.tsx:16-21`).

### 4.1 `src/components/MQTT/okToMqttState.test.ts` — **NEW**

Pure-function coverage of the four-state derivation (§2(b)):

| Case | Input | Expected |
|---|---|---|
| confirmed wins over everything | `{ okToMqttViolation: 1, bitfield: null }` | `'violation'` |
| confirmed with a readable bit | `{ okToMqttViolation: 1, bitfield: 0 }` | `'violation'` |
| null bitfield | `{ okToMqttViolation: 0, bitfield: null }` | `'unknown'` |
| undefined bitfield (field absent) | `{ okToMqttViolation: 0 }` | `'unknown'` |
| bit 0 set | `{ okToMqttViolation: 0, bitfield: 1 }` | `'ok'` |
| bit 0 set alongside other bits | `{ okToMqttViolation: 0, bitfield: 3 }` | `'ok'` |
| bit 0 clear, not flagged (self-publish) | `{ okToMqttViolation: 0, bitfield: 0 }` | `'self'` |
| bit 0 clear with other bits set | `{ okToMqttViolation: 0, bitfield: 2 }` | `'self'` |
| missing flag defaults to not-violating | `{ bitfield: 1 }` | `'ok'` |
| BIGINT-as-string coercion (PG/MySQL) | `{ okToMqttViolation: '1' as unknown as number }` | `'violation'` |

### 4.2 `src/components/MQTT/MqttPacketMonitorView.test.tsx` — **EXTEND**

**Fixture update (required for typecheck):** `basePacket` (`:45-64`) gains
`bitfield: 1, okToMqttViolation: 0` — a clean default so every existing case keeps passing unchanged.

New cases:

1. **`renders the ok_to_mqtt violation badge on a grouped row when okToMqttViolation is 1`** —
   `installFetchRouter({ packets: [basePacket({ okToMqttViolation: 1, bitfield: 0 })] })`; await
   `findByText('violation')`; assert its `className` contains `mqpm-badge-violation` **and**
   `mqpm-badge`; assert the existing `TEXT_MESSAGE_APP` type badge still renders in the same cell.
2. **`does not render the violation badge when okToMqttViolation is 0`** — default `basePacket()`;
   after `findByText('hello world')`, `expect(screen.queryByText('violation')).toBeNull()`.
3. **`does not render the violation badge for a suspected (null bitfield) row`** —
   `basePacket({ bitfield: null, okToMqttViolation: 0 })`; `queryByText('violation')` is null and
   `queryByText('unknown')` is null. This pins §2(b)'s "unknown never reaches the list" rule and is
   the regression guard against a future refactor that starts deriving the badge from `bitfield`.
4. **`the violation badge explains the at-least-one-gateway semantic in its title`** — assert the
   badge element's `title` attribute equals the `violationPacketTitle` English string verbatim
   (`getByText('violation').getAttribute('title')`). This is what stops the MAX semantic being
   misread.
5. **`the capture-disabled banner says violation detection keeps running`** — `enabled: false`;
   assert both the existing `MQTT packet capture is off. …` string and the
   `ok_to_mqtt violation detection keeps running …` string are present.
6. **`the disabled empty state repeats the violation-detection note`** — `enabled: false,
   packets: []`; assert `No packets captured. Enable capture to start recording.` and the note are
   both present.
7. **`the enabled empty state does not show the violation-detection note`** — `enabled: true,
   packets: []`; assert `No packets captured yet. Waiting for MQTT traffic…` is present and the note
   is **absent**. Guards against the note leaking into the normal path.

Note: cases 5–7 must use the `enabled: false` variant of `installFetchRouter` (`:94-106`), which
already threads `enabled` into the packets envelope.

### 4.3 `src/components/MQTT/MqttPacketDetailModal.test.tsx` — **EXTEND**

**Fixture updates (required for typecheck):** `basePacket` (`:30-49`) gains
`bitfield: 1, okToMqttViolation: 0`; `baseReception` (`:51-61`) gains
`bitfield: 1, okToMqttViolation: 0`.

New cases:

1. **`renders the packet-level ok_to_mqtt row as a violation`** —
   `basePacket({ okToMqttViolation: 1, bitfield: 0 })`; assert an element with text `violation` and
   class `mqpm-badge-violation` exists, and that its `title` is the **packet**-scope string.
2. **`renders 'allowed' when the sender opted in`** — default packet (`bitfield: 1`); assert
   `getByText('allowed')` with class `mqpm-oktomqtt-ok`.
3. **`renders 'unknown' when the bitfield is null`** — `basePacket({ bitfield: null })`; assert
   `getByText('unknown')` with class `mqpm-oktomqtt-unknown`, and that its `title` mentions the
   pre-detection case (assert the full `okToMqttUnknownTitle` string). This is the §2(d) guard.
4. **`renders 'opted out' when the bit is clear but no violation was recorded`** —
   `basePacket({ bitfield: 0, okToMqttViolation: 0 })`; assert `getByText('opted out')` with class
   `mqpm-oktomqtt-self`.
5. **`the per-gateway column attributes the violating gateway among clean ones`** — **the central case of this phase.**
   Serve three receptions for the same packet:
   ```ts
   receptions: [
     baseReception({ gatewayId: '!aaaaaaaa', gatewayNodeNum: 1, bitfield: 0, okToMqttViolation: 1 }),
     baseReception({ gatewayId: '!bbbbbbbb', gatewayNodeNum: 2, bitfield: 1, okToMqttViolation: 0 }),
     baseReception({ gatewayId: '!cccccccc', gatewayNodeNum: 3, bitfield: null, okToMqttViolation: 0 }),
   ]
   ```
   with a `nodeName` resolver mapping `1 -> 'Gateway A'`, `2 -> 'Gateway B'`, `3 -> 'Gateway C'`.
   Then, using `within(screen.getByText('Gateway A').closest('tr')!)` (import `within` from
   `@testing-library/react`):
   - `Gateway A`'s row contains `violation` and **not** `allowed`/`unknown`;
   - `Gateway B`'s row contains `allowed` and **not** `violation`;
   - `Gateway C`'s row contains `unknown` and **not** `violation`;
   - exactly one element with class `mqpm-badge-violation` exists inside the receptions table
     (`container.querySelectorAll('.mqpm-recv-table .mqpm-badge-violation').length === 1`).
6. **`the per-gateway violation marker uses the gateway-scoped tooltip`** — in the fixture from case
   5, assert the badge inside the receptions table has the `violationGatewayTitle` string, **not**
   the packet-scope one. Guards the `scope` prop from being wired backwards.
7. **`the receptions table renders the ok_to_mqtt header`** — assert a `<th>` with text
   `ok_to_mqtt` exists and that the column count is 7.

Existing cases must keep passing untouched — in particular
`fetches and renders receptions (gateway name, RSSI, SNR, computed hops)` at `:106-132`, whose
`getByText('2')` (hops) must not become ambiguous. The new cell renders words, not digits, so it
will not.

### 4.4 Full-suite gate

- `npx vitest run --reporter=json` → confirm `success: true`, not just the summary line.
- Judge `npm run lint:ci` by in-repo failures only:
  `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → **empty**.
- `npx tsc --noEmit` clean.
- **`eslint-baseline.json` must be byte-identical after the change.** Both edited components are
  zero-violation files (§1.8); a baseline that grows is a red flag, and `npm run lint:baseline` is
  not an acceptable fix here.
- PostgreSQL/MySQL containers are **not** required for this phase — it touches no schema, no
  repository, and no migration.

---

## 5. Browser validation plan

Executed after WP2 + WP3 are both merged into the branch, by the phase lead.

### 5.1 Deploy

Use the `docker-dev-deployer` agent / `docker-compose.dev.yml` from **this worktree**, with the
`-f docker-compose.dev.local.yml` override and the two gitignored files copied from the main
checkout. Verify the branch's frontend actually shipped (a shared checkout + docker cache has shipped
stale frontends before) — confirm by finding `mqpm-oktomqtt` in the served JS bundle, or by observing
the new `ok_to_mqtt` row in the modal.

Load `http://localhost:8080/meshmonitor`, log in `admin` / `changeme`.

### 5.2 Step 1 — the capture-off surfaces (no staging needed)

1. Open the MQTT source's **Packet Monitor** with `mqtt_packet_log_enabled` **off** (the default; if a
   previous session enabled it, toggle it off via the filter panel's `Capture enabled` checkbox).
2. Assert the disabled banner shows **both** sentences: the existing "MQTT packet capture is off…"
   and "ok_to_mqtt violation detection keeps running while capture is off…".
3. Assert the empty state below shows "No packets captured. Enable capture to start recording."
   **plus** the same note on a second line.
4. Screenshot. This is the §2(c) deliverable and it validates with zero data.

### 5.3 Step 2 — enable capture and confirm the clean path

1. Enable capture. Wait for live MQTT traffic to populate rows (a bridge/broker source must be
   connected).
2. Assert **no** `violation` badge appears on ordinary traffic (the overwhelmingly common case), and
   that the Type column is visually unchanged from before the phase.
3. Open any packet. Assert the new `ok_to_mqtt` row renders (`allowed` for decrypted LongFast traffic,
   `unknown` for anything undecryptable) and the receptions table has the new last column populated
   for every gateway.
4. Use `mcp__chrome-devtools__evaluate_script` to read the raw list response and confirm
   `okToMqttViolation` is present on the wire (`0` is expected) — this pins §1.3 empirically.
5. Check the console for errors/warnings.

### 5.4 Step 3 — getting a violation to appear

A natural violation requires a **third-party gateway** relaying a packet from a node that explicitly
cleared `ok_to_mqtt`, arriving after the Phase 1 upgrade. That cannot be arranged on demand — it
depends on someone else's misconfigured gateway. **Wait ~15 minutes on a busy public MQTT bridge and
check; if nothing appears, stage the data.**

**TEST-ONLY STAGING — explicitly not a product feature, and every staged row must be removed in
§5.6.** The dev container has **no `sqlite3` CLI binary**, so write through the app's own
`better-sqlite3` (SQLite's WAL mode tolerates the app holding the DB open):

```bash
# 1. Discover the real source id and the exact snake_case column names.
docker exec <dev-container> node -e "
const D=require('/app/node_modules/better-sqlite3');
const db=new D(process.env.DATABASE_PATH||'/data/meshmonitor.db',{readonly:true});
console.log(db.prepare('SELECT id,type FROM sources').all());
console.log(db.prepare('PRAGMA table_info(mqtt_packet_log)').all().map(c=>c.name).join(','));
"
```

Then insert **three receptions of one synthetic packet** (same `packet_id` + `from_node`, three
different gateways) so the modal's attribution case is exercised end-to-end:

| Gateway | `bitfield` | `ok_to_mqtt_violation` | Expected UI |
|---|---|---|---|
| `!aaaaaaaa` | `0` | `1` | `violation` badge |
| `!bbbbbbbb` | `1` | `0` | `allowed` |
| `!cccccccc` | `NULL` | `0` | `unknown` |

Build the `INSERT` from the column list printed above rather than guessing names, set `source_id` to
the discovered MQTT source, `timestamp`/`created_at` to `Date.now()`, `from_node` to a node number
distinct from every gateway, and a `packet_id` well outside real traffic (e.g. `999000001`). Leave
`ingest_outcome` as `'ingested'` and `encrypted` as `0`.

State plainly in the PR description that these rows were staged for validation and removed
afterwards.

### 5.5 Step 4 — assert the two surfaces

1. Refresh the Packet Monitor (or wait one 5 s poll). The staged packet's row must show the
   `violation` badge in the **Type** cell, next to its portnum badge.
2. Read the badge's `title` via `evaluate_script` and confirm it is the packet-scope string ending
   "Open the packet to see which gateway."
3. Click the row. In the modal:
   - the `ok_to_mqtt` packet row shows the `violation` badge (packet-scope tooltip);
   - the receptions table's `ok_to_mqtt` column shows **exactly one** `violation` — on the
     `!aaaaaaaa` row — with `allowed` on `!bbbbbbbb` and `unknown` on `!cccccccc`.
   This is the whole point of the phase: the badge is not a dead end.
4. Screenshot both surfaces.
5. Switch the theme (Latte ↔ Mocha) and confirm the badge remains legible in both and that
   `unknown`/`allowed` stay low-emphasis — the rules use `--ctp-*` tokens which are redefined per
   theme in `src/App.css`.
6. If the icon-style setting is reachable, switch to **emoji** mode and confirm the badge renders
   ⚠️ + `violation` rather than a broken glyph (validates the `UiIcon` emoji branch).

### 5.6 Step 5 — clean up

Delete the staged rows (`DELETE FROM mqtt_packet_log WHERE packet_id = 999000001`) **or** use the
Packet Monitor's own **Clear** button for that source. Re-check that the list no longer shows the
badge. Leave `mqtt_packet_log_enabled` in whatever state the user had it.

---

## 6. Work packages

Three packages. WP2 and WP3 run **in parallel** after WP1. File ownership is disjoint.

### WP1 — Shared primitives, types, CSS, i18n *(first; blocks both others)*

**Owns:**
`src/components/MQTT/okToMqttState.ts` (new) ·
`src/components/MQTT/okToMqttState.test.ts` (new) ·
`src/components/MQTT/MqttOkToMqttMarker.tsx` (new) ·
`src/components/MQTT/mqttPacketTypes.ts` ·
`src/components/MQTT/MqttPacketMonitor.css` ·
`public/locales/en.json`

**Scope:** §3.1–§3.5, §4.1.

**Depends on:** nothing.

**Acceptance:**
- `okToMqttState.test.ts` green on all ten cases in §4.1.
- `MqttOkToMqttMarker` renders the badge with `.mqpm-badge .mqpm-badge-violation` and a `UiIcon`
  with **no** `title` prop; the other three states render `.mqpm-oktomqtt*` text spans.
- All 11 locale keys added to `en.json` only; `node scripts/check-ui-locale-glyphs.mjs` passes.
- `tsc --noEmit` clean. **Expected transient failure:** the two existing test files will not typecheck
  until WP2/WP3 update their fixtures — that is the intended hand-off signal, and WP1 must not "fix"
  it by making the new fields optional.
- No new `eslint-baseline.json` entries; `react-refresh/only-export-components` clean (the pure
  helper lives in its own non-JSX module).

### WP2 — Grouped-row badge + capture-off availability note *(after WP1; parallel with WP3)*

**Owns:**
`src/components/MQTT/MqttPacketMonitorView.tsx` ·
`src/components/MQTT/MqttPacketMonitorView.test.tsx`

**Scope:** §3.6, §4.2 (including the `basePacket` fixture update).

**Depends on:** WP1 (needs `okToMqttState`, `MqttOkToMqttMarker`, the extended `MqttGroupedPacket`,
the CSS classes, and the locale keys).

**Acceptance:**
- All 7 new cases in §4.2 green, plus all 13 pre-existing cases unchanged.
- The badge appears **only** when `okToMqttViolation === 1` — never derived from `bitfield` in this
  file.
- `renderType`'s `useCallback` dependency array stays `[]`; no new `react-hooks/exhaustive-deps`
  violation.
- The availability note renders in the disabled banner **and** the disabled empty state, and **not**
  in the enabled empty state.
- No new column in the grouped table; header count still 8.
- `tsc --noEmit` + `lint:ci` clean for this file.

### WP3 — Detail modal: packet row + per-gateway column *(after WP1; parallel with WP2)*

**Owns:**
`src/components/MQTT/MqttPacketDetailModal.tsx` ·
`src/components/MQTT/MqttPacketDetailModal.test.tsx`

**Scope:** §3.7, §4.3 (including the `basePacket` / `baseReception` fixture updates).

**Depends on:** WP1 (same reasons, plus the extended `MqttReception`).

**Acceptance:**
- All 7 new cases in §4.3 green, plus all 8 pre-existing cases unchanged.
- The receptions table has exactly one new column, appended last; header count 7.
- The packet-section row sits immediately after `Encrypted`.
- `scope` is `"packet"` in the packet section and `"gateway"` in the table — pinned by §4.3 case 6.
- The attribution case (§4.3 case 5) proves exactly one violating gateway among three.
- `tsc --noEmit` + `lint:ci` clean for this file.

### Phase exit (phase lead, after WP2 + WP3 merge into the branch)

Not a work package — the closing sequence:

1. Full suite via `--reporter=json`, `success: true`; `lint:ci` with no in-repo `FAIL`;
   `tsc --noEmit` clean; `eslint-baseline.json` unchanged.
2. Browser validation per §5, including the staged-data case and its cleanup.
3. Tick **Phase 2** in `MQTT_OK_TO_MQTT_VIOLATIONS_EPIC.md` and add a
   **"Deviations / notes → Phase 2"** subsection recording: the four-state (not tri-state) model; the
   decision not to name the Reports view yet **plus the exact Phase 3 follow-up** for
   `mqtt.packets.violationsStillRecorded`; the correction that `MqttPacketMonitorView.tsx` is not a
   baselined file (§1.8); and that `topic` remains unsurfaced and is Phase 3's to use.
4. PR via `/create-pr`, then `/ci-monitor`.

---

## 7. Open risks

1. **The MAX semantic can still be misread by a user who never opens the modal.** Mitigated by the
   tooltip's second sentence and by the row already being click-to-open. Accepted; a per-gateway
   badge in the list would require a second query and a wider row.
2. **`--ctp-red` is shared with `.mqpm-badge-error`.** A packet that is both a decode-error and a
   violation shows two red badges. Distinguished by icon and word, not hue (§2(f)). Accepted rather
   than introducing a sixth hue into a five-hue family.
3. **`title`-only tooltips are not keyboard-accessible.** Mitigated by rendering the same information
   as text in the modal (§2(f)). If a future a11y pass adds a real tooltip primitive, this badge is a
   one-line migration.
4. **The availability note is prose, not a link.** Until Phase 3 ships there is nowhere to link to.
   Explicitly scheduled as a Phase 3 follow-up (§2(c)).
