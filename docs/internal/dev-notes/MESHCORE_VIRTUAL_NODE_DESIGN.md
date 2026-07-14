# MeshCore Virtual Node — Design Plan

**Issue:** [#3535](https://github.com/Yeraze/meshmonitor/issues/3535) — expose a real MeshCore node, that MeshMonitor already manages, as a virtual node the MeshCore **mobile app** can connect to over WiFi/TCP.

**Status:** Phases 0–4 implemented and verified against the real MeshCore
(`meshcore-flutter`) app over WiFi — see "Phasing" below. The app can now mirror
the node, send messages, apply admin-gated config, and relay adverts / login /
trace / telemetry / raw-RX through to the physical node.

> **Verified end-to-end:** the app connects over WiFi, shows the node identity,
> loads contacts + channels, and sends/receives channel messages through the real
> node (incl. an auto-responder round-trip). Two protocol subtleties were found
> only by watching the live command stream and are captured below.

> **Confirmed prerequisite:** the MeshCore mobile app supports a WiFi/TCP companion
> connection. Without that this feature would be impossible (MeshMonitor is
> headless/Docker and cannot present a BLE peripheral). With it, the feature
> reduces to "implement the *device end* of the companion frame protocol over a
> TCP server."

---

## 1. Goal & non-goals

**Goal.** A user whose phone cannot reach a MeshCore node directly (no BLE/USB range)
points the MeshCore app at `meshmonitor-host:PORT`. MeshMonitor answers the companion
protocol as if it *were* that node: the app sees the node's identity, contacts,
channels, message history, and telemetry, and can send messages / issue commands that
MeshMonitor relays to the real node it already holds the companion slot on.

**Non-goals (initial scope).**
- Not a BLE bridge — TCP/WiFi only (matches our existing transport story; see `meshcoreNativeBackend.ts`).
- Not a generic MeshCore-protocol simulator / test fixture — it is a *bridge to a real node*.
- Not multi-node aggregation — one virtual node maps to exactly one MeshCore source.

## 2. Why this is "implement the device end," not "passthrough"

MeshMonitor **already occupies the real node's single companion slot** via
`meshcore.js` (`TCPConnection` / `NodeJSSerialConnection` in
`src/server/meshcoreNativeBackend.ts`). We therefore **cannot** transparently splice the
phone's socket onto the node's companion link — there is only one slot and we hold it.

So, exactly like the existing **Meshtastic** `src/server/virtualNodeServer.ts`, this must be
a **synthesize-and-proxy** server:

- **Reads** (contacts, self-info, time, message history, channels, telemetry) are
  **answered from MeshMonitor's mirrored DB state** for this source.
- **Writes** (send message, set name, set radio params, …) are **forwarded to the real
  node** through the existing `meshcoreManager` for that source.

The Meshtastic VN is the proven template for every cross-cutting concern (multi-client TCP
server, framing, per-client buffers, inactivity cleanup, audit logging, an
`allowAdminCommands` safety gate, broadcast-on-incoming). We mirror its structure and swap
the wire protocol.

## 3. The MeshCore companion wire protocol (from `@liamcottle/meshcore.js` v1.13.0)

### 3.1 Framing (TCP)

Source: `src/connection/tcp_connection.js`, `connection.js`, `constants.js`.

```
frame = [ frameType:u8 ] [ frameLength:u16 little-endian ] [ payload:frameLength bytes ]
        frameType 0x3c '<'  = app  -> node   (commands)
        frameType 0x3e '>'  = node -> app    (responses + pushes)
        payload[0]          = command / response / push code (see below)
```

- The app **writes** `0x3c` frames (`sendToRadioFrame`). Our server **reads** these.
- The node **writes** `0x3e` frames. Our server **emits** these.
- BLE uses GATT characteristics instead of the length-prefixed framing, but we are
  TCP-only, so the 3-byte header above is the whole framing story.

> Contrast with Meshtastic VN, whose header is `0x94 0xc3 <len:u16 BE>`. MeshCore is
> `0x3c|0x3e <len:u16 LE>`. Same *idea*, different magic + endianness + a type byte.

### 3.2 Codes we must handle (`Constants` in `constants.js`)

**Commands the app sends → we must answer (`CommandCodes`):**

| Code | Command | Phase | Server behaviour |
|---:|---|:--:|---|
| 1 | `AppStart` | 0 | Reply `SelfInfo`(5) for the real node's identity |
| 5 | `GetDeviceTime` | 0 | Reply `CurrTime`(9) |
| 6 | `SetDeviceTime` | 3 | Forward to node (or no-op + `Ok`) |
| 4 | `GetContacts` | 1 | Reply `ContactsStart`(2), N×`Contact`(3), `EndOfContacts`(4) from DB |
| 10 | `SyncNextMessage` | 1 | Drain mirrored inbox: `ContactMsgRecv`(7)/`ChannelMsgRecv`(8) or `NoMoreMessages`(10) |
| 31 | `GetChannel` | 1 | Reply `ChannelInfo`(18) from DB |
| 2 | `SendTxtMsg` | 2 | Forward to node via `meshcoreManager`; reply `Sent`(6); later `SendConfirmed`(0x82) push |
| 3 | `SendChannelTxtMsg` | 2 | Forward to node; reply `Sent`(6) |
| 7 | `SendSelfAdvert` | 3 | Forward to node |
| 8 | `SetAdvertName` | 3 | Forward to node (admin-gated) |
| 11/12/38 | `SetRadioParams`/`SetTxPower`/`SetOtherParams` | 3 | Forward to node (admin-gated) |
| 20 | `GetBatteryVoltage` | 1 | Reply `BatteryVoltage`(12) from DB telemetry |
| 22 | `DeviceQuery` | 0 | Reply `DeviceInfo`(13) |
| 56 | `GetStats` | 1 | Reply `Stats`(24) from DB |
| 39/50 | `SendTelemetryReq`/`SendBinaryReq` | 2 | Forward to node; relay `TelemetryResponse`(0x8B)/`BinaryResponse`(0x8C) push |

**Responses we must *encode* (`ResponseCodes`):** `Ok`(0), `Err`(1), `ContactsStart`(2),
`Contact`(3), `EndOfContacts`(4), `SelfInfo`(5), `Sent`(6), `ContactMsgRecv`(7),
`ChannelMsgRecv`(8), `CurrTime`(9), `NoMoreMessages`(10), `BatteryVoltage`(12),
`DeviceInfo`(13), `ChannelInfo`(18), `Stats`(24).

**Pushes we must *emit* on live events (`PushCodes`):** `Advert`(0x80), `SendConfirmed`(0x82),
`MsgWaiting`(0x83), `TelemetryResponse`(0x8B), `BinaryResponse`(0x8C). `MsgWaiting` is the
key one — emitted when a new mesh message arrives for this source so the app knows to call
`SyncNextMessage`.

### 3.3 The encoding problem (the real work)

`meshcore.js` is a **client**: it *decodes* `0x3e` frames (`onFrameReceived` →
`packet.js`, `advert.js`, `buffer_reader.js`) and *encodes* `0x3c` command frames. We need
the **inverse**: encode `0x3e` responses/pushes and decode `0x3c` commands.

- **Decoders → our encoders.** Every field layout we need to *emit* is already pinned down
  by meshcore.js's *decoder* for that same struct (it has to parse what the firmware sends).
  We invert those readers using `BufferWriter` (`buffer_writer.js`) — e.g. read the
  `SelfInfo` decoder to learn the exact byte order of `{adv_type, tx_power, lat, lon,
  radio_freq, radio_bw, radio_sf, radio_cr, name, public_key}`, then write it back in the
  same order.
- **Cross-check against firmware.** Where meshcore.js is ambiguous or marked `// todo`,
  confirm against the MeshCore firmware companion serial handler (`CommandFrame` /
  `sendSelfInfo` etc.) before trusting the layout.
- We will add a small `meshcoreCompanionCodec.ts` (encode responses/pushes, decode
  commands) with unit tests that **round-trip against meshcore.js's own decoders** — i.e.
  feed our encoder output into `meshcore.js`'s parser and assert it reads back what we put
  in. That gives high-confidence fidelity without a physical device.

## 4. Proposed architecture

```
 MeshCore app (phone, WiFi)
        │  TCP  0x3c/0x3e frames
        ▼
 MeshCoreVirtualNodeServer  (NEW: src/server/meshcoreVirtualNodeServer.ts)
   • net.Server, per-client buffers, 3-byte framing
   • decode 0x3c command  ──► dispatch
        ├─ read  ► synthesize 0x3e response from DB (meshcore repos)
        └─ write ► meshcoreManager.<send/admin>()  ► real node
   • on live mesh event (meshcoreManager emits) ► 0x3e push (MsgWaiting/Advert/SendConfirmed)
        ▲
        │ uses
 meshcoreCompanionCodec.ts  (NEW: encode resp/push, decode cmd; round-trip tested)
 meshcoreManager / meshcore repositories (EXISTING: state + write path)
```

**Lifecycle & ownership.** One `MeshCoreVirtualNodeServer` per MeshCore source, owned by
that source's `meshcoreManager`, started/stopped with the source. Config lives on the
source row (`sources.config.virtualNode = { enabled, port, allowAdminCommands }`), mirroring
the Meshtastic `VirtualNodeConfig` shape so the existing source-config UI extends naturally.

**Identity.** `SelfInfo` advertises the **real node's** public key + name (already captured
by `meshcoreManager`). This is essential: the phone's contacts and any PKI the app displays
must line up with the physical node, since the real node — not the app — performs LoRa
crypto in companion mode. The app↔VN link is plaintext companion frames over local WiFi.

**Safety.** Reuse the Meshtastic VN's `allowAdminCommands` gate (default **false**). With it
off, read + send-message work, but config-mutating commands (`SetRadioParams`, `SetAdvertName`,
`ImportPrivateKey`, `Reboot`, …) are refused with `Err`(1)/`Disabled`(15). `ExportPrivateKey`(23)
is **always** refused regardless of the gate. All connects/admin-forwards are audit-logged.

## 5. Phasing (one mergeable PR per phase, behaviour-preserving, green-CI gated)

- **Phase 0 — Spike / handshake (de-risk first). ✅ IMPLEMENTED.** TCP server + framing +
  codec for `AppStart→SelfInfo`, `GetDeviceTime→CurrTime`, `DeviceQuery→DeviceInfo`,
  `GetContacts→`empty, `SyncNextMessage→NoMoreMessages`, `SetDeviceTime→Ok`, unsupported
  →`Err(UnsupportedCmd)`. Wired into `meshcoreManager` lifecycle (start after local-node
  refresh, stop on disconnect), config via `sources.config.virtualNode`
  (`meshcoreRegistry.meshcoreConfigFromSource`), and a dashboard Source-config UI (enable
  toggle + port). Encoder fidelity is unit-tested by **round-tripping through meshcore.js's
  own decoders**; the server handshake is covered by a loopback-socket integration test.
  **Exit criterion (pending hardware):** the real MeshCore app connects over WiFi and shows
  the node as connected with its correct name/identity. The automated round-trip tests give
  high confidence ahead of that manual check.
- **Phase 1 — Read-only mirror. ✅ IMPLEMENTED.** Contacts (`GetContacts`), channels
  (`GetChannel`/`ChannelInfo`), battery (`GetBatteryVoltage`), and live incoming messages
  via the `MsgWaiting`(0x83) push → `SyncNextMessage` → `ContactMsgRecv`/`ChannelMsgRecv`.
  `SetFloodScope` is acked as a no-op so the app doesn't treat it as fatal. Per-client
  message queue seeds empty (no history replay → no dupes on reconnect).
- **Phase 2 — Send path. ✅ IMPLEMENTED.** `SendChannelTxtMsg`/`SendTxtMsg` forwarded
  through `meshcoreManager.sendMessage`; DM prefixes resolved to full keys via the contact
  list.
- **Phase 3 — Admin/config + DM receipts. ✅ IMPLEMENTED.** Admin-gated config commands
  (`SetRadioParams`, `SetAdvertName`, `SetTxPower`, `SetAdvertLatLon`, `SetChannel`,
  `SetOtherParams`) are forwarded to the real node when the source's **Allow admin commands**
  flag is on (else `Err(UnsupportedCmd)`) — #3904/#3906/#3907. DM delivery receipts relay the
  node's real `expectedAckCrc` so the `SendConfirmed`(0x82) push is correlated and the app
  shows the delivered tick — #3869.
- **Phase 4 — Remote transactions + raw feed. ✅ IMPLEMENTED.** The remaining app-initiated
  commands are relayed with the `Sent`→async-push handshake: `SendSelfAdvert` (ack `Ok`,
  #3959); `SendLogin`→`LoginSuccess`(0x85), `SendTracePath`→`TraceData`(0x89),
  `SendTelemetryReq`→`TelemetryResponse`(0x8B) (#3961, correlated by the remote's 6-byte
  pubkey prefix or the app's own trace tag); and the node's raw RX feed bridged to apps as a
  `LogRxData`(0x88) push (#3964). Login/trace/telemetry/advert are **not** gated on
  `allowAdminCommands` — a real node accepts them unconditionally; only config *writes* are gated.
- **Phase 5 — CLI relay for remote-admin. ✅ IMPLEMENTED (#4106).** `SendTxtMsg` with
  `txtType=CliData` (the app issuing a CLI command to a node it logged into via `SendLogin`,
  #4094) is a **different wire operation from a plain chat DM** despite sharing command code 2 —
  it must go out with `txt_type=CliData` so the remote's `CommonCLI` handles it, not the chat
  handler. Routed to `meshcoreManager.sendCliCommand` (the same primitive the remote-admin CLI
  console uses, see `MESHCORE_REMOTE_ADMIN.md`) instead of `sendMessageWithResult`; the reply is
  queued through the normal `MsgWaiting`→`SyncNextMessage` path, tagged `txtType=CliData` on the
  way back out so the app renders it as a CLI reply. Gated on `allowAdminCommands` like the other
  config-mutating commands, since CLI text can include `set`/`reboot`/`setperm`. The effective
  reply-timeout honors the operator's `meshcoreCliTimeoutSeconds` setting (#4027) — the same
  setting the remote-admin console routes respect — and the resolved value is passed to **both**
  the `Sent` estimate and `sendCliCommand`, so a distant multi-hop repeater's reply isn't cut off
  at the 15s default the app was told to wait.

### Protocol subtleties found in testing (don't regress these)
- **Channel send acks `Ok`, DM send acks `Sent`.** meshcore.js's `sendChannelTextMessage`
  awaits `Ok`(0) (fire-and-forget broadcast); `sendTextMessage` (DM) awaits `Sent`(6) (carries
  the ack CRC). Replying `Sent` to a channel send hangs the app's send promise forever.
- **The `channel-N` marker moves fields by direction.** `meshcoreManager` tags channel
  messages with the synthetic `channel-N` key in `toPublicKey` for messages we *sent* but in
  `fromPublicKey` for messages we *received* (`toPublicKey` unset on RX). Detect it in both
  fields, or incoming channel replies get mis-encoded as a `ContactMsgRecv` and dropped.
- **`SendTxtMsg`'s `txtType` byte selects the wire operation, not just metadata.** Code 2
  covers both a plain chat DM (`txtType=Plain`) and a CLI/admin command to a logged-in node
  (`txtType=CliData`) — same frame shape, different handling entirely (#4106). Ignoring the
  byte and always treating it as chat means the remote's CLI handler never sees the command
  and the app times out waiting for a reply that will never come.

## 6. Key risks & how the plan retires them

| Risk | Mitigation |
|---|---|
| **Encoder byte-fidelity** (firmware expects exact layout) | Invert meshcore.js decoders; **round-trip unit tests** through meshcore.js's own parser; Phase-0 spike against a real app before building further |
| **Companion protocol version** (`SupportedCompanionProtocolVersion = 1`) | `SelfInfo`/`DeviceInfo` advertise v1; pin and assert in tests; revisit if app negotiates higher |
| **Slot exclusivity** (one companion slot) | Non-issue by design — we synthesize from DB, never passthrough; the real slot stays held by `meshcoreManager` |
| **`// todo` gaps in meshcore.js** (`SendLogin`, `SendStatusReq`, tuning) | Cross-check firmware source for those layouts; defer non-essential commands, answer `UnsupportedCmd`(1) until implemented |
| **Crypto / key exposure** | App↔VN is plaintext local WiFi; node does LoRa crypto. Never expose `ExportPrivateKey`; bind server to a configurable interface; document the trust boundary |
| **Multi-source bleed** | Server is per-source; every DB read scoped by `sourceId` (project invariant) |

## 7. New / touched files (estimate)

- **New:** `src/server/meshcoreVirtualNodeServer.ts`, `src/server/meshcoreCompanionCodec.ts`,
  `*.test.ts` for both (incl. round-trip-vs-meshcore.js tests).
- **Touched:** `meshcoreManager.ts` (own/start/stop server, emit live events, expose
  send/admin entry points), source-config schema + UI for `virtualNode`, `docs/features/meshcore.md`.
- **Reference, not reused:** `src/server/virtualNodeServer.ts` (Meshtastic) — structural template.

## 8. Open questions to confirm before Phase 1

1. Which app build/version is the target, and does it pin companion protocol v1?
2. Default port — reuse MeshCore's conventional companion TCP port (4403) or a distinct
   MeshMonitor port to avoid colliding with a node also exposed on the LAN?
3. Telemetry/binary-request relay: does the app tolerate VN synthesizing telemetry from DB,
   or must those always round-trip to the live node? (Phase 2 forwards; Phase 1 may synth.)
```
