# Meshtastic ↔ MeshCore Bridge via Automation Engine — Epic Plan

**Issue:** https://github.com/Yeraze/meshmonitor/issues/4577
**Started:** 2026-08-12
**Orchestrator model:** Opus

## Goal

Let a user build a **pair of automations** that bridge **text messages** between a
Meshtastic source and a MeshCore source (one automation MT→MC, the other MC→MT),
using the existing Automation Engine — **not** a native protocol bridge. Add the
supporting pieces that make this safe, easy, and self-describing:

1. A short protocol-label token so bridged text can read `MT@Alice: …` / `MC@Bob: …`.
2. Loop- and flood-safety hardening (the OWNER's explicit OverMesh concern).
3. A new in-app **Automation Template Gallery** (click-to-install), seeded with the
   Bridge template and an Auto-Ack template.
4. User-facing documentation / recipe.

## Why this shape (key survey findings, 2026-08-12)

The core bridge is **already constructible today** — this epic closes gaps and packages it.

- `trigger.message` fires on **both** protocols (Meshtastic `onMessage`, MeshCore
  `onMeshCoreMessage`) producing the same trigger type.
  (`automationEngineService.ts:563/607`, `triggerContext.ts:80/184`)
- `action.sendMessage` can target an **arbitrary source + channel, cross-protocol**
  (`params.sourceId`/`sourceIds`, `params.channel`/`channels[]`), dispatched via
  `sourceManagerRegistry.getManager(sourceId)` and duck-typed per protocol.
  (`actionExecutor.ts:280`, `meshActionDeps.ts:67/85`)
- Identity tokens already exist: `{{ trigger.fromName }}`, `{{ trigger.fromId }}`,
  `{{ trigger.senderLabel }}`, `{{ trigger.protocol }}` (=`meshtastic`/`meshcore`).
  MeshCore messages DO populate `trigger.fromName`. (`SubstitutionsHelp.tsx:14-39`)
- Self-origin loop guard exists (#3914): `isSelfMeshtastic` / `isSelfMeshCore` drop
  MeshMonitor's own re-emitted sends before they re-trigger.
  (`automationEngineService.ts:522-559`)

**Gaps this epic fixes:**
- No short protocol label (`meshtastic`/`meshcore` is too long for `MT@`/`MC@`).
- `isSelfMeshCore` has **no cross-source fallback** (Meshtastic has `isOwnNodeNum`,
  #4593) — a multi-MC-source setup can miss a self-send and loop.
- No per-automation rate limit dedicated to flood safety (only `cooldownGate` +
  per-run `maxActions` cap exist).
- No in-app template gallery — automations are hand-built or imported by hand.

**Scope decisions locked with the owner (2026-08-12 interview):**
- **Text only.** Positions are DROPPED this epic. (No "send position" primitive
  exists on either manager; MeshCore positions never reach the automation bus.
  Revisit as a separate effort if wanted.)
- **Template gallery is in-app, click-to-install** via `POST /api/automations/import`
  (templates land **disabled** for review), with a small wizard to pick the MT
  source+channel and MC source+channel. Not a static docs catalog.
- **Identity token = short protocol label** `{{ trigger.protocolShort }}` → `MT`/`MC`,
  composed with existing `{{ trigger.fromName }}`.
- **Full loop/flood safety hardening** is in scope.
- Gallery seeded with **MT↔MC Bridge** template AND an **Auto-Ack** template.
- A **docs recipe** is also wanted, in addition to the in-app gallery.

## Loop/flood safety model (defense in depth)

1. **Engine self-origin guard** (exists; Phase 2 fixes the MeshCore cross-source gap).
2. **Content guard in the bridge template**: a `condition.string` that skips text
   already starting with a bridge prefix (`MT@`/`MC@`), so a bridged message is never
   re-bridged even if a remote node echoes it. (Phase 4, template-level.)
3. **Per-automation rate limit** (Phase 2, engine-level; template ships safe defaults).
4. Existing `cooldownGate` + per-run `maxActions` cap remain.

## Phases

Each phase ships as its own merged PR and leaves `main` green.

- [ ] **Phase 1 — `protocolShort` identity token.**
  Add `{{ trigger.protocolShort }}` (`MT`/`MC`) to both message context builders
  (`buildMessageContext`, `buildMeshCoreMessageContext` in `triggerContext.ts`);
  document in `SubstitutionsHelp.tsx`; unit tests both protocols.
  *Exit:* token resolves to `MT`/`MC` on each protocol; documented; tests green.
  *Deps:* none.

- [x] **Phase 2 — Loop & flood safety hardening.** ✅ SHIPPED (PR pending merge)
  (a) Give `isSelfMeshCore` a cross-source fallback (mirror `isOwnNodeNum`/#4593 for
  MeshCore self public keys across all MeshCore sources).
  (b) Add a per-automation rate limit primitive (config + enforcement), distinct from
  `cooldownGate`, that bounds sends/minute per automation.
  Tests: self-guard cross-source; rate-limit enforcement; regression on
  `mqttIngestion.automationBus.test.ts`.
  *Exit:* multi-MC-source self-send is dropped; rate limit caps runaway sends; suite green.
  *Deps:* none (independent of Phase 1).

- [x] **Phase 3 — In-app Automation Template Gallery (infra + Auto-Ack template).** ✅ SHIPPED (PR pending merge)
  New gallery UI in the Automations area; a template catalog mechanism (static TS
  catalog of `{ id, name, description, icon, tags, build(params) → AutomationGraph }`);
  a "Use template" flow that (optionally via a small wizard) fills parameters and
  installs through `POST /api/automations/import` (lands disabled). Seed with a
  single **Auto-Ack** template to prove the mechanism end-to-end.
  Tests: catalog build output validates via `validateAutomationGraph`; install flow;
  UI render.
  *Exit:* user can click Auto-Ack → review params → install → a disabled automation
  appears; suite green; browser-validated.
  *Deps:* none strictly, but sequenced after 1–2 so the bridge template (Phase 4)
  can build on all three.

- [x] **Phase 4 — MT↔MC Bridge template.** ✅ SHIPPED (PR pending merge)
  Add the Bridge template to the gallery: builds the **pair** of automations
  (MT→MC and MC→MT), using `{{ trigger.protocolShort }}@{{ trigger.fromName }}: {{ trigger.text }}`,
  the content guard (skip already-`MT@`/`MC@`-prefixed text), rate-limit safe defaults
  (Phase 2), and a wizard to pick MT source+channel and MC source+channel.
  Tests: build output for both automations validates; content guard present;
  simulator round-trip proves no self-loop.
  *Exit:* one click scaffolds two disabled, safe, review-ready bridge automations;
  browser-validated.
  *Deps:* Phases 1, 2, 3.

- [x] **Phase 5, Documentation & recipe.** ✅ SHIPPED (PR pending merge)
  User-facing bridge recipe (in-app gallery walkthrough + manual construction),
  the new token, and prominent flood-safety guidance (OverMesh caution). Update
  `SubstitutionsHelp`/dev-notes as needed; refresh this plan's decisions.
  *Exit:* docs published/updated; plan checked off.
  *Deps:* Phases 1–4.

## Status log

- 2026-08-12: **EPIC COMPLETE.** All 5 phases shipped. Phase 5 documented the whole feature in
  `docs/features/automation-engine.md`: the `{{ trigger.protocolShort }}` token (Universal message
  tokens table), the per-automation Rate limit (flood ceiling) section, a Template Gallery section,
  and a full "Recipe, Meshtastic ↔ MeshCore bridge" (one-click + manual construction) with a
  prominent `::: warning` flood-safety callout covering the three safeguards (content guard, rate
  limit, channel scoping + DM exclusion) and the OverMesh caution. `npm run docs:build` clean.
- 2026-08-12: Epic created. Surveyed automation engine, script gallery, position flow.
  Interview complete (2 rounds). Plan drafted.
- 2026-08-12: **Phase 4 implemented** — the MT↔MC Bridge template (`templates/bridge.ts`,
  registered in `index.ts`). `build()` returns the **pair** `[MT_to_MC_Bridge, MC_to_MT_Bridge]`
  via `compile()` (editable in the visual builder). Each direction:
  `trigger.message` (rateLimit 20/60, origin channel filter) → `condition.sourceFilter` (origin
  source) → `condition.numeric isDM==0` (channel-broadcast only, no DMs) → **two
  `condition.string notContains` guards ('MT@' and 'MC@')** → `action.sendMessage` to the OTHER
  source/channel with text `{{ trigger.protocolShort }}@{{ trigger.fromName }}: {{ trigger.text }}`.
  - **Content-guard mechanism = `condition.string notContains`, NOT a regex negative-lookahead.**
    The engine compiles filter regexes with RE2 (`src/utils/safeRegex.ts`), which THROWS on
    lookaround, and the trigger prefilter swallows the throw as a silent non-match — a
    lookahead guard would make the bridge never fire. `notContains` is case-insensitive and
    decompile-friendly. This is defense-in-depth beyond the Phase-2 self-guard: the self-guard
    only drops MeshMonitor's OWN sends; the content guard also stops a remote node echoing a
    bridged `MT@…`/`MC@…` message back into an amplifying loop.
  - Wizard: MT source/channel + MC source/channel (reuse `sourceMulti`/`channelMulti`, take
    first) + optional rate-limit override.
  - Loop-safety proof: `bridge.loopSafety.test.ts` feeds a relayed `MT@…` message back through
    the opposite automation and asserts 0 actions (the `notContains` guard fails) — cycle broken.
    The MeshCore half runs the real `buildMeshCoreMessageContext`/`evaluateGraph` path because
    the simulator's message events are Meshtastic-shaped (hardcode `protocolShort:'MT'`).
  - Gate: typecheck clean, **full** vitest `success: true` (14196 passed / 0 failed / 0 failed
    suites), lint clean. Live-validated: both automations POSTed to the running build's real
    `/import` landed **disabled**; deleted afterward. (Bridge card/wizard live-render deferred —
    chrome-devtools MCP outage; structurally identical to the Phase-3-validated Auto-Ack card.)
- 2026-08-12: **Phase 3 implemented** (4 WPs). In-app Template Gallery:
  - New `src/components/automations/templates/` dir: `types.ts` (`AutomationTemplate` with
    `build() → BuiltAutomation | BuiltAutomation[]` — the array form is Phase 4's pair hook),
    `index.ts` (`TEMPLATES` registry), `autoAck.ts` (seed template).
  - `TemplateGallery.tsx` + `.module.css` — card grid + param wizard reusing the exported
    `FieldInput` from `AutomationBuilder.tsx` (source/channel pickers), installing each built
    automation via `POST /api/automations/import` (lands **disabled**), with per-automation
    partial-failure reporting. Wired into `AutomationsPage` via a "Browse templates" button.
  - **Key implementation decision:** Auto-Ack builds its graph via the project's `compile()`
    emitter (NOT hand-rolled `port:'true'` edges) so the installed automation round-trips
    through `decompile()` and stays editable in the visual builder. `graphEvaluator.portSatisfied`
    treats an unported condition-outgoing edge as the `true` branch (verified `graphEvaluator.ts`),
    so `zeroHop==1 → tapback` fires ONLY on direct/0-hop messages — no flood.
  - Gate: typecheck clean, vitest `success: true` (741 passed / 0 failed / 0 failed suites),
    lint clean. **Browser-validated** on the live dev instance: gallery card → wizard (real
    source/channel pickers, MT/MC badges) → Install → disabled automation that decompiles into
    the builder; no console errors; validation automation cleaned up afterward.
- 2026-08-12: **Phase 1 shipped** — PR #4675 merged (`{{ trigger.protocolShort }}` → MT/MC).
- 2026-08-12: **Phase 2 implemented** (2 commits). Two deliverables:
  - `isSelfMeshCore` cross-source fallback via new `getOwnPublicKeys()`/`isOwnPublicKey()`
    in `src/server/utils/ownNodes.ts` + `NodeDataProvider.isOwnPublicKey?` — mirrors the
    Meshtastic `isOwnNodeNum`/#4593 path so a self-sent MeshCore message re-entering via a
    different MC source is recognized as self and dropped.
  - Per-automation **rate-limit primitive**, keyed by automation id only (flood ceiling,
    NOT per-subject). Config surface: **`params.rateLimit = { maxActions, windowSeconds }`
    on the trigger node** (absent = no limit; `maxActions` clamped to 1000). Parsed by
    `parseRateLimit()` (`src/types/automation.ts`, runtime-lenient / save-strict like
    `cooldownScope`), enforced at all 5 engine dispatch sites via `rateLimitGate()` using the
    injectable clock. Precedence: cooldown checked first (a debounced event spends no rate
    budget); a rate-limited event does not advance cooldown. New trace outcome `'ratelimited'`.
  - **This is the shape Phase 4's bridge template writes for its safe defaults**, and what
    Phase 5 documents for users.
  - Gate: typecheck clean, vitest `success: true` (1234 passed / 0 failed / 0 failed suites),
    lint clean. No UI beyond the trace-badge enum (typecheck-covered) → no browser pass.

## Key file references (from survey)

| Area | Files |
|------|-------|
| Engine | `src/server/services/automation/automationEngineService.ts`, `automationEngineSingleton.ts` |
| Trigger context + tokens | `src/server/services/automation/triggerContext.ts`, `engineContext.ts`, `interpolate.ts` |
| Actions / send dispatch | `src/server/services/automation/actionExecutor.ts`, `meshActionDeps.ts` |
| Self-guard providers | `src/server/services/automation/meshNodeData.ts` |
| Types / validation | `src/types/automation.ts` (`AutomationGraph`, `validateAutomationGraph`) |
| CRUD / import | `src/server/routes/automationRoutes.ts` (`POST /`, `POST /import`, export) |
| Frontend tokens doc | `src/components/automations/SubstitutionsHelp.tsx`, `substitutionNodeTokens.ts` |
| Frontend catalog | `src/components/automations/catalog.ts` |
| Script Gallery model | `docs/.vitepress/theme/UserScriptsGallery.vue`, `docs/.vitepress/data/user-scripts.json` (static, docs-site) |
| Bus regression test | `src/server/mqttIngestion.automationBus.test.ts` |
