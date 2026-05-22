# Native JS/TS MeshCore — Feasibility & Impact Analysis

**Status:** Architectural analysis only. No implementation.
**Question:** What would it take to drop the Python bridge and talk to MeshCore Companion devices directly from Node/TypeScript? What does that unlock, and what does it cost?

---

## TL;DR (Recommendation)

**Go native. The work is mostly already done.**

[`@liamcottle/meshcore.js`](https://github.com/liamcottle/meshcore.js) is a mature, MIT-licensed JS implementation of the MeshCore Companion binary protocol. A clone already sits in this workspace at `~/.openclaw/workspace/meshcore.js`. It covers Serial (Node + Web), TCP (Node), and BLE (Web), uses `@noble/curves` for crypto, and has parity with python-meshcore on every wire opcode MeshMonitor currently uses. The only meaningful gap is **Node-side BLE** (Web BLE is supported, Node BLE is not).

Estimated effort to fully cut over: **~1.5–2.5 person-weeks** for serial + TCP. Add **~0.5–1 week** if Node BLE goes in scope.

Benefits beyond Electron packaging are substantial: one runtime, end-to-end typing, lower latency, no subprocess management, no "is Python3 installed?" support load.

The main downside: MeshMonitor takes on long-term protocol-tracking responsibility (today that's python-meshcore's problem).

---

## 1. What the Python bridge does today

`scripts/meshcore-bridge.py` (738 lines) is a long-lived subprocess that speaks line-oriented JSON over stdin/stdout. It wraps `python-meshcore` (`pip install meshcore`, currently v2.3.7) and exposes a fixed command vocabulary.

### Commands handled (20)

| Command | python-meshcore call | MeshCoreManager caller |
|---|---|---|
| `connect` | `MeshCore(SerialConnection|TCPConnection).connect()` | `startBridge()` |
| `disconnect` | `meshcore.disconnect()` | `disconnect()` |
| `get_self_info` | reads `meshcore.self_info` | `refreshLocalNode()` |
| `get_contacts` | `commands.get_contacts()` | `refreshContacts()` |
| `send_message` | `commands.send_msg` / `send_chan_msg` | `sendMessage()` |
| `send_advert` | `commands.send_advert()` | `sendAdvert()` |
| `login` | `commands.send_login()` | `loginToNode()` |
| `get_status` | `commands.req_status_sync(timeout=10)` | `requestNodeStatus()` |
| `set_name` | `commands.set_name()` | `setName()` |
| `set_radio` | `commands.set_radio(freq, bw, sf, cr)` | `setRadio()` |
| `set_coords` | `commands.set_coords()` | `setCoords()` |
| `set_advert_loc_policy` | `commands.set_advert_loc_policy()` | `setAdvertLocPolicy()` |
| `set_telemetry_mode_{base,loc,env}` | `commands.set_telemetry_mode_*` | `setTelemetryMode*()` |
| `get_stats` | `commands.get_stats_{core,radio,packets}` | `getStats*()` |
| `get_device_time` | `commands.get_time()` | `getDeviceTime()` |
| `device_query` | `commands.send_device_query()` | `deviceQuery()` |
| `request_telemetry` | `commands.binary.req_telemetry_sync()` | `requestRemoteTelemetry()` |
| `shutdown` | bridge-internal | `disconnect()` |
| `ping` | echo | (unused) |

### Unsolicited events pushed bridge → Node (5)

- `contact_message` — incoming DM (`CONTACT_MSG_RECV`)
- `channel_message` — incoming channel msg (`CHANNEL_MSG_RECV`)
- `contact_advertised` — `ADVERTISEMENT` event
- `contact_added` — `NEW_CONTACT` event
- `contact_path_updated` — `PATH_UPDATE` event

The bridge also calls `meshcore.start_auto_message_fetching()`, which silently drains the device's message queue whenever the firmware emits a `MESSAGES_WAITING` push. That happens transparently in `python-meshcore` — the JS side never sees it.

### Transport types

- **Serial** (`SerialConnection`, via pyserial)
- **TCP** (`TCPConnection`, via asyncio)
- **BLE** — defined in python-meshcore but **not exposed by the bridge** (the bridge only handles `connection_type ∈ {serial, tcp}`). MeshMonitor today has no BLE path through the bridge.

---

## 2. What python-meshcore actually does

Installed at `~/.openclaw/workspace/meshcore-cli/.venv/lib/python3.13/site-packages/meshcore/`. Module layout (~3,000 LOC):

```
meshcore.py             504  high-level MeshCore class
reader.py               992  binary frame parser + serial framing
events.py               316  EventType enum + dispatcher
meshcore_parser.py      212  protocol decoding
connection_manager.py   186  connection lifecycle
ble_cx.py               214  BLE transport (bleak)
tcp_cx.py               164  TCP transport
serial_cx.py            163  serial transport
parsing.py              114  shared primitives
packets.py              129  packet helpers
lpp_json_encoder.py      83  Cayenne-LPP → JSON
commands/                    ~50 user-facing commands
  base.py               14K   command framework (send + wait_for_events)
  device.py             16K   set_name, set_radio, get_stats_*, set_telemetry_mode_*, ...
  contact.py             9K   get_contacts, add/remove/share/export/import, reset_path, ...
  messaging.py          16K   send_msg, send_chan_msg, send_login, send_telemetry_req, ...
  binary.py             12K   req_telemetry_sync, req_status_sync, req_neighbours, req_acl, ...
  control_data.py       1.5K  set_flood_scope
```

### What's on the wire

The "Companion Radio protocol" is a binary, length-prefixed frame protocol over the USB/BLE/TCP transport between MeshMonitor's host and the locally-attached Companion node:

```
byte 0      : frame type (0x3c "<" = app→radio, 0x3e ">" = radio→app)
bytes 1..2  : payload length, uint16 LE
bytes 3..N  : payload, starts with 1-byte command/response/push code
```

Payloads are simple structs of little-endian integers, fixed-length strings (often NUL-padded to 32 bytes), and length-prefixed byte arrays. No compression, no on-wire crypto for the host↔node link (the radio-side mesh crypto happens inside the firmware and the LoRa packets — host↔node is a trusted link).

There **is no crypto in the python-meshcore↔node link**. python-meshcore does provide Curve25519/Ed25519 helpers for things like contact import/export and packet signing, but the host↔device link is unencrypted by design. (Crypto handled in firmware is opaque to the bridge.)

### Verdict on complexity

The protocol is straightforward: per-command opcodes, fixed framing, simple struct unpacking. Both python-meshcore and meshcore.js are ~3,000 lines, roughly half of which is rote command/response wiring. This is **not** a crypto- or compression-heavy protocol where reimplementation is risky — it's mostly bookkeeping over a serial line.

---

## 3. The JS side today

`src/server/meshcoreManager.ts` (1,528 lines) hosts the bridge wrapper:

- **All bridge I/O is in one class.** `sendBridgeCommand()` is the single ingress; `handleBridgeResponse()` and `handleBridgeEvent()` are the only egress. Every other method (sendMessage, setRadio, etc.) is a thin TS wrapper that calls `sendBridgeCommand('cmd_name', params)` and maps the JSON response into typed objects.
- **Coupling to the JSON shapes is tight but localized.** Field names like `pubkey_prefix`, `sender_timestamp`, `adv_type`, `bat_mv`, `up_secs`, `tx_power` appear in `handleBridgeEvent` and in the various refresh methods. They're snake_case mirrors of python-meshcore's internal names.
- **The Repeater path is separate.** `connectSerialDirect()` / `sendRepeaterCommand()` use serialport directly to talk to Repeater firmware over a text CLI. **This path already proves that native serial in Node works fine for MeshMonitor.** It does not go through the bridge.

**Replacement footprint:** ~600 lines of bridge plumbing (`startBridge`, `sendBridgeCommand`, `handleBridgeResponse`, `handleBridgeEvent`, every `sendBridgeCommand(...)` call) deletes outright. The public API of `MeshCoreManager` (connect/disconnect/sendMessage/refreshContacts/etc.) does not need to change — only the implementation behind it. Callers across the codebase (sources registry, routes, schedulers) are unaffected.

---

## 4. Existing JS/TS MeshCore implementations

### `@liamcottle/meshcore.js` (the find)

- **Repo:** github.com/liamcottle/meshcore.js
- **Version:** 1.13.0
- **License:** MIT
- **Author:** Liam Cottle — known in the Meshtastic/MeshCore community
- **Already cloned at:** `~/.openclaw/workspace/meshcore.js/`
- **Dependencies:** `@noble/curves` (~1.8), `serialport` (~13)
- **LOC:** ~2,750 (most in `src/connection/connection.js` = 2,448 lines)

#### Transport support

| Transport | python-meshcore | meshcore.js |
|---|---|---|
| Serial (Node) | ✅ pyserial | ✅ serialport |
| Serial (Web) | n/a | ✅ Web Serial |
| TCP (Node) | ✅ | ✅ net.Socket |
| BLE (Web) | n/a | ✅ Web Bluetooth |
| BLE (Node) | ✅ bleak | ❌ **gap** |

#### Command/response coverage

Every command MeshMonitor uses today exists in meshcore.js (verified against `src/constants.js` + grep over `src/connection/connection.js`):

- `AppStart`, `GetContacts`, `GetDeviceTime`, `SetDeviceTime`
- `SendTxtMsg`, `SendChannelTxtMsg`, `SendChannelData`
- `SendSelfAdvert`, `SetAdvertName`, `SetAdvertLatLon`
- `AddUpdateContact`, `RemoveContact`, `ShareContact`, `ExportContact`, `ImportContact`, `ResetPath`
- `SyncNextMessage` (drains MSG_WAITING)
- `SetRadioParams`, `SetTxPower`, `SetOtherParams` (manualAddContacts / telemetry modes / advLocPolicy bundled here — same as python)
- `Reboot`, `GetBatteryVoltage`, `DeviceQuery`
- `ExportPrivateKey`, `ImportPrivateKey`
- `SendLogin`, `SendStatusReq`
- `SendTelemetryReq` (text request) + `SendBinaryReq` (binary req — what `req_telemetry_sync` uses)
- `GetStats(core|radio|packets)`
- `GetChannel`, `SetChannel`
- `SignStart` / `SignData` / `SignFinish`, plus high-level `sign(data)`
- `SendTracePath`
- `SetFloodScope`
- High-level helpers: `findContactByName`, `findContactByPublicKeyPrefix`, `getWaitingMessages`, `getNeighbours`, `syncDeviceTime`, `sendAdvert`, `sendFloodAdvert`, `sendZeroHopAdvert`

#### Push handlers (all wired up)

- `Advert` / `NewAdvert` / `PathUpdated`
- `SendConfirmed`, `MsgWaiting`
- `RawData`, `LogRxData`, `TraceData`
- `LoginSuccess`, `LoginFail`
- `StatusResponse`, `TelemetryResponse`, `BinaryResponse`

#### Cayenne LPP

`cayenne_lpp.js` (8.6 KB) — full decoder in JS. We do **not** need to find a separate LPP library.

#### Crypto

`@noble/curves` provides Curve25519/Ed25519/X25519 — the primitives MeshCore uses for contact identity and signing. Battle-tested across the Ethereum and Bitcoin ecosystems.

### Other JS libraries checked

- **`meshcore-decoder/`** (workspace) — passive packet decoder only, no transport. Useful as a reference but not a replacement.
- **`meshcore-cli/`** (workspace) — Python CLI, not JS.
- **`meshcore-ha/`** (workspace) — Home Assistant integration, Python.
- **npm search:** `meshcore.js` is the only Node-targeted Companion-protocol library I'm aware of. There is no broader npm ecosystem for this protocol.

### Gaps in meshcore.js vs MeshMonitor's needs

1. **Node BLE.** Web BLE works; Node BLE does not. Adding a Noble (`@abandonware/noble`) transport is ~150–250 LOC mirroring `nodejs_serial_connection.js`. Today the bridge doesn't expose BLE either, so this is parity, not a regression — but it's needed to **unlock** native BLE in the desktop app.

2. **`set_telemetry_mode_{base,loc,env}` as direct helpers.** python-meshcore implements these by re-reading `self_info` via `send_appstart()`, mutating one field, and replaying via `set_other_params` (opcode 38). meshcore.js exposes `sendCommandSetOtherParams(manualAddContacts)` but the signature only carries `manual_add_contacts`. Generalizing it to carry the full SetOtherParams field set (telemetry modes, adv_loc_policy, multi_acks) is ~50 LOC. The wire opcode is already there.

3. **`req_telemetry_sync` sync helper.** meshcore.js exposes `sendCommandSendBinaryReq(publicKey, requestCodeAndParams)` plus the `BinaryResponse` push handler — building a sync `requestTelemetry(contact, timeout)` that issues the binary req with `BinaryRequestTypes.GetTelemetryData (0x03)` and awaits a matching `BinaryResponse` push is ~30 LOC and a small amount of LPP decoding glue (which `cayenne_lpp.js` already provides).

None of these gaps are conceptually hard; all are clean additions.

---

## 5. Effort estimate

Phased plan, assuming we keep `MeshCoreManager`'s public API stable so callers don't have to change:

| Phase | Work | Estimate |
|---|---|---|
| 0 | Decide: vendor `meshcore.js` as a Yeraze fork vs depend on `@liamcottle/meshcore.js` from npm | 0.5 day |
| 1 | Add a `MeshCoreNativeBackend` class that wraps meshcore.js and exposes the methods MeshCoreManager already uses. Connect Serial + TCP only. Wire push events to existing `dataEventEmitter` calls. | 3–5 days |
| 2 | Add helpers in meshcore.js (or our fork): generalized SetOtherParams, sync `requestTelemetry`. | 1–2 days |
| 3 | Add Node BLE transport via Noble (only if BLE matters; otherwise defer) | 3–5 days |
| 4 | Cut over `MeshCoreManager` to the native backend behind an env flag (`MESHCORE_TRANSPORT=native` vs `bridge`); run both in parallel against real hardware for a week | 2–3 days + soak time |
| 5 | Delete `scripts/meshcore-bridge.py`, drop Python dep from Dockerfile + dev setup, remove `MESHCORE_TRANSPORT` flag | 1 day |

**Total without Node BLE: ~8–12 person-days (≈1.5–2.5 weeks)**
**Total with Node BLE: ~11–17 person-days (≈2–3.5 weeks)**

---

## 6. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| meshcore.js falls behind upstream firmware protocol additions | Medium | Vendor it as a fork under `Yeraze/meshcore.js`; contribute changes back upstream. Liam is responsive. The community is small enough that staying in sync is feasible. |
| Latent bugs in meshcore.js that python-meshcore doesn't have | Medium | Phase 4 dual-run on real hardware. Keep the bridge in tree for one release as fallback. |
| Loss of access to python-meshcore-only debug tools (meshcore-cli, meshcore-ha) | Low | Those tools run independently; nothing stops a developer from installing them locally. We just stop *requiring* them. |
| serialport native-build pain in Electron | Low | serialport is already a documented Electron dependency; `electron-rebuild` handles it. Many Electron apps ship it. |
| Node BLE platform fragmentation (Noble on Linux/Mac/Win) | Medium | Defer Node BLE until specifically needed; ship Phase 1+2 first. Web BLE is an alternative for desktop if the app is web-tech-only. |
| LoRa-link crypto correctness regressions | Very low | Host↔device link has no crypto. All radio-side crypto happens inside the firmware, opaque to either library. |

---

## 7. Benefits beyond desktop packaging

- **One runtime.** Goodbye `spawn('python3', ...)`. No more "is Python3 on this host?" or "did `pip install meshcore` succeed?" support load. Already partially solved by Repeater mode (direct serial); native makes it uniform.
- **End-to-end TypeScript.** Today, every bridge response goes through `JSON.parse(line)` with `any`-typed payloads, then gets manually narrowed. Direct meshcore.js calls return TypeScript-friendly objects (or our wrapper does, with proper types).
- **Lower latency on push events.** Bridge events traverse Python event loop → JSON encode → pipe → readline parse → JSON.parse → switch dispatch. Native is direct EventEmitter dispatch. For things like incoming messages and advert pushes, this matters for UI responsiveness.
- **Simpler ops.** One process to monitor, one set of logs. No more "the bridge subprocess died but the Node parent is still up." No more dual error paths (`error from bridge stderr` vs `bridge command timeout` vs `bridge process exited`).
- **Easier testing.** No subprocess to mock. meshcore.js can be stubbed at the Connection layer — much cleaner unit tests for MeshCoreManager.
- **No more "MeshCore bridge: meshcore Python library not installed" warning.** It just works out of the box.

---

## 8. Downsides

- **Protocol-tracking burden moves to us.** Today, when MeshCore firmware adds a new opcode or changes a struct, python-meshcore catches up and we get it for free on the next pip install. After migration, meshcore.js (or our fork) is the catch-up point, and that's our problem. Liam is active but he's one person; the burden shifts.
- **Smaller deployment base.** python-meshcore has more users (HA integration, CLI, MeshMonitor, plus other Python-based mesh projects). More eyes = fewer bugs in steady-state. meshcore.js is newer and less battle-tested at the protocol-correctness level.
- **One-time migration cost.** ~2 weeks of focused work, plus parallel-run validation. Not free.
- **BLE story regresses on Node** unless we add the Noble transport. The bridge could in principle expose BLE (python-meshcore supports it); native Node can't until we write it.

---

## 9. Desktop app implications

### How the Python dep is handled today

`MeshCoreManager.startBridge()`:

```ts
const useSystemBin = process.env.NODE_ENV !== 'production' || process.env.IS_DESKTOP === 'true';
const pythonPath = useSystemBin ? 'python3' : '/opt/apprise-venv/bin/python3';
```

- **Docker (production server):** Python3 + meshcore baked into the image at `/opt/apprise-venv/`.
- **Dev:** uses system `python3` with `meshcore` installed in some venv the user manages.
- **Desktop (`IS_DESKTOP=true`):** falls back to `python3` on PATH — i.e., **today the desktop build requires the user to have Python3 + the meshcore pip package installed on their machine**. That's the core friction.

### What native JS unlocks for Electron/Tauri

- **No interpreter to bundle.** Bundling Python into Electron is awful: 30–80 MB extra, codesigning issues on macOS (every `.so` has to be signed), Gatekeeper notarization complications, Windows Defender false positives on bundled Python, antivirus warnings, etc.
- **No first-run pip install.** Pip-install-on-first-run is fragile (corporate proxies, no compiler for native wheels, ARM/x86 wheel availability).
- **serialport "just works" in Electron.** Native module rebuilt against Electron's Node — standard pattern, well-documented, used by lots of Electron apps. No worse than what we already do for the Repeater path.
- **`@noble/curves` is pure JS** — no native rebuilds.
- **Smaller installer.** Drop ~50–80 MB of Python runtime + meshcore + bleak + pyserial wheels.
- **Code signing simpler.** Fewer binaries to sign and notarize.

### BLE in Node/Electron — state of the art

This is the trickiest part. Options:

1. **`@abandonware/noble`** — long-standing fork of `noble`. Works on Linux (BlueZ via D-Bus), macOS (CoreBluetooth), Windows (UWP wrapper). Maintained-ish; common but has rough edges, especially on Windows. Used by many production Electron apps.
2. **Web Bluetooth in Electron** — Electron supports Web Bluetooth via Chromium. Works but requires user-gesture-driven device selection (no headless connect to a remembered device). Probably fine for "connect to my mesh node" UX where you pick from a list, but not for background reconnect.
3. **Native BLE module per platform** — overkill unless we hit real Noble pain.

For MeshMonitor's likely UX (one node per source, infrequent connect events), **Noble is probably fine**. The 3–5 day estimate above assumes Noble.

---

## 10. Recommended path forward

1. **Decision: fork `@liamcottle/meshcore.js` as `Yeraze/meshcore.js`.** Lets us land protocol updates and small helpers (set_other_params generalization, sync telemetry req) without waiting on an upstream maintainer. Stay in sync with upstream by rebasing periodically. Open PRs upstream for non-MeshMonitor-specific changes.
2. **Phase 1 (Serial + TCP):** ship a `MeshCoreNativeBackend` behind `MESHCORE_TRANSPORT=native`. Keep the Python bridge in place. Run both in parallel against the sandbox devices for a week. Compare event streams.
3. **Phase 2 (Cut over):** flip the default to native. Bridge stays as opt-in fallback for one release.
4. **Phase 3 (Delete):** drop the bridge, drop Python from the Docker image, drop `MESHCORE_TRANSPORT` flag. Update dev setup docs.
5. **Phase 4 (BLE):** add Noble transport when desktop BLE becomes a real requirement. Not on the critical path for the cut-over.

This is the lowest-risk version of the migration — the user-visible behavior of `MeshCoreManager` doesn't change, the swap is gated by an env flag during validation, and the bridge isn't deleted until we've proven the native path against real hardware.

---

## Appendix A — File pointers

| Concern | Path |
|---|---|
| Python bridge | `scripts/meshcore-bridge.py` |
| JS-side bridge consumer | `src/server/meshcoreManager.ts` |
| python-meshcore install | `~/.openclaw/workspace/meshcore-cli/.venv/lib/python3.13/site-packages/meshcore/` |
| meshcore.js workspace clone | `~/.openclaw/workspace/meshcore.js/` |
| meshcore.js entry | `meshcore.js/src/index.js` |
| meshcore.js wire constants | `meshcore.js/src/constants.js` |
| meshcore.js binary protocol | `meshcore.js/src/connection/connection.js` (2,448 LOC) |
| meshcore.js LPP decoder | `meshcore.js/src/cayenne_lpp.js` |
| meshcore.js TCP transport | `meshcore.js/src/connection/tcp_connection.js` |
| meshcore.js Node serial transport | `meshcore.js/src/connection/nodejs_serial_connection.js` |

## Appendix B — Why the Repeater path already validates native Node Serial

`MeshCoreManager.connectSerialDirect()` and `sendRepeaterCommand()` already use the `serialport` npm package directly in Node to talk to Repeater firmware over a text CLI. This path has been in production. It demonstrates that:

- `serialport` works fine for MeshMonitor in both Docker and desktop builds.
- The platform-specific concerns (`/dev/ttyUSB*` permissions, COM ports on Windows, etc.) are already solved.
- Whatever we'd hit on the native Companion path is incremental, not novel.

The Companion native path is a different *protocol* on the same *transport*. The transport is already proven.
