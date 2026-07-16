# MQTT Packet Monitor — Phase 2 Implementation Spec (Frontend UI + Validation)

**Status:** spec (no code written yet). Written against the worktree
`meshmonitor-mqtt-packetmon-ui` on `hotfix/mqtt-packetlog-outcome-union`
(Phase 1 backend + outcome-union hotfix present). Implementation lands on a
fresh branch off `origin/main` once Phase 1 + the hotfix are merged.

**Epic:** `docs/internal/dev-notes/MQTT_PACKET_MONITOR_EPIC.md` (issue #4124).
**Phase 1 spec:** `docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md`.

Phase 1 shipped the backend: migration 121 `mqtt_packet_log`, the repository,
`mqttPacketLogService`, the ingest hook, and the routes mounted at
`/api/sources/:id/mqtt/packets`. **No frontend consumes them yet.** Phase 2
builds the gateway-aware Packet Monitor view that renders on the existing
`packetmonitor` tab when the active source is `mqtt_broker` / `mqtt_bridge`.

---

## 1. Reuse inventory (read before writing anything)

| Need | Reuse | Path | Notes |
|------|-------|------|-------|
| **Structural template** | `MeshCorePacketMonitorView` | `src/components/MeshCore/MeshCorePacketMonitorView.tsx` | Copy the toolbar/header/banner/filter/table shell wholesale; swap the data model + fetch layer. |
| **Detail modal template** | `MeshCorePacketDetailModal` | `src/components/MeshCore/MeshCorePacketDetailModal.tsx` | Copy the `mcpm-modal*` markup + the `Row` helper; replace the rawHex-decode body with stored fields + a receptions table. |
| **CSS** | `MeshCorePacketMonitor.css` | `src/components/MeshCore/MeshCorePacketMonitor.css` | The `mcpm-*` classes (`mcpm-header`, `mcpm-btn`, `mcpm-btn-danger`, `mcpm-disabled-banner`, `mcpm-filters`, `mcpm-table*`, `mcpm-modal*`, `mcpm-dl-*`, `mcpm-badge`, `mcpm-mono`, `mcpm-error`, `mcpm-empty`) are the design source of truth. Phase 2 gets its own `MqttPacketMonitor.css` with a `mqpm-*` prefix cloned from these (do **not** share the file; keep the two monitors decoupled). |
| **Authenticated fetch** | `useCsrfFetch()` | `src/hooks/useCsrfFetch.ts` | **This is the approved wrapper.** The raw-`fetch()` ban targets bare `fetch(` in `src/components/**` / `src/pages/**`; `csrfFetch` is exempt (MeshCore view uses it). Do **not** use `ApiService` here — `ApiService.request()` returns the JSON body and is oriented at global (non-per-source) endpoints; the MeshCore monitor precedent is `csrfFetch` + explicit `${baseUrl}/api/sources/:id/...` URLs. |
| **Settings save** | inline `saveSettings` POST `${baseUrl}/api/settings` | (in MeshCore view) | Copy verbatim: `csrfFetch(`${baseUrl}/api/settings`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(patch) })`. |
| **Permissions** | `useAuth().hasPermission` | `src/contexts/AuthContext` | `hasPermission('packetmonitor','write')` gates Clear; `hasPermission('settings','write')` gates the capture toggle + retention inputs. Read gate is enforced by App tab-gating + the backend `requirePermission`. |
| **Node-name resolution** | `useNodes()` + `getNodeName` | `src/hooks/useServerData.ts`, `src/utils/nodeHelpers.ts` | `useNodes()` → `{ nodes: DeviceInfo[] }` from the poll cache (already source-scoped for the active source). Resolve names the way `PacketMonitorPanel` does: `node.user?.longName || node.user?.shortName || \`Node ${nodeNum}\``, keyed by `node.nodeNum`. Build one `Map<number,string>` in the view and pass a `nodeName(nodeNum): string` resolver down to rows + modal. Fall back to the hex `fromNodeId`/`gatewayId` string when no node row exists. |
| **Portal for modal** | `createPortal(..., document.body)` | react-dom | Same pattern as MeshCore view (`selectedPacket && createPortal(<Modal/>, document.body)`). |
| **i18n** | `useTranslation()` flat dotted keys | `public/locales/en.json` (flat keys, 4554 of them; NOT nested) + `src/config/i18n.ts` (http-backend, loads `public/locales/{lng}.json`) | Add `mqtt.packets.*` flat keys to `en.json` only; other locales fall back to `en` automatically (`fallbackLng`). Always pass a literal fallback string as the 2nd `t()` arg (the MeshCore convention) so the UI is correct even before translation. |
| **Icons** | `lucide-react` | — | `Pause, Play, Filter, RefreshCw, Trash2, ChevronDown` (or `Radio`/`Antenna` for the gateway control). Match the MeshCore imports; **omit `Download`** (see §7, export is out of scope). |

### Type sharing decision (mandatory read)

The Phase-1 types (`MqttGroupedPacket`, `MqttGateway`, `DbMqttPacket`,
`MqttIngestOutcome`) live in `src/db/repositories/mqttPacketLog.ts`, a **server
module that imports `drizzle-orm` and `BaseRepository` at runtime**. It cannot
be imported into the browser bundle. Follow the existing frontend boundary:
**mirror the view-model types in a new frontend file**
`src/components/Mqtt/mqttPacketTypes.ts` (parallel to how the MeshCore view uses
`MeshCoreOtaPacketEvent` from `hooks/useWebSocket`, a frontend-owned type). Mirror:

```ts
export type MqttIngestOutcome =
  | 'ingested' | 'encrypted' | 'ignored' | 'geo-ignored'
  | 'unsupported-portnum' | 'decode-error';

export interface MqttGroupedPacket {
  packetId: number | null; fromNode: number | null; fromNodeId: string | null;
  toNode: number | null; toNodeId: string | null;
  channel: number | null; channelId: string | null;
  portnum: number | null; portnumName: string | null;
  encrypted: number; ingestOutcome: string;
  payloadSize: number | null; payloadPreview: string | null;
  gatewayCount: number; receptionCount: number;
  firstHeard: number; lastHeard: number;
}
export interface MqttGateway {
  gatewayId: string; gatewayNodeNum: number | null;
  receptionCount: number; lastHeard: number;
}
/** Subset of DbMqttPacket the receptions table renders. */
export interface MqttReception {
  gatewayId: string | null; gatewayNodeNum: number | null;
  timestamp: number; rxTime: number | null;
  rxSnr: number | null; rxRssi: number | null;
  hopLimit: number | null; hopStart: number | null;
}
```

> Keep these structurally identical to the repo interfaces. A `*.test.ts` in
> Phase 1 already pins the server shapes; if the server shapes drift, the
> integration breaks visibly at runtime (documented risk §8).

---

## 2. The response-envelope gotcha (THE critical difference from MeshCore)

The MeshCore `/packets` routes return **bare** bodies (`{ packets, enabled, ... }`),
so the MeshCore view reads `data.packets` directly. **The MQTT Phase-1 routes use
`ok(res, {...})`**, which wraps everything in `{ success: true, data: {...} }`.
Therefore every MQTT fetch must **unwrap `.data`**:

```ts
const res = await csrfFetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const body = await res.json();
const payload = body.data ?? body;   // tolerate either; MQTT routes always wrap
const packets: MqttGroupedPacket[] = Array.isArray(payload.packets) ? payload.packets : [];
```

Exact backend shapes (all under `body.data`):

| Endpoint | Method | Query | `body.data` shape |
|----------|--------|-------|-------------------|
| `${baseUrl}/api/sources/:id/mqtt/packets` | GET | `limit?`, `offset?`, `gateways?` (CSV of gatewayId), `portnum?`, `since?` (s or ms), `encrypted?` (`1`/`0`) | `{ packets: MqttGroupedPacket[], total, offset, limit, enabled, maxCount, maxAgeHours }` |
| `.../mqtt/packets/gateways` | GET | — | `{ gateways: MqttGateway[] }` |
| `.../mqtt/packets/receptions` | GET | `packetId` (required, int), `fromNode` (required, int) | `{ receptions: DbMqttPacket[] }` (oldest-first) |
| `.../mqtt/packets` | DELETE | — | `{ deleted: number }` (requires `packetmonitor:write`) |
| `${baseUrl}/api/settings` | POST | body `{ mqtt_packet_log_enabled?: '1'|'0', mqtt_packet_log_max_count?: string, mqtt_packet_log_max_age_hours?: string }` | `{ success: true }` |

Do **not** send an explicit `limit`: let the server apply
`mqtt_packet_log_max_count` as the effective page size (same rationale as the
MeshCore view; the list is already dedup/grouped so one page is the whole log).

---

## 3. File-by-file changes

### 3.1 NEW `src/components/Mqtt/mqttPacketTypes.ts`
The mirrored types from §1. No runtime code.

### 3.2 NEW `src/components/Mqtt/MqttPacketMonitorView.tsx`

**Props:**
```ts
interface MqttPacketMonitorViewProps { baseUrl: string; sourceId: string; }
```

**Hooks / derived:**
```ts
const { t } = useTranslation();
const csrfFetch = useCsrfFetch();
const { hasPermission } = useAuth();
const { nodes } = useNodes();
const canWriteSettings = hasPermission('settings', 'write');
const canClear = hasPermission('packetmonitor', 'write');
const prefix = `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/mqtt/packets`;
const nodeName = useCallback((n: number | null): string | null => { /* Map lookup */ }, [nodes]);
```

**State:**
- `packets: MqttGroupedPacket[]`, `gateways: MqttGateway[]`
- `loading`, `error: string | null`
- `paused: boolean` (transient, not persisted) + `pausedRef` mirror
- `showFilters: boolean` (persisted)
- Filters (persisted): `selectedGateways: string[]`, `encryptedFilter: '' | '1' | '0'`, `portnumFilter: number | ''`
- Settings: `enabled`, `maxCount` (default 5000), `maxAgeHours` (default 24), `savingSettings`
- `selectedPacket: MqttGroupedPacket | null` (opens modal)
- `total: number` (for the header count / "showing N of M")

**localStorage persistence** (mirror `PacketMonitorPanel`'s pattern; keys namespaced
`mqttPacketMonitor.*`): persist `showFilters`, `selectedGateways`, `encryptedFilter`,
`portnumFilter`. Load via a `safeJsonParse` helper (copy the one in
`PacketMonitorPanel.tsx`). Do **not** persist `paused`.

**Data loading — polling (no socket event exists for MQTT packet log):**
```ts
const load = useCallback(async () => {
  setError(null);
  const params = new URLSearchParams();
  if (selectedGateways.length) params.set('gateways', selectedGateways.join(','));
  if (encryptedFilter !== '') params.set('encrypted', encryptedFilter);
  if (portnumFilter !== '') params.set('portnum', String(portnumFilter));
  const res = await csrfFetch(`${prefix}?${params.toString()}`);
  // ...unwrap body.data (see §2); set packets/total/enabled/maxCount/maxAgeHours
}, [csrfFetch, prefix, selectedGateways, encryptedFilter, portnumFilter]);
```
- Initial `load()` + reload whenever a filter changes (`useEffect([load])`), showing
  the spinner only on the first load (track `loading` separately from refetches).
- **Poll every 5000 ms** via `setInterval`, skipping the tick when `pausedRef.current`
  is true. Clean up the interval on unmount / prefix change.
  ```ts
  useEffect(() => {
    const id = setInterval(() => { if (!pausedRef.current) void load(); }, 5000);
    return () => clearInterval(id);
  }, [load]);
  ```
  **Justification for `setInterval` over TanStack/socket:** (a) the list is
  server-side **grouped/deduplicated** — gateway counts and lastHeard change as
  new receptions arrive, so there is nothing to incrementally merge client-side; a
  full refetch is the correct model. (b) No `mqtt:*-packet` socket event was added
  in Phase 1 (unlike MeshCore's `meshcore:ota-packet`), so a socket path doesn't
  exist. (c) A bare interval matches the "lightweight" simpler-view precedent and
  keeps the pause semantics trivial (skip the tick).
- Fetch the gateway list once on mount and refresh it inside `load()` opportunistically
  (cheap; keeps the multi-select fresh). Simpler: a separate `loadGateways()` called on
  mount + on manual refresh.

**Toolbar (header)** — clone `mcpm-header`:
- count badge = `packets.length` (and `total` if it differs, e.g. `12 / 340`)
- Pause/Resume (`Pause`/`Play`), Filter toggle (`active` class when `showFilters`),
  Refresh (`() => void load()`), Clear (`canClear` only, `mqpm-btn-danger`,
  `window.confirm` then DELETE then clear local `packets`). **No Export button.**

**Enable banner** — clone `mcpm-disabled-banner`: when `!enabled`, show the
capture-off message; if `canWriteSettings`, an "Enable capture" button that calls
`handleToggleEnabled()` (POST `mqtt_packet_log_enabled: '1'`).

**Filter panel** (`showFilters`) — clone `mcpm-filters`:
- **Gateway multi-select** (primary feature): a checkbox dropdown (see §4).
- **Encrypted** select: All / Encrypted (`'1'`) / Decrypted (`'0'`).
- **Portnum** select (parity, optional): a small select of common PortNums
  (reuse names via `meshtasticProtobufService`-style constants if a frontend list
  exists; otherwise a numeric input). Keep it optional — the backend already
  accepts `portnum`.
- Behind `canWriteSettings`: the capture-enabled checkbox + Max count
  (`min 100 max 50000 step 100`, save on blur → `mqtt_packet_log_max_count`) +
  Max age hours (`min 1 max 720`, save on blur → `mqtt_packet_log_max_age_hours`).
  Copy the MeshCore markup 1:1, swapping the setting keys.

**Table** — clone `mcpm-table`. Columns, newest-first (rows already `lastHeard DESC`
from the server):
| Column | Source | Render |
|--------|--------|--------|
| Time | `lastHeard` | `formatTime(lastHeard)` (HH:MM:SS.mmm, copy MeshCore helper) |
| From | `fromNode`/`fromNodeId` | `nodeName(fromNode) ?? fromNodeId ?? '—'` |
| To | `toNode`/`toNodeId` | broadcast (`0xffffffff`/`4294967295`) → "Broadcast"; else `nodeName(toNode) ?? toNodeId ?? '—'` |
| Type | `portnumName` / `ingestOutcome` / `encrypted` | if `encrypted` and no decoded portnum → outcome badge (`encrypted`/`ignored`/`geo-ignored`/`unsupported-portnum`/`decode-error`); else `portnumName ?? '—'` as a `mqpm-badge` |
| Channel | `channelId` | `channelId ?? (channel != null ? \`#${channel}\` : '—')` |
| Gateways | `gatewayCount` | number; `title`/tooltip = `receptionCount` receptions (and, when a gateway filter is active, the "selected gateways only" note — §4) |
| Size | `payloadSize` | number or `—` |
| Preview | `payloadPreview` | truncated text; `—` when null |

Row `onClick={() => setSelectedPacket(p)}`. `key` = `${p.packetId}-${p.fromNode}-${p.lastHeard}`
(packetId/fromNode is the group identity; add lastHeard to disambiguate null-id groups).

**Empty / loading states** — clone `mcpm-empty`: loading spinner; else if empty,
message differs on `enabled` (waiting vs "enable capture to start recording").

**Modal mount:** `selectedPacket && createPortal(<MqttPacketDetailModal packet={selectedPacket} prefix={prefix} csrfFetch={csrfFetch} nodeName={nodeName} onClose={() => setSelectedPacket(null)} />, document.body)`.

### 3.3 NEW `src/components/Mqtt/MqttPacketDetailModal.tsx`

**Props:**
```ts
interface Props {
  packet: MqttGroupedPacket;
  prefix: string;                 // `${baseUrl}/api/sources/:id/mqtt/packets`
  csrfFetch: ReturnType<typeof useCsrfFetch>;
  nodeName: (n: number | null) => string | null;
  onClose: () => void;
}
```

**Body** (clone `mcpm-modal*` + `Row` helper):
- **Packet section** (`mcpm-dl-section`): From (name + hex), To, Channel
  (`channelId` + wire `channel`), PortNum (`portnumName` + numeric), Ingest outcome
  (badge), Encrypted (yes/no), Payload size, Gateway count, Reception count,
  First heard / Last heard (localized). Preview text when present.
- **Receptions table** (`mqpm-recv-table`): one row per gateway copy —
  Gateway (`nodeName(gatewayNodeNum) ?? gatewayId`), Time (`timestamp`), rxTime
  (when `> 0`), RSSI (`rxRssi`), SNR (`rxSnr?.toFixed(2)`), Hops
  (`hopStart != null && hopLimit != null ? hopStart - hopLimit : '—'`).

**Receptions fetch (with the packetId-null/0 edge):**
```ts
const canFetch = typeof packet.packetId === 'number' && packet.packetId !== 0
              && typeof packet.fromNode === 'number';
useEffect(() => {
  if (!canFetch) return;                       // skip: over-matches null-id groups
  // GET `${prefix}/receptions?packetId=${packet.packetId}&fromNode=${packet.fromNode}`
  // unwrap body.data.receptions
}, [canFetch, packet.packetId, packet.fromNode]);
```
When `!canFetch`, render the packet fields but replace the receptions table with a
note: `t('mqtt.packets.noReceptions', 'Per-gateway receptions are unavailable for packets without a packet ID.')`.
Rationale: the route parses `packetId`/`fromNode` as ints and queries
`WHERE packetId = ?` — a `0`/null key would over-match every id-less packet from
that node, so we deliberately don't fetch.

### 3.4 NEW `src/components/Mqtt/MqttPacketMonitor.css`
Clone `MeshCorePacketMonitor.css`, rename the `mcpm-` prefix to `mqpm-`. Add:
- `.mqpm-recv-table` (dense table inside the modal body; reuse `mcpm-table` metrics).
- `.mqpm-gateway-dropdown` (the checkbox multi-select — §4): a relatively-positioned
  button + an absolutely-positioned scrollable panel (`max-height: 260px; overflow-y:auto`),
  `z-index` above the table but below the modal (`< 1000`).
- Outcome badge color variants (`.mqpm-badge-encrypted`, `.mqpm-badge-ignored`,
  `.mqpm-badge-geo-ignored`, `.mqpm-badge-error`) using the existing `--ctp-*` vars
  (yellow/peach/red family), mirroring `.mcpm-decode-note`'s color-mix approach.

### 3.5 EDIT `src/App.tsx` (keep the diff minimal — 4 edit points)

1. **Import** (near L24, with the other component imports):
   ```ts
   import MqttPacketMonitorView from './components/Mqtt/MqttPacketMonitorView';
   ```
2. **Source-type derivation** (L123, right after `isMqttBridge`):
   ```ts
   const isMqttBroker = sourceType === 'mqtt_broker';
   const isMqtt = isMqttBridge || isMqttBroker;
   ```
3. **Tab gate** (L684, inside `tabPermissions`): MQTT sources gate on permission
   alone (the view shows its own enable banner; `packetLogEnabled` is derived from
   the Meshtastic `getPacketStats()` call and is meaningless for MQTT sources):
   ```ts
   packetmonitor: () => isMqtt
     ? hasPermission('packetmonitor', 'read')
     : (packetLogEnabled && hasPermission('packetmonitor', 'read')),
   ```
   Add `isMqttBroker` to the dependency array at L706 (`isMqttBridge` is already there).
4. **Render swap** (L5196–5202):
   ```tsx
   {activeTab === 'packetmonitor' && (
     <ErrorBoundary fallbackTitle="Packet Monitor failed to load">
       <div style={{ height: 'calc(100dvh - var(--header-height, 60px) - 4rem)', overflow: 'hidden' }}>
         {isMqtt && sourceId ? (
           <MqttPacketMonitorView baseUrl={baseUrl} sourceId={sourceId} />
         ) : (
           <PacketMonitorPanel onClose={() => setActiveTab('nodes')} />
         )}
       </div>
     </ErrorBoundary>
   )}
   ```
   `baseUrl` and `sourceId` are already in scope (L267, L120). `main.tsx` routes both
   `mqtt_broker` and `mqtt_bridge` into `<App>` (only `meshcore` gets a separate page),
   so App is the correct mount surface. No `main.tsx` change needed.

### 3.6 EDIT `public/locales/en.json` — add `mqtt.packets.*` flat keys (§6)

### 3.7 Docs
- NEW/EDIT `docs/features/packet-monitor.md`: add a "MQTT sources" section describing
  the gateway-aware view (deduplicated packets, gateway multi-select, per-gateway
  receptions with RSSI/SNR/hops, capture opt-in + retention). The existing
  `packet-monitor.md` already has a sidebar entry (`config.mts` L109) — no sidebar
  change required. Keep it a section in the existing page (packet monitor is one
  feature with source-specific behavior), not a new page.
- EDIT `docs/internal/dev-notes/MQTT_PACKET_MONITOR_EPIC.md`: tick the Phase 2
  deliverable checkboxes as they land.

---

## 4. Gateway multi-select filter (the headline feature)

- **Data:** `loadGateways()` → GET `.../gateways` → `body.data.gateways: MqttGateway[]`.
  Sort by `receptionCount DESC` for display.
- **Control:** a `mqpm-gateway-dropdown` — a toolbar/filter button labeled
  `t('mqtt.packets.gateways', 'Gateways')` + `({selectedGateways.length || 'all'})`,
  toggling an absolutely-positioned panel of checkboxes. Each row:
  `☐ {nodeName(gw.gatewayNodeNum) ?? gw.gatewayId}  · {gw.receptionCount}`.
  A "Select all / Clear" affordance at the top. Close on outside-click
  (a `mousedown` listener on document, removed on unmount) — copy any existing
  outside-click pattern if one exists, else implement inline.
- **Wiring:** selected `gatewayId`s → the `gateways` CSV query param on the next
  `load()`. Changing the selection triggers `load()` via the filter `useEffect`.
- **gatewayCount-under-filter labeling (Phase-1 deviation §"Grouped-list semantics"):**
  when `selectedGateways.length > 0`, the Gateways column header/tooltip and the
  filter panel must state that counts reflect **only the selected gateways**
  (`t('mqtt.packets.gatewayCountFiltered', 'Gateway counts reflect the selected gateways only.')`).
  When no filter is active, counts are across all gateways.

---

## 5. Test plan

Precedent: view components use Testing Library + `@vitest-environment jsdom`, and
mock `react-i18next` so `t(key, fallback)` returns the fallback string (see
`src/components/MeshCore/MeshCorePacketDetailModal.test.tsx`). No test exists for
`MeshCorePacketMonitorView` itself — so match the *modal* test depth for the modal
and add a focused view test with a mocked fetch layer.

**NEW `src/components/Mqtt/MqttPacketDetailModal.test.tsx`** (jsdom):
- Renders packet fields (from-name via injected `nodeName`, channel, portnum,
  outcome badge, encrypted flag).
- With `canFetch` true: mock `csrfFetch` to resolve `{ success:true, data:{ receptions:[...] }}`;
  assert the receptions table shows gateway name, RSSI, SNR, and computed hops
  (`hopStart - hopLimit`). Use `findBy*` for the async fetch.
- With `packetId: 0` (and `null`): assert the "no receptions" note renders and
  `csrfFetch` is **not** called.

**NEW `src/components/Mqtt/MqttPacketMonitorView.test.tsx`** (jsdom):
- Mock `react-i18next`, `useCsrfFetch` (returns a `vi.fn()` resolving envelope
  bodies), `useAuth` (`hasPermission` returns true/false per case), `useNodes`
  (returns a small `nodes` array). Fake timers for the poll interval.
- Render + initial load: assert the grouped rows appear (unwrapping `body.data`);
  assert the header count.
- **Envelope regression guard:** the mocked GET returns `{ success:true, data:{ packets:[...] }}`
  and the test asserts rows render — a component that read `body.packets` (the
  MeshCore mistake) would show empty and fail. This is the single most valuable test.
- Enable banner: `enabled:false` → banner visible; with `settings:write` the
  Enable button POSTs `mqtt_packet_log_enabled:'1'`.
- Clear button: hidden without `packetmonitor:write`; with it, confirm+DELETE clears rows.
- Gateway filter: selecting a gateway adds `gateways=<id>` to the next request URL
  (assert on the `csrfFetch` mock's call args).
- Pause: advancing fake timers does not refetch while paused.

**Full suite + gates before PR:** `npm test` (all green), `npm run lint:ci`
(baseline not grown — new files must be `any`-free and use `csrfFetch`, not raw
`fetch`), `tsc` typecheck green.

---

## 6. i18n keys — add to `public/locales/en.json` (flat dotted keys)

Reuse existing `common.*` where present (`common.pause`,`common.resume`,`common.refresh`,
`common.clear`,`common.close`,`common.loading`,`common.all`; `common.filters` is absent
so rely on the literal fallback like the MeshCore view does). New `mqtt.packets.*`:

```
mqtt.packets.title               "Packet Monitor"
mqtt.packets.disabled            "MQTT packet capture is off. No new packets will be recorded until you enable it."
mqtt.packets.enable              "Enable capture"
mqtt.packets.captureEnabled      "Capture enabled"
mqtt.packets.maxCount            "Max count"
mqtt.packets.maxAgeHours         "Max age (h)"
mqtt.packets.empty               "No packets captured yet. Waiting for MQTT traffic…"
mqtt.packets.emptyDisabled       "No packets captured. Enable capture to start recording."
mqtt.packets.time                "Time"
mqtt.packets.from                "From"
mqtt.packets.to                  "To"
mqtt.packets.type                "Type"
mqtt.packets.channel             "Channel"
mqtt.packets.gateways            "Gateways"
mqtt.packets.gatewayCount        "Gateways"
mqtt.packets.gatewayCountFiltered "Gateway counts reflect the selected gateways only."
mqtt.packets.receptions          "Receptions"
mqtt.packets.size                "Size"
mqtt.packets.preview             "Preview"
mqtt.packets.encrypted           "Encrypted"
mqtt.packets.decrypted           "Decrypted"
mqtt.packets.portnum             "Port"
mqtt.packets.outcome             "Outcome"
mqtt.packets.detailTitle         "Packet Detail"
mqtt.packets.packetSection       "Packet"
mqtt.packets.receptionsSection   "Per-gateway receptions"
mqtt.packets.gateway             "Gateway"
mqtt.packets.rssi                "RSSI"
mqtt.packets.snr                 "SNR"
mqtt.packets.hops                "Hops"
mqtt.packets.rxTime              "Rx time"
mqtt.packets.firstHeard          "First heard"
mqtt.packets.lastHeard           "Last heard"
mqtt.packets.noReceptions        "Per-gateway receptions are unavailable for packets without a packet ID."
mqtt.packets.clickToView         "Click to view receptions"
mqtt.packets.clearConfirm        "Clear the captured MQTT packet log for this source?"
mqtt.packets.selectAll           "Select all"
mqtt.packets.clearSelection      "Clear"
```
Only `en.json` is edited; other locales inherit via `fallbackLng: 'en'`.

---

## 7. Export decision (explicitly out of scope)

The MeshCore view has an Export (JSONL) button backed by a dedicated backend export
route. Phase 1 shipped **no** MQTT export route, and the epic does not require export.
Adding it would mean new backend work (a `/mqtt/packets/export` route + service
method + audit) — **out of scope for Phase 2. Drop the Export button and the
`Download` icon import.** If wanted later, file a follow-up.

---

## 8. Work packages (dependency-ordered, for Sonnet implementers)

**WP1 — Types + view shell + App integration** (foundation; do first)
- `mqttPacketTypes.ts`, `MqttPacketMonitorView.tsx` (toolbar, banner, table, polling,
  settings save, filters minus the gateway dropdown), `MqttPacketMonitor.css`.
- App.tsx 4 edits (§3.5).
- Accept: MQTT source shows the tab; view loads + polls grouped packets (unwrapping
  `body.data`); enable banner + capture toggle + retention inputs work; clear works;
  non-MQTT sources still render `PacketMonitorPanel` unchanged; `tsc`+`lint:ci` green.

**WP2 — Gateway multi-select filter** (depends on WP1)
- `loadGateways()`, the `mqpm-gateway-dropdown` control + CSS, CSV wiring, the
  filtered-count labeling (§4), plus the encrypted/portnum parity filters +
  localStorage persistence.
- Accept: selecting gateways narrows the list and sets `gateways=` on the request;
  filtered-count note shows; filter state survives reload.

**WP3 — Detail modal + receptions** (depends on WP1; parallel with WP2)
- `MqttPacketDetailModal.tsx` + receptions fetch with the packetId-0/null guard (§3.3),
  receptions table CSS.
- Accept: row click opens modal; receptions table shows gateway/RSSI/SNR/hops;
  id-less packets show the note and skip the fetch.

**WP4 — Tests + i18n + docs** (depends on WP1–WP3)
- The two `*.test.tsx` (§5), the `en.json` keys (§6), the `packet-monitor.md` section
  + epic checkbox updates.
- Accept: full `npm test` green, `lint:ci` baseline not grown, docs build clean.

Browser validation (dev-container deploy + chrome-devtools against a live MQTT
source) is a later epic stage — WPs must leave the feature testable there.

---

## 9. Open questions / risks (resolved where possible)

1. **`packetLogEnabled` is Meshtastic-derived** (`getPacketStats()` in
   `src/services/packetApi.ts`, no sourceId → primary source). For MQTT sources it's
   meaningless, so §3.5 gates the tab on permission alone and lets the view's own
   enable banner communicate capture state. *Resolved.*
2. **Type drift** between the mirrored frontend types and the repo interfaces is a
   silent runtime risk. Mitigation: keep the mirror minimal (view-model subset) and
   rely on the envelope regression test to catch shape breaks. *Accepted risk.*
3. **`toNode` broadcast value** — MQTT stores `p.to >>> 0`, so broadcast is
   `4294967295`. Render as "Broadcast". *Resolved in the table spec.*
4. **Gateway names** depend on the node being present in the poll cache for the active
   source (gateways are often not in-mesh nodes) → many will fall back to the hex
   `gatewayId`. Acceptable; the hex id is meaningful to operators. *Resolved.*
5. **Poll churn on high-throughput sources:** a 5 s full refetch of a 5000-row grouped
   aggregate is the server's cost, not the client's; the query is indexed
   (migration 121). If it proves heavy in browser validation, raise the interval or add
   a "live/paused" default of paused. *Watch during validation.*
6. **`common.filters` key is absent** from `en.json` — the literal `t('...', 'Filters')`
   fallback covers it (same as MeshCore). Optionally add `common.filters` while here.
   *Non-blocking.*
```
