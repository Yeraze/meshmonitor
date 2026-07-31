# MeshCore Analyzer Observer — Phase 3 Implementation Spec

**Epic:** #4457 — see `MESHCORE_ANALYZER_OBSERVER_EPIC.md`
**Phase:** 3 of 3 (final) — frontend UI + user documentation
**Branch:** `feature/meshcore-observer-mqtt-phase3` (worktree
`/home/yeraze/Development/meshmonitor-observer-mqtt-p3`, cut from `origin/main`
with Phases 1 + 2 merged: `c8f48451`, `d31de413`).
**Backend is DONE and FROZEN.** This phase adds no server behaviour. Every
route, config field, status field, and error code named below already ships.

Read `MESHCORE_OBSERVER_PHASE1_SPEC.md` §5.1 (config validation) and §7
(API surface + error codes), and `MESHCORE_OBSERVER_PHASE2_SPEC.md` §4.1
(status surface) before writing code. This spec quotes the load-bearing parts
so you do not have to hold both open, but it is not a substitute for them.

---

## 0. Decisions made in this spec (read first)

These are settled. Do not re-litigate them in the PR.

- **D-1. The observer *config* lives in the Dashboard source modal; the signing
  *key* and the live *status* live in the MeshCore Configuration view.** Split,
  not unified. §2 justifies it.
- **D-2. `DashboardPage.tsx` is touched by exactly ONE work package (WP2), and
  the logic it gains is ~40 lines of JSX plus 4 call sites.** All parsing,
  validation, seeding, and error mapping go into a new pure sibling module
  `src/pages/DashboardPage.observerConfig.ts`, following the
  `DashboardPage.bboxSeed.ts` (`src/pages/DashboardPage.bboxSeed.ts`) and
  `src/components/MQTT/mqttBridgeConfig.ts` precedents.
- **D-3. Key management is a new component `MeshCoreObserverSection.tsx` under
  `src/components/MeshCore/`, mounted by `MeshCoreConfigurationView`**, sitting
  in the same class as the existing `MeshCoreDeviceManagement` sub-component
  (`MeshCoreConfigurationView.tsx` L546-740) — per-source, immediate-effect,
  `configuration:write`-gated key operations.
- **D-4. API access goes through `useCsrfFetch`, never `ApiService`, never raw
  `fetch()`.** `ApiService` (`src/services/api.ts`) is a singleton with a
  hand-maintained method per endpoint and no per-source observer methods;
  every MeshCore component and hook in the tree already uses `useCsrfFetch`
  (`src/components/MeshCore/hooks/useMeshCore.ts` L378, L472). Raw `fetch()` is
  ESLint-banned in `src/components/**` and `src/pages/**`
  (`eslint.config.mjs` L149-161); `useCsrfFetch` lives in `src/hooks/` and is
  the sanctioned wrapper.
- **D-5. The four key routes return the `{success, data}` envelope. The frontend
  MUST unwrap `.data` itself** — `ApiService.request()` does not, and neither
  does `csrfFetch`. Getting this wrong yields a `status` object with a `success`
  key and no `stored` field, which renders as "no key stored" forever. A named
  test pins the unwrap (§11.1).
- **D-6. `GET /api/sources/:id/status` is NOT enveloped** (bare JSON) and its
  `observer` sub-object is stripped for callers without `nodes:read`
  (Phase 2 spec §4.1). The status panel therefore renders conditionally on
  `observer` being present, and its absence is a normal state, not an error.
- **D-7. No deep link into the MeshCore Configuration *sub-view*.**
  `MeshCorePage`'s `view` is local `useState` (`MeshCorePage.tsx` L67), not URL
  state. The modal gets a hint + a button that navigates to `/source/:id`; the
  user clicks Configuration in the sub-toolbar. Adding hash-sync to
  `MeshCorePage` is its own change (would need a `VALID_TABS`-style seam).
- **D-8. New user-visible strings land in `public/locales/en.json` only.** The
  ten locale files are not kept in lockstep — `meshcore.form.allow_pki_export`
  (shipped 4.13.2) exists in `en.json` and in none of the other nine. `t(key,
  fallback)` renders the fallback everywhere else. Keys are **flat dotted
  strings** at the JSON top level, not nested objects.
- **D-9. Zero backend change.** Not one line under `src/server/` or `src/db/`.
  See §14 for the two things that looked like they might force one and do not.

---

## 1. Reuse inventory (MANDATORY — read before writing any code)

Every item below was verified in this worktree. If you find yourself writing
something that resembles one of these, stop and reuse it.

### 1.1 The source add/edit modal, MeshCore branch — `src/pages/DashboardPage.tsx`

1,767 lines. Baselined at `{"@typescript-eslint/no-explicit-any": 10}` in
`eslint-baseline.json` — **do not grow that count.**

| What | Where |
|---|---|
| Form state block (`formVn*`, `formMc*`, …) | L130-197 |
| `onAddSource()` — the reset-everything path | L338-373 |
| `onEditSource()` — the seed-from-config path; MeshCore/Meshtastic branch | L376-478 (`virtualNode` seed at L446-452) |
| `onSaveSource()` — the MeshCore config build | L545-610 (`cfg.virtualNode` written at L602-607) |
| Save + `ApiError` handling | L1517-1539 (`setFormError((err.body as any)?.error …)` at L1534) |
| MeshCore JSX branch | L1428-1577 |
| **`virtualNode` fieldset — the structural model for the observer fieldset** | **L1524-1573** |
| `formError` render + Save button | L1736-1744 |
| mqtt_bridge "advanced settings are on the Configuration page" hint + deep-link button — **the model for D-7's cross-link** | L1394-1425 |

The `virtualNode` fieldset's exact shape (reuse verbatim, swapping content):

```tsx
<fieldset style={{ border: '1px solid var(--ctp-surface1)', borderRadius: 6, padding: '8px 12px 12px', margin: '8px 0' }}>
  <legend style={{ fontSize: 12, padding: '0 6px', color: 'var(--ctp-subtext0)' }}>…</legend>
  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4 }}>
    <input type="checkbox" checked={…} onChange={…} />
    {t('…')}
  </label>
  {enabled && (
    <>
      <label className="dashboard-form-field" style={{ marginTop: 8 }}>
        <span className="dashboard-form-label">{t('…')}</span>
        <input className="dashboard-form-input" … />
        <p style={{ fontSize: 11, color: 'var(--ctp-subtext0)', margin: '4px 0 0' }}>{t('…')}</p>
      </label>
    </>
  )}
</fieldset>
```

### 1.2 Pure sibling-module precedent for keeping DashboardPage small

- `src/pages/DashboardPage.bboxSeed.ts` + `DashboardPage.bboxSeed.test.ts` — a
  pure helper extracted out of the page, unit-tested on its own.
- `src/components/MQTT/mqttBridgeConfig.ts` — `buildBridgeConfig` /
  `formFromBridgeConfig` / `emptyBridgeForm`, shared by the modal *and* the
  dedicated configuration view "so the two editors can never drift"
  (its own header comment).

**Copy this pattern.** WP2 creates `src/pages/DashboardPage.observerConfig.ts`.

### 1.3 The MeshCore Configuration view — `src/components/MeshCore/MeshCoreConfigurationView.tsx`

- Props (L15-23): `{ status, actions, baseUrl?, sourceId? }`. `sourceId` and
  `baseUrl` are supplied by `MeshCorePage` (L177-183); they are optional only
  for legacy single-source callers.
- Section container: `<CollapsibleSection title={…} className="form-section">`
  (`./CollapsibleSection`).
- Permission gate already in scope: `const canWriteConfig =
  hasPermission('configuration', 'write')` (L28).
- Companion detection: `const COMPANION_ONLY_DEVICES = new Set([2, 3])` (L13) —
  the *name* is misleading; membership means repeater/room-server. "Is a
  companion" is `!COMPANION_ONLY_DEVICES.has(local?.advType ?? 1)`.
- Conditional sub-section mounts to copy (L511-541): `MeshCoreChannelsConfigSection`,
  `MeshCoreLocalConsole`, `MeshCoreDeviceManagement`.
- **`MeshCoreDeviceManagement` (L546-740) is the direct model for
  `MeshCoreObserverSection`:** a `React.FC` sub-component with its own
  `useState` busy flags, `window.confirm` for destructive actions (L562-566,
  L604-608), an inline hex-input panel with `role="alert"` errors (L699-708),
  a 128-hex client-side regex pre-check (L598), and a clipboard copy with an
  insecure-context fallback:

  ```tsx
  try { await navigator.clipboard.writeText(exportedKey); }
  catch { window.prompt('Copy this private key:', exportedKey); }
  ```

  (L586-593.) **The observer section copies the public key, never a private
  key** — but it uses the same two-step fallback, which is the house precedent
  for `navigator.clipboard` being unavailable on non-HTTPS origins (see also
  `src/components/traceroute/TracerouteCopyLinks.tsx`).

Baseline for this file: `{"react-hooks/exhaustive-deps": 3}` — do not grow it.

### 1.4 Feature-specific status off `useSourceStatuses` — `src/components/MQTT/MqttBridgeConfigurationView.tsx`

The exact pattern to mirror (L37-52, L91-96):

```tsx
/** Deliberately a narrow, LOCAL slice — not an import of a server-side type —
 *  since the status endpoint's payload crosses the boundary as plain JSON. */
interface GeoFilterSourceStatus { downlinkDrops?: { geo?: number }; … }

const sourceStatuses = useSourceStatuses([sourceId]);
const geoStatus = sourceStatuses.get(sourceId) as GeoFilterSourceStatus | null | undefined;
```

Also reused from that file: `formatRelativeTime` from `../../utils/datetime`
(L106 there; signature `formatRelativeTime(timestamp, timeFormat?, dateFormat?,
showAbsolute?)`), and `UiIcon` from `../icons`.

### 1.5 The polling path — `src/hooks/useDashboardData.ts`

```ts
export function useSourceStatuses(sourceIds: string[]): Map<string, SourceStatus | null>
```
L122-139. `useQueries` + `refetchInterval: DASHBOARD_POLL_INTERVAL` (15 s),
`retry: false`. `SourceStatus` (L40-60) carries `[key: string]: unknown`, so
`observer` passes through the type without a server-type import.

**Do not open a second polling loop.** Calling `useSourceStatuses([sourceId])`
from the observer section joins the existing query by key
(`['dashboard','status',id,isAuthenticated]`) — the same trick
`MqttBridgeConfigurationView` uses.

### 1.6 API access — `src/hooks/useCsrfFetch.ts`

```ts
const csrfFetch = useCsrfFetch();
await csrfFetch(url, { method: 'PUT', headers: {...}, body: JSON.stringify(...) });
```
Adds `X-CSRF-Token` on POST/PUT/DELETE/PATCH and `credentials: 'include'`.
Prefix URLs with `appBasename` from `../../init` (see
`useMeshCore.ts` `mcPrefix` construction, L378-472).

### 1.7 Icons — `src/components/icons/UiIcon.tsx`

Registry names verified present and used by this phase: `key`, `import`,
`upload`, `delete`, `refresh`, `check`, `alert`, `error`, `info`, `copy`,
`link`, `statusOn`, `statusOff`, `time`, `forward`, `security`, `radio`.
**No hardcoded emoji or Unicode icon stand-ins** (CLAUDE.md; ESLint
`no-restricted-syntax` block at `eslint.config.mjs` L175+).

### 1.8 Test patterns

| Need | Template |
|---|---|
| DashboardPage modal test (mock block is ~140 lines — copy it wholesale) | `src/pages/DashboardPage.meshcoreAdminCheckbox.test.tsx` |
| MeshCore view component test (auth mock, `t(key)` returns the key) | `src/components/MeshCore/MeshCoreConfigurationView.test.tsx` |
| Pure sibling-module test | `src/pages/DashboardPage.bboxSeed.test.ts` |
| Hook test with `renderHook` | `src/hooks/useTraceroutePairHistory.test.tsx`, `src/hooks/useElevationEnabled.test.tsx` |

`src/test/setup.ts` L8-9 mocks `react-i18next` so `t(key, fallback)` returns
**the key**. All component assertions query by key string, e.g.
`screen.getByRole('checkbox', { name: 'meshcore.form.observer_enable' })`.

### 1.9 Docs surfaces

- `docs/features/` — one markdown page per feature (39 pages today).
- `docs/.vitepress/config.mts` — sidebar. The "Protocol-Specific" group is at
  L152-158 and currently holds a single entry, `{ text: 'MeshCore', link:
  '/features/meshcore' }`.
- `docs/features/meshcore.md` — the MeshCore hub page (H2 outline: Overview,
  Source Types, Adding a MeshCore Source, Device Types, The MeshCore Page,
  Telemetry, Regions / Scopes, Remote Administration, …).
- `CHANGELOG.md` — Keep-a-Changelog. `## [Unreleased]` at L7 with
  `### Changed` / `### Fixed` sub-heads today; this phase adds `### Added`.

---

## 2. Placement decision (D-1) and its justification

| Surface | Home | Why |
|---|---|---|
| `observer.enabled`, `brokerUrl`, `iataCode`, `tokenAudience` | **Source add/edit modal** (`DashboardPage.tsx`, MeshCore branch) | These are `sources.config` fields. Every other `sources.config` field for a MeshCore source — transport, serial port, device type, heartbeat, autoConnect, the whole `virtualNode` block — is edited there and saved by the same `PUT /api/sources/:id`. Splitting them out would mean two places that write `config`, i.e. the drift `mqttBridgeConfig.ts` was created to prevent. Available at **create** time, which the key UI cannot be. |
| Signing key: status / fetch-from-device / paste / clear | **`MeshCoreConfigurationView`** (new `MeshCoreObserverSection`) | (a) It is **not** `sources.config` — it lives in `meshcore_observer_keys` behind four separate routes with immediate effect. Putting immediate-effect buttons inside a form whose Save button commits a *different* transaction produces the classic "did my key save?" ambiguity, and the modal's Cancel would appear to roll back a write it cannot. (b) There is **no `sourceId` in create mode**, so half the UI would be permanently dead there. (c) `MeshCoreDeviceManagement` (L546-740) already lives in this view and is the same feature class: per-source, immediate-effect, companion-only, `configuration:write` key operations. (d) The view is already `configuration`-permission-scoped end to end (sub-toolbar gate at `MeshCoreSubToolbar.tsx` L60). |
| Live observer status (connected / counters / lastError) | **Same new section**, directly under the key block | Status is only meaningful next to the key it depends on (`keyStored:false` is the single most common cause of `connected:false`). `useSourceStatuses` is already the per-source status path and the section joins the existing 15 s query. |

**Cross-link (D-7):** the modal's observer fieldset ends with a hint —
"Signing key and live status are on this source's MeshCore → Configuration
page" — plus, when `editingSourceId` is set, a small button that closes the
modal and `navigate(\`/source/${editingSourceId}\`)`. Modeled verbatim on the
mqtt_bridge hint at `DashboardPage.tsx` L1394-1425, minus the `#hash` (D-7).

**Clipboard:** the only copy affordance in this phase is on the **public** key,
which is not a secret. It still uses the `navigator.clipboard` →
`window.prompt` fallback (§1.3) because the dev container and many LAN
deployments are plain HTTP, where `navigator.clipboard` is `undefined`.

---

## 3. `src/pages/DashboardPage.observerConfig.ts` (NEW, pure — WP2)

No React import. No i18n import. Pure functions + types, so
`DashboardPage.observerConfig.test.ts` can drive every branch without a DOM.

```ts
/**
 * MeshCore Analyzer Observer (#4457 Phase 3) — pure form <-> config mapping
 * for the source add/edit modal.
 *
 * Extracted out of DashboardPage.tsx deliberately: the page is 1,700+ lines
 * and every branch here is worth a unit test. Mirrors the split used by
 * DashboardPage.bboxSeed.ts and components/MQTT/mqttBridgeConfig.ts.
 *
 * The client-side checks here MIRROR the server's validateObserverConfig
 * (src/server/routes/sourceRoutes.ts L86-170, spec'd in
 * MESHCORE_OBSERVER_PHASE1_SPEC.md §5.1). They exist to give fast, specific
 * feedback — the server remains the authority and re-checks everything.
 */

/** The observer block as it is persisted inside `sources.config`. */
export interface ObserverConfigWire {
  enabled: boolean;
  brokerUrl: string;
  iataCode: string;
  tokenAudience: string;
}

/** Modal form state — all strings, because inputs are all strings. */
export interface ObserverForm {
  enabled: boolean;
  brokerUrl: string;
  iataCode: string;
  tokenAudience: string;
}

export function emptyObserverForm(): ObserverForm;

/**
 * Seed the form from a source's stored config. Tolerates a missing block, a
 * non-object block, and missing individual fields (all -> '').
 */
export function observerFormFromConfig(config: unknown): ObserverForm;

/**
 * Validate + build. Returns `{ config }` on success (config is `undefined`
 * when the observer is disabled — matching the server's
 * `observerConfigFromSource` incomplete-block-to-undefined rule), or
 * `{ error: { key, fallback } }` for the first failing check.
 *
 * `key`/`fallback` are i18n inputs, NOT rendered text — the caller does
 * `t(key, fallback)`. Same convention as the mqtt_bridge builder's error shape
 * consumed at DashboardPage.tsx L540-544.
 */
export function buildObserverConfig(
  form: ObserverForm,
): { config?: ObserverConfigWire; error?: { key: string; fallback: string } };

/**
 * Map a server error `code` from a failed source save onto an i18n key, or
 * null when the code is not observer-related (caller then falls back to the
 * server's own `error` string, as today).
 */
export function observerErrorMessageKey(code: string | undefined | null): string | null;
```

### 3.1 `buildObserverConfig` check order (mirrors Phase 1 §5.1)

Run in this order and return on the first failure:

| # | Check | Error key / fallback |
|---|---|---|
| 0 | `!form.enabled` | return `{ config: undefined }` — **no validation at all when disabled**, matching the server's check 5 |
| 1 | `brokerUrl.trim()` empty | `meshcore.form.observer_error_broker_required` / "Broker URL is required" |
| 2 | `brokerUrl` has an explicit scheme that is not `ws:`/`wss:`/`mqtt:`/`mqtts:` | `meshcore.form.observer_error_broker_scheme` / "Broker URL must use ws://, wss://, mqtt:// or mqtts:// (or a bare host:port)" |
| 3 | `brokerUrl` has no parseable host | `meshcore.form.observer_error_broker_invalid` / "Broker URL is not a valid address" |
| 4 | `iataCode.trim()` neither `/^[A-Za-z]{3}$/` nor case-insensitive `test` | `meshcore.form.observer_error_iata` / "Region must be a 3-letter IATA code (e.g. MCO) or 'test'" |
| 5 | `tokenAudience.trim()` empty, `> 255` chars, or contains whitespace | `meshcore.form.observer_error_audience` / "Token audience must be non-empty and contain no spaces" |
| — | otherwise | `{ config: { enabled: true, brokerUrl: brokerUrl.trim(), iataCode: iataCode.trim().toUpperCase(), tokenAudience: tokenAudience.trim() } }` |

**Scheme detection (check 2) must not reimplement `normalizeBrokerUrl`.** Do it
with a regex on the raw string, exactly as the server does before normalizing:

```ts
const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
const ALLOWED = new Set(['ws', 'wss', 'mqtt', 'mqtts']);
if (schemeMatch && !ALLOWED.has(schemeMatch[1].toLowerCase())) return { error: … };
```

A bare `mqtt-us-v1.letsmesh.net:443` has **no** `://` and therefore no scheme —
it passes check 2 and the server normalizes it to `mqtt://…`. This is the
deliberate Phase 1 behaviour (epic "Broker URL validation" deviation); do not
"fix" it by rejecting bare hosts.

For check 3, parse with `new URL(schemeMatch ? raw : \`mqtt://${raw}\`)` inside
a `try`; empty `hostname` or a throw is a failure.

**Uppercasing `iataCode` on build is intentional** and matches
`observerConfigFromSource` (Phase 1 spec §4.1). Do **not** uppercase in the
input's `onChange` — that fights the cursor on paste and makes `test` render as
`TEST`. `'test'` uppercased to `'TEST'` is accepted by the server (check 9 is
case-insensitive) and by the broker (it uppercases IATA in topics anyway).

### 3.2 `observerErrorMessageKey` mapping

Codes from Phase 1 §5.1 that a source save can return:

| Server `code` | i18n key | Fallback |
|---|---|---|
| `INVALID_BROKER_URL` | `meshcore.form.observer_error_broker_invalid` | "Broker URL is not a valid address" |
| `INVALID_IATA_CODE` | `meshcore.form.observer_error_iata` | (as above) |
| `OBSERVER_REQUIRES_COMPANION` | `meshcore.form.observer_error_requires_companion` | "The Analyzer Observer requires a Companion device — repeaters cannot export a signing key." |
| `OBSERVER_KEY_IN_CONFIG` | `meshcore.form.observer_error_key_in_config` | "Signing keys are never stored in the source config. Use the Configuration page's Analyzer Observer section." |
| anything else | `null` | caller keeps today's behaviour |

`INVALID_PARAMETER` / `INVALID_PARAMETER_TYPE` map to `null` on purpose: they
are shared codes used by many non-observer branches of the same save, and the
server's own `error` string is already specific.

---

## 4. `DashboardPage.tsx` changes (WP2 — the ONLY package that touches this file)

Five edits. Nothing else.

### 4.1 State (add next to the `formVn*` block, ~L144)

One object, not four `useState`s — keeps the diff small and matches the
`formBrokerBridgeRewrites` object-state precedent at L176.

```tsx
import { emptyObserverForm, observerFormFromConfig, buildObserverConfig, observerErrorMessageKey, type ObserverForm } from './DashboardPage.observerConfig';

// MeshCore Analyzer Observer (#4457) — publishes heard packets to a
// MeshCore-Analyzer MQTT broker. Key management lives on the source's
// MeshCore Configuration page, not here (see the fieldset hint).
const [formObserver, setFormObserver] = useState<ObserverForm>(emptyObserverForm());
```

### 4.2 Reset in `onAddSource()` (~L350, beside `setFormVnAllowPkiExport(false)`)

```tsx
setFormObserver(emptyObserverForm());
```

### 4.3 Seed in `onEditSource()` (~L452, right after the `virtualNode` seeds)

```tsx
setFormObserver(observerFormFromConfig(cfg?.observer));
```

### 4.4 Build in `onSaveSource()`, MeshCore branch (after the `virtualNode` write at L602-607)

```tsx
// Analyzer Observer (#4457). Validated client-side for fast feedback; the
// server re-checks with validateObserverConfig and is the authority.
const observerResult = buildObserverConfig(formObserver);
if (observerResult.error) {
  setFormError(t(observerResult.error.key, observerResult.error.fallback));
  return;
}
if (observerResult.config) {
  cfg.observer = observerResult.config;
} else {
  // Explicit disable so an edit that turns the observer off actually clears
  // it. Writing `{enabled:false}` (rather than deleting the key) keeps the
  // server's hot-swap diff at sourceRoutes.ts L1012-1014 able to see the
  // change and stop the publisher without bouncing the radio link.
  cfg.observer = { enabled: false, brokerUrl: '', iataCode: '', tokenAudience: '' };
}
```

> **Why `{enabled:false, …''}` and not `delete cfg.observer`:** the server's
> `validateObserverConfig` returns `null` for `enabled !== true` (check 5), so
> the empty strings are never validated. The hot-swap comparison is
> `JSON.stringify(oldCfg.observer ?? null) !== JSON.stringify(newCfg.observer ?? null)`
> — an omitted block and a disabled block are both "not running", but writing
> the disabled block makes the transition from enabled→disabled a visible diff
> whose `observerChanged && !restOfConfigChanged` branch hot-swaps the
> publisher to a stop **without a device reconnect**. Deleting the key works
> too, but leaves the previous values unrecoverable if the user toggles back.

### 4.5 Error surfacing in the `ApiError` catch (L1532-1537)

```tsx
if (err instanceof ApiError) {
  const code = err.code ?? (err.body as any)?.code;
  const observerKey = observerErrorMessageKey(code);
  setFormError(
    observerKey
      ? t(observerKey, (err.body as any)?.error ?? '')
      : ((err.body as any)?.error ?? t('source.form.error_save_failed')),
  );
  return;
}
```

`ApiError` already carries `code` (`src/services/api.ts` L120-133); the
`err.body.code` read is belt-and-braces for handlers that predate the envelope.
**This is the file's only new `as any` — reuse the existing casts' style and do
not add a sixth.** The baseline allows 10 `no-explicit-any` in this file and
there are 10; `(err.body as any)` already appears on the line you are editing,
so the count does not move. Verify with `npm run lint:ci`.

### 4.6 JSX — the observer fieldset (insert after the `virtualNode` fieldset, ~L1573)

Same `<fieldset>` skeleton as §1.1. Contents:

1. `<legend>` → `t('meshcore.form.observer', 'Analyzer Observer')`
2. Enable checkbox → `t('meshcore.form.observer_enable', 'Publish heard packets to a MeshCore Analyzer broker')`
3. Help `<p>` (always visible, under the checkbox) →
   `t('meshcore.form.observer_help', 'Relays every packet this Companion hears to a MeshCore Analyzer MQTT broker so your node counts as an observer. MeshMonitor only publishes — it never receives from the broker or transmits on the mesh. Companion devices only.')`
4. When `formObserver.enabled`, three `label.dashboard-form-field` blocks, each
   with a `span.dashboard-form-label`, an `input.dashboard-form-input`, and an
   11px hint `<p>`:

   | Field | Label key | Placeholder | Hint key / fallback |
   |---|---|---|---|
   | `brokerUrl` | `meshcore.form.observer_broker_url` "Broker URL" | `wss://mqtt-us-v1.letsmesh.net:443` | `meshcore.form.observer_broker_url_help` — "ws://, wss://, mqtt://, or mqtts://. A bare host:port is accepted and defaults to mqtt://." |
   | `iataCode` | `meshcore.form.observer_iata` "Region (IATA)" | `MCO` | `meshcore.form.observer_iata_help` — "Three-letter IATA code for your region (e.g. MCO for Central Florida), or 'test' for a local broker." |
   | `tokenAudience` | `meshcore.form.observer_audience` "Token audience" | `meshcore-mqtt` | `meshcore.form.observer_audience_help` — "Must exactly match the broker's expected audience, or authentication is rejected. Ask your region's broker operator." |

5. A key-management hint + cross-link button (D-7), mirroring L1394-1425:

```tsx
<div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 8 }}>
  <span style={{ fontSize: 11, color: 'var(--ctp-subtext0)', flex: 1 }}>
    {t('meshcore.form.observer_key_hint', 'The signing key and live publish status are on this source’s MeshCore → Configuration page.')}
  </span>
  {editingSourceId && (
    <button type="button" /* same inline style object as L1404-1415 */
      title={t('meshcore.form.observer_open_config', 'Open Configuration page')}
      onClick={() => { setShowSourceModal(false); void navigate(`/source/${editingSourceId}`); }}>
      {t('meshcore.form.observer_open_config', 'Configuration')} <UiIcon name="forward" size={14} />
    </button>
  )}
</div>
```

6. **Repeater guard.** When `formMcDeviceType === 'repeater'`, render the
   fieldset with the enable checkbox `disabled` and show
   `t('meshcore.form.observer_repeater_note', 'The Analyzer Observer requires a Companion device — a repeater cannot export the signing key it needs.')`
   instead of the three inputs. This mirrors the server's check 6
   (`OBSERVER_REQUIRES_COMPANION`) so the user never reaches a rejected save.
   Do **not** auto-clear `formObserver.enabled` when the type flips — the
   server only rejects on save, and silently mutating a user's setting on an
   unrelated dropdown change is worse than a disabled control.

**`t()` calls must all pass a fallback string** (second arg). Every existing
MeshCore form string does.

---

## 5. `src/components/MeshCore/hooks/useObserverKey.ts` (NEW — WP1)

The single owner of the four key routes. No component calls them directly.

```ts
/**
 * MeshCore Analyzer Observer signing-key management (#4457 Phase 3).
 *
 * Wraps GET/POST/PUT/DELETE /api/sources/:id/observer/key. Those four routes
 * use the {success, data} response envelope (Phase 1 spec §7), and neither
 * ApiService.request() nor csrfFetch unwraps `data` — THIS HOOK DOES. Reading
 * the body directly yields an object with no `stored` field, which renders as
 * "no key stored" forever.
 */

/** Mirrors ObserverKeyStatus from server/services/meshcoreObserverKeyStore.ts.
 *  Deliberately re-declared here (client/server boundary is plain JSON). */
export interface ObserverKeyStatus {
  stored: boolean;
  publicKey: string | null;
  origin: 'device' | 'manual' | null;
  updatedAt: number | null;
  /** SESSION_SECRET changed since the key was stored — the key is now
   *  undecryptable. `publicKey` survives (clear column) and stays displayable. */
  keyRotated: boolean;
  /** false when SESSION_SECRET is auto-generated: storing a key is impossible. */
  canStore: boolean;
  /** Human-readable reason accompanying canStore:false. */
  reason: string | null;
}

export interface ObserverKeyError {
  /** Server machine code, e.g. 'SOURCE_NOT_CONNECTED'. null on a transport failure. */
  code: string | null;
  /** Server-supplied message; a last-resort fallback for unmapped codes. */
  message: string | null;
}

export type ObserverKeyAction = 'import' | 'manual' | 'clear';

export interface UseObserverKeyResult {
  status: ObserverKeyStatus | null;
  loading: boolean;
  loadError: ObserverKeyError | null;
  /** Which mutation is in flight, or null. Drives per-button spinners. */
  busy: ObserverKeyAction | null;
  /** Result of the last mutation attempt; cleared when a new one starts. */
  actionError: ObserverKeyError | null;
  refresh: () => Promise<void>;
  importFromDevice: () => Promise<boolean>;
  setManualKey: (privateKeyHex: string) => Promise<boolean>;
  clearKey: () => Promise<boolean>;
  clearActionError: () => void;
}

export function useObserverKey(
  sourceId: string,
  opts?: { enabled?: boolean },
): UseObserverKeyResult;
```

### 5.1 Implementation notes

- Base: ``const base = `${appBasename}/api/sources/${sourceId}/observer/key`;``
  (`appBasename` from `../../../init`). Import route is `` `${base}/import` ``
  — note the path is `/observer/key/import`, i.e. **`base + '/import'`**.
- One shared response reader:

  ```ts
  async function readEnvelope(res: Response): Promise<
    { ok: true; data: ObserverKeyStatus } | { ok: false; error: ObserverKeyError }
  > {
    let body: any = null;
    try { body = await res.json(); } catch { /* empty/non-JSON body */ }
    if (!res.ok) {
      return { ok: false, error: { code: body?.code ?? null, message: body?.error ?? null } };
    }
    return { ok: true, data: body?.data as ObserverKeyStatus };   // <- the unwrap (D-5)
  }
  ```

- Every mutation, on success, sets `status` from the returned `data` — all four
  routes return the same `ObserverKeyStatus`, so **no refetch after a mutation.**
  Round trips: 1, not 2.
- `busy` is set before the request and cleared in `finally`. Guard re-entry:
  `if (busyRef.current) return false;` — use a ref, not the state value, so
  rapid double-clicks cannot both pass the check.
- `clearKey` does **not** confirm — confirmation is the component's job
  (`window.confirm`, matching `MeshCoreDeviceManagement` L562-566).
- `setManualKey` sends `{ privateKey: hex }`. It does **not** trim or strip
  `0x` — the server does both (`sourceObserverRoutes.ts` L164). Sending the raw
  user string keeps one source of truth. Do a `/^[0-9a-fA-F]{128}$/` pre-check
  in the **component** (fast feedback), not here.
- **Never log, store, or surface the pasted private key.** No `console.log`, no
  `logger.debug`, no inclusion in an error message.
- **exhaustive-deps:** every callback is `useCallback` with `[base, csrfFetch]`
  (`base` is a `useMemo` on `[sourceId]`; `csrfFetch` is already `useCallback`-
  stable in `useCsrfFetch`). The initial-load effect depends on
  `[refresh, enabled]`. No disables. This file must add **zero**
  `react-hooks/exhaustive-deps` violations.
- Unmount safety: a `cancelledRef` set in the effect cleanup, checked before
  every `setState` after an `await`.

---

## 6. `src/components/MeshCore/MeshCoreObserverSection.tsx` (NEW — WP3)

```tsx
interface MeshCoreObserverSectionProps {
  /** Source UUID. The section does not render without one. */
  sourceId: string;
  /** Live device-link state. Gates ONLY the "Fetch from device" button —
   *  status/paste/clear all work while disconnected. */
  connected: boolean;
  /** advType off status.localNode. undefined while disconnected -> treated as
   *  companion, matching MeshCoreConfigurationView's `local?.advType ?? 1`. */
  deviceType?: number;
}

export const MeshCoreObserverSection: React.FC<MeshCoreObserverSectionProps>;
```

### 6.1 Mount site — `MeshCoreConfigurationView.tsx` (one edit, ~L541)

Insert immediately **before** the `MeshCoreDeviceManagement` mount (the observer
section is not a danger zone; the red-bordered device management stays last):

```tsx
{/* Analyzer Observer (#4457) — signing key + live publish status. Rendered
    while DISCONNECTED too: three of the four key routes work without a
    manager. Companion-only, matching the server's OBSERVER_REQUIRES_COMPANION. */}
{sourceId && !COMPANION_ONLY_DEVICES.has(local?.advType ?? 1) && (
  <MeshCoreObserverSection
    sourceId={sourceId}
    connected={connected}
    deviceType={local?.advType}
  />
)}
```

Note the gate deliberately omits `connected &&` and `canWriteConfig &&`
(unlike the `MeshCoreDeviceManagement` line above it): read-only users get the
status display, and disconnected sources still need key management. The
component does its own `configuration:read` / `configuration:write` gating.

### 6.2 Structure

Wrap in `<CollapsibleSection title={t('meshcore.observer.title', 'Analyzer Observer')} className="form-section">`.

```
CollapsibleSection "Analyzer Observer"
├── intro <p className="hint"> — what this is + link to the docs page
├── [A] Status block        (only when `observer` is present on the source status)
├── [B] Key status block    (only when configuration:read)
└── [C] Key actions block   (only when configuration:write)
```

Permission reads (`useAuth`):
```tsx
const canRead  = hasPermission('configuration', 'read',  { sourceId });
const canWrite = hasPermission('configuration', 'write', { sourceId });
```
Pass `{ sourceId }` — per-source permissions are real (CLAUDE.md; AuthContext
L77-81 explicitly refuses a cross-source union). `useObserverKey(sourceId, { enabled: canRead })`.

#### [A] Status block

```tsx
interface ObserverSourceStatusSlice {   // local narrow slice — §1.4 pattern
  observer?: {
    configured: boolean; keyStored: boolean; connected: boolean;
    publishes: number; dropped: number;
    lastPublishAt: number | null; lastError: string | null;
    tokenExpiresAt: number | null;      // unix SECONDS
  };
}
const statuses = useSourceStatuses([sourceId]);
const observer = (statuses.get(sourceId) as ObserverSourceStatusSlice | null | undefined)?.observer;
```

Render only when `observer` is truthy. Absent means either the observer is not
running for this source **or** the caller lacks `nodes:read` (D-6) — both are
silent, neither is an error.

Rows:

| Row | Content |
|---|---|
| Link state | `<UiIcon name={observer.connected ? 'statusOn' : 'statusOff'} />` + `meshcore.observer.status_connected` / `status_disconnected` |
| Configured | shown **only** when `!observer.configured` → warning line `meshcore.observer.not_configured` ("Enabled, but the broker URL, region, or audience is missing. Edit the source to complete it.") |
| Key | shown **only** when `!observer.keyStored` → warning `meshcore.observer.no_key_running` ("No usable signing key — the publisher will not connect. Import or paste one below.") |
| Published | `observer.publishes` — `meshcore.observer.published_count` |
| Dropped | `observer.dropped`; append the hint `meshcore.observer.dropped_help` ("Packets heard while the broker socket was down.") only when `> 0` |
| Last publish | `observer.lastPublishAt ? formatRelativeTime(observer.lastPublishAt) : t('common.never', 'Never')` |
| Token expires | `observer.tokenExpiresAt ? formatRelativeTime(observer.tokenExpiresAt * 1000) : '—'` — **×1000, the field is unix SECONDS** (Phase 2 `MeshCoreObserverStatus` L97-98). Getting this wrong renders "56 years ago". |
| Last error | when `observer.lastError`, a `role="alert"` line in `var(--ctp-red)` prefixed by `<UiIcon name="alert" />` |

Counters are cumulative for the publisher's lifetime and reset on restart —
say so in the docs page, not in the UI.

#### [B] Key status block

From `useObserverKey`. States, in priority order:

1. `loading` → `meshcore.observer.key_loading` ("Checking…")
2. `loadError` → `role="alert"`, mapped via §7.
3. `status.canStore === false` → **prominent yellow warning**, before anything
   else: `meshcore.observer.cannot_store` ("MeshMonitor cannot store the
   signing key: {{reason}}") interpolating `status.reason`, plus
   `meshcore.observer.cannot_store_fix` ("Set a fixed SESSION_SECRET and
   restart to enable observer key storage."). Import and paste controls are
   **disabled** in this state; Clear stays enabled (the DELETE route is
   deliberately not gated on `canStore` — `sourceObserverRoutes.ts` L188-190).
4. `status.stored === false` → `meshcore.observer.key_none` ("No signing key
   stored. The observer cannot authenticate to the broker until you add one.")
5. `status.stored === true`:
   - Public key, truncated, monospace: `pk.slice(0, 8) + '…' + pk.slice(-8)`,
     with `title={pk}` and a copy button
     (`meshcore.observer.copy_public_key`) using the clipboard→`window.prompt`
     fallback from §1.3. Label it `meshcore.observer.public_key` ("Node public
     key") and note in the hint that it is public, so nobody thinks a secret is
     on screen.
   - Origin badge: `meshcore.observer.origin_device` ("Read from device") /
     `meshcore.observer.origin_manual` ("Entered manually").
   - `updatedAt` → `formatRelativeTime(status.updatedAt)` (milliseconds, no
     conversion) as `meshcore.observer.key_updated`.
   - `keyRotated === true` → `role="alert"` yellow warning:
     `meshcore.observer.key_rotated` ("The stored signing key can no longer be
     decrypted — SESSION_SECRET changed since it was saved. The observer will
     not connect until you re-import or re-paste the key. The public key above
     is still correct.")

`status.reason` and `status.publicKey` are server strings/values — render as
text, never `dangerouslySetInnerHTML`.

#### [C] Key actions block (`canWrite` only)

Three controls, laid out like `MeshCoreDeviceManagement` L626-658
(`div` with `display:flex; gap:0.75rem; flexWrap:wrap`):

| Control | Behaviour |
|---|---|
| **Fetch from device** (`<UiIcon name="import" />`) | `POST …/key/import`. `disabled = !connected \|\| busy !== null \|\| status?.canStore === false`. When `!connected`, render the disabled button with `title={t('meshcore.observer.fetch_needs_connection', 'Connect to the device first — the key is read over the live link.')}`. On success show a transient `meshcore.observer.key_imported` confirmation next to the button (same `<UiIcon name="check" /> Saved` treatment as `MeshCoreConfigurationView` L505-509). |
| **Enter key manually** (`<UiIcon name="key" />`) | Toggles an inline panel (NOT a modal — copy the `importKeyOpen` panel at L688-716): a `type="password"` input, an `autoComplete="off"`, a `role="alert"` error line, Cancel + Save. Client pre-check `/^[0-9a-fA-F]{128}$/` on `value.trim().replace(/^0x/i,'')` → `meshcore.observer.manual_invalid_length` before any request. On success, close the panel and **clear the draft state**. |
| **Clear stored key** (`<UiIcon name="delete" />`, `color: var(--ctp-red)`) | `window.confirm(t('meshcore.observer.clear_confirm', 'Forget the stored Analyzer Observer signing key? The observer will stop publishing until a new key is added.'))`, then `DELETE`. `disabled = busy !== null \|\| !status?.stored`. |

`type="password"` on the paste input is a deliberate divergence from
`MeshCoreDeviceManagement`'s `type="text"` (L692): the observer key is
long-lived credential material and there is no reason to render it. Do not add
a reveal toggle.

Mutation errors render once, under the action row, `role="alert"`, mapped via §7.

### 6.3 Styling — `MeshCoreObserverSection.module.css` (NEW)

CLAUDE.md: new components use CSS modules; the global sheets
(`MeshCorePage.css`, `src/styles/nodes.css`) are frozen. **Do not add a single
rule to `MeshCorePage.css`.** Keep the module small — a handful of classes:

```
.section        /* block spacing */
.statusGrid     /* 2-col label/value grid, collapses to 1 col under 480px */
.statusLabel .statusValue
.pubkey         /* font-family: var(--font-mono, monospace); word-break: break-all */
.warning        /* var(--ctp-yellow) */
.error          /* var(--ctp-red) */
.actions        /* flex, gap .75rem, wrap */
.panel          /* the inline manual-entry panel; background var(--ctp-surface0) */
.hint           /* 11px, var(--ctp-subtext0) */
```

Use existing Catppuccin CSS variables (`--ctp-red`, `--ctp-yellow`,
`--ctp-green`, `--ctp-surface0`, `--ctp-subtext0`, `--font-mono`) so the
component follows every custom theme. `.statusGrid` must not force horizontal
page scroll on mobile.

Buttons keep the global `btn-secondary` / `btn-primary` classes (as the rest of
this view does) — the module styles layout and semantics only.

---

## 7. Error-code → message map (shared by §5/§6)

Put this in `MeshCoreObserverSection.tsx` as a module-level constant. It maps
codes from Phase 1 spec §7.5 (which explicitly says: "Both use the same code
names so the Phase 3 UI has one mapping table").

| Code | i18n key | Fallback |
|---|---|---|
| `SOURCE_NOT_CONNECTED` | `meshcore.observer.err_not_connected` | "Not connected to the device. Connect the source, then fetch the key again." |
| `EXPORT_FAILED` | `meshcore.observer.err_export_failed` | "The device refused to export its key. Check that it is a Companion (not a repeater) and still connected, then retry." |
| `INVALID_KEY_LENGTH` | `meshcore.observer.err_key_length` | "The key must be exactly 128 hex characters (64 bytes)." |
| `INVALID_KEY_MATERIAL` | `meshcore.observer.err_key_material` | "That is 128 hex characters, but not a valid MeshCore signing key." |
| `CREDENTIAL_PERSISTENCE_DISABLED` | `meshcore.observer.err_no_persistence` | "MeshMonitor cannot store credentials — set a fixed SESSION_SECRET and restart." |
| `INVALID_PARAMETER_TYPE` | `meshcore.observer.err_bad_request` | "The key could not be read from the request." |
| `SOURCE_NOT_FOUND` | `meshcore.observer.err_source_missing` | "This source no longer exists." |
| `INVALID_PARAMETER` | `meshcore.observer.err_not_meshcore` | "The Analyzer Observer applies to MeshCore sources only." |
| `INTERNAL_ERROR` | `meshcore.observer.err_internal` | "Something went wrong on the server. Check the MeshMonitor logs." |
| `null` (transport/network) | `meshcore.observer.err_network` | "Could not reach MeshMonitor. Check your connection and retry." |
| unmapped code | — | render `error.message` verbatim; if that is null, use `err_internal` |

`INVALID_KEY_LENGTH` / `INVALID_KEY_MATERIAL` are returned with **502** on
import (device fault) and **400** on paste (user fault). The message above is
written for the paste case; on the **import** path prefix it with
`meshcore.observer.err_from_device` ("The device returned an unusable key: ")
so the user is not told to fix their own typing when they never typed anything.
Branch on which action was in flight, not on the HTTP status.

Rate limiting: `POST …/key/import` is behind `meshcoreDeviceLimiter`
(`sourceObserverRoutes.ts` L82). A 429 arrives with `retryAfterSeconds`; render
`meshcore.observer.err_rate_limited` ("Too many device requests. Try again in
{{seconds}}s.") when `res.status === 429`.

---

## 8. i18n keys (WP0 — sole owner of `public/locales/en.json`)

Flat dotted keys at the JSON top level (D-8). **`en.json` only.** No key differs
from another by case alone.

### 8.1 Modal fieldset — `meshcore.form.*`

```
meshcore.form.observer                          Analyzer Observer
meshcore.form.observer_enable                   Publish heard packets to a MeshCore Analyzer broker
meshcore.form.observer_help                     Relays every packet this Companion hears to a MeshCore Analyzer MQTT broker so your node counts as an observer. MeshMonitor only publishes — it never receives from the broker or transmits on the mesh. Companion devices only.
meshcore.form.observer_broker_url               Broker URL
meshcore.form.observer_broker_url_help          ws://, wss://, mqtt://, or mqtts://. A bare host:port is accepted and defaults to mqtt://.
meshcore.form.observer_iata                     Region (IATA)
meshcore.form.observer_iata_help                Three-letter IATA code for your region (e.g. MCO for Central Florida), or 'test' for a local broker.
meshcore.form.observer_audience                 Token audience
meshcore.form.observer_audience_help            Must exactly match the broker's expected audience, or authentication is rejected. Ask your region's broker operator.
meshcore.form.observer_key_hint                 The signing key and live publish status are on this source's MeshCore → Configuration page.
meshcore.form.observer_open_config              Configuration
meshcore.form.observer_repeater_note            The Analyzer Observer requires a Companion device — a repeater cannot export the signing key it needs.
meshcore.form.observer_error_broker_required    Broker URL is required
meshcore.form.observer_error_broker_scheme      Broker URL must use ws://, wss://, mqtt:// or mqtts:// (or a bare host:port)
meshcore.form.observer_error_broker_invalid     Broker URL is not a valid address
meshcore.form.observer_error_iata               Region must be a 3-letter IATA code (e.g. MCO) or 'test'
meshcore.form.observer_error_audience           Token audience must be non-empty and contain no spaces
meshcore.form.observer_error_requires_companion The Analyzer Observer requires a Companion device — repeaters cannot export a signing key.
meshcore.form.observer_error_key_in_config      Signing keys are never stored in the source config. Use the Configuration page's Analyzer Observer section.
```

### 8.2 Configuration-view section — `meshcore.observer.*`

```
meshcore.observer.title                 Analyzer Observer
meshcore.observer.intro                 Publishes every packet this node hears to a MeshCore Analyzer MQTT broker. Configure the broker on the source's edit form; manage the signing key here.
meshcore.observer.status_heading        Publisher status
meshcore.observer.status_connected      Connected to broker
meshcore.observer.status_disconnected   Not connected to broker
meshcore.observer.not_configured        Enabled, but the broker URL, region, or audience is missing. Edit the source to complete it.
meshcore.observer.no_key_running        No usable signing key — the publisher will not connect. Import or paste one below.
meshcore.observer.published_count       Packets published
meshcore.observer.dropped_count         Packets dropped
meshcore.observer.dropped_help          Packets heard while the broker socket was down.
meshcore.observer.last_publish          Last publish
meshcore.observer.token_expires         Auth token expires
meshcore.observer.last_error            Last error
meshcore.observer.key_heading           Signing key
meshcore.observer.key_loading           Checking…
meshcore.observer.key_none              No signing key stored. The observer cannot authenticate to the broker until you add one.
meshcore.observer.public_key            Node public key
meshcore.observer.public_key_help       This is the node's public key — safe to share. It is also the broker username and part of the topic path.
meshcore.observer.copy_public_key       Copy public key
meshcore.observer.origin_device         Read from device
meshcore.observer.origin_manual         Entered manually
meshcore.observer.key_updated           Stored
meshcore.observer.key_rotated           The stored signing key can no longer be decrypted — SESSION_SECRET changed since it was saved. The observer will not connect until you re-import or re-paste the key. The public key above is still correct.
meshcore.observer.cannot_store          MeshMonitor cannot store the signing key: {{reason}}
meshcore.observer.cannot_store_fix      Set a fixed SESSION_SECRET and restart to enable observer key storage.
meshcore.observer.fetch_button          Fetch from device
meshcore.observer.fetching              Fetching…
meshcore.observer.fetch_needs_connection Connect to the device first — the key is read over the live link.
meshcore.observer.key_imported          Key saved
meshcore.observer.manual_button         Enter key manually
meshcore.observer.manual_heading        Paste the node's 128-character hex private key
meshcore.observer.manual_placeholder    128-character hex private key
meshcore.observer.manual_invalid_length The key must be exactly 128 hex characters (64 bytes).
meshcore.observer.manual_save           Save key
meshcore.observer.manual_saving         Saving…
meshcore.observer.clear_button          Clear stored key
meshcore.observer.clear_confirm         Forget the stored Analyzer Observer signing key? The observer will stop publishing until a new key is added.
meshcore.observer.clearing              Clearing…
meshcore.observer.err_not_connected     Not connected to the device. Connect the source, then fetch the key again.
meshcore.observer.err_export_failed     The device refused to export its key. Check that it is a Companion (not a repeater) and still connected, then retry.
meshcore.observer.err_key_length        The key must be exactly 128 hex characters (64 bytes).
meshcore.observer.err_key_material      That is 128 hex characters, but not a valid MeshCore signing key.
meshcore.observer.err_no_persistence    MeshMonitor cannot store credentials — set a fixed SESSION_SECRET and restart.
meshcore.observer.err_bad_request       The key could not be read from the request.
meshcore.observer.err_source_missing    This source no longer exists.
meshcore.observer.err_not_meshcore      The Analyzer Observer applies to MeshCore sources only.
meshcore.observer.err_internal          Something went wrong on the server. Check the MeshMonitor logs.
meshcore.observer.err_network           Could not reach MeshMonitor. Check your connection and retry.
meshcore.observer.err_from_device       The device returned an unusable key:
meshcore.observer.err_rate_limited      Too many device requests. Try again in {{seconds}}s.
meshcore.observer.docs_link             Analyzer Observer setup guide
```

Check before adding: `common.never`, `common.cancel`, `common.save` already
exist — reuse rather than adding `meshcore.observer.*` duplicates. Verify with
`node -e "const j=require('./public/locales/en.json'); console.log(j['common.never'], j['common.cancel'])"`.

---

## 9. Documentation (WP4)

### 9.1 New page — `docs/features/meshcore-analyzer-observer.md`

Audience: an operator who has a MeshCore Companion in MeshMonitor and wants
their node to show up as an observer on a regional analyzer (FL Mesh,
LetsMesh). Follow the house voice of `docs/features/meshcore.md`: H2 sections,
short paragraphs, concrete values.

Required sections:

1. **What it is** — MeshMonitor publishes packets your Companion hears to a
   MeshCore-Analyzer-compatible MQTT broker, so you count as an observer
   *without* running a second app that fights over the serial port. **Explicitly
   state: observation-only.** MeshMonitor never subscribes to the broker, never
   injects broker traffic into the mesh, and never transmits on your behalf.
2. **Requirements** — a Companion source (not a repeater / not a room server);
   the source connected at least once for the key import; a fixed
   `SESSION_SECRET` (otherwise the key cannot be stored — link to the existing
   credential-store discussion in `docs/features/meshcore.md` §"Credential
   store"); a broker URL, region code, and token audience from your region's
   operator.
3. **Step 1 — enable and configure** — Dashboard → edit the MeshCore source →
   Analyzer Observer fieldset. Table of the three fields with a worked example
   (LetsMesh: `wss://mqtt-us-v1.letsmesh.net:443`) and a note that a bare
   `host:port` is accepted. Mention that saving observer-only changes **hot-swaps
   the publisher without bouncing the radio link** (Phase 2 deviation (f)) —
   this is a user-visible reassurance worth stating.
4. **Step 2 — provide the signing key** — MeshCore → Configuration → Analyzer
   Observer. "Fetch from device" (preferred) vs manual paste. Explain plainly
   *why* a key is needed: the broker authenticates you as your node by
   verifying an Ed25519 token signed with the node's own key, and the username
   is `v1_{PUBLIC_KEY}`. Explain that the key is stored **encrypted** and is
   never returned by any API. Warn that the pasted key is the node identity.
5. **Step 3 — verify** — the status block: Connected, Packets published
   climbing, Last publish recent. Then what to look for on the analyzer.
6. **Troubleshooting** — a table keyed by what the user sees:
   | Symptom | Cause | Fix |
   |---|---|---|
   | "No signing key stored" | never imported | Fetch from device |
   | `keyRotated` warning | `SESSION_SECRET` changed | re-import / re-paste |
   | Not connected + `lastError` mentioning the token | wrong `tokenAudience` | match the broker's expected audience exactly |
   | Not connected, no error | broker unreachable | check URL/scheme/port |
   | Dropped counter climbing | socket down while packets arrived | expected during a broker outage; not data loss on the mesh |
   | "requires a Companion device" on save | source is a repeater | observer is companion-only |
   Add: counters are cumulative since the publisher started and reset when the
   source reconnects or the observer config changes.
7. **Privacy and what is published** — one row per heard packet: timestamp,
   packet type, route type, hop path hashes, SNR/RSSI, length, packet hash, and
   the **raw hex of the OTA frame**. Encrypted payloads stay encrypted — the
   observer does not decrypt. Plus a retained online/offline status message
   carrying the device name, model, firmware version, and radio parameters.
   State plainly that raw frames of everything the node hears leave your
   network, so operators can make an informed choice.
8. **What it does not do** — no subscribing, no remote-serial / `serial/commands`,
   no advert transmission, no multi-broker fan-out, no `raw`/`decoded`/`debug`
   topics. (From Phase 2 spec §10.)

### 9.2 Sidebar — `docs/.vitepress/config.mts`

Add under the `Protocol-Specific` group (L152-158), after the MeshCore entry:

```ts
{ text: 'MeshCore Analyzer Observer', link: '/features/meshcore-analyzer-observer' }
```

### 9.3 Cross-links

- `docs/features/meshcore.md` — add a short `## Analyzer Observer` section
  (3-4 sentences) near "Remote Administration", linking to the new page.
- The section intro in the UI links to
  `https://meshmonitor.org/features/meshcore-analyzer-observer` via
  `meshcore.observer.docs_link`. Use an absolute `meshmonitor.org` URL, not a
  root-relative path — root-relative doc links rendered inside the app resolve
  against the instance's own base URL (the News-popup bug in the current
  `CHANGELOG.md [Unreleased]`).

### 9.4 `CHANGELOG.md`

Add an `### Added` block under `## [Unreleased]` (it currently has only
`### Changed` and `### Fixed`; `### Added` goes first per Keep a Changelog).
One entry covering the whole epic, in the house style — a bolded lede, then
what it does, what it does not do, and the issue ref `(#4457)`. Mention:
observation-only; companion-only; encrypted key storage; the three config
fields; per-source; hot-swap without a device bounce.

### 9.5 Epic doc — `MESHCORE_ANALYZER_OBSERVER_EPIC.md`

- Tick the three Phase 3 checkboxes (L56-58) and mark the exit criterion.
- Update the `**Status:**` line (L3) to Phase 3 complete.
- Add a `### Phase 3` block under "Deviations / notes" for anything that
  differed from this spec, in the same voice as the Phase 1/2 blocks.
- Post the findings back to #4457 (epic decision 1), including the wire-contract
  confirmation from the live run.

---

## 10. Accessibility & responsiveness (applies to WP2 and WP3)

- Every input has a real `<label>` (wrapping, as the modal does) or an
  `htmlFor`/`id` pair (as `MeshCoreConfigurationView` does for selects). The
  tests query by accessible name; a missing label fails them.
- All error and warning lines carry `role="alert"`.
- Buttons that are disabled for a *reason* carry a `title` explaining it
  (see "Fetch from device" when disconnected).
- The status grid collapses to one column below 480px; nothing in this phase
  may cause horizontal page scroll on mobile.
- Icons are decorative next to text; do not rely on colour alone — every
  warning has text, and the connected indicator has a label beside the icon.

---

## 11. Test plan

All new tests are Vitest + Testing Library, `@vitest-environment jsdom`.
`src/test/setup.ts` mocks `react-i18next` so `t(key, fallback)` returns the key.

### 11.1 `src/components/MeshCore/hooks/useObserverKey.test.tsx` (WP1)

`renderHook` from `@testing-library/react`. Mock `../../../hooks/useCsrfFetch`
to return a `vi.fn()`; mock `../../../init` → `{ appBasename: '' }`.

- **Unwraps the envelope (D-5).** `csrfFetch` resolves `{ ok: true, json: async () => ({ success: true, data: { stored: true, publicKey: 'AB…', origin: 'device', updatedAt: 1, keyRotated: false, canStore: true, reason: null } }) }` → `result.current.status.stored === true` and `result.current.status.publicKey === 'AB…'`. **Explicitly assert `(status as any).success === undefined`** so a future "just use the body" regression fails here.
- Calls the right URLs/methods: `GET /api/sources/s1/observer/key`; `POST …/observer/key/import`; `PUT …/observer/key` with body `{"privateKey":"<raw>"}`; `DELETE …/observer/key`.
- **`setManualKey` sends the raw string** — passing `'  0xAB…  '` puts exactly that in the body (server does the trimming).
- Mutation success replaces `status` from the response **without a second GET** — assert `csrfFetch` call count is exactly 2 (initial load + mutation).
- Error path: `{ ok: false, status: 409, json: async () => ({ success: false, error: 'Source is not connected…', code: 'SOURCE_NOT_CONNECTED' }) }` → `actionError` is `{ code: 'SOURCE_NOT_CONNECTED', message: 'Source is not connected…' }` and `status` is unchanged.
- Non-JSON error body → `actionError.code === null`, no throw.
- `busy` is the action name during flight and `null` after; a second call while busy returns `false` without a request.
- `enabled: false` performs no initial GET.
- No state update after unmount (assert no `act(...)` warning / use the cancelled ref).

### 11.2 `src/components/MeshCore/MeshCoreObserverSection.test.tsx` (WP3)

Mock `./hooks/useObserverKey` (the hook has its own tests),
`../../hooks/useDashboardData` (`useSourceStatuses`), and
`../../contexts/AuthContext` (per `MeshCoreConfigurationView.test.tsx`'s
reassignable `authPermission` pattern).

- Renders the status block when `observer` is on the status; renders **nothing** status-wise when it is absent (the `nodes:read`-stripped case, D-6) while the key block still renders.
- `tokenExpiresAt` is treated as **seconds**: given `Math.floor(Date.now()/1000) + 3600`, the rendered relative time is in the future, not decades in the past. (Assert via a spy on `formatRelativeTime` or by asserting the string does not contain a year-scale unit.)
- `keyRotated: true` renders `meshcore.observer.key_rotated` with `role="alert"`.
- `canStore: false` renders `meshcore.observer.cannot_store` **and** disables Fetch + Manual, while **Clear stays enabled**.
- `stored: false` disables Clear.
- Fetch button is disabled with a `title` when `connected: false`; enabled when `connected: true`.
- Clicking Fetch calls `importFromDevice`; a rejected `SOURCE_NOT_CONNECTED` renders `meshcore.observer.err_not_connected`.
- Manual panel: entering 100 hex chars and saving does **not** call `setManualKey` and renders `meshcore.observer.manual_invalid_length`; 128 hex chars calls it once with the entered value.
- Manual input is `type="password"`.
- Clear asks `window.confirm` (stub it) and does nothing when the user cancels.
- `configuration:write` denied → the whole actions block is absent while the status/key display remains.
- **The private key never reaches the DOM after save:** after a successful `setManualKey`, `container.innerHTML` does not contain the hex string.

### 11.3 `src/pages/DashboardPage.observerConfig.test.ts` (WP2)

Pure, fast, no DOM. Cover every row of §3.1 and §3.2:

- Disabled form → `{ config: undefined }`, and **no error even with garbage in the other fields** (mirrors the server's check 5).
- `wss://host:443`, `ws://h`, `mqtt://h`, `mqtts://h`, and bare `host:443` all pass.
- `http://h`, `https://h`, `tcp://h`, `tls://h` → `observer_error_broker_scheme`.
- `iataCode`: `MCO` ok; `mco` ok; `test` ok; `TEST` ok; `MC` / `MCOX` / `12` / `''` → `observer_error_iata`.
- `tokenAudience`: `''`, `'  '`, `'a b'`, `'a\tb'`, 256 chars → `observer_error_audience`; 255 chars ok.
- Build output normalizes: `brokerUrl` trimmed, `iataCode` uppercased, `tokenAudience` trimmed, `enabled: true`.
- `observerFormFromConfig`: `undefined`, `null`, `42`, `'x'`, `[]`, `{}` all → `emptyObserverForm()`; a full block round-trips; a partial block fills the missing fields with `''`.
- `observerErrorMessageKey`: each mapped code; `undefined`/`null`/`'INVALID_PARAMETER'`/`'NOPE'` → `null`.

### 11.4 `src/pages/DashboardPage.observerFieldset.test.tsx` (WP2)

Copy the entire mock block from `DashboardPage.meshcoreAdminCheckbox.test.tsx`
(it is the working, complete set: `useDashboardData`, `useMapAnalysisData`,
`AuthContext`, `CsrfContext`, `SettingsContext`, `DashboardSidebar` stub with
an `edit-{name}` button, `DashboardMap`, `LoginModal`, `init`, and the
`useNavigate` mock). Give the fixture source an `observer` block.

- Pre-populates all four controls from `config.observer`.
- Fields are hidden until the enable checkbox is checked, and appear after.
- Save persists `config.observer` with the normalized values (assert on the `PUT /api/sources/src-mc` body, exactly as the reference test does).
- Unchecking enable and saving persists `config.observer.enabled === false` (§4.4).
- A source with **no** `observer` block loads with the checkbox unchecked and saves `enabled: false`, without disturbing `config.virtualNode`.
- Client-side rejection: IATA `'XX'` blocks the save (**no `fetch` call**) and renders `meshcore.form.observer_error_iata`.
- `deviceType: 'repeater'` → enable checkbox disabled and `meshcore.form.observer_repeater_note` visible.
- Server error surfacing: `fetch` resolves `{ ok: false, status: 400, json: async () => ({ success:false, error:'…', code:'OBSERVER_REQUIRES_COMPANION' }) }` → `meshcore.form.observer_error_requires_companion` is rendered. (Check how `ApiService` shapes `ApiError` from that response and match it; if the mock shape fights you, assert the mapping through `observerErrorMessageKey` in 11.3 and keep this case to a smoke check.)

### 11.5 Suite hygiene (WP5)

- Full `npm test` — **0 failures**. Confirm `success: true` via the JSON reporter, not the summary line (`rtk` summaries hide suite-level failures).
- Frontend-only phase: PostgreSQL/MySQL containers are **not** required (no schema or migration change). State that in the PR so a reviewer does not ask.
- `npx tsc --noEmit`.
- `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → **empty**.
- `eslint-baseline.json` must be **unchanged**. If a rule count would grow, fix the code — do not regenerate the baseline.

---

## 12. Work packages

Exclusive file ownership is listed per package. **Two packages must never edit
the same file.** `public/locales/en.json` is owned only by WP0;
`DashboardPage.tsx` only by WP2; `MeshCoreConfigurationView.tsx` only by WP3.

### WP0 — i18n keys (~20 min, start first, blocks nobody)

**Owns:** `public/locales/en.json`

Add every key in §8 verbatim. Flat top-level dotted strings. Do not touch the
other nine locale files.

**Acceptance:**
- `node -e "const j=require('./public/locales/en.json'); const need=[/* paste the §8 key list */]; const miss=need.filter(k=>!(k in j)); console.log(miss.length ? miss : 'all present')"` prints `all present`.
- `git diff --stat` shows exactly one file changed.
- JSON parses; no duplicate keys (`node -e "JSON.parse(require('fs').readFileSync('public/locales/en.json','utf8'))"` plus a manual duplicate scan).
- No key added that already exists (`common.never`, `common.cancel`, `common.save` reused, not duplicated).

### WP1 — `useObserverKey` hook (parallel with WP0, WP2, WP4)

**Owns:** `src/components/MeshCore/hooks/useObserverKey.ts`,
`src/components/MeshCore/hooks/useObserverKey.test.tsx`

Implement §5 exactly, including the D-5 unwrap and the seconds-vs-ms note being
*out* of this file (the hook returns raw server values; the component converts).

**Acceptance:**
- All §11.1 tests pass.
- No raw `fetch(` in the file — `useCsrfFetch` only.
- Zero new `react-hooks/exhaustive-deps` violations; no `eslint-disable` added.
- No `console.*` and no logging of `privateKey` anywhere.
- `npx tsc --noEmit` clean.

### WP2 — Modal fieldset + pure config module (parallel with WP0, WP1, WP4)

**Owns:** `src/pages/DashboardPage.observerConfig.ts`,
`src/pages/DashboardPage.observerConfig.test.ts`,
`src/pages/DashboardPage.tsx`,
`src/pages/DashboardPage.observerFieldset.test.tsx`

Implement §3 and §4. **This is the only package permitted to open
`DashboardPage.tsx`.** Keep the edit to the five sites in §4.

**Acceptance:**
- §11.3 and §11.4 tests pass.
- `git diff --stat src/pages/DashboardPage.tsx` shows **under ~90 added lines**, and the diff contains no logic beyond the five §4 sites.
- `eslint-baseline.json` entry for `src/pages/DashboardPage.tsx` still reads `{"@typescript-eslint/no-explicit-any": 10}` after `npm run lint:ci`.
- No raw `fetch(`; no hardcoded emoji; every new string goes through `t(key, fallback)`.
- The MeshCore modal still saves a source **without** an observer block unchanged (regression: the existing `DashboardPage.meshcoreAdminCheckbox.test.tsx` must still pass untouched).

### WP3 — Observer section component (depends on WP1)

**Owns:** `src/components/MeshCore/MeshCoreObserverSection.tsx`,
`src/components/MeshCore/MeshCoreObserverSection.module.css`,
`src/components/MeshCore/MeshCoreObserverSection.test.tsx`,
`src/components/MeshCore/MeshCoreConfigurationView.tsx` (the single mount edit
in §6.1 — nothing else in that file)

Implement §6 and §7.

**Acceptance:**
- §11.2 tests pass.
- `MeshCorePage.css` and `src/styles/nodes.css` are **untouched** (`git diff --name-only` proves it).
- `eslint-baseline.json` entry for `MeshCoreConfigurationView.tsx` still reads `{"react-hooks/exhaustive-deps": 3}`.
- Icons come from `UiIcon`; no emoji, no inline SVG.
- The existing `MeshCoreConfigurationView.test.tsx` passes unchanged (the new mount must not break the sections it asserts on — note those tests render **without** a `sourceId`, so the observer section must not render there).
- Manual-entry input is `type="password"`; the key never appears in the DOM after save.

### WP4 — Documentation (parallel with everything)

**Owns:** `docs/features/meshcore-analyzer-observer.md` (new),
`docs/.vitepress/config.mts`, `docs/features/meshcore.md`, `CHANGELOG.md`,
`docs/internal/dev-notes/MESHCORE_ANALYZER_OBSERVER_EPIC.md`

Implement §9.

**Acceptance:**
- The new page covers all eight §9.1 sections, including the privacy section and the observation-only statement.
- `npm run docs:build` (or the repo's equivalent) succeeds with no dead-link warnings for the new page.
- The sidebar entry renders under Protocol-Specific.
- `CHANGELOG.md` has an `### Added` entry under `## [Unreleased]` referencing `#4457`.
- No screenshots referenced that do not exist in `docs/images/`.

### WP5 — Verification, browser validation, PR (sequential, last)

**Owns:** nothing exclusively; fixes across files as needed after the review
loop, with the owning package's author consulted for anything non-trivial.

- Full suite, `tsc --noEmit`, `lint:ci` (all per §11.5).
- Deploy the dev container from **this worktree** with `-f docker-compose.dev.yml -f docker-compose.dev.local.yml` (the USB/`group_add` override) and verify the built frontend is the branch's, not a cached one.
- Run §13's browser validation script.
- Update the epic doc's Phase 3 deviations with anything that differed.
- Open the PR; run `/ci-monitor`.

### Dependency graph

```
WP0 (locales)   ─────────────────────────────┐
WP1 (hook) ──────────────> WP3 (section) ────┤
WP2 (modal + pure module) ───────────────────┼──> WP5 (verify + browser + PR)
WP4 (docs) ──────────────────────────────────┘
```

WP0, WP1, WP2, WP4 start simultaneously. WP3 starts when WP1's hook signature
is on the branch (it can start against the §5 signature immediately and rebase).

---

## 13. Browser validation script (for the orchestrator, chrome-devtools MCP)

Run after WP5's deploy. App at `http://localhost:8080/meshmonitor`, login
`admin` / `changeme`. Use a MeshCore **Companion** source (e.g. "Yeraze MC
Sandbox"). **Real mouse events** (`page.mouse` / the MCP `click` on a snapshot
uid), not synthetic `dispatchEvent` — synthetic events bypass hit-testing.

**V1 — Fieldset appears and validates (create path)**
1. Dashboard → **Add Source** → Type = MeshCore.
2. Assert an "Analyzer Observer" fieldset is present with an unchecked enable checkbox and **no** broker/region/audience inputs.
3. Check the box → assert the three inputs and their hints appear.
4. Assert the key hint text is present and the "Configuration" cross-link button is **absent** (create mode has no `editingSourceId`).
5. Set Device Type = Repeater → assert the enable checkbox is disabled and the repeater note is shown. Set it back to Companion.
6. Cancel out.

**V2 — Fieldset seeds and saves (edit path)**
1. Edit the Companion source. Scroll to the Analyzer Observer fieldset.
2. Check enable; broker `wss://mqtt-us-v1.letsmesh.net:443`; region `mco`; audience `meshcore-mqtt`.
3. Click Save. Assert the modal closes and no error line appeared.
4. Re-open the edit modal. Assert enable is checked, broker is the URL typed, region reads **`MCO`** (uppercased on build), audience is `meshcore-mqtt`.
5. **Network assertion:** the `PUT /api/sources/<id>` request body contains `config.observer = {enabled:true, brokerUrl:"wss://mqtt-us-v1.letsmesh.net:443", iataCode:"MCO", tokenAudience:"meshcore-mqtt"}`.
6. **No device bounce:** in the container logs, the save produces no MeshCore reconnect — the hot-swap branch fires. (`docker logs <container> --since 30s | grep -i -E "reconnect|disconnect|reconfigureObserver"`.)

**V3 — Client-side validation**
1. In the edit modal, set region to `XX`, click Save.
2. Assert the red form error reads the IATA message and **no `PUT /api/sources/…` request was issued** (check the network log).
3. Restore `MCO`.

**V4 — Key management (Configuration view)**
1. Navigate to the source → MeshCore → **Configuration**. Expand **Analyzer Observer**.
2. With no key stored: assert "No signing key stored", **Clear disabled**, **Fetch enabled** (source is connected).
3. Click **Fetch from device**. Assert `POST /api/sources/<id>/observer/key/import` returns 200 and the panel now shows a truncated public key, origin "Read from device", and a "Stored <relative time>" line.
4. Assert the **full 128-hex private key is nowhere in the DOM**: `document.body.innerText.match(/[0-9a-fA-F]{128}/)` is `null`.
5. Click the copy button on the public key → assert no exception in the console (on plain HTTP the `window.prompt` fallback fires; dismiss it).
6. Click **Enter key manually**, type 100 hex chars, Save → assert the length error appears and **no `PUT`** was issued. Cancel.
7. Click **Clear stored key** → accept the confirm → assert `DELETE` 200 and the panel returns to "No signing key stored".
8. Re-import with **Fetch from device** so the source is left working.

**V5 — Disconnected behaviour**
1. Disconnect the source from the dashboard.
2. Return to Configuration → Analyzer Observer. Assert the section still renders, the key status still loads (a `GET` succeeded), and **Fetch from device** is disabled with a tooltip.
3. Reconnect.

**V6 — Live status panel**
1. With the observer enabled, a key stored, and a reachable broker (run `meshcore-mqtt-broker` locally with `test` region per Phase 2 spec §8.1, and set region `test` + the broker's audience), wait for the 15 s poll.
2. Assert: Connected indicator on; "Packets published" > 0 after traffic; "Last publish" shows a recent relative time; "Auth token expires" is a **future** time (this is the seconds-vs-ms bug detector — if it reads decades ago, the ×1000 is missing).
3. Break it: set `tokenAudience` to `wrong-audience` and save. After the next poll, assert the Connected indicator goes off and a "Last error" line appears mentioning the token/audience. Restore the correct audience and assert recovery.

**V7 — Permissions**
1. In a fresh anonymous/incognito context (no login), open the source's MeshCore Configuration page. Assert either the Configuration view is not reachable at all, or — if anonymous `configuration:read` is granted on this instance — the **actions block is absent** and no key mutation controls render.
2. Assert `GET /api/sources/<id>/status` for that context contains **no** `observer` key (D-6), and the status block is correspondingly absent rather than rendering zeros.

**V8 — Mobile layout**
1. Resize to 390×844. Assert the observer fieldset and the Configuration section both fit with **no horizontal page scroll** (`document.documentElement.scrollWidth <= window.innerWidth`).

**V9 — Console hygiene**
1. Across V1-V8, assert no uncaught errors and no React key/`act` warnings in the console log.

---

## 14. Explicitly OUT OF SCOPE for Phase 3

A PR containing any of these will be sent back.

- **Any backend change.** Two things looked like they might force one and do
  not: (1) the status route already strips `observer` for non-`nodes:read`
  callers (Phase 2 §4.1), so no new gating is needed; (2) the four key routes
  already return everything the UI needs in one shape, so no new endpoint and
  no `GET`-shape change. If you believe a backend change is genuinely forced,
  stop and raise it — do not sneak it in.
- **New global settings** or `VALID_SETTINGS_KEYS` entries. Everything is
  per-source.
- **New permissions or permission resources.** The observer rides on
  `configuration:read`/`configuration:write` (key routes) and `nodes:read`
  (status visibility). No new resource, no new middleware.
- **Migrations, schema, repositories, raw SQL.**
- **Deep-linking into a MeshCore sub-view** (`#configuration` hash sync in
  `MeshCorePage`, `VALID_TABS` additions). D-7.
- **Translating the new strings into the other nine locale files.** D-8.
- **Any subscribe path, remote-serial UI, or `serial/commands` surface.** The
  epic's headline invariant is observation-only, and it applies to the UI too:
  no control that could make MeshMonitor consume from the broker.
- **Displaying, exporting, or copying the observer *private* key** anywhere in
  the UI, including a "reveal" toggle on the paste field. The API never returns
  it and the UI must never hold it after a successful save.
- **A published-packet viewer / observer packet log.** The MeshCore Packet
  Monitor already shows what the node hears; a second observer-specific feed is
  a separate feature.
- **Multi-broker fan-out UI**, `raw`/`decoded`/`debug` topic toggles, or an
  advert privacy-filter control — none of these exist on the backend
  (Phase 2 §10).
- **Cascade cleanup of `meshcore_observer_keys` on source delete.** Still a
  known gap with its own change (Phase 1 deviations).
- **Converting neighbouring handlers or components to `ApiService` / the
  response envelope.** Touch only what this phase adds.
- **Regenerating `eslint-baseline.json`.**
