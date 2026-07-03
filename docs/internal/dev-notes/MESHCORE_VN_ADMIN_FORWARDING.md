# MeshCore Virtual Node — config/admin command forwarding

**Issue:** #3904 (the `unhandled frame: code=142` / silently-dropped config commands).
**Prereq (merged):** PR #3905 — the "Allow admin commands" UI checkbox + `allowAdminCommands` persistence.

## What it does

When the meshcore-flutter app (or any companion client) connected to the Virtual
Node sends a config-mutating command, the VN now forwards it to the **physical**
MeshCore node — gated on the source's `allowAdminCommands` flag — instead of
dropping it with a blanket `Err(UnsupportedCmd)`.

Before: `MeshCoreVirtualNodeServer.dispatchCommand()` only implemented a
read/message subset; every `Set*` command hit `default:` → `Err(UnsupportedCmd)`,
and `allowAdminCommands` was never consulted (dead code).

## Design: parse-and-dispatch onto existing manager setters

The physical Companion node is driven by `meshcore.js`, and `MeshCoreManager`
already exposes typed, tested setters for these commands. So the VN parses each
config frame and calls the matching manager method — rather than raw-relaying
bytes (which would need a low-level frame writer and racy response correlation on
a shared serial link). This mirrors how the VN already handles sends
(`manager.sendMessage`, not a raw relay of `SendTxtMsg`).

| App command (code) | Wire payload | Manager method | Units note |
|---|---|---|---|
| `SetAdvertName` (8)   | `[8][name: UTF-8]`                          | `setName(name)`               | — |
| `SetRadioParams` (11) | `[11][freq:u32LE][bw:u32LE][sf:u8][cr:u8]`  | `setRadio(freq,bw,sf,cr)`     | wire freq=kHz→**MHz**, bw=Hz→**kHz** |
| `SetTxPower` (12)     | `[12][power:u8]`                            | `setTxPower(power)`           | dBm |
| `SetAdvertLatLon` (14)| `[14][lat:i32LE][lon:i32LE]`                | `setCoords(lat,lon)`          | fixed ×1e6 → **decimal degrees** |
| `SetChannel` (32)     | `[32][idx:u8][name:cstring(32)][secret:16]` | `setChannel(idx,name,secretHex)` | secret bytes → hex; **no scope** passed (leaves DB scope untouched) |
| `SetOtherParams` (38) | `[38][manualAddContacts:u8][telemetryMode:u8 packed][advLocPolicy:u8]` | `setOtherParams({…})` | telemetry byte unpacked to three 2-bit sections; forwarded atomically in one frame |

Parsers live in `meshcoreCompanionCodec.ts` (`parseSetAdvertName` … `parseSetChannel`,
plus `fixedToDegrees` / `wireFreqToMhz` / `wireBwToKhz`), unit-tested by feeding
meshcore.js's own `sendCommandSet*` builder output back through them. Dispatch and
gating live in `MeshCoreVirtualNodeServer.handleConfigCommand()`.

## Response semantics (what the app sees)

| Situation | Response |
|---|---|
| `allowAdminCommands` off | `Err(UnsupportedCmd)` — explicit rejection, not a silent hang |
| malformed / short payload | `Err(IllegalArg)` (manager not called) |
| manager returns `false` (node rejected) | `Err(BadState)` |
| manager throws | `Err(BadState)` |
| success | `Ok` |

Because the manager setters already await the node's ack, the VN's `Ok`
truthfully reflects the node applying the change. All forwarding goes through the
manager's single serialized command path, so there's no new serial contention.

## SetOtherParams (38) — atomic path

`SetOtherParams` bundles `manualAddContacts`, three 2-bit telemetry-visibility
sections, and `advLocPolicy`. Rather than fan it out across the manager's
piecemeal string-based setters (`setTelemetryModeBase` etc., each a separate
non-atomic read-modify-write frame — and none for `manualAddContacts`), it gets
a dedicated single-frame path:

`parseSetOtherParams` → `MeshCoreManager.setOtherParams({…})` →
native-backend `set_other_params` → `meshcore.js connection.setOtherParams(opts)`.

Telemetry modes stay as **raw 2-bit integers** end to end — the backend's
`telemetryModeStringToNumber` accepts numeric values directly, so there's no
lossy wire-int ↔ manager-string round-trip (the two vocabularies also disagree:
meshcore.js `TelemetryMode.AlwaysOn = 1` vs MeshMonitor `'always' → 2`). One
frame, one node ack, no mapping ambiguity.

## Deliberately out of scope (follow-ups)

- **Destructive / identity / contact commands** — `Reboot`(19),
  `ExportPrivateKey`(23)/`ImportPrivateKey`(24), `AddUpdateContact`(9)/
  `RemoveContact`(15), `SendSelfAdvert`(7). Still `Err(UnsupportedCmd)`; each
  warrants its own design + review.
- **Repeater (serial-CLI) sources** — this is Companion (`meshcore.js`) only.
