# TX-Disabled Support — Phase 2 Implementation Spec (Frontend gating UX)

**Epic:** #4294 (see `TX_DISABLED_SUPPORT_EPIC.md`). Phase 1 (backend) is merged: every
transmit primitive throws `TxDisabledError`, routes map it to
`fail(res, 409, 'TX_DISABLED', 'Transmit is disabled on this source')`, `POST /api/config/lora`
now passes the caller's `txEnabled` through (backfilling from device state only when omitted),
and imports/restores preserve the device's current value.

Phase 2 makes the **frontend** honor the state: every send/request control that cannot work
with TX disabled renders **disabled with an explanatory tooltip** (never hidden — reads still
work); the LoRa TX checkbox gets a danger-confirm on disable; TX state refreshes promptly after
a save; and any 409 that slips through a race shows a clear toast instead of a silent failure.

> **All file:line anchors below were re-verified against the `feature/tx-disabled-frontend`
> worktree (origin/main + Phase 1). The App.tsx anchors in the epic doc had drifted; these are
> current.** Line numbers may still shift by a few lines as the implementer edits above them —
> anchor on the quoted code, not the number.

---

## 1. Reuse inventory (verified — do NOT introduce new primitives for these)

| Concern | What exists | Location |
|---|---|---|
| **Per-source TX state** | `useTxStatus({ baseUrl, sourceId })` → `{ isTxDisabled, ... }`, TanStack Query key `['txStatus', baseUrl, sourceId]`, 30s poll. Already consumed once. | `src/hooks/useTxStatus.ts`; consumer `src/App.tsx:245` |
| **Toast** | `useToast()` → `showToast(message, type, duration?)`, `type ∈ 'success'\|'error'\|'warning'\|'info'`. Provider wraps the app. | `src/components/ToastContainer.tsx` |
| **Confirm dialog** | The app has **no** shared ConfirmDialog component — the established danger-confirm pattern is `window.confirm(t('<key>'))`. Used verbatim for a comparable radio-config danger (router role) at `DeviceConfigSection.tsx:127` and `SecurityConfigSection.tsx:153`. **Reuse `window.confirm`.** | — |
| **i18n** | `react-i18next` `const { t } = useTranslation()`. Keys are **flat dotted strings** (e.g. `"lora_config.tx_enabled"`) in per-language JSON under `public/locales/{lng}.json`, loaded over HTTP. `fallbackLng: 'en'`. `t('key', 'Default')` fallback form is used in places. | `src/config/i18n.ts`; strings in `public/locales/en.json` |
| **Disabled + tooltip pattern** | Native `disabled={...}` on the control + `title={...}` for the hover explanation. This is the app-wide idiom (e.g. `MessagesTab.tsx` exchange buttons `disabled={connectionStatus !== 'connected' || ...}`; `node-indicator-icon title={t(...)}`). No tooltip component. | throughout |
| **`fetch` wrapper** | `useAuthFetch()` → `authFetch(url, opts)` returns the raw `Response` (adds CSRF, retries 403). App send-handlers read `response.ok` / `await response.json()`. **New code must use `authFetch`, never raw `fetch`** (ratchet ban in `src/components/**`, `src/pages/**`). | `src/hooks/useAuthFetch.ts` |
| **ApiService errors** | `apiService.request()` throws `ApiError` with `.status` and `.code` on non-2xx (reads `body.code`). So `apiService.setLoRaConfig(...)` / AdminCommandsTab `executeCommand(...)` throw `ApiError{ code: 'TX_DISABLED' }` on a 409. | `src/services/api.ts:43-60,148-160` |
| **QueryClient** | `useQueryClient()` from `@tanstack/react-query`; App already holds one (`src/App.tsx:357`). | — |
| **Global banner** | `banners.tx_disabled` string already exists and renders via `AppBanners` when `isTxDisabled`. **Keep as the single paused-features indicator — no per-feature badges.** | `src/components/AppBanners/AppBanners.tsx` |

### Existing i18n keys to reuse (already present, do not re-add)
- `banners.tx_disabled` — the global banner copy.
- `lora_config.tx_enabled` = "TX Enabled", `lora_config.tx_enabled_description` = "Enable radio transmission. Disable to make the node listen-only." (ConfigurationTab LoRa form label).
- `admin_commands.tx_enabled` / `admin_commands.tx_enabled_description` (AdminCommandsTab LoRa form label).
- `config.lora_saved_toast`, `config.lora_failed` (ConfigurationTab save toasts).

---

## 2. New shared code (small, once)

### 2a. TX-disabled detection helper — `src/utils/txDisabled.ts` (new, pure, no React)
Pure functions so both `authFetch` (Response) call-sites and `apiService`/`ApiError` call-sites
share one definition and it is unit-testable. **No CSS, no hook, no `any`.**

```ts
export const TX_DISABLED_CODE = 'TX_DISABLED';

/** True when a parsed error body from a 409 signals TX disabled. */
export function isTxDisabledBody(status: number, body: unknown): boolean {
  return (
    status === 409 &&
    typeof body === 'object' && body !== null &&
    (body as { code?: unknown }).code === TX_DISABLED_CODE
  );
}

/** True when a thrown ApiError (or any {code}) is a TX-disabled error. */
export function isTxDisabledError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    (err as { code?: unknown }).code === TX_DISABLED_CODE
  );
}
```

Ships with `src/utils/txDisabled.test.ts` (WP1).

### 2b. New i18n keys — add to `public/locales/en.json` ONLY
en.json is the source of truth (4627 keys today; es has 4598 — English leads, Weblate propagates
translations, and `fallbackLng:'en'` covers any locale that hasn't caught up). **Do NOT hand-edit
`de/es/fr/nb_NO/pl/pt_BR/ru/sv/zh_Hans.json`** — those are Weblate-managed; missing keys fall back
to English automatically. Add:

| Key | English value |
|---|---|
| `tx_disabled.control_tooltip` | `Transmit is disabled on this node's radio. Re-enable TX in the LoRa configuration to use this.` |
| `tx_disabled.send_blocked_toast` | `Transmit is disabled on this source — nothing was sent.` |
| `tx_disabled.remote_admin_notice` | `Remote-node admin is unavailable while Transmit is disabled on this source. Local-node admin still works — you can re-enable TX in the LoRa Config below.` |
| `lora_config.tx_disable_confirm` | `Disable transmit on this node?\n\nThe node becomes invisible to the mesh: it can still receive, but it will not send messages, respond to traceroutes, or accept remote administration until you re-enable TX. Continue?` |

`AdminCommandsTab`'s inline LoRa checkbox reuses `lora_config.tx_disable_confirm` for its confirm
(same consequences); no separate `admin_commands.*` confirm key needed.

---

## 3. File-by-file changes

Gating keys off a single derived boolean. In `App.tsx`, compute once (near the existing
`isTxDisabled` at :245) and thread it down. **MQTT-bridge sources are never gated**, so combine
with the existing `isMqttBridge` flag:

```ts
// App.tsx, after line 245
const txGated = isTxDisabled && !isMqttBridge;   // Meshtastic TCP source with TX off
```
(These surfaces — ChannelsTab / MessagesTab / NodePopup — are inherently the Meshtastic unified
views; MeshCore has its own components and is out of scope by construction.)

### 3.1 `src/App.tsx` — send-handler 409 handling + prop threading
The handlers use `authFetch` and already branch on `response.ok`. In each handler's non-ok /
catch path, detect TX-disabled and surface the toast. App already has `showToast`, `t`,
`isTxDisabledBody`. Handlers (verified):

- `handleSendMessage` — `:2591` (channel send + Enter). Currently returns early on `!connected`.
  Read `errorData` in the failure branch and, if `isTxDisabledBody(response.status, errorData)`,
  `showToast(t('tx_disabled.send_blocked_toast'), 'warning')` and return before the generic `setError`.
- `handleSendBell` (channel) `:2719`, `handleSendBellDM` `:2744` — same failure-branch check.
- `handleSendPosition` `:2768` — same.
- `handleResendMessage` `:2790` — same.
- `handleRequestNeighborInfo` `:2068`, `handleRequestTelemetry` `:2118` — these currently
  `catch` and only `logger.error`. Add a `response.ok`/`errorData.code` inspection (telemetry
  already parses `detail`; neighborinfo needs a `response.ok` check added) and toast on TX-disabled.
- Tapback (`handleSendTapback`) and exchange position/nodeinfo (which route through the same
  `/api/position/request` and `/api/nodeinfo/request` handlers) — apply the same check in their
  handler bodies.

Thread the gate flag into the two tab renders and the two NodePopup renders:
- `<ChannelsTab ... />` at `:3628` — add `txDisabled={txGated}`.
- `<MessagesTab ... />` at `:3680` — add `txDisabled={txGated}`.
- Map `<NodePopup>` inside the map route `~:3546` region and the standalone `<NodePopup>` `~:3792`
  — add `txDisabled={txGated}` to both.

> Ratchet note: adding a `showToast`/`isTxDisabledBody` call inside these handlers introduces no
> new hook deps (they are plain async functions, not `useCallback`). No `react-hooks/exhaustive-deps`
> impact in App.tsx.

### 3.2 `src/components/ChannelsTab.tsx` — channel send box, bell, position, tapback
- Add `txDisabled?: boolean;` to `ChannelsTabProps` (near `connectionStatus: string;` at `:91`)
  and destructure it (near `:172`).
- The send form renders only when `connectionStatus === 'connected'` (`:1185`) — keep that; we
  disable within it, not hide. In the input/button block (`~:1210-1258`):
  - message textarea `~:1212`: add `disabled={txDisabled}` and wrap or set `title={txDisabled ? t('tx_disabled.control_tooltip') : undefined}`; also guard the Enter handler (`~:1225`) so `handleSendMessage` is not called when `txDisabled`.
  - bell button `~:1246` (`onSendBell`), position button `~` (`onSendPosition`), send button `:1255` (`disabled={!newMessage.trim()}` → `disabled={!newMessage.trim() || txDisabled}`): add `|| txDisabled` and the conditional `title`.
- Tapback: the reaction/emoji controls — emoji-picker button `:1099` (`setEmojiPickerMessage`) and
  existing-reaction click `:1160` (`handleSendTapback`). Add `disabled={txDisabled}` /
  `title` to the emoji-picker button; for the reaction chips, either disable the click when
  `txDisabled` or rely on the handler-level 409 toast (chips are also used to read reactions, so
  prefer keeping them clickable and letting the toast fire). Document the choice inline.

**Because the disabled `title` on a `<button disabled>` does not always fire hover events in every
browser, wrap the send/bell/position button group's tooltip on an enclosing `<span title=...>`**
(same trick already acceptable in the codebase) if QA finds the native title doesn't show. The
input `title` fires reliably.

### 3.3 `src/components/MessagesTab.tsx` — DM send box, bell, resend, exchange/request buttons
- Add `txDisabled?: boolean;` to `MessagesTabProps` (near `connectionStatus: string;` `:118`),
  destructure near `:224`.
- DM send box renders under `connectionStatus === 'connected'` (`:1777`); keep shown, disable within:
  - DM textarea `~:1798` and send button `:1833` (`disabled={!newMessage.trim()}` → `|| txDisabled`), bell button `:1825` (`onSendBell`): add `|| txDisabled` + conditional `title`.
- The per-node action buttons already read `connectionStatus !== 'connected' || <loading>`. Add
  `|| txDisabled` to each and set the `title` to `tx_disabled.control_tooltip` when `txDisabled`:
  - traceroute `:1208` and the second traceroute button `:2046`/`:2067` (node-detail panel).
  - send-position / exchange-position `:1239`.
  - nodeinfo / key-repair exchange `:1250` and `:2132`.
  - request-telemetry `:1261`.
  - **Leave `admin scan` `:1295` as-is** unless it maps to a transmit primitive — verify; the
    remote-admin scanner sends over LoRa, so if it fires an OTA request, gate it too (`|| txDisabled`).
    (It is a request; gate it.)

### 3.4 `src/components/NodePopup/NodePopup.tsx` + `src/components/map/popups/sections.tsx` — map traceroute
- `NodePopup` already receives `connectionStatus`, `tracerouteLoading`, `onTraceroute`. Add
  `txDisabled?: boolean;` to `NodePopupProps` (`:32-47`), destructure (`:53-68`).
- The traceroute run button lives in `TracerouteBody` (`sections.tsx:360`), gated by
  `runDisabled` (`:356/:367`, applied to the `<button ... disabled={runDisabled}>` at `:432`).
  - In `NodePopup`, OR `txDisabled` into the value passed as `runDisabled` (`:182`:
    `runDisabled={connectionStatus !== 'connected' || tracerouteLoading === node.user?.id || txDisabled}`).
  - Add an optional `runDisabledReason?: string` prop to `TracerouteBodyProps` and set
    `title={runDisabledReason}` on the button (so the tooltip explains *why*). `NodePopup` passes
    `runDisabledReason={txDisabled ? t('tx_disabled.control_tooltip') : undefined}`.
- `sections.tsx` is a shared popup primitive: adding one optional prop + `title` is additive and
  keeps its existing tests green.

### 3.5 `src/hooks/useSourceView.ts` — node-list/map traceroute 409 race
`handleTraceroute` (`:183-225`) is fire-and-forget (`authFetch` then poll; no `response.ok`
check). Add a `response.ok` guard: on non-ok, parse the body and if
`isTxDisabledBody(response.status, body)` call `showToast(t('tx_disabled.send_blocked_toast'), 'warning')`
(both `showToast` and `t` are already in scope, `:140`). This covers the race where the button
wasn't yet disabled. **Add `showToast`/`t` to the `useCallback` dep array only if not already
present** (they are already effectively closed over — confirm the existing dep list at `:225` and
extend minimally to avoid a NEW `exhaustive-deps` violation).

### 3.6 `src/components/configuration/LoRaConfigSection.tsx` — danger-confirm on TX disable
The `txEnabled` checkbox (`onChange={(e) => setTxEnabled(e.target.checked)}`) is already a real,
settable control. Wrap the change to confirm only on the true→false transition:

```tsx
const handleTxEnabledChange = (checked: boolean) => {
  if (!checked && txEnabled) {
    if (!window.confirm(t('lora_config.tx_disable_confirm'))) return; // keep it checked
  }
  setTxEnabled(checked);
};
// ...
<input id="txEnabled" type="checkbox" checked={txEnabled}
       onChange={(e) => handleTxEnabledChange(e.target.checked)} ... />
```
No other change here; the parent already sends the real value.

### 3.7 `src/components/ConfigurationTab.tsx` — remove nothing to add; wire freshness invalidation
- `handleSaveLoRaConfig` (`:857`) already sends the real `txEnabled` from state (`:888`) — Phase 1
  backend consumes it directly. **No force-true to remove here** (the `useState(true)` seed at `:89`
  is only a pre-load default; `:426-427` overwrites it from device config when present — correct
  preserve-current behavior).
- After the successful `apiService.setLoRaConfig(...)` (right after `showToast(t('config.lora_saved_toast')...)`
  at `:893`), invalidate TX status so the banner + gating update promptly:
  ```ts
  queryClient.invalidateQueries({ queryKey: ['txStatus'] }); // prefix match → all sources
  ```
  Add `import { useQueryClient } from '@tanstack/react-query';` and
  `const queryClient = useQueryClient();` (not currently in this file).

### 3.8 `src/components/AdminCommandsTab.tsx` — remove force-true, gate remote actions, confirm, invalidate
- **Remove the two force-true load defaults** (epic exit criterion 3). At `:503` and `:1059`:
  `txEnabled: config.txEnabled ?? true,` → `txEnabled: config.txEnabled !== false,`
  (keeps default-true only when genuinely absent, but reflects an explicit device `false` —
  matches the `tx-status` default-true convention rather than force-coercing). The send path
  (`:1652 txEnabled: configState.lora.txEnabled`) already forwards the real value — leave it.
  > Note: the epic referenced `useAdminCommandsState.ts:223`; **that file does not exist in this
  > tree** — the only frontend force-true sites are these two `?? true` lines in AdminCommandsTab.
- **Compute a component-level remote flag.** `localNodeNum`/`isLocalNode` are computed inline in
  several handlers (`:659`, `:933`, `:1193`). Hoist a memo near the top of the component:
  ```ts
  const localNodeNum = useMemo(
    () => nodes.find(n => (n.user?.id || n.nodeId) === currentNodeId)?.nodeNum,
    [nodes, currentNodeId]
  );
  const isManagingRemoteNode =
    selectedNodeNum !== null && selectedNodeNum !== 0 && selectedNodeNum !== localNodeNum;
  ```
- **TX status for the active source.** Add `const { isTxDisabled } = useTxStatus({ baseUrl, sourceId });`
  (component already has `sourceId`; import the hook). Derive
  `const remoteAdminBlocked = isManagingRemoteNode && isTxDisabled;`
- **Gate remote-target actions (not local).** `executeCommand` (`:1407`) is the single choke point
  for every remote admin send and already shows a toast on error. Add, at the top of
  `executeCommand`, an early guard:
  ```ts
  if (remoteAdminBlocked) { showToast(t('tx_disabled.remote_admin_notice'), 'warning'); return; }
  ```
  and, in its `catch`, detect a 409 race — `if (isTxDisabledError(error)) showToast(t('tx_disabled.send_blocked_toast'), 'warning'); else <existing>`.
  Add `remoteAdminBlocked` to the `executeCommand` `useCallback` deps (it already depends on
  `showToast`, `t`). Because **local-node admin never sets `isManagingRemoteNode`**, reboot /
  set-time / local config-read/write / **local `setLoRaConfig`** stay fully usable — this is the
  path that re-enables TX.
- **Disable the remote action buttons + tooltip.** For the action buttons that target the remote
  node (reboot, purge NodeDB, favorite/ignore, the per-config "Set" buttons), add
  `disabled={... || remoteAdminBlocked}` and `title={remoteAdminBlocked ? t('tx_disabled.remote_admin_notice') : undefined}`.
  (Belt-and-suspenders with the `executeCommand` guard.)
- **Inline notice.** When `remoteAdminBlocked`, render a notice block at the top of the tab body:
  `{remoteAdminBlocked && <div className="admin-notice-banner">{t('tx_disabled.remote_admin_notice')}</div>}`
  (reuse an existing warning/notice class if present in AdminCommandsTab's stylesheet; otherwise a
  minimal inline style is acceptable here since this is an existing global-styled component, not a
  new CSS-module component).
- **Inline LoRa TX checkbox confirm** (`:2811-2812`): wrap like §3.6 —
  `onChange={(e) => { const checked = e.target.checked; if (!checked && configState.lora.txEnabled && !window.confirm(t('lora_config.tx_disable_confirm'))) return; setLoRaConfig({ txEnabled: checked }); }}`.
- **Freshness invalidation** after a successful local LoRa save (`:1670` `executeCommand('setLoRaConfig', ...)`):
  add `queryClient.invalidateQueries({ queryKey: ['txStatus'] })` after it resolves. Add
  `useQueryClient` import + instance. (Harmless for remote saves; correct for local.)

---

## 4. Work packages

Dependency-ordered. **Tests fold into each WP** (no separate test WP). Full Vitest suite must be
green at the end of each WP.

### WP1 — Shared helper + i18n keys (foundation, no UI behavior yet)
**Files:** `src/utils/txDisabled.ts` (+`.test.ts`); `public/locales/en.json`.
- Implement `isTxDisabledBody` / `isTxDisabledError` / `TX_DISABLED_CODE`.
- Add the four new `en.json` keys (§2b).
- **Tests:** `txDisabled.test.ts` — truthy on `(409, {code:'TX_DISABLED'})` / `{code:'TX_DISABLED'}`,
  falsy on other statuses/codes/non-objects.
- No other file imports it yet → safe to land first, unblocks all others.

### WP2 — LoRa checkbox usability + freshness invalidation (config surfaces)
**Depends on:** WP1 (i18n key). **Files:** `LoRaConfigSection.tsx`, `ConfigurationTab.tsx`,
plus the AdminCommandsTab LoRa-checkbox confirm + local-save invalidation + the two `?? true`
removals **only if** WP4 isn't taken first — to keep file sets disjoint, **do the AdminCommandsTab
LoRa-checkbox confirm, `?? true` removal, and local-save invalidation in WP4**, and keep WP2 to
`LoRaConfigSection.tsx` + `ConfigurationTab.tsx`.
- §3.6 confirm dialog in `LoRaConfigSection`.
- §3.7 `queryClient.invalidateQueries(['txStatus'])` after ConfigurationTab LoRa save.
- **Tests:** `LoRaConfigSection` test — unchecking TX with `window.confirm` mocked → `true` calls
  `setTxEnabled(false)`; mocked → `false` does NOT; checking TX never prompts. `ConfigurationTab`
  test (extend existing) — successful LoRa save calls `queryClient.invalidateQueries` with the
  `['txStatus']` key (mock `useQueryClient`).

### WP3 — Messaging + map gating (ChannelsTab / MessagesTab / NodePopup / useSourceView / App threading)
**Depends on:** WP1. **Files:** `App.tsx`, `ChannelsTab.tsx`, `MessagesTab.tsx`,
`NodePopup/NodePopup.tsx`, `map/popups/sections.tsx`, `hooks/useSourceView.ts` (+ their tests).
- §3.1 App: `txGated` derivation, prop threading, send-handler 409 toasts.
- §3.2/§3.3/§3.4/§3.5 disabled+tooltip on every messaging/map send control; 409 race toasts.
- **Tests:** new `ChannelsTab.txDisabled.test.tsx`, `MessagesTab.txDisabled.test.tsx`
  (render with `txDisabled` and assert send/bell/position/traceroute/exchange/telemetry controls
  are `disabled` and carry the tooltip `title`); extend `NodePopup.test.tsx` and
  `sections.test.tsx` for `runDisabled`/`runDisabledReason`. Assert reads remain enabled.
- Disjoint from WP2/WP4 file sets → parallelizable with WP2.

### WP4 — AdminCommandsTab remote gating + force-true removal + confirm + invalidation
**Depends on:** WP1. **Files:** `AdminCommandsTab.tsx` (+ `AdminCommandsTab.txDisabled.test.tsx`).
- §3.8 in full: `?? true` → `!== false`; `useTxStatus`; `isManagingRemoteNode`/`remoteAdminBlocked`;
  `executeCommand` guard + catch; remote action buttons disabled+title; inline notice; inline LoRa
  checkbox confirm; local-save `['txStatus']` invalidation.
- **Tests:** remote node selected + TX off → `executeCommand` guarded (no network call, notice
  toast), remote buttons disabled, notice rendered. Local node selected + TX off → admin fully
  enabled (reboot/set-time/local setLoRaConfig NOT disabled). Unchecking inline TX prompts
  `window.confirm`. Successful local LoRa save invalidates `['txStatus']`.
- Single-file (plus its test) → parallelizable with WP2 and WP3.

**Ordering:** WP1 first; then WP2 ‖ WP3 ‖ WP4 in parallel (disjoint files). Merge order is flexible.

---

## 5. ESLint ratchet / conventions guardrails

- **No raw `fetch()`** in any touched component/page — reuse `authFetch` / `apiService`. New util
  `txDisabled.ts` does no I/O.
- **`react-hooks/exhaustive-deps` is ratcheted.** When adding `txDisabled` / `remoteAdminBlocked` /
  `isTxDisabledBody` references inside an existing `useCallback` (`useSourceView.handleTraceroute`,
  `AdminCommandsTab.executeCommand`), **add every newly-referenced value to that callback's dep
  array** so no NEW violation is introduced. App.tsx send handlers are plain functions — no dep impact.
- **No `any`** in new code (`no-explicit-any` is an error). The helper uses `unknown` + narrowing.
- **No new global CSS.** Changes are `disabled`/`title`/existing-class additions. The only new
  visible chrome is the AdminCommandsTab inline notice — reuse an existing notice class; if none
  fits, a minimal inline style is acceptable in that already-global-styled component (a new CSS
  module for one banner line is not warranted). Do not add rules to the frozen `src/styles/*.css`.
- **UiIcon rule:** if the notice or any new control needs an icon, use `UiIcon`, never a literal emoji.
- Verify locally with `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` (empty = pass).

---

## 6. Browser-validation flows (live dev container, chrome-devtools)

Prereq: configure a **Meshtastic TCP source with TX disabled** (set `lora.txEnabled=false` on the
device, or via the LoRa Config UI using the new confirm — then confirm the global
`banners.tx_disabled` banner is showing). Drive:

1. **Channel send box** (Channels tab): input + send + bell + position buttons render **disabled**;
   hovering shows the `tx_disabled.control_tooltip`. Reactions/reads still visible. Enter in the box
   does not send.
2. **DM send box** (Messages tab): DM input/send/bell disabled + tooltip; resend button on own
   messages disabled.
3. **Per-node request buttons** (Messages node detail): traceroute, exchange position, exchange
   nodeinfo/key-repair, request telemetry, request neighbor-info, admin-scan all disabled + tooltip.
4. **Map popup** (Nodes/Map): open a node popup → the "Run traceroute" button is disabled with the
   tooltip; the rest of the popup (identity/signal/position) reads normally.
5. **AdminCommandsTab — remote node:** select a *remote* node → inline "remote admin unavailable"
   notice appears; remote action buttons disabled; clicking a still-enabled path yields the
   `send_blocked_toast` (race), not a crash.
6. **AdminCommandsTab — local node:** select the *local* node → all admin controls usable
   (reboot, set-time, config read/write). **Toggle TX back on via the local LoRa checkbox** — the
   `lora_config.tx_disable_confirm` prompt appears only when *disabling*; re-enabling does not prompt.
7. **Freshness:** after saving the LoRa config (either ConfigurationTab or local AdminCommandsTab),
   confirm the global banner and all gated controls update within a couple seconds **without a page
   reload** (the `['txStatus']` invalidation), and again passively within the 30s poll if you change
   TX on the device directly.
8. **Race toast:** with TX disabled, momentarily race a send before the poll updates (e.g. via a
   direct API call in devtools) and confirm the backend 409 surfaces as the friendly warning toast.
9. **Negative control:** repeat 1–4 on a normal TX-enabled source and on an MQTT-bridge source —
   nothing should be gated.

---

## 7. Out of scope (Phase 3)

- Automations builder `sendMessage` warning badge.
- v1 API docs, user-facing receive-only docs, locale-string translation verification (Weblate).
- MeshCore / MQTT-bridge TX gating (intentionally never gated — different transport).
- Any backend change (Phase 1 is the enforcement point; Phase 2 is UX only).
