# MeshMapper Observer — Phase 2 spec (UI: broker list, presets, status)

**Issue:** #5014 · **Epic doc:** `MESHMAPPER_OBSERVER_EPIC.md` · **Phase 1 spec:**
`MESHMAPPER_OBSERVER_PHASE1_SPEC.md` (merged as PR #5022, commit `02d20b55`)

Phase 2 is UI + docs only. **No server file changes, no migration, no protobuf,
no new route.** Every backend contract this spec consumes already shipped in
Phase 1 and was re-verified against the merged tree while writing this document
(see §1.6 "Verified against the merged code").

---

## 0. Mesh impact checklist

Run per CLAUDE.md, and the answer is short:

1. **Airtime:** zero. This phase sends no LoRa packets, arms no radio timer, and
   changes nothing about what the observer publisher relays. The publisher
   itself is passive (it forwards packets the radio already heard) and was
   built in Phase 1.
2. **Spam:** none. No message send, no `dataEventEmitter` fan-out, no
   automation trigger, no notification.
3. **Safety timer reset:** none. Saving the source config restarts the
   publisher via the existing `reconfigureObserver` path, which is the
   pre-existing Phase 1/#4457 behaviour and carries no last-fire timestamp.

The only new recurring cost is HTTP: one `GET /api/sources/:id/observer/status`
every 15 s, and only while a user has the MeshCore Configuration view open on a
MeshCore source (§5.2). That reuses the existing dashboard poll cadence rather
than inventing a new one. Nothing to ask the project owner about.

---

## 1. Reuse inventory (mandatory — read before writing code)

### 1.1 Form ↔ config mapping module

`src/pages/DashboardPage.observerConfig.ts` (191 lines) is the pattern and it
is **extended, not replaced**. It already carries every convention Phase 2
needs:

- Pure functions, zero React, zero network — unit-tested in
  `DashboardPage.observerConfig.test.ts` (30 cases).
- `ObserverForm` (all-strings form state) ↔ `ObserverConfigWire` (persisted
  shape), with `emptyObserverForm()` / `observerFormFromConfig(config: unknown)`
  / `buildObserverConfig(form)`.
- Error shape `{ key, fallback }` — **i18n inputs, not rendered text**. The
  caller does `t(key, fallback)`.
- `observerErrorMessageKey(code)` maps a server error `code` onto an i18n key.
- The module deliberately mirrors the server's `validateObserverConfig` for
  fast feedback and says so in its header; the server stays the authority.

Sibling precedents for the same split: `DashboardPage.bboxSeed.ts`,
`src/components/MQTT/mqttBridgeConfig.ts`.

**Nothing new is invented here.** Phase 2 adds a `brokers` array to
`ObserverForm`, three preset constants, and three more validation checks —
inside the existing module, in the existing style.

### 1.2 Fieldset markup + styling conventions

`src/pages/DashboardPage.tsx` ~L1692–1748 holds the whole observer fieldset:

- `<fieldset>` + `<legend>` with inline styles using `var(--color-*)` semantic
  tokens (never `--ctp-*`).
- Text inputs use the global classes `dashboard-form-field` /
  `dashboard-form-label` / `dashboard-form-input`.
- Repeated fields render via `OBSERVER_FIELDS.map(...)` rather than copy-paste.
- `<select>` elements carry an explicit `aria-label`, because the wrapping
  `<label>` also contains the help `<p>` and the implicit accessible name would
  be label-plus-help concatenated. **Keep doing this** — the existing tests
  query by accessible name.
- Existing tests query inputs by `placeholder`; the placeholder strings are
  therefore load-bearing test selectors (§7.1 covers the churn).

Phase 2's broker rows need real layout (a repeating card with a remove button),
which inline styles handle badly. Per the CSS-containment rule, the new layout
goes in a **new CSS module** `src/pages/DashboardPage.observerBrokers.module.css`
— not into `src/styles/dashboard.css` (frozen) and not into more inline style
objects. Everything that already works as an inline style stays inline; only the
new repeating-row layout moves to the module.

### 1.3 Status polling + API access

Three existing mechanisms, each reused for exactly one job:

| Need | Existing mechanism | Phase 2 use |
|---|---|---|
| Compact per-source indicator on the dashboard card | `useSourceStatuses(sourceIds)` in `src/hooks/useDashboardData.ts` — `useQueries`, `refetchInterval: DASHBOARD_POLL_INTERVAL` (15 s), `retry: false`. `DashboardPage.tsx` already calls it and passes `statusMap` to `DashboardSidebar`. | **Zero new requests.** `MeshCoreManager.getStatus()` already embeds the full `MeshCoreObserverStatus` (including `brokers[]`) as `status.observer` — verified at `meshcoreManager.ts:6385-6391`. The badge reads the already-polled map. |
| Per-broker detail panel | `GET /api/sources/:id/observer/status` (Phase 1, `sourceObserverRoutes.ts`) | New `useObserverStatus` hook, `useQuery` + `refetchInterval: DASHBOARD_POLL_INTERVAL`, mirroring `useSourceStatuses`. |
| HTTP from a page/component | `ApiService` (`src/services/api.ts`) — generic `get<T>` / `put<T>` / `post<T>` at L365–383 wrapping `request<T>`; `DashboardPage.tsx` already imports `api` and `ApiError`. | Two typed methods added (§4.1). |

Raw `fetch()` is ESLint-banned in `src/components/**` and `src/pages/**`
(`eslint.config.mjs` L163–172, selector `callee.name === 'fetch'`). The existing
observer hooks (`useObserverKey`, `useObserverCredentials`) call
`csrfFetch(...)` from `useCsrfFetch` — a call to a *variable*, so it does not
trip the rule. **Both paths are legal.** New code uses `ApiService` (the
preferred direction per the rule's own message), which also gives WP2 and WP3 a
single typed surface.

### 1.4 Status-rendering components

`src/components/MeshCore/MeshCoreObserverSection.tsx` (685 lines) is the
existing observer status + credential surface, mounted by
`MeshCoreConfigurationView.tsx:550` — which is what `MeshCoreSourcePage.tsx`
renders (page → `MeshCorePage` → `MeshCoreConfigurationView` → this section).
**"Per-broker detail on MeshCoreSourcePage" therefore means a child of this
section, not new code on the page file.** `MeshCoreSourcePage.tsx` is not
touched.

Reuse from it verbatim:

- `CollapsibleSection` (`src/components/MeshCore/CollapsibleSection.tsx`).
- `MeshCoreObserverSection.module.css` classes: `.statusGrid` (two-column
  `max-content 1fr`, collapses to one column under 480 px), `.statusLabel`,
  `.statusValue`, `.warning`, `.error`, `.hint`.
- `formatRelativeTime` from `src/utils/datetime` for `lastPublishAt`
  (milliseconds).
- The `tokenExpiresAt` rule, learned in #4457 Phase 3 browser validation:
  it is **unix seconds**, and it must render as an *absolute* local time
  (`new Date(x * 1000).toLocaleString()`), because `formatRelativeTime` clamps
  future timestamps to "just now" — which reads wrong for a +24 h expiry.
- The D-6 silence convention: an absent `observer` slice is not an error
  (either not running or the caller lacks the permission); render nothing.
- `UiIcon name="statusOn" | "statusOff" | "alert"` — already in
  `UI_ICON_DEFINITIONS`. **No emoji, no Unicode stand-ins** (CLAUDE.md).

### 1.5 Badge slot on the dashboard source card

`src/components/Dashboard/DashboardSidebar.tsx` ~L598–612 renders the card
header. The Virtual Node badge there is the exact precedent for a compact,
config-derived indicator:

```tsx
{!isUnified && (() => {
  const vn = (source.config as any)?.virtualNode;
  return vn?.enabled ? (
    <span className="dashboard-source-card-badge" title={t('source.virtual_node_badge_title')}>
      VN:{vn.port}
    </span>
  ) : null;
})()}
```

The observer badge slots in beside it, same `dashboard-source-card-badge`
class (a *use* of a frozen global class, not an addition to a frozen sheet).
`DashboardSidebar.module.css` already exists if a small alignment tweak is
needed.

### 1.6 Verified against the merged code (do not trust the Phase 1 spec text)

Checked in the worktree at `ab663555`:

- `MeshCoreObserverBrokerConfig` = `{ url; authMode?; tokenAudience?; label? }`
  (`meshcoreConfig.ts:112-127`). `label` max 64 chars, UI-only, never on the
  wire.
- `normalizeObserverBrokers` precedence (`meshcoreConfig.ts:206+`): a non-empty
  `brokers` array wins outright — `brokerUrl` is **not** unioned in. Entry
  `authMode` falls back to the block-level `authMode`; entry `tokenAudience`
  is **never** inherited from the block level (only the synthesized legacy
  entry gets it).
- `observerConfigFromSource` returns `undefined` unless `enabled && iataCode &&
  brokers.length > 0`.
- `validateObserverConfig` (`sourceRoutes.ts:159+`): `MAX_OBSERVER_BROKERS = 8`
  (`TOO_MANY_BROKERS`), `MAX_OBSERVER_CONFIG_BYTES = 1536` on the observer block
  alone (`OBSERVER_CONFIG_TOO_LARGE`), `DUPLICATE_BROKER_URL` on normalized-key
  collision, `MISSING_BROKER` only when `brokers` was explicitly provided,
  yields nothing usable, **and** there is no legacy `brokerUrl`. The
  `enabled !== true` early return happens *before* the broker-requirement
  branch, so a disabled block never hits URL/audience/`MISSING_BROKER` checks
  (this is what makes §3.4's disabled round-trip safe).
- `GET /observer/status` returns the envelope `{ success: true, data: { running,
  ...MeshCoreObserverStatus } }` — `running: true` from a live publisher,
  `running: false` plus a config-derived snapshot otherwise (all counters
  zeroed, every configured broker `configured: true, keyStored: false,
  connected: false`). Gated `requirePermission('configuration','read')`.
- Credential `PUT`/`DELETE` accept an **optional** `brokerKey`; absent = the
  legacy single-credential path. A present key is bounded against the source's
  currently *configured* brokers → `UNKNOWN_BROKER` (400) otherwise. **Order
  matters: the config save must land before the credential PUT**, or the key is
  not yet configured and the PUT 400s.
- `observerBrokerKey(url) = normalizeBrokerUrl(url).toLowerCase()`, and
  `normalizeBrokerUrl` (`mqttBrokerClient.ts:504`) passes an explicit
  `mqtt|mqtts|ws|wss|tcp|tls` scheme through untouched. So for every preset the
  key is simply the lowercased URL, e.g. `wss://mqtt.meshmapper.net:443`.
- **`storeForBroker` is read-modify-write and says so**
  (`meshcoreObserverCredentialStore.ts:259-262`): *"If a future UI ever
  batch-saves N brokers in one gesture, it MUST serialize those PUTs."* Phase 2
  is that UI. §3.5 serializes them.
- `GET /observer/credentials` returns `{ ...status, brokers: Array<{brokerKey,
  username}> }` — the array is always present on the route response even when
  empty.
- The source-status route strips `observer` for callers without `nodes:read`
  (`sourceRoutes.ts:1487-1494`) — the badge must degrade, not break (§5.1).

### 1.7 Presets — verified, not assumed

The brief said to mark LetsMesh audiences as an assumption. **They are not an
assumption.** The upstream reference implementation ships the values verbatim:

- `agessaman/meshcore-packet-capture` → `presets/meshmapper.toml`:
  `server = "mqtt.meshmapper.net"`, `port = 443`, `transport = "websockets"`,
  `[broker.auth] method = "token"`, `audience = "mqtt.meshmapper.net"`.
- `presets/letsmesh.toml`: `letsmesh-us` → `mqtt-us-v1.letsmesh.net` / 443 /
  websockets / token / `audience = "mqtt-us-v1.letsmesh.net"`; `letsmesh-eu` →
  `mqtt-eu-v1.letsmesh.net` / 443 / websockets / token /
  `audience = "mqtt-eu-v1.letsmesh.net"`.

All three are host-as-audience, token mode, WSS on 443 — which is exactly the
MeshMapper wiki's documented value for its own broker. No assumption remains.

### 1.8 i18n

Every string goes through `t(key, fallback)`. Translations live in
`public/locales/*.json`; **only `public/locales/en.json` is hand-edited** —
Weblate populates the rest. Existing key namespaces to extend:
`meshcore.form.observer_*` (the fieldset) and `meshcore.observer.*` (the status
section). `src/config/i18nLanguageCoverage.test.ts` measures non-empty-value
coverage and is unaffected by adding English keys.

---

## 2. Scope

**In:** broker-list editor with presets in the Dashboard observer fieldset;
legacy→`brokers[0]` migration on save; per-broker password credentials; compact
observer badge on the dashboard source card; per-broker status panel under the
existing Analyzer Observer section; user docs.

**Out:** filtering / rate limiting / bbox (deferred per the epic's interview
decision 2); repeater support; any server change; a "test connection" button;
per-broker enable/disable toggles (remove the row instead).

---

## 3. Form state + mapping (`DashboardPage.observerConfig.ts`)

### 3.1 New and changed types

```ts
/** One editable broker row. `id` is a client-only React key + row identity;
 *  it is NEVER persisted and is NOT the server's brokerKey. */
export interface ObserverBrokerForm {
  id: string;
  url: string;
  authMode: ObserverAuthMode;
  tokenAudience: string;
  label: string;
}

/** Modal form state. `brokerUrl` / `tokenAudience` / block-level `authMode`
 *  are GONE — every broker property now lives on its row (#5014 Phase 2). */
export interface ObserverForm {
  enabled: boolean;
  iataCode: string;
  brokers: ObserverBrokerForm[];
}

/** One broker as persisted inside `sources.config.observer.brokers[]`. */
export interface ObserverBrokerWire {
  url: string;
  authMode: ObserverAuthMode;
  /** Omitted entirely in password mode. */
  tokenAudience?: string;
  /** Omitted entirely when blank. */
  label?: string;
}

/** The observer block as persisted. NOTE: no `brokerUrl`, no top-level
 *  `tokenAudience` — writing this object is what clears the legacy fields
 *  (§3.4). `authMode` survives only as the block-level default/mirror. */
export interface ObserverConfigWire {
  enabled: boolean;
  authMode: ObserverAuthMode;
  iataCode: string;
  brokers: ObserverBrokerWire[];
}
```

`ObserverAuthMode` and `observerErrorMessageKey` are unchanged.

### 3.2 New constants + helpers

```ts
/** MUST match MAX_OBSERVER_BROKERS in src/server/routes/sourceRoutes.ts.
 *  Duplicated rather than imported — pages must not pull from src/server
 *  (same rule as MAX_HOP_LIMIT in DashboardPage.tsx). */
export const MAX_OBSERVER_BROKERS = 8;

/** Client mirror of the server's observerBrokerKey():
 *  normalizeBrokerUrl(url).toLowerCase(). Used ONLY for client-side duplicate
 *  detection — never sent to the server, which re-derives it. */
export function observerBrokerFormKey(url: string): string;

export interface ObserverBrokerPreset {
  id: 'meshmapper' | 'letsmesh_us' | 'letsmesh_eu' | 'custom';
  labelKey: string;
  labelFallback: string;
  /** Blank for 'custom'. */
  url: string;
  tokenAudience: string;
  /** Persisted `label`. Blank for 'custom'. */
  label: string;
}

export const OBSERVER_BROKER_PRESETS: readonly ObserverBrokerPreset[];

/** Fresh row from a preset, with a generated `id`. */
export function observerBrokerFormFromPreset(preset: ObserverBrokerPreset): ObserverBrokerForm;

/** Blank token-mode row with a generated `id`. */
export function emptyObserverBrokerForm(): ObserverBrokerForm;
```

Preset table (values verified in §1.7):

| id | label | url | tokenAudience | authMode |
|---|---|---|---|---|
| `meshmapper` | `MeshMapper` | `wss://mqtt.meshmapper.net:443` | `mqtt.meshmapper.net` | `token` |
| `letsmesh_us` | `LetsMesh US` | `wss://mqtt-us-v1.letsmesh.net:443` | `mqtt-us-v1.letsmesh.net` | `token` |
| `letsmesh_eu` | `LetsMesh EU` | `wss://mqtt-eu-v1.letsmesh.net:443` | `mqtt-eu-v1.letsmesh.net` | `token` |
| `custom` | (i18n "Custom…") | `''` | `''` | `token` |

`observerBrokerFormKey` implementation mirrors `normalizeBrokerUrl` exactly:
trim; if `/^(mqtt|mqtts|ws|wss|tcp|tls):\/\//i` then pass through; else if the
text after the last `:` parses to 8883 or 8884 prefix `mqtts://`; else prefix
`mqtt://`. Then `.toLowerCase()`. Carry a comment naming
`src/server/transports/mqttBrokerClient.ts` as the original.

Row `id`: `crypto.randomUUID()` when available, else a module-level
monotonically-increasing counter (`obs-broker-${++n}`). jsdom in Vitest has
`crypto.randomUUID`, but the fallback keeps the module free of an environment
assumption.

### 3.3 `observerFormFromConfig` — the legacy → `brokers[0]` migration

Reads the persisted block and produces rows. This is where legacy configs get
lifted, and it **must mirror `normalizeObserverBrokers`' precedence exactly**
(§1.6):

```
blockAuthMode = c.authMode === 'password' ? 'password' : 'token'

if Array.isArray(c.brokers) && c.brokers.length > 0:
    rows = c.brokers.map(entry => ({
      id: newId(),
      url:          string(entry.url)            ?? '',
      authMode:     entry.authMode === 'password' ? 'password'
                  : entry.authMode === 'token'    ? 'token'
                  : blockAuthMode,                       // rule: entry defaults to block
      tokenAudience: string(entry.tokenAudience)  ?? '',  // NEVER inherit block-level
      label:         string(entry.label)          ?? '',
    }))
else if typeof c.brokerUrl === 'string' && c.brokerUrl.trim() !== '':
    rows = [{                                            // legacy → brokers[0]
      id: newId(),
      url: c.brokerUrl,
      authMode: blockAuthMode,
      tokenAudience: string(c.tokenAudience) ?? '',       // the ONE inheriting case
      label: '',
    }]
else:
    rows = []

return { enabled: c.enabled === true, iataCode: string(c.iataCode) ?? '', brokers: rows }
```

Tolerances preserved from the current implementation: a non-object / null /
array `config` yields `emptyObserverForm()`; a non-object entry inside
`brokers` yields an all-blank row rather than throwing (it will then fail
check 3 on save with a row-numbered message, which is the correct feedback).

**Migration is realised on save, not on load.** Loading a legacy source shows
one row pre-filled from `brokerUrl`; saving writes `brokers: [...]` with no
`brokerUrl` key, and the stale field is gone. A user who opens and cancels the
modal changes nothing.

### 3.4 `buildObserverConfig` — validation + build

Signature grows an optional interpolation bag on the error:

```ts
export function buildObserverConfig(form: ObserverForm): {
  config?: ObserverConfigWire;
  error?: { key: string; fallback: string; params?: Record<string, string | number> };
};
```

The caller becomes `t(err.key, err.fallback, err.params)` — the three-arg
`t(key, defaultValue, options)` overload, already used elsewhere (see the
`TFunc` alias in `MeshCoreObserverSection.tsx`). Fallbacks use `{{index}}` /
`{{label}}` placeholders.

**Row sanitisation, run first in both branches:** drop rows whose `url.trim()`
is empty **and** whose `label.trim()` and `tokenAudience.trim()` are also empty
(an untouched blank row the user added and abandoned). A row with a blank URL
but other content is kept, so it fails check 3 loudly instead of vanishing.

**Check 0 — disabled.** Return a disabled block that *preserves the operator's
work*, so a disable → re-enable round-trip does not wipe the broker list:

```ts
{ enabled: false,
  authMode: rows[0]?.authMode ?? 'token',
  iataCode: form.iataCode.trim().toUpperCase(),
  brokers: rows.map(toWire) }
```

Safe because the server's `enabled !== true` early return precedes every
URL/audience/`MISSING_BROKER` check (§1.6). Rows are still capped at
`MAX_OBSERVER_BROKERS` here (check 2 runs before check 0's return) so a disabled
block cannot trip `TOO_MANY_BROKERS` or `OBSERVER_CONFIG_TOO_LARGE`.

Enabled path, in order (first failure wins, as today):

| # | Check | Error key | Fallback |
|---|---|---|---|
| 1 | `rows.length === 0` | `meshcore.form.observer_error_no_brokers` | `Add at least one broker` |
| 2 | `rows.length > MAX_OBSERVER_BROKERS` | `meshcore.form.observer_error_too_many_brokers` | `At most {{max}} brokers are allowed` |
| 3 | per row: `url.trim()` empty | `meshcore.form.observer_error_broker_required` *(reused)* | `Broker {{index}}: broker URL is required` |
| 4 | per row: explicit scheme not in `ws/wss/mqtt/mqtts` | `meshcore.form.observer_error_broker_scheme` *(reused)* | `Broker {{index}}: URL must use ws://, wss://, mqtt:// or mqtts:// (or a bare host:port)` |
| 5 | per row: no parseable hostname | `meshcore.form.observer_error_broker_invalid` *(reused)* | `Broker {{index}}: URL is not a valid address` |
| 6 | per row, token mode: audience empty / >255 / contains whitespace | `meshcore.form.observer_error_broker_audience` | `Broker {{index}}: token audience must be non-empty and contain no spaces` |
| 7 | per row: `label.trim().length > 64` | `meshcore.form.observer_error_broker_label` | `Broker {{index}}: label must be at most 64 characters` |
| 8 | duplicate `observerBrokerFormKey(url)` across rows | `meshcore.form.observer_error_duplicate_broker` | `Broker {{index}} duplicates another broker's URL` |
| 9 | IATA: not 3 letters and not `test` (case-insensitive) | `meshcore.form.observer_error_iata` *(reused)* | unchanged |

Checks 3–8 run per row in order, reporting `index` as **1-based** (what the UI
shows). Checks 3–5 keep their existing keys so the existing i18n entries and
`ERROR_CODE_KEY_MAP` stay valid; only their English fallbacks gain the
`Broker {{index}}: ` prefix.

`toWire(row)`:

```ts
{
  url: row.url.trim(),
  authMode: row.authMode,
  ...(row.authMode === 'token' ? { tokenAudience: row.tokenAudience.trim() } : {}),
  ...(row.label.trim() ? { label: row.label.trim() } : {}),
}
```

Password-mode rows drop `tokenAudience` entirely rather than carrying a stale
value — the existing #4595 rule, now per row.

Successful output:

```ts
{ config: {
    enabled: true,
    authMode: rows[0].authMode,                 // block-level mirror of brokers[0]
    iataCode: form.iataCode.trim().toUpperCase(),
    brokers: rows.map(toWire),
} }
```

**No `brokerUrl` key. No top-level `tokenAudience` key.** `DashboardPage`
assigns `cfg.observer = <this object>` wholesale, so both legacy fields
disappear from the persisted blob on the first save. Block-level `authMode`
stays semantically correct because it mirrors `brokers[0].authMode`, which is
exactly what `observerConfigFromSource` reports as the flat mirror.

### 3.5 Per-broker credentials and save order

Password-mode rows need a broker password, which never rides in
`sources.config`. Draft state lives in `DashboardPage`, keyed by the row's
client `id`:

```ts
const [formObserverCreds, setFormObserverCreds] =
  useState<Record<string, { username: string; password: string }>>({});
```

Drafts are **never seeded from the server** (the password is never returned) and
are cleared whenever the modal opens (`onAddSource` / `onEditSource`). Only rows
where both `username` and `password` are non-blank are pushed; a blank pair
means "leave the stored credential alone", which the UI states in a hint.

**Save sequence — order is mandatory:**

1. `buildObserverConfig(formObserver)` → client validation → `cfg.observer`.
2. `PUT /api/sources/:id` (or `POST /api/sources`) — the existing call.
   *Must complete first:* the credential route bounds `brokerKey` against the
   source's **configured** brokers and returns `UNKNOWN_BROKER` for anything
   else (§1.6).
3. Only when `formType === 'meshcore' && editingSourceId` and at least one
   pushable draft exists:
   a. `await api.getObserverStatus(editingSourceId)` and read
      `data.brokers[]` for the **authoritative** `key` values. We do not send a
      locally-derived key: the client mirror in §3.2 exists for duplicate
      detection only, and reading back removes any chance of the two drifting.
   b. For each draft, match `observerBrokerFormKey(row.url)` against
      `broker.key` (both already lowercased). No match → collect an error for
      that row and continue.
   c. **Serially** — `for (const … of …) { await api.putObserverCredentials(…) }`
      — never `Promise.all`. `storeForBroker` is read-modify-write and the store
      explicitly requires serialization (§1.6).
   d. Collect per-row failures. On any failure, keep the modal open and set
      `formError` to a partial-failure message, exactly like the existing
      `mqtt_bridge` rewrite block at `DashboardPage.tsx:800-880`
      (`source.form.bridge_rewrite_partial_error` is the shape to copy).
      The source itself is already saved; say so.
4. On full success, close the modal and invalidate the sources query as today.

New-source creation (`POST`) skips step 3 entirely — there is no source id until
the POST returns, and the observer needs a device-derived signing key anyway.
The fieldset's existing "Configuration" shortcut button already tells the user
where to finish. Copy for a password-mode row on a *new* source says: save
first, then set the password from the Configuration page.

---

## 4. File-by-file changes

### 4.1 `src/services/api.ts` — two typed methods (WP1)

Placed beside the other MeshCore methods. `request()` returns the raw body and
does **not** unwrap `data`, so these methods unwrap it themselves — same rule
the observer hooks call out in their headers.

```ts
/** One broker's Analyzer Observer status. Mirrors
 *  MeshCoreObserverBrokerStatus in src/server/services/meshcoreObserverStatus.ts;
 *  re-declared because the boundary is plain JSON. */
export interface ObserverBrokerStatus {
  key: string;
  url: string;
  label: string | null;
  authMode: 'token' | 'password';
  tokenAudience: string | null;
  configured: boolean;
  keyStored: boolean;
  connected: boolean;
  publishes: number;
  dropped: number;
  /** milliseconds */
  lastPublishAt: number | null;
  lastError: string | null;
  /** unix SECONDS */
  tokenExpiresAt: number | null;
}

export interface ObserverStatusResponse {
  /** false = no publisher running; the rest is a config-derived snapshot. */
  running: boolean;
  configured: boolean;
  authMode: 'token' | 'password';
  keyStored: boolean;
  connected: boolean;
  publishes: number;
  dropped: number;
  lastPublishAt: number | null;
  lastError: string | null;
  tokenExpiresAt: number | null;
  brokers: ObserverBrokerStatus[];
}

async getObserverStatus(sourceId: string): Promise<ObserverStatusResponse> {
  const body = await this.get<{ success: boolean; data: ObserverStatusResponse }>(
    `/api/sources/${sourceId}/observer/status`,
  );
  return body.data;
}

/** Store one broker's static MQTT credential. `brokerKey` MUST come from
 *  getObserverStatus() and the source config MUST already be saved, or the
 *  server replies UNKNOWN_BROKER. Callers MUST serialize these — the store is
 *  read-modify-write (meshcoreObserverCredentialStore.ts:259). */
async putObserverCredentials(
  sourceId: string,
  payload: { brokerKey?: string; username: string; password: string },
): Promise<void> {
  await this.put(`/api/sources/${sourceId}/observer/credentials`, payload);
}
```

No `any`. Both interfaces exported for WP2/WP3.

### 4.2 `src/pages/DashboardPage.observerConfig.ts` (WP1)

Everything in §3. `OBSERVER_FIELDS` moves out of `DashboardPage.tsx` and into
this module as two tables — one for the block-level field (`iataCode`) and one
for the per-row fields (`url`, `tokenAudience`, `label`) — so the fieldset keeps
its `.map()` rendering and the placeholders stay in one place.

### 4.3 `src/pages/DashboardPage.observerBrokers.module.css` (new, WP2)

Owns only the repeating-row layout. Semantic tokens with **no fallback value**
(`var(--color-surface)`, never `var(--color-surface, #fff)`) — the theme rule
from the map-sidebar work. Classes: `.brokerList`, `.brokerRow`, `.brokerHead`
(label + remove button on one line), `.brokerFields`, `.presetBar`,
`.removeButton`, `.credRow`, `.rowError`. Under 480 px `.brokerHead` stacks.

### 4.4 `src/pages/DashboardPage.tsx` (WP2)

- State: `formObserver` keeps its name and type (`ObserverForm`, now with
  `brokers`); add `formObserverCreds` (§3.5). Reset both in `onAddSource`
  (~L387) and seed `formObserver` from `observerFormFromConfig(cfg?.observer)`
  in `onEditSource` (~L522, unchanged call) while clearing
  `formObserverCreds`.
- Save path (~L680–686): unchanged shape; the error line becomes
  `t(observerResult.error.key, observerResult.error.fallback, observerResult.error.params)`,
  and the disabled fallback object is deleted — `buildObserverConfig` now
  returns a proper disabled block itself (§3.4), so the line is just
  `cfg.observer = observerResult.config;` (the return type makes `config`
  always defined; keep a defensive `if (!observerResult.config) return;` only
  if TypeScript narrowing demands it).
- New post-save block after the existing `mqtt_bridge` one (~L880): §3.5 step 3.
- Fieldset JSX (~L1692–1748): replaced body (§4.5). The enable checkbox, the
  repeater note, the help paragraph and the "Configuration" shortcut button all
  stay exactly as they are.

New local handlers (all plain functions on the component, no new `useEffect`, so
**no `react-hooks/exhaustive-deps` surface is added**):

```ts
const addObserverBroker = (preset: ObserverBrokerPreset) => void;
const removeObserverBroker = (rowId: string) => void;
const updateObserverBroker = (rowId: string, patch: Partial<ObserverBrokerForm>) => void;
const updateObserverCred = (rowId: string, patch: Partial<{ username: string; password: string }>) => void;
```

### 4.5 Fieldset layout (WP2)

Inside the existing `<fieldset>`, when `formObserver.enabled` and the device is
not a repeater:

1. **Region (IATA)** — the one block-level text input, unchanged placeholder
   `MCO` (existing tests depend on it).
2. **Brokers** — `<div className={styles.brokerList}>`, one `.brokerRow` per
   entry:
   - Header: `Broker {index}` plus the row's `label` when set, and a remove
     button (`<UiIcon name="delete" size={14} />` + visually-hidden text, with
     `aria-label={t('meshcore.form.observer_broker_remove', 'Remove broker {{index}}', { index })}`).
   - `label` text input (placeholder `MeshMapper`).
   - `url` text input (placeholder `wss://mqtt-us-v1.letsmesh.net:443` —
     **keep this exact string**, existing tests query by it).
   - `authMode` `<select>` with an explicit `aria-label` (§1.2), options
     `token` / `password`, reusing the existing option i18n keys.
   - `tokenAudience` text input, rendered **only** in token mode (placeholder
     `meshcore-mqtt` — keep the string).
   - In password mode only: `username` + `password` (`type="password"`,
     `autoComplete="new-password"`) inputs plus the hint "Leave blank to keep
     the stored password."
3. **Preset bar** — `<div className={styles.presetBar}>` with one button per
   entry in `OBSERVER_BROKER_PRESETS`, each `onClick={() => addObserverBroker(p)}`,
   disabled when `formObserver.brokers.length >= MAX_OBSERVER_BROKERS`. Adding
   a preset whose key already exists is allowed by the button but caught by
   check 8 on save with a clear message — simpler than a disabled-button matrix,
   and the duplicate is obvious on screen.
4. The existing credentials/key hint + "Configuration" shortcut button,
   unchanged.

Accessibility: each input keeps the `dashboard-form-field` /
`dashboard-form-label` / `dashboard-form-input` trio; because several rows now
share a label text, every input carries an
`aria-label={t(key, fallback, { index })}` so Testing Library and screen readers
can tell rows apart.

### 4.6 `src/components/MeshCore/hooks/useObserverStatus.ts` (new, WP3)

```ts
export interface UseObserverStatusResult {
  status: ObserverStatusResponse | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useObserverStatus(
  sourceId: string,
  opts?: { enabled?: boolean },
): UseObserverStatusResult;
```

`useQuery({ queryKey: ['observer', 'status', sourceId], queryFn: () =>
api.getObserverStatus(sourceId), refetchInterval: DASHBOARD_POLL_INTERVAL,
enabled: opts?.enabled ?? true, retry: false })` — mirrors `useSourceStatuses`
(§1.3). `DASHBOARD_POLL_INTERVAL` is imported from
`src/hooks/useDashboardData.ts`; no new constant.

### 4.7 `src/components/MeshCore/MeshCoreObserverBrokerPanel.tsx` + `.module.css` (new, WP3)

```ts
export interface MeshCoreObserverBrokerPanelProps {
  sourceId: string;
  /** Parent has already checked configuration:read; false suspends polling. */
  enabled?: boolean;
}
export const MeshCoreObserverBrokerPanel: React.FC<MeshCoreObserverBrokerPanelProps>;
```

Renders nothing (`null`) when `status` is null, when `status.brokers` is empty,
or on error — the D-6 silence convention. Otherwise a heading
(`meshcore.observer.brokers_heading`, "Brokers") and one card per broker:

- Title: `broker.label ?? broker.url`; the URL always shown beneath in
  `.pubkey`-style mono when a label exists.
- `UiIcon name={broker.connected ? 'statusOn' : 'statusOff'}` + connected /
  not-connected text.
- `.statusGrid` rows: Packets published (`publishes`), Packets dropped
  (`dropped`, with the existing `dropped_help` hint when > 0), Last publish
  (`formatRelativeTime(lastPublishAt)` — **milliseconds**, or "Never"), and —
  token mode only — Auth token expires
  (`new Date(tokenExpiresAt * 1000).toLocaleString()` — **seconds**, absolute).
- `!broker.configured` → `.warning` row, `role="alert"`.
- `!broker.keyStored` → `.warning` row, `role="alert"`, wording branching on
  `authMode` exactly like block [A].
- `broker.lastError` → `.error` row, `role="alert"`, prefixed with
  `<UiIcon name="alert" size={14} />`.
- When `status.running === false`, a single leading `.hint` line: "Publisher not
  running — showing configured brokers."

Its `.module.css` holds only the per-card frame (`.brokerCard`, `.brokerTitle`,
`.brokerUrl`, `.brokerList`); the label/value grid reuses the classes it
imports from `MeshCoreObserverSection.module.css`. If cross-module class import
proves awkward, duplicate the four short rules into the new module rather than
widening a global sheet.

### 4.8 `src/components/MeshCore/MeshCoreObserverSection.tsx` (WP3)

One import and one mount, immediately after block [A]:

```tsx
<MeshCoreObserverBrokerPanel sourceId={sourceId} enabled={canRead} />
```

Nothing else in the file changes. Block [A] stays as the aggregate summary; the
panel is its per-broker breakdown. (Browser validation V6 judges whether the
duplication reads as redundant on a single-broker source; if it does, the
follow-up is to hide block [A]'s counter rows when `brokers.length > 1` — noted,
not implemented.)

### 4.9 `src/components/Dashboard/DashboardSidebar.tsx` (WP3)

A badge in the card header beside the VN badge (§1.5), for `source.type ===
'meshcore'` only:

```tsx
{!isUnified && source.type === 'meshcore' && (() => {
  const obs = (source.config as ObserverCardConfig | undefined)?.observer;
  if (obs?.enabled !== true) return null;
  const configuredCount =
    Array.isArray(obs.brokers) && obs.brokers.length > 0
      ? obs.brokers.length
      : (typeof obs.brokerUrl === 'string' && obs.brokerUrl.trim() ? 1 : 0);
  const live = (status as ObserverCardStatus | null | undefined)?.observer;
  const connectedCount = live
    ? (live.brokers?.filter((b) => b.connected).length
        ?? (live.connected ? 1 : 0))
    : null;
  const on = (connectedCount ?? 0) > 0;
  return (
    <span
      className="dashboard-source-card-badge"
      title={
        connectedCount === null
          ? t('source.observer_badge_unknown', 'Analyzer Observer configured; status unavailable')
          : t('source.observer_badge_title', 'Analyzer Observer: {{connected}} of {{total}} brokers connected',
              { connected: connectedCount, total: configuredCount })
      }
    >
      <UiIcon name={on ? 'statusOn' : 'statusOff'} size={12} />{' '}
      {connectedCount === null ? `OBS ${configuredCount}` : `OBS ${connectedCount}/${configuredCount}`}
    </span>
  );
})()}
```

Two narrow local interfaces (`ObserverCardConfig`, `ObserverCardStatus`) —
**no `any` casts**, unlike the neighbouring legacy `(source.config as any)`
lines, which stay untouched. `connectedCount === null` is the honest
`nodes:read`-stripped / poll-not-landed case (§1.6) and must not render as
`0/N`.

### 4.10 `public/locales/en.json` (WP2 + WP3)

New keys only, English fallbacks matching the `t()` fallbacks exactly. WP2 owns
`meshcore.form.observer_*`; WP3 owns `meshcore.observer.*` and `source.observer_*`.
The two touch disjoint subtrees of one file — resolve additively if they land
concurrently.

### 4.11 Docs (WP4)

`docs/features/meshcore-analyzer-observer.md` — already listed in
`docs/.vitepress/config.mts:161`, so **no sidebar change is needed**. Updates:

- Reframe "Step 1 — Enable and configure" around the broker list and the preset
  buttons; note the 8-broker cap.
- New section **"Contribute to MeshMapper"** with the one-click flow: edit the
  MeshCore source → Analyzer Observer → enable → set the region code → click
  **MeshMapper** (and optionally **LetsMesh US** / **LetsMesh EU**; MeshMapper
  recommends dual-publish and dedupes) → save → import the signing key from the
  Configuration page. Say plainly that this is publish-only, costs no airtime,
  and never transmits on the mesh.
- New section **"Multiple brokers"**: each broker has its own audience and
  authentication; one broker failing does not stop the others (Phase 1's
  per-connection hard-stop behaviour); per-broker counters live on the source's
  Configuration page.
- Document the compact `OBS n/N` badge on the dashboard source card.
- Add the preset table from §1.7 verbatim.

`docs/internal/dev-notes/MESHMAPPER_OBSERVER_EPIC.md` — tick Phase 2 and record
deviations under "Deviations / notes".

---

## 5. Status surfaces — behaviour rules

### 5.1 Compact card indicator

| Condition | Rendering |
|---|---|
| non-meshcore source, or `config.observer.enabled !== true` | no badge |
| enabled, `status.observer` absent (poll pending, publisher down, or `nodes:read` stripped) | `statusOff` + `OBS N`, title "status unavailable" |
| enabled, `status.observer` present | `statusOn`/`statusOff` + `OBS c/N` |

`N` comes from **config** (what the operator asked for); `c` comes from
**status** (what is actually up). Never infer `N` from the status array — a
publisher that failed to start reports fewer brokers than are configured, and
that gap is precisely the signal worth showing.

### 5.2 Per-broker panel polling

15 s (`DASHBOARD_POLL_INTERVAL`), only while the MeshCore Configuration view is
mounted, only when `configuration:read` holds, `retry: false`. One source, one
request. TanStack dedupes by query key, so mounting the panel twice costs
nothing extra.

---

## 6. Constraints checklist

- **ESLint baseline must not grow.** No new `any` (§4.1, §4.9 define real
  interfaces); no raw `fetch()` in pages/components (`ApiService` only); no new
  `useEffect`, so no new `react-hooks/exhaustive-deps` sites. Verify with
  `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty.
- **Icons via `UiIcon` only** — `statusOn`, `statusOff`, `alert`, `delete`,
  `plus` are all in `UI_ICON_DEFINITIONS`. No emoji, no Unicode stand-ins.
- **New components use CSS modules** with semantic `var(--color-*)` tokens and
  no fallback values. `src/styles/dashboard.css` and
  `src/components/MeshCore/MeshCorePage.css` stay frozen.
- **No `VALID_SETTINGS_KEYS` change** — this feature stores nothing in
  `settings`; it lives in `sources.config` and the credential store.
- Relative-import `.js` extensions do **not** apply here (frontend files are not
  in `tsconfig.server.json`'s include set) — leave existing frontend import
  style alone.

---

## 7. Test plan

All Vitest + Testing Library, `@vitest-environment jsdom` where DOM is involved.

### 7.1 `src/pages/DashboardPage.observerConfig.test.ts` (extend, WP1)

Existing 30 cases: the `emptyObserverForm`, `observerFormFromConfig`, and
output-normalization blocks are **rewritten** for the `brokers[]` shape; the
URL-scheme, host-parseability, IATA and audience-shape cases are **kept** and
re-pointed at `form.brokers[0]`. New cases:

*Migration*
- legacy `{ brokerUrl, authMode:'token', tokenAudience }` → exactly one row
  carrying that URL, mode and audience.
- legacy `{ brokerUrl, authMode:'password' }` → one password-mode row, audience
  `''`.
- `brokers:[…]` present → `brokerUrl` on the same block is **ignored** (not
  unioned) — mirrors `normalizeObserverBrokers` rule 1.
- a `brokers[]` entry with no `authMode` inherits the block-level `authMode`.
- a `brokers[]` entry with no `tokenAudience` gets `''`, **not** the block-level
  `tokenAudience` — the non-inheritance rule.
- `brokers: []` (empty array) and no `brokerUrl` → zero rows.
- non-object entry inside `brokers` → an all-blank row, no throw.

*Build*
- output has **no `brokerUrl` key and no top-level `tokenAudience` key**
  (`expect(Object.keys(config)).toEqual(['enabled','authMode','iataCode','brokers'])`).
- block-level `authMode` mirrors `brokers[0].authMode` for a
  password-then-token list and a token-then-password list.
- password-mode row omits `tokenAudience`; blank `label` is omitted.
- `label` and `url` are trimmed; `iataCode` uppercased.
- 9 rows → `observer_error_too_many_brokers` with `params.max === 8`.
- zero rows → `observer_error_no_brokers`.
- duplicate rows differing only in case / trailing whitespace →
  `observer_error_duplicate_broker` with `params.index === 2`.
- a bare `host:8883` row and a `mqtts://host:8883` row collide (exercises the
  `normalizeBrokerUrl` port-8883 branch in `observerBrokerFormKey`).
- 65-char label → `observer_error_broker_label`.
- row-numbered errors report **1-based** indices.
- disabled form preserves `brokers` and `iataCode` and sets `enabled:false`.
- disabled form with 9 rows still returns `observer_error_too_many_brokers`.
- fully-blank abandoned row is dropped; a row with only a `label` is kept and
  fails check 3.

*Presets*
- all four presets present, in order; the three named ones are `token` mode
  with host-as-audience; `custom` is blank.
- `observerBrokerFormFromPreset` produces unique `id`s across calls.
- an 8-broker block built from presets serializes under
  `MAX_OBSERVER_CONFIG_BYTES` (1536) — a direct guard on the server's byte cap:
  `expect(Buffer.byteLength(JSON.stringify(config))).toBeLessThan(1536)`.

### 7.2 `src/pages/DashboardPage.observerFieldset.test.tsx` (extend, WP2)

Keep the mock block wholesale; it is the working set for this page. Existing 11
cases updated for the new markup (the `wss://…`, `MCO`, `meshcore-mqtt`
placeholders are preserved precisely so most queries survive). New cases:

- a legacy `observer` block pre-populates exactly one broker row with the
  legacy URL and audience.
- saving that unchanged legacy source writes `config.observer.brokers` with one
  entry and **no `brokerUrl` / no top-level `tokenAudience`** — the migration,
  asserted end-to-end.
- clicking **MeshMapper** appends a row with the verified URL/audience/label;
  saving writes both brokers in order.
- clicking **LetsMesh US** then **LetsMesh EU** yields a 3-broker save.
- the remove button drops the right row (add three, remove the middle, assert
  the saved array).
- 9 brokers → save blocked client-side with the too-many message and **no fetch
  issued** (mirrors the existing "rejects an invalid IATA code client-side
  without issuing a fetch" case).
- two identical presets → duplicate error, no fetch.
- switching a row to password mode hides its audience input, shows
  username/password, and saves `authMode:'password'` with no `tokenAudience` on
  that entry.
- password-mode row with both credential fields filled: after the source PUT
  resolves, a `GET …/observer/status` fires and then **exactly one**
  `PUT …/observer/credentials` with the `brokerKey` taken from the status
  response.
- two password-mode rows → **two** credential PUTs, and they are **serialized**:
  assert the second request is not issued until the first resolves (resolve the
  first PUT manually from the test and assert call counts between awaits).
- a credential PUT returning `UNKNOWN_BROKER` leaves the modal open with the
  partial-failure message, and the source PUT is not retried.
- blank username/password on a password-mode row issues **no** credential PUT.
- disabling the observer and saving writes `enabled:false` while preserving
  `brokers`.
- repeater device: enable checkbox still disabled, repeater note still shown,
  preset buttons absent.
- `config.virtualNode` remains untouched across a broker-list save (keep the
  existing assertion).

### 7.3 `src/components/MeshCore/MeshCoreObserverBrokerPanel.test.tsx` (new, WP3)

Mock `useObserverStatus` (not `ApiService`) so the component test stays about
rendering.

- two brokers render two cards, labels preferred over URLs, URL shown beneath.
- a connected broker gets `statusOn`, a disconnected one `statusOff`.
- `publishes` / `dropped` render; the dropped hint appears only when `> 0`.
- `lastPublishAt` goes through `formatRelativeTime` (ms, **not** ×1000);
  `null` → "Never".
- `tokenExpiresAt` renders as an absolute local time (assert the string is not
  a relative phrase) and the row is **absent** in password mode.
- `lastError` renders with `role="alert"`.
- `configured:false` and `keyStored:false` each produce their own `role="alert"`
  warning, with password-mode wording when `authMode === 'password'`.
- `running:false` shows the "publisher not running" hint.
- empty `brokers` array, null status, and error state each render nothing.

### 7.4 `src/components/MeshCore/hooks/useObserverStatus.test.tsx` (new, WP3)

- calls `api.getObserverStatus` once with the right source id and exposes
  `status`.
- `enabled:false` issues no request.
- a rejected query surfaces `error` and leaves `status` null (`retry:false`
  means no retry storm).

### 7.5 `src/components/Dashboard/DashboardSidebar.test.tsx` (extend, WP3)

- meshcore source with `observer.enabled:true` and 2 configured brokers, status
  reporting 1 connected → badge text `OBS 1/2`, `statusOn`.
- same config, `status.observer` absent → `OBS 2`, `statusOff`, "status
  unavailable" title.
- legacy `brokerUrl`-only config counts as 1 broker.
- `observer.enabled:false`, and a non-meshcore source → no badge.

### 7.6 Suite-wide

`npm run test` (full Vitest) must be green — no schema or migration change, so
the PostgreSQL/MySQL containers are **not** required for this phase. Confirm
`success: true` from the JSON reporter, not the assertion headline (the rtk
summary masks suite-level collection failures).

---

## 8. Work packages

Ordering: **WP1 → (WP2 ∥ WP3) → WP4.** Files are disjoint except
`public/locales/en.json`, which WP2 and WP3 extend in different subtrees.

### WP1 — mapping module, presets, ApiService (blocking)

**Owns:** `src/pages/DashboardPage.observerConfig.ts`,
`src/pages/DashboardPage.observerConfig.test.ts`, `src/services/api.ts`.

Everything in §3 plus §4.1. Pure functions and two typed API methods; no
component touched, no JSX. Done when §7.1 passes and `tsc` is clean.
`DashboardPage.tsx` will not compile against the new `ObserverForm` until WP2
lands — that is expected; WP1 ships as one commit on the branch, WP2 follows
immediately.

### WP2 — Dashboard broker-list editor + save path

**Depends on:** WP1.
**Owns:** `src/pages/DashboardPage.tsx`,
`src/pages/DashboardPage.observerFieldset.test.tsx`,
`src/pages/DashboardPage.observerBrokers.module.css` (new),
`public/locales/en.json` (`meshcore.form.observer_*` subtree).

§4.3–4.5 and §3.5. The largest package. Watch: preserve the three existing
placeholder strings; keep the explicit `aria-label` on every `<select>`;
serialize the credential PUTs; do not add a `useEffect`.

### WP3 — status surfaces

**Depends on:** WP1 (for the ApiService types). Independent of WP2.
**Owns:** `src/components/MeshCore/hooks/useObserverStatus.ts` (new) + test,
`src/components/MeshCore/MeshCoreObserverBrokerPanel.tsx` + `.module.css` +
test (all new), `src/components/MeshCore/MeshCoreObserverSection.tsx` (one
import, one mount), `src/components/Dashboard/DashboardSidebar.tsx` +
`DashboardSidebar.test.tsx`, `public/locales/en.json`
(`meshcore.observer.*` / `source.observer_*` subtrees).

§4.6–4.9, §5, §7.3–7.5.

### WP4 — docs

**Depends on:** WP2 + WP3 merged into the branch (so the copy describes shipped
UI).
**Owns:** `docs/features/meshcore-analyzer-observer.md`,
`docs/internal/dev-notes/MESHMAPPER_OBSERVER_EPIC.md`.

§4.11. No `docs/.vitepress/config.mts` change — the page is already in the
sidebar.

---

## 9. Browser validation script (orchestrator)

Deploy the branch with the `deploy` skill, **including the USB override**:
`-f docker-compose.dev.yml -f docker-compose.dev.local.yml`. Log in at
`http://localhost:8080/meshmonitor` as `admin` / `changeme`. Use a MeshCore
Companion source on `/dev/ttyUSB2` or `/dev/ttyUSB3`. **This feature sends no
mesh traffic at all** — no test messages are needed; if any are sent for
unrelated reasons, use the `gauntlet` channel, never Primary.

| # | Action | Expected |
|---|---|---|
| V1 | Dashboard → edit the MeshCore source → Analyzer Observer. Source still has the pre-#5014 single-broker config. | Exactly one broker row, pre-filled with the legacy URL and audience. Region field carries the old IATA code. |
| V2 | Save without editing. Then re-open the modal and inspect the source via `./scripts/api-test.sh get /api/sources` | `config.observer` has `brokers:[{…}]`; **`brokerUrl` and the top-level `tokenAudience` are gone**; `authMode` equals `brokers[0].authMode`. The migration. |
| V3 | Click **MeshMapper**. | A new row appears with `wss://mqtt.meshmapper.net:443`, audience `mqtt.meshmapper.net`, label `MeshMapper`, token mode. |
| V4 | Click **LetsMesh US** and **LetsMesh EU**, then Save. | Saves cleanly. `api-test.sh get /api/sources` shows 4 brokers in order with the verified audiences. |
| V5 | Click **MeshMapper** a second time and Save. | Client-side duplicate error naming the row; **no** network request fires (check DevTools). Remove the row and save again. |
| V6 | Navigate to the source page → MeshCore → Configuration → Analyzer Observer. | Aggregate block [A] unchanged above; a **Brokers** panel below with one card per configured broker. Judge whether the aggregate now reads as redundant and note it. |
| V7 | With the signing key imported and the device connected, watch the Brokers panel for ~60 s. | Per-broker `connected` dots go on; `publishes` climbs independently per broker; `Auth token expires` shows an **absolute** future local time (never "just now"); `Last publish` shows a sane relative time. |
| V8 | Point one broker at a bogus host (`wss://nope.invalid:443`) and save. | Only that card shows `Last error` (`role="alert"`) and a `statusOff` dot; the other brokers keep publishing. Confirms Phase 1's per-connection hard-stop. |
| V9 | Return to the Dashboard. | The MeshCore source card shows an `OBS c/N` badge with a `statusOn` dot; `c` reflects V8's one broken broker; the tooltip reads "Analyzer Observer: c of N brokers connected". |
| V10 | Add a password-mode broker row, fill username + password, Save. Watch the Network tab. | Order is: `PUT /api/sources/:id` → `GET …/observer/status` → `PUT …/observer/credentials` carrying `brokerKey`. With two password rows, the second PUT starts only after the first responds. |
| V11 | Save again with the credential fields left blank. | No credential PUT is issued; the stored password survives (the Configuration page still shows the username). |
| V12 | Disable the observer checkbox and Save; re-open the modal. | `enabled:false` persisted, and the broker list is still there. Re-enable + Save restores publishing without re-entering anything. |
| V13 | Resize the browser to 400 px wide with 4 brokers configured. | Broker rows and the Brokers panel stack to one column; **no horizontal page scroll**. |
| V14 | Toggle light/dark theme on both surfaces. | All new colors track the theme (semantic tokens, no hardcoded hex). |
| V15 | Log in as a non-admin without `nodes:read` on that source. | The card badge shows `OBS N` with a "status unavailable" tooltip — never `0/N`. Without `configuration:read`, the Brokers panel is absent entirely, no console errors. |

Attach screenshots of V6, V7, V9 and V13 to the PR (UI PRs require one).

---

## 10. Open items for the project owner

1. **`MAX_OBSERVER_BROKERS = 8`** was flagged for review at the Phase 1 PR and
   is now user-visible as a hard cap in the editor. Confirm 8 is the number, or
   name a different one before WP2 hard-codes the message copy.
2. **Block [A] vs. the Brokers panel** duplicate counters on a single-broker
   source (§4.8). V6 decides; the fix, if wanted, is a small follow-up.
