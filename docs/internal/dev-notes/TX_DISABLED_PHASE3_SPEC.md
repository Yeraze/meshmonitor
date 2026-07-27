# TX-Disabled Support — Phase 3 Spec (Polish + Docs, closeout)

**Epic:** #4294 — TX-Disabled Support
**Phase:** 3 of 3 (final). Phases 1 (backend 409 + honor `txEnabled`) and 2 (frontend
gating, `useTxStatus` consumers, `src/utils/txDisabled.ts`, `tx_disabled.*` i18n) are merged.
**Author role:** Phase Architect (spec only — no feature code, no doc prose written here).
**Worktree validated against:** `/home/yeraze/Development/meshmonitor-tx-disabled-docs`
(branch `feature/tx-disabled-docs`, off origin/main with Phases 1 & 2 merged).

Phase 3 is deliberately small: one thin code change (automations builder warning badge)
plus documentation. Everything below is validated against the current tree with file:line
anchors.

---

## 0. Reuse inventory (use these — do not reinvent)

| Need | Reuse | Location (validated) |
|---|---|---|
| Warning icon | `UiIcon` name `alert` (AlertTriangle / ⚠️, "warnings and security risks") | `src/components/icons/UiIcon.tsx:136` |
| TX-disabled detection predicates | `isTxDisabledError` / `isTxDisabledBody` (already used by Phase 2) | `src/utils/txDisabled.ts` |
| TX status hook | `useTxStatus({ baseUrl, sourceId })` → `{ isTxDisabled, data:{txEnabled} }` — **single-source only**, cannot be looped | `src/hooks/useTxStatus.ts` |
| Per-source TX flag origin | `lora.txEnabled` read via `mgr.getCurrentConfig()?.deviceConfig?.lora` | `src/server/routes/sourceRoutes.ts:262` (inside `computeSourceRadioSummary`) |
| Sources-list public summary choke point | `computeSourceRadioSummary()` → attached as `radio:` on each `GET /api/sources` entry | `src/server/routes/sourceRoutes.ts:257`, merged at `:312` |
| Automations builder (leaf, pure/presentational) | `AutomationBuilder.tsx`; `sendSourceMulti` field render | `src/components/automations/AutomationBuilder.tsx:150` |
| `sendSourceMulti` filter | `isSendableSource(s)` (enabled and not MQTT) | `AutomationBuilder.tsx:25` |
| `SourceOption` shape | `{ id; name; type?; enabled? }` | `AutomationBuilder.tsx:17` |
| Sources data owner | `AutomationsPage.tsx` fetches `/api/sources` via `apiService.get` | `src/components/automations/AutomationsPage.tsx:192` |
| CSS (existing automations sheet) | `.ae-muted`, `.ae-switch`, `.ae-token-diag--warn` (`var(--ctp-yellow)`) | `src/components/automations/AutomationsPage.css:58,62,111` |
| i18n | flat dotted keys in `public/locales/en.json`; existing `tx_disabled.*` block | `public/locales/en.json:121-123` |
| v1 action route 409 shape | `{ success:false, error:'…', code:'TX_DISABLED' }` (hand-written) | `src/server/routes/v1/actions.ts` (`/traceroute`, `/request-position`, `/request-nodeinfo`, `/request-neighbors`) |
| Main-API 409 shape | `fail(res, 409, 'TX_DISABLED', '…')` → same JSON body | `messageRoutes.ts:1320`, `meshRequestRoutes.ts:43/125/206/288/345`, `adminRoutes.ts:618/663/785/848/930/950` |
| Docs sidebar | VitePress `/features/` sidebar, "Core" group | `docs/.vitepress/config.mts:69-77` |
| User-facing LoRa/device doc | `docs/features/device.md` — "LoRa Radio Configuration" (`:280`) | (no `tx_enabled`/Transmit item today) |
| API reference docs | `docs/api/REST_API.md` (endpoint-by-endpoint) + `docs/api/API_REFERENCE.md` ("Complete REST API Documentation", VitePress-rendered) | `docs/api/` |

Note: `docs/api/API.md` is explicitly marked outdated ("use REST_API.md or API_REFERENCE.md
instead") — **do not** edit it. `docs/development/api-reference.md` is only a pointer page to
REST_API.md + the interactive OpenAPI spec — no endpoint tables there.

---

## 1. Design analysis: the automations badge (the honest per-source check)

The task asks: "when an automation's send-message action targets a source whose TX is disabled,
show an inline warning badge." Two facts constrain the design:

1. **Automations are global and fan out at runtime.** A `sendMessage` (and `tapback`,
   `requestData`, `deviceReboot`) action carries a `sourceIds: string[]` multi-select
   (`kind: 'sendSourceMulti'`, `catalog.ts:313,322,384,394`). "Leave none" = use the
   triggering source (unknown at design time). So there is **no single design-time sourceId**;
   there is a set of *explicitly selected* sourceIds, each of which has a concrete,
   knowable design-time TX state.

2. **`useTxStatus` is single-source and cannot be looped** (React hooks rule). Calling it
   once per selected source is not viable. `AutomationBuilder` is also a pure presentational
   component that receives all data via props (no `baseUrl`, no query client, no i18n today).

**Chosen approach — augment the already-public sources list with `txEnabled`, then badge
each selected TX-disabled source.** This is a concrete, honest, per-selected-source check
(not invented per-source machinery, and not a vague static note). It piggybacks on the exact
choke point that already exposes `lora` config publicly for the frequency summary.

Rejected alternatives:
- N× `GET /api/device/tx-status?sourceId=` fetches from `AutomationsPage` — more code, N
  requests, and would need a non-hook fetch loop; the one-field sources-list augmentation is
  strictly simpler and reuses an existing endpoint.
- A static informational note only ("TX-disabled sources are skipped at runtime") — acceptable
  *fallback* if reviewers reject the backend field, but weaker: it can't point at *which*
  selected source is offline. Keep the Phase-1 skip-and-record behavior sentence (below) as a
  complementary help line regardless.

Scope of the badge: render it in the **shared `sendSourceMulti` render case**
(`AutomationBuilder.tsx:150`), so it automatically covers every TX action that uses that field
kind (send message, tapback, request-data, device-reboot) — more correct than special-casing
`sendMessage`, and zero extra code per action.

---

## 2. Work packages

Two work packages. **WP1 (code) and WP2 (docs) touch disjoint files and are fully parallel.**

### WP1 — Automations builder TX-disabled warning badge

**W1.1 Backend: expose `txEnabled` on the sources list (Meshtastic-only, fail-open true).**
- File: `src/server/routes/sourceRoutes.ts`.
- Add `txEnabled?: boolean;` to `interface SourceRadioSummary` (`:248`) with a
  "Meshtastic only" doc comment.
- In `computeSourceRadioSummary` Meshtastic branch (`:261-280`), set
  `txEnabled: lora.txEnabled ?? true` in the returned object (default **true** = fail-open,
  matching firmware default and `GET /api/device/tx-status`). MeshCore / MQTT branches leave
  it `undefined` (they have no such flag; badge never shows for them).
- It surfaces automatically via the existing `radio: computeSourceRadioSummary(s.id)` merge
  (`:312`). No new endpoint.
- Sensitivity: `txEnabled` is public RF behavior (the node stops transmitting — observable
  over the air), consistent with the existing frequency/region rationale in the comment at
  `:240-247`. No secret; `stripSourceSecrets` unaffected. It rides `optionalAuth()`.

**W1.2 Frontend: thread `txEnabled` into `SourceOption` and render the badge.**
- `AutomationBuilder.tsx`: extend `SourceOption` (`:17`) with `txEnabled?: boolean;`.
- `AutomationsPage.tsx` (`:192-194`): the `apiService.get` generic and the `.map` currently
  project `{ id, name, type, enabled }`. Add `radio?: { txEnabled?: boolean }` to the fetched
  type and map `txEnabled: s.radio?.txEnabled` into each `SourceOption`.
- `AutomationBuilder.tsx` `sendSourceMulti` case (`:150`): inside the per-source `.map`, when
  `s.txEnabled === false` (strict — only on positive knowledge; `undefined` shows nothing),
  render an inline `<UiIcon name="alert" size={14} />` + short warning text next to the
  source label. Use a small yellow style (see W1.4).
- Keep it a **hint, not a hard block**: do not disable the checkbox. A user may legitimately
  pre-select a source they intend to re-enable, and the runtime engine already skips-and-records
  (Phase 1). The badge is advisory.

**W1.3 i18n wiring.** `AutomationBuilder` and `AutomationsPage` currently use **no**
`useTranslation` (the whole automations builder is hardcoded English — catalog help strings,
"No sendable (non-MQTT) sources.", etc.). The epic requires the string live under
`tx_disabled.*` in `en.json`. Recommended: add the key (W1.4) and introduce a single
`useTranslation()` call in `AutomationBuilder` for the badge text/tooltip only (react-i18next
is already the app-wide provider; low risk). Acceptable fallback if a reviewer prefers not to
introduce i18n into an otherwise un-i18n'd leaf: hardcode the English literal and still add the
`en.json` key for future adoption. State whichever choice is made in the PR body.

**W1.4 CSS.** Add one small rule to `src/components/automations/AutomationsPage.css` (a CSS
module for a single inline badge inside a component that already owns a global sheet is
overkill; a sibling rule is consistent with `.ae-token-diag--warn`). Suggested:
`.ae-tx-warn { color: var(--ctp-yellow); font-size: 0.75rem; display: inline-flex; align-items: center; gap: 0.25rem; margin-left: 0.4rem; }`.
Do not hardcode a hex color — reuse the `--ctp-*` theme vars (already used throughout this sheet).

**W1.5 Tests.**
- Backend: extend the sources-list route/unit coverage to assert `radio.txEnabled` reflects
  `lora.txEnabled` (false when disabled; true/absent otherwise). Use the route harness pattern
  (`createRouteTestApp`) if adding a route test; a `computeSourceRadioSummary` unit test is also
  acceptable and lighter.
- Frontend: a component test rendering `AutomationBuilder` with a `sourceMessage`/`action.sendMessage`
  block and a `sources` array where one source has `txEnabled:false` — assert the badge renders
  for that source and **not** for a `txEnabled:true`/`undefined` source, and that the checkbox is
  still enabled.
- ESLint ratchet: no raw `fetch()` (AutomationsPage uses `apiService`), no new `any`, no new
  `exhaustive-deps`. Confirm with `npm run lint:ci` (filter out `.claude/worktrees` per CLAUDE.md).

### WP2 — Documentation (all doc files; no code)

**W2.1 v1 API + main-API: document `409 TX_DISABLED`.**
The v1 external action routes (`src/server/routes/v1/actions.ts`) and the main-API
message/mesh-request/admin routes both return, on a TX-disabled source:
```json
{ "success": false, "error": "Transmit is disabled on this source", "code": "TX_DISABLED" }
```
with HTTP **409**. (v1 hand-written; main API via `fail(res, 409, 'TX_DISABLED', …)` — identical body.)

Rather than editing every endpoint block, do both of:
1. **Add a global entry to the Error Handling sections.** In `docs/api/REST_API.md`
   ("Error Handling", `:87`, before the "Common Status Codes" list at `:110`) and the
   equivalent section in `docs/api/API_REFERENCE.md`, add a `409 TX_DISABLED` row/paragraph:
   "`409 TX_DISABLED` — returned by any transmit action (message send, traceroute, position /
   nodeinfo / neighbor / telemetry request, remote-node admin) when the target source has
   `lora.txEnabled = false` (receive-only mode). Body: `{ success:false, error, code:'TX_DISABLED' }`.
   Nothing is transmitted. Re-enable TX in the LoRa config to clear it." Add `409` to the
   "Common Status Codes" list too.
2. **Annotate the specific documented action endpoints** that already have per-endpoint status
   lists, adding a `409: Transmit disabled on this source (TX_DISABLED)` line:
   - `docs/api/REST_API.md` → `POST /api/traceroutes/send` (`:808`, currently only documents `500` at `:829`).
   - `docs/api/API_REFERENCE.md` → `POST /api/messages/send` (`:204`) and any documented
     position/nodeinfo/neighbor/telemetry request + remote-admin endpoints.
   The v1 per-source action endpoints (`/api/v1/sources/{id}/actions/*`) are **not** currently
   in `REST_API.md` or `docs/public/openapi.yaml` endpoint-by-endpoint; the global Error
   Handling note (step 1) covers them. Optionally add a `409` response with a `$ref` to the
   existing `Error` schema (`openapi.yaml:72`) if/when those action paths are added to the
   OpenAPI spec — treat as nice-to-have, not required for closeout.

**W2.2 Document the `txEnabled` behavior change (config/lora + import).**
In the same API docs (near the LoRa/config write endpoint and the import/export sections), add
a short note: as of #4294, `POST /api/config/lora` **no longer force-sets `txEnabled: true`** —
it honors the submitted value and backfills the device's current value when the field is omitted
(whole-message LoRaConfig replace; an omitted bool would otherwise decode as `false`). Channel-URL
and config **import/export preserve** the actual `txEnabled` value instead of forcing `true`.
(Remote-node import preserve is best-effort — see §4.)

**W2.3 New user-facing doc page: Receive-Only Mode.**
- **File:** `docs/features/receive-only-mode.md`.
- **Sidebar:** add `{ text: 'Receive-Only Mode', link: '/features/receive-only-mode' }` to the
  **"Core"** group in `docs/.vitepress/config.mts` (after "Device Configuration", `:75`).
  Rationale: it is a device/LoRa capability, adjacent to Device Configuration.
- **Cross-link:** add a short pointer from `docs/features/device.md` "LoRa Radio Configuration"
  section (`:280`) to the new page.
- **Outline** (firmware semantics per epic doc — cite them, don't re-derive):
  1. *What it is* — running a Meshtastic source with `lora.txEnabled = false`; the radio's
     hard TX kill switch (firmware `RadioLibInterface.cpp` drops every outbound LoRa packet
     with `ERRNO_DISABLED`).
  2. *What still works* — RX and decode, all read-only pages (Dashboard, Packet Monitor,
     Telemetry, Map, Messages history), TCP API config reads/writes, and **local**-node admin
     (reboot, set-time, config read/write; the time-sync scheduler is local admin).
  3. *What's disabled* — sending messages/tapbacks, traceroute, position/nodeinfo/neighbor/
     telemetry requests, **remote**-node admin, and the node's own NodeInfo/Position/Telemetry
     broadcasts. Consequence: **the node goes invisible to the mesh** (stops announcing itself).
  4. *How MeshMonitor behaves* — a persistent warning banner (`banners.tx_disabled`); every
     send/transmit control is disabled with a tooltip; a `409 TX_DISABLED` toast if a race slips
     through; automations that target a receive-only source skip-and-record at runtime (and now
     show a builder badge). Not gated: MQTT bridge downlink (publishes to a broker, bypasses the
     radio) and MeshCore sources (different protocol, no such flag).
  5. *How to enable / disable* — LoRa config "Transmit Enabled" checkbox + the danger-confirm
     dialog; note MeshMonitor now **persists** the setting instead of reverting it to `true`
     (the #4294 fix; previously the force-true override silently re-enabled TX). Caveat worth
     stating: some hardware re-reads its own config and may revert `tx_enabled` on the device
     side — that is a device quirk, not MeshMonitor behavior (observed in Phase 2 live testing).

**W2.4 i18n for new user-facing strings.** Any new UI strings (only the automations badge in
this phase) → `public/locales/en.json` **only**. Other locales are Weblate-managed and fall
back to English. Doc pages (`.md`) are English-only and need no i18n. Keys to add:

| Key | Suggested English | Used by |
|---|---|---|
| `tx_disabled.automation_source_warning` | e.g. "Transmit is disabled on this source — messages sent through it will be skipped." | WP1 badge (`AutomationBuilder.tsx` `sendSourceMulti`) |

Place it in the existing `tx_disabled.*` block (`en.json:121-123`). No other new UI strings.

---

## 3. Parallelism, validation, sequencing

- **WP1 ⟂ WP2 fully parallel** — disjoint files (WP1: `sourceRoutes.ts`, `AutomationBuilder.tsx`,
  `AutomationsPage.tsx`, `AutomationsPage.css`, `en.json`, tests; WP2: `docs/**` + `config.mts`,
  plus the one shared file `en.json` for the badge key which is WP1's, not WP2's). They can be
  one PR (small) or two; recommend a **single Phase-3 PR** since the whole phase is small.
- **Browser validation: light-touch is sufficient.** The badge is trivial and unit-tested. A
  single manual check against a TX-disabled sandbox source (open Automations builder → add a
  Send Message action → confirm the badge appears next to the disabled source and the checkbox
  still toggles) is enough; a full puppeteer pass is not warranted for closeout. Recommend one
  screenshot in the PR for the reviewer.
- **Docs build:** run the VitePress build (or `npm run docs:build` if defined) to confirm the
  new sidebar link resolves and the page renders — a dead sidebar link fails the docs build.
- **Gate before PR:** full Vitest suite (0 failures), `npm run lint:ci` clean (filter
  `.claude/worktrees`), tsc clean. CI runs system tests — none needed to be added for this phase.

---

## 4. Deferred / out-of-scope (file as follow-up, do NOT do in Phase 3)

- **Remote-import `txEnabled` accuracy TODO.** Phase 1 left a `TODO(#4294 follow-up)` at the
  `adminRoutes.ts` remote import call site: a fully-accurate remote `txEnabled` preserve needs an
  extra `requestRemoteConfig(LORA_CONFIG)` round-trip (today it is best-effort:
  cached remote config → decoded URL value → fail-open `true`). **Recommendation: file this as a
  separate GitHub follow-up issue, not part of Phase 3.** It is a backend round-trip enhancement,
  not docs/polish, and the fail-open behavior is safe (never disables TX on import). Phase 3
  should only *document* the best-effort behavior (W2.2), not implement the round-trip.
- **Per-button disabling of Device/Module config-section "Set" buttons** in AdminCommandsTab
  (Phase 2 noted these are protected by the `executeCommand` choke-point guard + inline notice,
  functionally correct). A visual-only nicety; leave out unless the user asks.
- **OpenAPI spec additions for v1 action endpoints** — the `/actions/*` paths aren't in
  `openapi.yaml` at all; adding them is a larger doc effort beyond "document the 409." Optional.

---

## 5. File:line reference index (validated this tree)

- `src/server/routes/sourceRoutes.ts:248` — `interface SourceRadioSummary` (add `txEnabled`)
- `src/server/routes/sourceRoutes.ts:257-291` — `computeSourceRadioSummary` (set `txEnabled` in MT branch)
- `src/server/routes/sourceRoutes.ts:312` — `radio: computeSourceRadioSummary(s.id)` merge onto list entry
- `src/components/automations/AutomationBuilder.tsx:17` — `SourceOption` interface
- `src/components/automations/AutomationBuilder.tsx:25` — `isSendableSource`
- `src/components/automations/AutomationBuilder.tsx:150` — `case 'sendSourceMulti'` render (badge here)
- `src/components/automations/AutomationsPage.tsx:192-194` — `/api/sources` fetch + map to `SourceOption`
- `src/components/automations/catalog.ts:313,322,384,394` — `sendSourceMulti` action fields
- `src/components/automations/AutomationsPage.css:58,62,111` — existing `.ae-muted/.ae-switch/.ae-token-diag--warn`
- `src/components/icons/UiIcon.tsx:136` — `alert` icon
- `public/locales/en.json:121-123` — existing `tx_disabled.*` keys (add new key here)
- `src/server/routes/v1/actions.ts` — v1 409 `{success:false,error,code:'TX_DISABLED'}`
- `src/server/routes/messageRoutes.ts:1320`, `meshRequestRoutes.ts:43/125/206/288/345`,
  `adminRoutes.ts:618/663/785/848/930/950` — main-API `fail(res,409,'TX_DISABLED',…)`
- `docs/api/REST_API.md:87` (Error Handling), `:808` (`POST /api/traceroutes/send`)
- `docs/api/API_REFERENCE.md:204` (`POST /api/messages/send`)
- `docs/features/device.md:280` (LoRa Radio Configuration — cross-link target)
- `docs/.vitepress/config.mts:69-77` — `/features/` sidebar "Core" group (add page here)
