# MeshCore Strict Receive-Only — Phase 2 Implementation Spec (Frontend gating UX)

**Epic:** #4547 (see `MESHCORE_RECEIVE_ONLY_EPIC.md`). **Phase 1 spec:** `MESHCORE_RECEIVE_ONLY_PHASE1_SPEC.md`.
**Branch:** `feature/meshcore-receive-only-ui` (worktree `/home/yeraze/Development/meshmonitor-mc-rxonly-p2`).
**Template:** `TX_DISABLED_PHASE2_SPEC.md` (Meshtastic #4294 Phase 2) — same disabled-not-hidden
philosophy, same `disabled` + `title` idiom, same toast-on-409 fallback.

Phase 1 shipped the enforcement: the `meshcoreReceiveOnly` per-source setting, `isReceiveOnly()` /
`canTransmit()`, a fail-closed bridge-command denylist, 24 primitive guards, 10 scheduler
silent-skips, 22 routes returning `409 TX_DISABLED`, and the read contract. **Phase 2 adds no
enforcement** — every control it disables is already blocked server-side. Phase 2 makes the block
*visible and explainable* so the user is never left staring at a dead button.

One backend item rides along (§4): `POST /api/settings` does not validate the
`meshcoreReceiveOnly` value, which is a fail-**open** on malformed input.

> **Anchors.** All `file:line` references below were read against this worktree on 2026-08-04.
> Line numbers drift as implementers edit above them — **anchor on the quoted code, not the number.**

---

## 1. Reuse inventory (verified — do NOT introduce new primitives for these)

| Concern | What already exists | Location | Verdict for Phase 2 |
|---|---|---|---|
| **Per-source TX/receive-only state** | `useTxStatus({ baseUrl, sourceId })` → `{ isTxDisabled, isUdpRelay, ...query }`, TanStack key `['txStatus', baseUrl, sourceId]`, 30 s poll, `staleTime` 25 s, `retry: 1`. `canTransmit ?? txEnabled` fallback for old servers. | `src/hooks/useTxStatus.ts:70-113` | **Serves MeshCore as-is. No extension needed.** Phase 1 made `GET /api/device/tx-status` MeshCore-aware: `deviceStatusRoutes.ts:19-27` narrows via `sourceManagerRegistry.getManager(sourceId)` + `isMeshCoreManager` and returns `{ txEnabled: canTx, udpRelayEnabled: false, canTransmit: canTx }`. So `isTxDisabled === true` **is** "receive-only" for a MeshCore `sourceId`. Do not add a `useMeshCoreReceiveOnly` hook. |
| **409 detection** | `TX_DISABLED_CODE`, `isTxDisabledBody(status, body)`, `isTxDisabledError(err)` — pure, no React, no I/O. | `src/utils/txDisabled.ts` | Reuse verbatim. Already imported by `App.tsx:50`. |
| **Global banner** | `AppBanners` renders one TX banner slot from `isTxDisabled` / `isUdpRelay`; offsets in the config-issue and update banners already count it as one. Uses `UiIcon`. | `src/components/AppBanners/AppBanners.tsx` | Reuse the slot; add **one** optional prop to swap the copy (§3.9). Do not add a second banner. |
| **Banner + tooltip i18n keys** | `banners.tx_disabled`, `banners.tx_disabled_udp_relay`, `tx_disabled.control_tooltip`, `tx_disabled.send_blocked_toast`, `tx_disabled.remote_admin_notice`, `tx_disabled.automation_source_warning`. | `public/locales/en.json:113-131` | Meshtastic-worded, and **one of them is actively misleading on MeshCore** — verbatim strings quoted immediately below. Add a parallel `meshcore.receive_only.*` family (§2); do **not** reword the existing ones (Meshtastic sources still need them verbatim). |
| **Disabled + tooltip pattern** | Native `disabled={...}` + `title={...}`. No tooltip component exists. Precedent for "explain *why* it is disabled" via an optional reason prop: `TracerouteBody.runDisabledReason` (`map/popups/sections.tsx`, added by #4294 Phase 2). | throughout | Reuse. `MeshCoreMessageStream` and `CliConsoleBody` get the same optional-reason prop treatment (§3.1). |
| **Danger confirm** | No shared ConfirmDialog. The app-wide danger-confirm is `window.confirm(t('<key>'))` — used at `MeshCoreSettingsView.tsx:81` (purge all messages), `MeshCoreConfigurationView.tsx:616` (import private key), `LoRaConfigSection.tsx` (TX disable, #4294). | — | Reuse `window.confirm`. |
| **Toast** | `useToast()` → `showToast(message, type, duration?)`, `type ∈ 'success'\|'error'\|'warning'\|'info'`. | `src/components/ToastContainer.tsx` | Reuse. Already in scope in `MeshCoreSettingsView`, `MeshCoreNodesView`, `MeshCoreAutoAnnounceSection`, `MeshCoreTimerTriggersSection`, `App.tsx`. |
| **Fetch wrapper (components)** | `useCsrfFetch()` → `csrfFetch(url, opts, signal)` returns a raw `Response`, adds `X-CSRF-Token` on mutations, `credentials: 'include'`. This is the MeshCore-tree idiom (`useMeshCore.ts`, every `*Section.tsx`). `useAuthFetch()` is the App.tsx idiom. | `src/hooks/useCsrfFetch.ts`; `src/hooks/useAuthFetch.ts` | **Both are hooks, so the `src/components/**` raw-`fetch()` ban is satisfied.** New code must use one of them — never bare `fetch`. |
| **Per-source setting save from inside the MeshCore UI** | `MeshCoreNodeDisplaySection.tsx:105-137` — `csrfFetch(\`${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}\`, { method:'POST', ... })`, then `queryClient.invalidateQueries({ queryKey: nodeDisplaySettingsQueryKey(sourceId) })`, then a success/failure toast. Rendered from `MeshCoreSettingsView.tsx:271`. | `src/components/MeshCore/MeshCoreNodeDisplaySection.tsx` | **This is the idiom for the receive-only toggle**, not the `discoverable` toggle. |
| *(rejected)* Device-state toggle idiom | `MeshCoreSettingsView.tsx:180-188` `handleToggleDiscoverable` — optimistic `setState`, `await setDiscoverable(next)`, revert on failure. Talks to `/meshcore/config/discoverable`, i.e. **device** state. | — | **Rejected for receive-only.** Receive-only is a MeshMonitor *setting* (`source:{id}:meshcoreReceiveOnly`), not device state; it must go through `/api/settings?sourceId=` so the Phase 1 `refreshMeshcoreReceiveOnly` callback (`settingsRoutes.ts:889-891`) fires. |
| **Query invalidation after a TX-state change** | `ConfigurationTab.tsx:898` `void queryClient.invalidateQueries({ queryKey: ['txStatus'] })` — prefix match, hits every source's entry. Test precedent: `ConfigurationTab.txDisabled.test.tsx:92-99`. | — | Reuse verbatim after the toggle save. |
| **Source context** | `useSource()` → `{ sourceId, sourceName, sourceType }`; `sourceType === 'meshcore'` for MeshCore sources. | `src/contexts/SourceContext.tsx` | Reuse in `App.tsx` only (§3.9). MeshCore components already receive `sourceId` as an explicit prop from `MeshCorePage`. |
| **Client radio summary** | `SourceRadioSummary` already carries `receiveOnly?: boolean` and `canTransmit?: boolean` (Phase 1 WP5). Consumed via `useDashboardData.ts:34` (`DashboardSource.radio`), fetched by `useDashboardSources()` under key `['dashboard', 'sources']`. | `src/types/elevation.ts:40-58`; `src/hooks/useDashboardData.ts:102-107` | **Not the distribution channel for Phase 2** — see §3.0. Available for a future dashboard badge; Phase 2 leaves it untouched. |
| **App-level gating already flowing** | `App.tsx:249-251`: `const { isTxDisabled, isUdpRelay } = useTxStatus({ baseUrl, sourceId }); const txGated = isTxDisabled && !isMqttBridge;` — threaded to `ChannelsTab` (`:3592`), `MessagesTab` (`:3717`), both `NodePopup`s. `handleRequestNeighborInfo` (`:2068-2115`) already has a `sourceType === 'meshcore'` branch **and** an `isTxDisabledBody` toast. | `src/App.tsx` | **Free win: because `tx-status` is now MeshCore-aware, `txGated` is already `true` for a receive-only MeshCore source, so the unified-view controls are already disabled.** Phase 2 adds **no** gating logic here — it threads a correct tooltip string (§3.9, required: the current one names a nonexistent remedy) and adds a regression test. Do not re-implement the gating. |
| **Console primitive** | `CliConsoleBody` already has `disabled?: boolean`, `disabledPlaceholder?: string`, `emptyTextDisabled`, and applies `disabled || sending` to the quick-action buttons (`:298`), the input (`:388`) and the Send button (`:395`). Imperative `runCommand` via `CliConsoleBodyHandle`. | `src/components/MeshCore/CliConsoleBody.tsx` | Reuse — **no new props needed** beyond what exists. |
| **Message-composer primitive** | `MeshCoreMessageStream` has `disabled?: boolean` applied to the input (`:615`) and Send button (`:619`); used by Channels (`:741-745`), DMs (`:513-517`) and Rooms (`:369-373`), all as `disabled={!connected || !canSend}`. | `src/components/MeshCore/MeshCoreMessageStream.tsx` | Reuse; add **one** optional `disabledReason?: string` → `title` (§3.1), mirroring `TracerouteBody.runDisabledReason`. |
| **ACL form** | `MeshCoreAclManager` already has `disabled?: boolean`; pushes `setperm …` through the parent's `CliConsoleBodyHandle`. | `src/components/MeshCore/MeshCoreAclManager.tsx:44-56` | Reuse the existing prop. Currently rendered with **no** `disabled` at `MeshCoreRemoteConsole.tsx:283` and `MeshCoreLocalConsole.tsx:143`. |
| **Icons** | `UiIcon` registry, keyed by `UiIconName = keyof typeof UI_ICON_DEFINITIONS`, re-exported from `src/components/icons/index.ts`. **Verified present:** `blocked` (Ban, "ignored and blocked state") `UiIcon.tsx:144`; `pause` (Pause, "pause controls") `:193`; `alert` (AlertTriangle) `:136`; `info` `:176`; `radio` `:198`; `radioSignal` `:204`. | `src/components/icons/UiIcon.tsx` | **Use `UiIcon name="blocked"` for the status-bar chip and `UiIcon name="pause"` for the paused note — both verified to exist.** `UiIconName` is a keyof type, so a wrong name is a `tsc` error, not a silent blank. **No literal emoji in JSX or locale copy.** |
| **Route test harness / component tests** | 18 existing `src/components/MeshCore/*.test.tsx` files (RTL + Vitest). `createRouteTestApp()` for the one server-side test (§4). | `src/server/test-helpers/routeTestApp.ts` | Reuse both. |

### The existing TX-disabled strings, verbatim (read 2026-08-04, `public/locales/en.json:128-130`)

```
"tx_disabled.control_tooltip":   "Transmit is disabled on this node's radio. Re-enable TX in the LoRa configuration to use this."
"tx_disabled.send_blocked_toast": "Transmit is disabled on this source — nothing was sent."
"tx_disabled.remote_admin_notice": "Remote-node admin is unavailable while Transmit is disabled on this source. Local-node admin still works — you can re-enable TX in the LoRa Config below."
```

**`control_tooltip` names a Meshtastic-specific remedy ("the LoRa configuration") that does not
exist on MeshCore hardware.** A MeshCore user shown this tooltip goes hunting for a LoRa Config
section with a TX checkbox; there is none, and the actual remedy lives in MeshCore → Settings →
Receive-only mode. That is a correctness problem, not a cosmetic one, so **§3.9 threads the MeshCore
variant into the unified views** rather than deferring it. `send_blocked_toast` is transport-neutral
in wording but still says "Transmit is disabled" rather than "receive-only", so it is swapped on the
same flag for consistency. `remote_admin_notice` belongs to `AdminCommandsTab`, which speaks the
Meshtastic admin protocol and is not a MeshCore surface at all (MeshCore remote admin is
`MeshCoreRemoteConsole`) — left alone, noted in §9.

### New code, justified

| New thing | Closest existing | Why new |
|---|---|---|
| `MeshCoreReceiveOnlyNote.tsx` + `MeshCoreReceiveOnlyNote.module.css` | An inline `<p className="hint">` | The "Paused — receive-only mode" note appears at **7 sites** (§3.6). Seven copies of the same icon + string + inline style is worse than one 15-line presentational component, and CSS modules are mandatory for new components (the global sheets are frozen). It renders `null` when `receiveOnly` is false, so call sites stay one line. |
| `disabledReason?: string` on `MeshCoreMessageStream` | `TracerouteBody.runDisabledReason` | Same shape, same reason: a `disabled` control must be able to say *why*. Additive optional prop; existing tests stay green. |
| `isMeshCore?: boolean` on `AppBanners` | — | One prop to pick between two existing banner strings. Cheaper than a second banner slot (which would break the hard-coded `[showTxBanner]` offset arithmetic). |
| Everything else | — | **No new hook, no new context, no new CSS in `src/styles/*`, no new API endpoint, no new query key.** |

---

## 2. New i18n keys — `public/locales/en.json` **only**

`en.json` is the source of truth; `de/es/fr/nb_NO/pl/pt_BR/ru/sv/zh_Hans.json` are Weblate-managed
and `fallbackLng: 'en'` covers the gap. **Do not hand-edit the other locale files.**
No emoji, no Unicode icon stand-ins in any value.

| Key | English value |
|---|---|
| `meshcore.receive_only.title` | `Receive-only mode` |
| `meshcore.receive_only.toggle_label` | `Strict receive-only (never transmit)` |
| `meshcore.receive_only.description` | `Block every transmission from this MeshCore node. Messages, adverts, path discovery, remote CLI, logins, telemetry requests and all automations are held. Receiving, the packet log, the Analyzer Observer, contact and telemetry updates, and local serial configuration keep working.` |
| `meshcore.receive_only.firmware_caveat` | `MeshCore firmware has no radio-level transmit switch, so MeshMonitor enforces this in software. Transmissions the node makes on its own — link-layer acknowledgements, and any advert schedule configured outside MeshMonitor — are not affected.` |
| `meshcore.receive_only.disable_confirm` | `Allow this MeshCore node to transmit again?\n\nMessages, adverts, path discovery, remote administration and every enabled automation will resume sending over the radio. Continue?` |
| `meshcore.receive_only.control_tooltip` | `Receive-only mode is on for this MeshCore source. Turn it off in MeshCore Settings to use this.` |
| `meshcore.receive_only.blocked_toast` | `Receive-only mode is on for this MeshCore source — nothing was sent.` |
| `meshcore.receive_only.paused_note` | `Paused — receive-only mode. These settings are saved and unchanged; they take effect again when receive-only is turned off.` |
| `meshcore.receive_only.status_chip` | `Receive-only` |
| `meshcore.receive_only.saved_on` | `Receive-only mode enabled — this node will not transmit` |
| `meshcore.receive_only.saved_off` | `Receive-only mode disabled — this node can transmit again` |
| `meshcore.receive_only.save_failed` | `Failed to change receive-only mode` |
| `meshcore.receive_only.console_placeholder` | `Local serial commands still work; commands that transmit are blocked.` |
| `banners.receive_only_meshcore` | `Receive-Only Mode: this MeshCore source will not transmit. Messages, adverts, path discovery, remote administration and automations are held. Turn it off in MeshCore Settings to transmit again.` |

---

## 3. File-by-file changes

### 3.0 Distribution of the receive-only flag — **decision**

**Call `useTxStatus` exactly once, in `MeshCorePage`, and thread one `receiveOnly: boolean` prop
down.** This is the same shape App.tsx uses for `txGated` (`App.tsx:251`).

Rejected alternatives, for the record:
- **A new React context.** Rejected: `MeshCorePage` already prop-threads `status`, `loading`,
  `actions`, `sourceId`, `baseUrl` to every child. One more boolean costs nothing and a context
  would be a second, parallel source of truth for something TanStack already caches.
- **`useTxStatus` per component.** Rejected: same query key in ~12 components is deduped by
  TanStack but multiplies the mock surface in every component test for no benefit.
- **`GET /api/sources` → `radio.receiveOnly` (`useDashboardSources`, key `['dashboard','sources']`).**
  Rejected as the *gating* channel: it is a heavier, dashboard-shaped payload on a different
  cadence, and `useTxStatus` is already the app's established "can this source send?" question with
  an existing invalidation convention. Phase 1 correctly shipped both; Phase 2 consumes the
  cheaper, purpose-built one. (The `radio.receiveOnly` field stays available for a future
  dashboard badge — Phase 2 does not touch it.)
- **Adding `useTxStatus` inside `useMeshCore`.** Rejected: `useMeshCore` is the API layer and is
  mocked wholesale in several tests; adding a query there widens the mock surface.

`MeshCorePage.tsx` (`:59-64`):
```ts
import { useTxStatus } from '../../hooks/useTxStatus';
// ...
const { isTxDisabled: receiveOnly } = useTxStatus({ baseUrl, sourceId });
```
Thread `receiveOnly={receiveOnly}` into every child rendered at `:95-211`:
`MeshCoreStatusBar`, `MeshCoreNodesView`, `MeshCoreChannelsView`, `MeshCoreRoomsView`,
`MeshCoreDirectMessagesView`, `MeshCoreConfigurationView`, `MeshCoreAutomationsView`,
`MeshCoreSettingsView`. (`MeshCoreTelemetryView`, `MeshCorePacketMonitorView` and
`MeshCoreInfoView` are read-only / serial-only — skip them.)

Each of those adds `receiveOnly?: boolean;` (default `false`) to its props interface and
re-threads to its own children:
- `MeshCoreDirectMessagesView` → `MeshCoreMessageStream`, `MeshCoreContactDetailPanel`,
  `MeshCoreNodeTelemetryConfig` (`:554`).
- `MeshCoreContactDetailPanel` → `MeshCoreRemoteConsole` → `MeshCoreRemoteStatsPanel`,
  `CliConsoleBody`, `MeshCoreAclManager`.
- `MeshCoreConfigurationView` → `MeshCoreLocalConsole` (`:526`) → `CliConsoleBody`,
  `MeshCoreAclManager`.
- `MeshCoreAutomationsView` → all five sections (`:323-336`).
- `MeshCoreChannelsView` / `MeshCoreRoomsView` → `MeshCoreMessageStream`.

**Freshness.** The toggle's save invalidates `['txStatus']` (prefix) so every consumer re-reads
within one tick — no page reload. The 30 s poll is the passive backstop for an out-of-band change
(another browser tab, a direct API call).

### 3.1 Shared primitives

**`src/components/MeshCore/MeshCoreMessageStream.tsx`**
- Add `disabledReason?: string;` to the props interface (near `disabled`).
- Input (`:608-616`): add `title={disabled ? disabledReason : undefined}`.
- Send button (`:617-622`): same.
- Wrap the two controls' shared parent `<div className="meshcore-send-bar">` (`:607`) with
  `title={disabled ? disabledReason : undefined}` as well — a `title` on a `disabled` `<button>`
  does not fire hover in every browser; the enclosing element's does. (Same trick the #4294 spec
  called out.)
- No behavior change when `disabledReason` is omitted.

**`src/components/MeshCore/MeshCoreReceiveOnlyNote.tsx`** (new) + `.module.css`
```tsx
interface MeshCoreReceiveOnlyNoteProps { receiveOnly?: boolean; className?: string; }
```
Renders `null` unless `receiveOnly`. Otherwise a single `<p role="status" className={...}>` with
`<UiIcon name="pause" size={14} />` + `{t('meshcore.receive_only.paused_note')}`.
(`pause` = lucide `Pause`, "pause controls" — verified at `UiIcon.tsx:193`. `UiIconName` is a
`keyof` type, so a wrong name fails `tsc` rather than rendering blank.)
Styling in `MeshCoreReceiveOnlyNote.module.css` — muted foreground, small type, `0.5rem` gap.
**No rule may be added to `src/styles/*.css`.**

### 3.2 The toggle — `src/components/MeshCore/MeshCoreSettingsView.tsx`

Add a **new `form-section` immediately above** the existing "Device actions" section (`:255`), so
the explanation sits above the buttons it disables.

State + save (model on `MeshCoreNodeDisplaySection.tsx:105-137`):
```ts
const queryClient = useQueryClient();          // @tanstack/react-query — new import here
const csrfFetch = useCsrfFetch();              // new import here
const [savingReceiveOnly, setSavingReceiveOnly] = useState(false);

const handleToggleReceiveOnly = useCallback(async (next: boolean) => {
  // Enabling is the safe direction — no confirm. Disabling resumes RF transmission.
  if (!next && !window.confirm(t('meshcore.receive_only.disable_confirm', '...'))) return;
  setSavingReceiveOnly(true);
  try {
    const res = await csrfFetch(
      `${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meshcoreReceiveOnly: next }) },
    );
    if (!res.ok) { showToast(t('meshcore.receive_only.save_failed', '...'), 'error'); return; }
    await queryClient.invalidateQueries({ queryKey: ['txStatus'] });
    showToast(t(next ? 'meshcore.receive_only.saved_on' : 'meshcore.receive_only.saved_off', '...'),
              'success');
  } finally { setSavingReceiveOnly(false); }
}, [baseUrl, sourceId, csrfFetch, queryClient, showToast, t]);
```
Every value referenced inside the callback is in the dep array — **no new
`react-hooks/exhaustive-deps` violation.**

Rendering:
```tsx
<div className="form-section">
  <h3>{t('meshcore.receive_only.title', 'Receive-only mode')}</h3>
  <label style={{ display:'flex', alignItems:'center', gap:'0.5rem' }}>
    <input type="checkbox" checked={receiveOnly} disabled={savingReceiveOnly}
           onChange={(e) => void handleToggleReceiveOnly(e.target.checked)} />
    <span>{t('meshcore.receive_only.toggle_label', '...')}</span>
  </label>
  <p className="hint">{t('meshcore.receive_only.description', '...')}</p>
  <p className="hint">{t('meshcore.receive_only.firmware_caveat', '...')}</p>
</div>
```
`checked` reads the threaded `receiveOnly` prop (server truth via `useTxStatus`), **not** local
state — so the checkbox and every gated control flip together off one cache entry and cannot
disagree. No optimistic update: the invalidation lands in well under the ~200 ms it takes a user to
notice, and an optimistic flip that later reverts would be worse for a safety control.

**Confirm policy — decision and rationale.** Confirm on **disable only**. Unlike Meshtastic
(`lora_config.tx_disable_confirm`, where *disabling* TX is the dangerous direction because it makes
the node invisible to the mesh), here the dangerous direction is inverted: enabling receive-only is
the conservative, reversible choice, while disabling it silently resumes RF transmission — possibly
releasing queued automations, adverts and auto-acks. The confirm therefore guards the resume.
Copy is `meshcore.receive_only.disable_confirm`.

Gate the section's own TX buttons (all with `title={receiveOnly ? t('meshcore.receive_only.control_tooltip') : undefined}`):
- Send advert `:265` → `disabled={!connected || loading || receiveOnly}`.
- Discover Nearby / Repeaters / Sensors `:282,290,298` → append `|| receiveOnly`.
- Discover regions `:414` → append `|| receiveOnly`.
- **Not** gated: Refresh contacts `:262` (serial), Save scope `:405` (serial `set_flood_scope`),
  saved-region add/delete (DB only), purge messages (DB only).
- "Respond to discovery requests" toggle `:367-375`: leave settable (it is device state Phase 1
  neutralises at chokepoint B), but render `<MeshCoreReceiveOnlyNote receiveOnly={receiveOnly} />`
  under it.

### 3.3 The 409 fallback — `src/components/MeshCore/hooks/useMeshCore.ts`

Every MeshCore TX call funnels through this hook, so one helper covers every consumer *and* every
second render path. Add near the top of the hook body:
```ts
const { showToast } = useToast();
/** True when the response was the Phase 1 409; also raises the toast. */
const reportTxDisabled = useCallback((status: number, body: unknown): boolean => {
  if (!isTxDisabledBody(status, body)) return false;
  showToast(t('meshcore.receive_only.blocked_toast', '...'), 'warning');
  return true;
}, [showToast, t]);
```
Call it in the failure branch of each TX action, **before** the existing `setError(...)`, and return
the existing failure value when it returns `true` (so the red inline error does not double up with
the toast). Actions to patch (all in this file):

`sendMessage`, `sendRoomPost`, `loginRoom`, `loginRoomWithSaved`, `loginRemote`,
`loginRemoteWithSaved`, `sendCliCommand` (`:1148`), `sendLocalCliCommand` (`:1185`),
`getRemoteStatus` (`:1241`), `sendAdvert`, `discoverNodes` (`:958`), `discoverRegions` (`:1048`),
`resetContactPath` (`:911`), `discoverContactPath` (`:940`), `traceContactPath`,
`pingContactZeroHop`, `shareContact`, `getNeighbours`.

Several of these (`sendCliCommand`, `sendLocalCliCommand`) already read `data.code` and
`response.status` into their return value — reuse those, do not re-parse the body twice.
`sendLocalCliCommand` is how a typed `advert` reaches the console: it 409s, the toast fires, and
the console prints the server's error line as it does today.

Ratchet: `reportTxDisabled` is referenced inside existing `useCallback`s — **add it to each of those
dep arrays** in the same edit.

### 3.4 Messaging surfaces

| Surface | File:line | Route | Change |
|---|---|---|---|
| Channel send box | `MeshCoreChannelsView.tsx:741-745` `disabled={!connected \|\| !canSend}` | POST `/messages/send` | `\|\| receiveOnly` + `disabledReason={receiveOnly ? t('meshcore.receive_only.control_tooltip') : undefined}` |
| DM send box | `MeshCoreDirectMessagesView.tsx:513-517` | POST `/messages/send` | same |
| Room post box | `MeshCoreRoomsView.tsx:369-373` | POST `/rooms/post` | same |
| Room login button | `MeshCoreRoomsView.tsx:308-311` `disabled={loginLoading}` | POST `/rooms/login` | `\|\| receiveOnly` + `title` |
| Room password input + Enter | `MeshCoreRoomsView.tsx:293-295` | " | `disabled={loginLoading \|\| receiveOnly}`; guard the `onKeyDown` Enter branch with `!receiveOnly` |
| Room auto-login-with-saved | `MeshCoreRoomsView.tsx:131-147` (effect) | POST `/rooms/login-with-saved` | **§3.4a** — fires from an effect, not a click; a disabled button does not stop it |
| Room sync-config save | `MeshCoreRoomsView.tsx:362` | settings write (no RF) | **Not gated.** Render `<MeshCoreReceiveOnlyNote />` beside it (the sync *scheduler* logs in over RF and is Phase-1-skipped). |

### 3.4a Automatic / background TX triggers — silent skip, never a toast

Three TX calls fire **without user action**. A disabled button does not stop any of them, and left
unguarded each produces a 409 on every mount or selection change. Because §3.3 routes those 409s
through `reportTxDisabled`, an unguarded version means a **toast storm on page load** — the user
would see warnings for actions they never took.

**Rule — mirror Phase 1's scheduler contract at the UI layer.** *Automatic and background paths
skip silently: no request is issued, no toast is raised, and no error state is set. Only
user-initiated actions surface the receive-only toast.* Because the guard returns before the fetch,
`reportTxDisabled` is never reached — that is the mechanism, and it is what the tests assert.

**Latch hazard — read this before writing the guard.** All three effects set a
"do not repeat" latch **before** awaiting. Placing the guard after the latch would permanently
poison the effect for that session: turning receive-only back off would never re-trigger it. **The
`receiveOnly` early return must come before the latch is set.**

#### (a) Rooms auto-login — `MeshCoreRoomsView.tsx:131-147`
```ts
useEffect(() => {
  if (!selectedRoom) return;
  if (loggedInRooms.has(selectedRoom)) return;
  if (!storedCreds.has(selectedRoom)) return;
  if (receiveOnly) return;                       // ← ADD HERE, before the latch below
  if (autoLoginAttempted.current.has(selectedRoom)) return;
  autoLoginAttempted.current.add(selectedRoom);  // the latch
  // ...
}, [selectedRoom, loggedInRooms, storedCreds, actions, receiveOnly]);   // ← dep added
```
Placed after the cheap identity checks and **before** `autoLoginAttempted.current.add(...)`, so
selecting the same room again after receive-only is turned off still auto-logs in.

#### (b) ChannelsView region discovery — `MeshCoreChannelsView.tsx:373-390`
```ts
useEffect(() => {
  if (!showScopeOverride || !status?.connected) return;
  if (receiveOnly) return;                       // ← ADD HERE, before the latch below
  if (regionsDiscoveredRef.current) return;
  regionsDiscoveredRef.current = true;           // the latch
  // ...
}, [showScopeOverride, status?.connected, discoverRegions, receiveOnly]);   // ← dep added
```
The file's own comment at `:372-375` already warns that `discoverRegions()` "emits active radio
traffic" and must never be tied to `status?.connected` because reconnect flapping would flood the
mesh (#3704 review) — the same reasoning applies here. Guarding before
`regionsDiscoveredRef.current = true` means reopening the scope-override panel after receive-only is
turned off still populates the suggestion datalist. The existing `catch` already resets the latch on
failure; the guard must not touch it.

#### (c) RemoteStatsPanel auto-load — `MeshCoreRemoteStatsPanel.tsx:44-60`
`load()` early-returns when `receiveOnly`, before any `fetchStatus(publicKey)` call and before any
loading state is set; `receiveOnly` joins its dep array (`:60`). Its user-initiated entry points
(the refresh button `:85-89`, the empty-state button `:144`) are separately disabled in §3.5, so the
only caller that can reach the guard is the automatic one.

### 3.5 Contact / node / console / telemetry surfaces

**`MeshCoreContactDetailPanel.tsx`** — gate six buttons with `|| receiveOnly` and the tooltip
`title`; leave two alone.

| Button | Line | Route | Gate? |
|---|---|---|---|
| Reset path | `:632-636` (`disabled={resetting}`) | POST `/contacts/:pk/reset-path` | **yes** |
| Share contact | `:645-649` (`disabled={sharing}`) | POST `/contacts/:pk/share` | **yes** |
| Trace path | `:668-672` (`disabled={tracing}`) | POST `/contacts/:pk/trace-path` | **yes** |
| Ping (0 hop) | `:681-685` (`disabled={pinging}`) | POST `/contacts/:pk/ping` | **yes** |
| Discover path | `:700-704` (`disabled={discovering}`) | POST `/contacts/:pk/discover-path` | **yes** |
| Neighbours | `:726-730` (`disabled={neighboursLoading}`) | **GET** `/contacts/:pk/neighbours` | **yes** — a GET that transmits |
| Export contact | `:713-717` | serial `export_contact` | no |
| Remove contact | `:739-743` | serial `remove_contact` | no |
| Out-path editor Save | `:1154-1158` | serial `set_out_path` | no |

**`MeshCoreNodesView.tsx` — the second render path for Discover.** The same three discovery actions
that live in `MeshCoreSettingsView` (§3.2) are *also* rendered as a menu here
(`:385, :388, :391`, fed by `onDiscoverNodes` from `MeshCorePage.tsx:129`). **This is exactly the
class of miss that cost #4294 a follow-up patch** (`NodesTab.tsx` rendering `TracerouteBody`
directly). Add `disabled={receiveOnly}` + `title` to all three `role="menuitem"` buttons, and an
early return in `handleDiscover` (`:267-287`) with `receiveOnly` added to its dep array.

**`MeshCoreRemoteConsole.tsx`** — every path here is remote-over-RF.
- "Login with saved" `:241-245` (`disabled={loginBusy}`) → `|| receiveOnly` + `title`.
- "Login" opener `:251-255` and the fallback opener `:261` → same.
- Modal submit `:336-340` → same.
- `CliConsoleBody` `:274-280` `disabled={!loggedIn}` → `disabled={!loggedIn || receiveOnly}` and
  `disabledPlaceholder={receiveOnly ? t('meshcore.receive_only.control_tooltip') : <existing>}`.
- `MeshCoreAclManager` `:283` → pass `disabled={receiveOnly}` (the prop already exists).
- `MeshCoreRemoteStatsPanel` `:268-272` → thread `receiveOnly`.

**`MeshCoreRemoteStatsPanel.tsx`** — GET `/admin/status/:pk` transmits.
- Refresh button `:85-89` (`disabled={loading}`) → `|| receiveOnly` + `title`.
- Empty-state fetch button `:144` → `disabled={receiveOnly}` + `title`.
- `load()` (`:44-60`) — the automatic path; guarded per **§3.4a(c)** (silent skip, no toast).

**`MeshCoreLocalConsole.tsx` — the console stays enabled.** Local serial CLI is explicitly allowed
(interview decision 2); only the synthetic `advert` verb transmits.
- Do **not** pass `receiveOnly` into `CliConsoleBody`'s `disabled`.
- Filter the quick-action catalog: the companion catalog's `advert` entry (`:35`) and the repeater
  catalog's `advert` entry (`:47`) must be dropped (or rendered `disabled` with the tooltip) when
  `receiveOnly`. Prefer **disabled + tooltip over removal** — a vanished button teaches the user
  nothing. `ActionCommand` has no `disabled` field, so filter the array and render a separate
  disabled placeholder button, or add an optional `disabled?: boolean` to `ActionCommand` and honor
  it at `CliConsoleBody.tsx:298` (`disabled={disabled || sending || action.disabled}`). **Take the
  `ActionCommand.disabled` route** — it is 2 lines and keeps the button visible.
- Append `t('meshcore.receive_only.console_placeholder')` to the console `placeholder` when
  `receiveOnly`.
- `MeshCoreAclManager` `:143`: `setperm` over the **local serial** link is allowed → leave enabled.

**`MeshCoreNodeTelemetryConfig.tsx`** — POST `/nodes/:pk/telemetry/poll` transmits.
- "Poll status" `:278-282` and "Poll LPP" `:288-292` (`disabled={!canPoll || polling !== null}`) →
  `|| receiveOnly` + `title`.
- The enable checkbox `:221-222` and interval input `:245-246` write settings only — **leave
  editable** (§3.6 consistency rule). Render `<MeshCoreReceiveOnlyNote receiveOnly={receiveOnly} />`
  in the section.
- Also add an `isTxDisabledBody` check to `poll()` (`:152`), which uses `csrfFetch` directly rather
  than `useMeshCore`.

**Status bar — `MeshCoreStatusBar.tsx`.**
- Send advert `:46-52` (`disabled={loading}`) → `|| receiveOnly` + `title`.
  (**Second render path** for the same action as `MeshCoreSettingsView.tsx:265`.)
- Add a persistent chip next to the connection chip when `receiveOnly`, reusing the existing
  `mrc-status-chip mrc-status-idle` class family (see `MeshCoreLocalConsole.tsx:106-115`):
  `<span className="mrc-status-chip mrc-status-idle"><UiIcon name="blocked" size={12} /> {t('meshcore.receive_only.status_chip')}</span>`
  (`blocked` = lucide `Ban` — verified at `UiIcon.tsx:144`).
  This guarantees an always-visible indicator on the MeshCore page regardless of whether the global
  banner renders in that route's tree.
- Disconnect `:53-57` is not RF → not gated.

### 3.6 Automations — "Paused" notes, editable settings

**Consistency rule (interview decision 5): configuration inputs stay fully editable; only controls
that cause an *immediate* transmission are disabled.** Rationale: saving an automation setting does
not transmit — Phase 1's schedulers read the setting and silently skip. Disabling the inputs would
protect nothing while making a user believe their configuration had been taken away, and the whole
point of decision 5 is that turning receive-only off restores prior behavior *exactly*. So the note
explains the pause; the form keeps working.

`MeshCoreAutomationsView.tsx` threads `receiveOnly` to all five sections (`:323-336`).

| Section | Note placement | Immediate-TX control to disable |
|---|---|---|
| `MeshCorePathfindingFilterSection.tsx` | under the header/enable row (`:383-388`) | none |
| `MeshCoreAutoAckSection.tsx` | under the header (`:264-276`) | none |
| `MeshCoreAutoAnnounceSection.tsx` | under the header (`:315-337`) | **"Send Now" `:327-329`** → `sendNowDisabled \|\| receiveOnly` + `title`; also add an `isTxDisabledBody` check to `sendNow` (`:270-292`, uses `csrfFetch` directly) |
| `MeshCoreAutoResponderSection.tsx` | under the header (`:268-283`) | none |
| `MeshCoreTimerTriggersSection.tsx` | under the section header (`~:311`) | **"Run now" `:342-348`** → `!canWrite \|\| runningId === tr.id \|\| !tr.enabled \|\| receiveOnly` + `title`; also add an `isTxDisabledBody` check to `runNow` (`:263-280`) |

Every `disabled={disabled || !canWrite}` input in these five files is left **untouched**.

### 3.7 Surfaces deliberately **not** gated (state this in the PR body)

Serial/DB-only, and therefore still fully usable while receive-only:
`MeshCoreConfigurationView` name / location / radio params / TX power / telemetry modes;
`MeshCoreChannelsConfigSection` channel CRUD; `MeshCoreObserverSection` (publishes to MQTT, not
LoRa); `MeshCoreInfoView` sync-time; `MeshCoreTelemetryView`, `MeshCorePacketMonitorView`,
`MeshCoreMap` (read-only — verified: no TX call sites); device reboot; private-key import/export;
contact export/import/remove; out-path editor; connect/disconnect; message purge/delete.

### 3.8 Full TX-surface checklist (verify every row against the running app)

Derived from the epic's route inventory **and** re-verified against the components. Second render
paths are called out explicitly.

1. `POST /messages/send` — Channels send box · DM send box **(2 paths)**
2. `POST /rooms/login` — Rooms login button + password Enter
3. `POST /rooms/login-with-saved` — Rooms auto-login effect **(not a button — §3.4a(a))**
4. `POST /rooms/post` — Rooms send box
5. `POST /contacts/:pk/reset-path` — ContactDetailPanel
6. `POST /contacts/:pk/discover-path` — ContactDetailPanel
7. `POST /contacts/discover` — SettingsView ×3 · NodesView menu ×3 **(2 paths, 6 buttons)**
8. `POST /regions/discover` — SettingsView button · ChannelsView mount effect **(2 paths; the effect is §3.4a(b))**
9. `POST /contacts/:pk/trace-path` — ContactDetailPanel
10. `POST /contacts/:pk/ping` — ContactDetailPanel
11. `POST /contacts/:pk/share` — ContactDetailPanel
12. **`GET` `/contacts/:pk/neighbours`** — ContactDetailPanel
13. `POST /nodes/:pk/telemetry/poll` — NodeTelemetryConfig ×2 buttons
14. `POST /neighbors/request` — **`App.tsx:2084-2092`, outside the MeshCore tree.** Already gated by
    `txGated` and already toasts on 409; needs the copy fix (§3.9) + a regression test only.
15. `POST /admin/login` — RemoteConsole modal
16. `POST /admin/login-with-saved` — RemoteConsole button
17. `POST /admin/cli` — RemoteConsole `CliConsoleBody` + `MeshCoreAclManager`
18. **`GET` `/admin/status/:pk`** — RemoteStatsPanel refresh + empty-state buttons, plus the auto-load **(§3.4a(c))**
19. `POST /cli` (`advert` verb only) — LocalConsole quick action + typed input (409 → toast)
20. `POST /advert` — StatusBar button · SettingsView button **(2 paths)**
21. `POST /automation/announce/send` — AutoAnnounceSection "Send Now"
22. `POST /automation/timers/:id/run` — TimerTriggersSection "Run now"

### 3.9 App-level copy — unified views, banner, toasts

`txGated` (`App.tsx:251`) is already `true` for a receive-only MeshCore source, so **no gating logic
changes here.** What is wrong is the wording, and it is wrong in a way that misdirects the user:
`tx_disabled.control_tooltip` tells a MeshCore operator to "Re-enable TX in the LoRa configuration",
a screen that does not exist for their hardware (verbatim string and reasoning in §1). This is
therefore in scope, not deferred.

**One computed string, threaded — no per-site conditionals.**

`App.tsx` (`sourceType` already destructured at `:109`; `t` and `isTxDisabled` already in scope):
```ts
const isMeshCoreSource = sourceType === 'meshcore';
const txDisabledTooltip = t(
  isMeshCoreSource ? 'meshcore.receive_only.control_tooltip' : 'tx_disabled.control_tooltip'
);
```
Thread `txDisabledTooltip={txDisabledTooltip}` alongside the existing `txDisabled` prop into:
- `<ChannelsTab ... txDisabled={txGated} />` (`:3592`)
- `<MessagesTab ... txDisabled={txGated} />` (`:3717`)
- `<NodesTab ... />` — carries `txDisabled` already (see `NodesTab.tsx:1833`)
- both `<NodePopup>` renders (map route and standalone)

In each of those four components add `txDisabledTooltip?: string;` to the props interface, destructure
it, and replace every `t('tx_disabled.control_tooltip')` with
`(txDisabledTooltip ?? t('tx_disabled.control_tooltip'))`. **The `??` fallback is load-bearing**: it
keeps the prop optional so every existing test that renders these components without it is unchanged.

Verified call-site inventory (23 sites, all mechanical `title=` / `runDisabledReason=` swaps):

| File | Lines |
|---|---|
| `src/components/MessagesTab.tsx` | `1425, 1457, 1469, 1481, 1523, 1904, 1926, 2037, 2069, 2078, 2350, 2372, 2437, 2459, 2524, 2546, 2610` (17) |
| `src/components/ChannelsTab.tsx` | `1172, 1232, 1264, 1273, 1282` (5) |
| `src/components/NodesTab.tsx` | `1833` — `runDisabledReason` on `TracerouteBody` |
| `src/components/NodePopup/NodePopup.tsx` | `186` — `runDisabledReason` on `TracerouteBody` |

Several sites use the form `title={txDisabled ? t('tx_disabled.control_tooltip') : t('some.other')}` —
swap only the first branch; leave the non-disabled label alone.

**Toasts.** In the send-handler 409 branches that already call
`showToast(t('tx_disabled.send_blocked_toast'), 'warning')` (`:1995, :2050, :2112, :2161, :2340,
:2718, :2760, :2789, :2815, :2920`), switch the key to
`t(isMeshCoreSource ? 'meshcore.receive_only.blocked_toast' : 'tx_disabled.send_blocked_toast')`.
These are plain async functions, not `useCallback`s — **no dep-array impact** (same note as #4294).

**Banner.** `AppBanners.tsx`: add `isMeshCore?: boolean` to `AppBannersProps`; in the TX-banner body
select `t(isMeshCore ? 'banners.receive_only_meshcore' : 'banners.tx_disabled')`. Pass
`isMeshCore={isMeshCoreSource}` from `App.tsx:3292-3296`. `showTxBanner` and all offset arithmetic
are unchanged, so the existing banner tests stay green.

**Not in scope here:** `AdminCommandsTab` and `tx_disabled.remote_admin_notice` — that tab speaks the
Meshtastic admin protocol and is not a MeshCore surface (MeshCore remote admin is
`MeshCoreRemoteConsole`, handled in §3.5). Noted in §9.

---

## 4. Carried-forward backend item — validate `meshcoreReceiveOnly`

**The bug.** `POST /api/settings` builds `filteredSettings[key] = String(settings[key])`
(`settingsRoutes.ts:319`) with **no value validation**. `MeshCoreManager.refreshReceiveOnly()`
(`meshcoreManager.ts:4023-4030`) does `raw === 'true'`. So a caller posting `"1"`, `"yes"`, `"TRUE"`,
`1` or `"on"` persists a value that reads as **false** — receive-only silently **OFF** while the
user believes transmission is blocked. That is a fail-open on a safety flag.

**Survey result: there is no existing boolean-validation convention to follow.** Every other boolean
setting is written unvalidated and read with `=== 'true'`. The closest precedent for
*value*-validating a settings key is the range check on `maxNodeAgeHours`
(`settingsRoutes.ts:393-400`), which returns `fail(res, 400, 'INVALID_MAX_NODE_AGE_HOURS', …)` before
any write. Follow that shape.

**Change** — `src/server/routes/settingsRoutes.ts`, immediately after the filter loop
(`:320`, before the `autoAckRegex` block and well before either `setSourceSettings` at `:812` or
`setSettings` at `:897`):

```ts
/**
 * Keys whose consumers compare against the exact string 'true'. `String(v)` above
 * happily stores '1' / 'yes' / 'TRUE', every one of which those consumers read as
 * FALSE — a silent fail-OPEN for a safety flag (#4547 Phase 1 review). Reject rather
 * than coerce: a client sending a non-boolean is a client with a bug, and quietly
 * normalizing it would hide that bug in the one place it matters.
 */
const STRICT_BOOLEAN_SETTINGS_KEYS = ['meshcoreReceiveOnly'] as const;

for (const key of STRICT_BOOLEAN_SETTINGS_KEYS) {
  if (!(key in filteredSettings)) continue;
  const v = filteredSettings[key];
  if (v !== 'true' && v !== 'false') {
    return fail(res, 400, 'INVALID_BOOLEAN_SETTING',
      `${key} must be the boolean true or false (received "${v}")`);
  }
}
```

Notes:
- Declare the constant **module-level in `settingsRoutes.ts`**, not in
  `src/server/constants/settings.ts`. `settings.allowlist.test.ts` makes exact-equality assertions
  over the key arrays in that file, and Phase 1 already proved that touching it is the way to break
  a test that should stay unmodified. Keeping the list local also keeps this to one file.
- `String(true) === 'true'`, so a JSON boolean from the UI passes unchanged.
- The check sits before **both** write paths, so a rejected request writes nothing and never invokes
  `callbacks.refreshMeshcoreReceiveOnly` (`:889-891`).
- `fail` is already imported in this file. Scope stops here — **do not** extend this to other
  boolean keys in this PR.

---

## 5. Test plan

Standard Vitest + Testing Library files inside the existing suite. **No standalone scripts.**
No `any`. New MeshCore component tests follow the existing `src/components/MeshCore/*.test.tsx`
patterns (18 files exist); the one server test uses `createRouteTestApp()`.

### 5.1 Component disabled-state tests

Each renders the component twice — `receiveOnly={false}` and `receiveOnly={true}` — and asserts the
gated controls flip `disabled` and carry `title === t('meshcore.receive_only.control_tooltip')`,
**and that the non-gated controls stay enabled** (the negative control is what proves the gate is
targeted rather than a blanket freeze).

| File (new unless noted) | Asserts |
|---|---|
| `MeshCoreSettingsView.receiveOnly.test.tsx` | toggle renders and reflects the prop; Send advert / Discover ×3 / Discover regions disabled + tooltip; Refresh contacts + Save scope **enabled**; paused note under the discoverable toggle |
| `MeshCoreMessageStream.receiveOnly.test.tsx` (or extend `MeshCoreMessageStream.test.tsx`) | `disabled` + `disabledReason` → input and Send button disabled and both carry the `title`; omitting `disabledReason` leaves `title` undefined |
| `MeshCoreContactDetailPanel.receiveOnly.test.tsx` | the six RF buttons disabled + tooltip; **Export and Remove still enabled** |
| `MeshCoreNodesView.receiveOnly.test.tsx` | all three discover menu items disabled + tooltip; `onDiscoverNodes` never called on click |
| `MeshCoreRemoteConsole.receiveOnly.test.tsx` (extend the existing file) | both login buttons + modal submit disabled; `CliConsoleBody` receives `disabled`; `MeshCoreAclManager` receives `disabled` |
| `MeshCoreRemoteStatsPanel.receiveOnly.test.tsx` | refresh + empty-state buttons disabled; `fetchStatus` not called on mount/expand while receive-only |
| `MeshCoreLocalConsole.receiveOnly.test.tsx` | console input/Send **enabled**; `ver` / `stats` / `clock` quick actions **enabled**; `advert` quick action **disabled**; ACL form **enabled** |
| `MeshCoreNodeTelemetryConfig.receiveOnly.test.tsx` (extend) | both poll buttons disabled; enable checkbox + interval input **enabled**; paused note rendered |
| `MeshCoreRoomsView.receiveOnly.test.tsx` | login button + password input disabled; send box disabled (auto-login effect covered in §5.3a) |
| `MeshCoreChannelsView.receiveOnly.test.tsx` (extend) | send box disabled + tooltip (mount effect covered in §5.3a) |
| `MeshCoreDirectMessagesView.receiveOnly.test.tsx` (extend) | send box disabled; `receiveOnly` threaded to `MeshCoreContactDetailPanel` and `MeshCoreNodeTelemetryConfig` |
| `MeshCoreStatusBar.receiveOnly.test.tsx` | Send advert disabled + tooltip; Disconnect **enabled**; receive-only chip rendered |
| `MeshCoreAutoAnnounceSection.receiveOnly.test.tsx` | "Send Now" disabled + tooltip; paused note rendered; **every config input still enabled** |
| `MeshCoreTimerTriggersSection.receiveOnly.test.tsx` | "Run now" disabled + tooltip; paused note; config inputs enabled |
| `MeshCoreAutoAckSection.receiveOnly.test.tsx`, `MeshCoreAutoResponderSection.receiveOnly.test.tsx`, `MeshCorePathfindingFilterSection.receiveOnly.test.tsx` | paused note rendered; **no** input disabled by receive-only |
| `MeshCoreReceiveOnlyNote.test.tsx` | renders `null` when false; renders the string + a `UiIcon` (not a literal emoji) when true |
| `MeshCorePage.receiveOnly.test.tsx` | with `useTxStatus` mocked to `{ isTxDisabled: true }`, `receiveOnly` reaches every child that declares it |

### 5.2 Toggle save / invalidate path — `MeshCoreSettingsView.receiveOnly.test.tsx`

- Checking the box **does not** call `window.confirm`; POSTs
  `/api/settings?sourceId=<id>` with body `{ meshcoreReceiveOnly: true }`.
- Unchecking calls `window.confirm`; mocked `true` → POST with `{ meshcoreReceiveOnly: false }`;
  mocked `false` → **no** network call and the checkbox stays checked.
- A successful save calls `queryClient.invalidateQueries({ queryKey: ['txStatus'] })`
  (mock `useQueryClient`, exactly as `ConfigurationTab.txDisabled.test.tsx:92-99` does).
- A non-ok save shows the `meshcore.receive_only.save_failed` error toast and does **not** invalidate.

### 5.3 409 toast path

- `useMeshCore.receiveOnly.test.ts` (new; model on `useMeshCore.isLocal.test.ts`): with `csrfFetch`
  mocked to resolve `{ ok: false, status: 409, json: () => ({ success:false, code:'TX_DISABLED' }) }`,
  each patched action resolves to its normal failure value (**does not throw**) and `showToast` was
  called once with the `meshcore.receive_only.blocked_toast` string and `'warning'`.
- A non-409 failure still takes the existing `setError` path and raises **no** toast.
- `MeshCoreAutoAnnounceSection` / `MeshCoreTimerTriggersSection` / `MeshCoreNodeTelemetryConfig`:
  one 409 test each for their direct-`csrfFetch` handlers.
- `App.tsx` regression: with `sourceType='meshcore'` and `useTxStatus` → `isTxDisabled: true`,
  `handleRequestNeighborInfo`'s 409 branch raises the **MeshCore-worded** toast.

### 5.3a Automatic-path silence (§3.4a) — one test per effect, **required**

These are the regression net for a toast storm on page load. Each asserts the **absence** of both a
request and a toast — a disabled-button assertion cannot catch these, because there is no button.

| File | Assertions with `receiveOnly` |
|---|---|
| `MeshCoreRoomsView.receiveOnly.test.tsx` | Select a room that has stored credentials → `actions.loginRoomWithSaved` **not called**, `showToast` **not called**, no error state rendered. Then re-render with `receiveOnly={false}` and select the same room again → it **is** called (proves the latch was not poisoned). |
| `MeshCoreChannelsView.receiveOnly.test.tsx` | Open the scope-override control → `actions.discoverRegions` **not called**, `showToast` **not called**. Re-render with `receiveOnly={false}` and reopen → it **is** called (latch not poisoned). |
| `MeshCoreRemoteStatsPanel.receiveOnly.test.tsx` | Mount / expand the panel → `fetchStatus` **not called**, `showToast` **not called**, no loading spinner. With `receiveOnly={false}` → it **is** called. |

The "flip the flag off and it works again" half of each test is not optional — it is the only thing
that catches a guard placed after the latch.

### 5.4 Settings validation — `src/server/routes/settingsRoutes.receiveOnlyValidation.test.ts` (new)

`createRouteTestApp()` with the settings router mounted (**mandatory** for new route tests — no
`vi.mock('../../services/database.js', …)`).

- `{ meshcoreReceiveOnly: true }` → 200; stored value is `'true'`; the
  `refreshMeshcoreReceiveOnly` callback fired.
- `{ meshcoreReceiveOnly: false }` → 200; stored `'false'`.
- Each of `'1'`, `'yes'`, `'TRUE'`, `'on'`, `1`, `null`, `{}` → **400** with
  `code === 'INVALID_BOOLEAN_SETTING'`, **nothing written** (the previously-stored value is
  unchanged), and `refreshMeshcoreReceiveOnly` **not** called.
- A request carrying a valid `meshcoreReceiveOnly` **plus** other keys still persists the other keys.
- Global (no `sourceId`) POSTs carrying unrelated keys are unaffected.

### 5.5 Suite requirements

Full Vitest suite green (0 failures) — confirm `success: true` via the JSON reporter, not `rtk`'s
`PASS/FAIL` summary. `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` must be
empty. `npm run typecheck` clean; run a `tsc` pass **including** test files (`tsconfig.json` excludes
`src/**/*.test.ts`, so the default run never checks them — Phase 1's reviewer note). No schema
change, so the PostgreSQL/MySQL containers are not required.

---

## 6. Work packages

**All agents share the one worktree `/home/yeraze/Development/meshmonitor-mc-rxonly-p2`, so file
overlap forces sequencing.** WP1 touches the props interfaces of the files WP2/WP3/WP4 then modify,
so **WP1 must be complete and committed before WP2–WP5 start.** After WP1, the four remaining
packages are file-disjoint and run in parallel.

```
WP1 ──┬── WP2  (settings toggle + backend validation)
      ├── WP3  (messaging / contact / console / node surfaces)
      ├── WP4  (automations)
      └── WP5  (unified-view tooltip copy + banner + toasts)
```

Also note the `rtk`-wrapped-`git commit` hazard: parallel agents in one worktree can sweep each
other's files. **Commit with an explicit pathspec** (`git commit -- <paths>`), never a bare
`git commit -a`, and audit the per-commit file list.

### WP1 — Foundation: flag distribution, shared primitives, i18n, 409 helper
**Files:** `public/locales/en.json`; `src/components/MeshCore/MeshCorePage.tsx`;
`src/components/MeshCore/MeshCoreReceiveOnlyNote.tsx` + `.module.css` (new);
`src/components/MeshCore/MeshCoreMessageStream.tsx`;
`src/components/MeshCore/CliConsoleBody.tsx` (optional `ActionCommand.disabled`);
`src/components/MeshCore/hooks/useMeshCore.ts`; plus a **one-line `receiveOnly?: boolean` prop
addition + destructure (no behavior)** in `MeshCoreStatusBar`, `MeshCoreNodesView`,
`MeshCoreChannelsView`, `MeshCoreRoomsView`, `MeshCoreDirectMessagesView`,
`MeshCoreContactDetailPanel`, `MeshCoreRemoteConsole`, `MeshCoreRemoteStatsPanel`,
`MeshCoreNodeTelemetryConfig`, `MeshCoreLocalConsole`, `MeshCoreConfigurationView`,
`MeshCoreAutomationsView`, `MeshCoreSettingsView`, and the five automation sections.
**Tests:** `MeshCoreReceiveOnlyNote.test.tsx`, `MeshCorePage.receiveOnly.test.tsx`,
`MeshCoreMessageStream.receiveOnly.test.tsx`, `useMeshCore.receiveOnly.test.ts`.

**Acceptance:**
- `MeshCorePage` calls `useTxStatus({ baseUrl, sourceId })` once and threads `receiveOnly` to all
  eight direct children; each re-threads to its own children per §3.0.
- `MeshCoreMessageStream` accepts `disabledReason` and puts it on the input, the Send button **and**
  the enclosing `.meshcore-send-bar`.
- `MeshCoreReceiveOnlyNote` renders `null` when false and uses `UiIcon`, not an emoji; its styling
  lives in a CSS module — **zero lines added to `src/styles/*.css`**.
- All 14 `meshcore.receive_only.*` keys + `banners.receive_only_meshcore` exist in `en.json`;
  **no other locale file is touched.**
- `useMeshCore.reportTxDisabled` exists and is called from all 18 listed actions; every affected
  `useCallback` dep array is updated (no new `exhaustive-deps` violation).
- `tsc` clean including tests; suite green; `lint:ci` clean of in-repo failures.

### WP2 — Receive-only toggle + backend value validation
**Depends on:** WP1. **Parallel with:** WP3, WP4, WP5.
**Files:** `src/components/MeshCore/MeshCoreSettingsView.tsx`;
`src/server/routes/settingsRoutes.ts`.
**Tests:** `MeshCoreSettingsView.receiveOnly.test.tsx`;
`src/server/routes/settingsRoutes.receiveOnlyValidation.test.ts`.

**Acceptance:**
- The toggle renders above "Device actions", reads `checked` from the threaded prop (not local
  state), and posts to `/api/settings?sourceId=` via `csrfFetch`.
- **Confirm on disable only**; enabling never prompts.
- A successful save invalidates `['txStatus']`; a failure toasts and does not invalidate.
- Send advert / Discover ×3 / Discover regions disabled + tooltip; Refresh contacts and Save scope
  remain enabled; the paused note renders under the discoverable toggle.
- `POST /api/settings` rejects any `meshcoreReceiveOnly` that is not exactly `'true'`/`'false'`
  with `400 INVALID_BOOLEAN_SETTING`, **before any write**, and does not fire
  `refreshMeshcoreReceiveOnly`. `settings.allowlist.test.ts` passes **unmodified**.
- No other settings key's validation behavior changes.

### WP3 — Messaging, contact, console and node surfaces
**Depends on:** WP1. **Parallel with:** WP2, WP4, WP5.
**Files:** `MeshCoreChannelsView.tsx`, `MeshCoreDirectMessagesView.tsx`, `MeshCoreRoomsView.tsx`,
`MeshCoreContactDetailPanel.tsx`, `MeshCoreRemoteConsole.tsx`, `MeshCoreRemoteStatsPanel.tsx`,
`MeshCoreLocalConsole.tsx`, `MeshCoreNodeTelemetryConfig.tsx`, `MeshCoreNodesView.tsx`,
`MeshCoreStatusBar.tsx`, `MeshCoreConfigurationView.tsx` (thread-through only).
**Tests:** the eleven files listed in §5.1 for these components, plus the direct-`csrfFetch` 409
test for `MeshCoreNodeTelemetryConfig`.

**Acceptance:**
- Every row of the §3.8 checklist owned by this package is disabled + tooltipped, **including both
  second render paths** (advert: StatusBar *and* SettingsView-owned-by-WP2; discover: NodesView menu
  *and* SettingsView-owned-by-WP2 — WP3 owns the NodesView and StatusBar halves).
- **All three §3.4a automatic paths skip silently** — Rooms auto-login, ChannelsView
  `discoverRegions` mount effect, `MeshCoreRemoteStatsPanel.load()`: no request, **no toast**, no
  error state, `receiveOnly` in each dep array, and in every case the guard sits **before** the
  do-not-repeat latch. The §5.3a "flip the flag off and it fires again" assertions must be present
  and passing; a guard placed after a latch fails this package even if everything else is green.
- The local console stays usable: input, Send, and the `ver`/`stats`/`clock`/`help` quick actions
  enabled; only `advert` disabled.
- Export / Remove / out-path save / sync-time / channel CRUD / device config remain enabled
  (explicit negative assertions).
- No new `exhaustive-deps` or `no-explicit-any` violations; no raw `fetch()`.

### WP4 — Automations: paused notes + immediate-send gating
**Depends on:** WP1. **Parallel with:** WP2, WP3, WP5.
**Files:** `MeshCoreAutomationsView.tsx`, `MeshCoreAutoAckSection.tsx`,
`MeshCoreAutoAnnounceSection.tsx`, `MeshCoreAutoResponderSection.tsx`,
`MeshCorePathfindingFilterSection.tsx`, `MeshCoreTimerTriggersSection.tsx`.
**Tests:** the five automation `*.receiveOnly.test.tsx` files in §5.1 plus the two direct-`csrfFetch`
409 tests.

**Acceptance:**
- All five sections render `<MeshCoreReceiveOnlyNote>` when receive-only.
- "Send Now" and "Run now" disabled + tooltip; their handlers also detect a 409 and toast.
- **Every configuration input in all five sections remains enabled and its saved value unchanged** —
  asserted explicitly, since this is interview decision 5 and the whole point of the phase.
- No automation setting is written, cleared or defaulted by any code path added here.

### WP5 — Unified-view copy correctness + global banner
**Depends on:** WP1 (the i18n keys). **Parallel with:** WP2, WP3, WP4.
**Files:** `src/App.tsx`, `src/components/AppBanners/AppBanners.tsx`, `src/components/MessagesTab.tsx`,
`src/components/ChannelsTab.tsx`, `src/components/NodesTab.tsx`,
`src/components/NodePopup/NodePopup.tsx`. (Disjoint from WP2/WP3/WP4 — none of them touch a file
outside `src/components/MeshCore/` or `src/server/`.)
**Tests:** extend the `AppBanners` tests for the `isMeshCore` branch; extend the existing
`*.txDisabled.test.tsx` files for `txDisabledTooltip`; a focused handler test for the MeshCore-worded
409 toast.

**Acceptance:**
- `txDisabledTooltip` is computed once in `App.tsx` and threaded to `ChannelsTab`, `MessagesTab`,
  `NodesTab` and both `NodePopup` renders; **all 23 verified call sites** (§3.9 table) read the prop
  with an `?? t('tx_disabled.control_tooltip')` fallback, so the prop stays optional.
- A MeshCore receive-only source shows `meshcore.receive_only.control_tooltip` — which names the
  MeshCore Settings remedy — and **never** the LoRa-configuration wording. A Meshtastic source's
  tooltips are byte-identical to today (assert both directions).
- `AppBanners` shows `banners.receive_only_meshcore` for a MeshCore source and the unchanged
  `banners.tx_disabled` otherwise; banner-offset arithmetic and existing tests untouched.
- The App send-handler 409 toasts use the MeshCore string when `sourceType === 'meshcore'`.
- **No change to `txGated` or to any control-gating logic** — that already works. A regression test
  proves the MeshCore neighbor-info button is still disabled.

---

## 7. Conventions guardrails

- **No literal emoji or Unicode icon stand-ins** in JSX or in any `en.json` value added here — use
  `UiIcon`. Only the two verified names: `blocked` (status chip) and `pause` (paused note).
- **No raw `fetch()`** in `src/components/**` or `src/pages/**` — use `useCsrfFetch` (the MeshCore
  idiom) or `useAuthFetch`. `useTxStatus` lives in `src/hooks/` and is exempt; do not "fix" it.
- **No new `any`** (`no-explicit-any` is a ratcheted error).
- **No new `react-hooks/exhaustive-deps` violations.** Every value newly referenced inside an
  existing `useCallback`/`useEffect` (`receiveOnly`, `reportTxDisabled`, `queryClient`, `csrfFetch`)
  must be added to that hook's dep array in the same edit.
- **New styling goes in a CSS module** (`MeshCoreReceiveOnlyNote.module.css`). Zero additions to
  `src/styles/nodes.css` or its siblings. Reuse existing `mrc-status-chip` / `hint` /
  `form-section` classes where they fit.
- Verify with `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` (empty = pass) —
  plain `npx eslint <file>` exiting 0 does **not** prove the ratchet passes.

---

## 8. Browser validation (live dev container, chrome-devtools)

Prereq: a MeshCore source connected in the dev container (`docker-compose.dev.yml` **plus**
`docker-compose.dev.local.yml` for the `/dev/ttyUSB*` mappings). Start with receive-only **off**.

1. **Toggle on.** MeshCore → Settings → Receive-only mode. Check the box: **no confirm prompt**,
   success toast, and within ~1 s (no page reload) the status-bar chip appears, the global banner
   shows the MeshCore wording, and the Send advert button beside it greys out.
2. **Messaging.** Channels and DMs: input + Send disabled, hover shows the receive-only tooltip;
   message history still renders and new inbound messages still arrive.
3. **Contacts.** Open a contact: Reset path / Share / Trace / Ping / Discover path / Neighbours all
   disabled with tooltips; **Export and Remove still work.**
4. **Discovery — both paths.** Settings → Discover Nearby/Repeaters/Sensors disabled; Nodes view →
   the discover menu's three items disabled. (Regression target for the #4294-class miss.)
5. **Consoles.** Remote console: login buttons disabled, console body disabled with the explanatory
   placeholder, ACL form disabled. Local console: still usable — run `ver` and `stats` successfully;
   the `advert` quick action is disabled; typing `advert` manually returns the server error and the
   receive-only toast, and does **not** crash the console.
6. **Automations.** Each of the five sections shows the paused note; "Send Now" and "Run now" are
   disabled; **change a field, save, reload — the value persisted unchanged.**
7. **Race toast.** With the UI gated, fire `POST …/messages/send` directly from devtools and confirm
   the 409 surfaces as the friendly warning toast rather than a red error or a crash.
7a. **No toast storm (§3.4a).** With receive-only on, hard-reload the MeshCore page, select a room
   that has saved credentials, open a channel's scope-override control, and expand a remote node's
   stats panel. **Zero toasts** should appear from any of these — they are automatic paths. Confirm
   in the Network panel that no `/rooms/login-with-saved`, `/regions/discover` or `/admin/status/:pk`
   request was issued. Then turn receive-only off and repeat: each now fires normally.
7b. **Tooltip correctness (§3.9).** On a receive-only MeshCore source, hover a disabled control in
   the unified Messages/Channels/Nodes views and the map popup's traceroute button. The tooltip must
   name **MeshCore Settings**, not "the LoRa configuration". Repeat on a TX-disabled Meshtastic
   source and confirm it still says "Re-enable TX in the LoRa configuration".
8. **Toggle off.** Uncheck: the confirm prompt **does** appear; accept, and every control above
   re-enables without a reload. Send a message on the `gauntlet` channel to prove TX resumed.
9. **Negative control — per-source isolation.** With a second, non-receive-only source configured,
   switch to it and confirm **nothing** is gated there. Confirm a Meshtastic source still shows the
   original `banners.tx_disabled` wording, not the MeshCore one.

---

## 9. Out of scope (Phase 3)

- Virtual Node command rejection (the 9 TX commands → `Err` frame).
- User-facing docs (`docs/features/…`), REST API 409 documentation.
- Locale propagation beyond `en.json` (Weblate).
- Mid-retry-chain re-arm: flipping receive-only ON parks that specific DM/channel retry rather than
  auto-resuming when the flag goes off (Phase 1 known limitation). Phase 2 does not add a re-arm.
- `AdminCommandsTab` and `tx_disabled.remote_admin_notice`. That tab drives the **Meshtastic** admin
  protocol (`executeCommand` → Meshtastic AdminMessage) and is not a MeshCore surface at all —
  MeshCore remote admin is `MeshCoreRemoteConsole`, gated in §3.5. Nothing to gate; the notice string
  is unreachable for a MeshCore source. Flag it if a future phase exposes that tab to MeshCore.
  *(Unified-view tooltip copy is **not** deferred — see §3.9, it is required work in WP5.)*
- A `radio.receiveOnly` badge on the multi-source dashboard (the field exists; nothing consumes it).
