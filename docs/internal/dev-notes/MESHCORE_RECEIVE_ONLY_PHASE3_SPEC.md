# MeshCore Strict Receive-Only Mode — Phase 3 Spec

**Epic issue:** #4547 · **Epic plan:** `MESHCORE_RECEIVE_ONLY_EPIC.md`
**Branch:** `feature/meshcore-receive-only-vn` · **Worktree:** `/home/yeraze/Development/meshmonitor-mc-rxonly-p3`
**Depends on:** Phase 1 (`c41428e6`) and Phase 2 (`d818768f`), both on `origin/main`.

Phase 3 closes the last transmit path (the Virtual Node TCP port) and ships the
documentation. Two independent halves:

- **Part A** — refuse the 9 TX-causing Virtual Node companion commands.
- **Part B** — user doc, sidebar, cross-links, API docs, i18n audit.

All line numbers below were re-verified against the current worktree on 2026-08-04.
The epic's Phase-3 inventory (`MESHCORE_RECEIVE_ONLY_EPIC.md:230-236`) proved
accurate — no drift.

---

## 1. Reuse inventory (read this before writing anything)

Everything Phase 3 needs already exists. The only genuinely new artifacts are one
private helper method, one interface method, and one docs page.

### 1.1 Receive-only state

| Mechanism | Location | Phase 3 use |
|---|---|---|
| `MeshCoreManager.isReceiveOnly(): boolean` | `src/server/meshcoreManager.ts:3989` | **The** state read. Sync, cached, no DB hit. |
| `MeshCoreManager.canTransmit(): boolean` | `meshcoreManager.ts:3998` | Inverse of the above; routes use `isReceiveOnly()`, so the VN matches routes. |
| `setReceiveOnly()` / `refreshReceiveOnly()` | `meshcoreManager.ts:4007`, `:4023` | Already keeps the cache fresh on settings write and on `connect()` (`:1207`). Phase 3 adds nothing here. |
| `MESHCORE_RECEIVE_ONLY_MESSAGE` | `src/server/constants/meshcoreTx.ts:58` | Not used on the wire (companion protocol carries no error string) — but referenced in log lines so grep finds every refusal site. |
| `TxDisabledError` / `isTxDisabledError()` | `src/server/errors/txDisabledError.ts` | **Not** newly consumed by the VN. See §2.6 for why the pre-check does not rely on the downstream throw. |

### 1.2 Route-layer refusal idiom being mirrored

`src/server/routes/meshcoreRouteShared.ts`:

- `requireMeshcoreTx()` (`:79`) — middleware, fails **closed** when the manager is missing.
- `rejectIfReceiveOnly(req, res): boolean` (`:100`) — inline guard, **returns `true` when it has
  already written the response.**
- `failIfTxDisabled(res, error): boolean` (`:113`) — catch-block mapping.

Phase 3's VN helper (`§2.3`) is the transport-shifted twin of `rejectIfReceiveOnly`: same name
shape, same boolean-means-already-replied contract, same fail-closed posture. Reviewers should be
able to read one and recognise the other.

### 1.3 Virtual Node server — existing primitives (all reused, none replaced)

`src/server/meshcoreVirtualNodeServer.ts`:

| Primitive | Line | Note |
|---|---|---|
| `MeshCoreVirtualNodeManager` interface | `:68` | Deliberately narrow so the server is testable with a fake. Phase 3 widens it by exactly one method. |
| `send(clientId, payload)` | `:1437` | The single socket-write path. Frames via `frameNodeToApp`. Never bypass it. |
| `encodeErr(errCode?)` | `meshcoreCompanionCodec.ts:997` | `[0x01][errCode]`. |
| `ErrorCodes` | `meshcoreCompanionCodec.ts:127` | `UnsupportedCmd:1, NotFound:2, TableFull:3, BadState:4, FileIoError:5, IllegalArg:6`. |
| `encodeDisabled()` | `meshcoreCompanionCodec.ts:992` | `Disabled(15)`. **Rejected** for this phase — see §2.2. |
| `COMMAND_NAMES` reverse map | `:192` | Human-readable command name for the refusal log line. Already used by `handleConfigCommand:726`. |
| `handleConfigCommand`'s `allowAdminCommands` refusal | `:727-733` | The precedent for a policy refusal on this port: `logger.debug(...)` + `Err`. Phase 3 copies the shape exactly. |
| `handleExportPrivateKey`'s `allowPkiExport` refusal | `:650-656` | The *other* precedent — and the one case that correctly uses `Disabled(15)`. §2.2 explains why it is the exception, not the rule. |

### 1.4 Test harness — existing, reused as-is

`src/server/meshcoreVirtualNodeServer.test.ts` (1,500+ lines, 12 describe blocks):

| Harness piece | Line | Phase 3 use |
|---|---|---|
| `FakeManager implements MeshCoreVirtualNodeManager` | `:61` | Gains one method + one mock (§3.1). |
| `makeManager(overrides)` | `:179` | `makeManager({ isReceiveOnly: () => true })` is the whole per-test setup. |
| `TestClient` (`request`, `expectFrames`, `send`, `close`) | `:198` | Byte-level frame assertions over a real socket. |
| `frameCommand(payload)` | `:187` | Builds app→node frames. |
| Real `meshcore.js` decoder driven directly (`conn.onFrameReceived`) | `:277-283` | The existing pattern for "prove a real client parses our frame". Phase 3 reuses it — see §3.4 for the no-`any` variant. |
| `vi.mock('../services/database.js')` stub | `:24-29` | Already stubs `auditLogAsync` + `settings.getSetting`. No change needed. |

**Decision: new tests go in the existing file, not a new one.** The sibling Meshtastic VN tests
(`virtualNodeServer.*.test.ts`) each build their own harness, but that harness is ~180 lines here
and `FakeManager` must be edited in this file regardless. A separate file would either duplicate
the harness or export it. One new `describe` block, zero duplication.

### 1.5 Docs surfaces

| Surface | Location | Phase 3 action |
|---|---|---|
| VitePress sidebar | `docs/.vitepress/config.mts` — `Protocol-Specific` group at `:152-160` (`text:` at `:153`, items at `:155-158`) | Add one entry. |
| Meshtastic analogue page | `docs/features/receive-only-mode.md` (91 lines) | Model for structure **and** contains a now-false claim to fix (`:65`). |
| MeshCore feature page | `docs/features/meshcore.md` (583 lines) | Cross-link + a short section. |
| MeshCore VN docs | `docs/configuration/virtual-node.md` — `## MeshCore Virtual Node` at `:434`, `### What works` at `:452`, `### Safety: admin commands` at `:501` | Add a sibling safety subsection. |
| API shared 409 block | `docs/api/REST_API.md:104-118` and `docs/api/API_REFERENCE.md:1104-1118` | Extend to MeshCore. |
| `POST /api/settings` | `docs/api/API_REFERENCE.md:698` | Document `400 INVALID_BOOLEAN_SETTING`. |
| `docs/api/API.md` | `:3-10` carries an explicit "This document is outdated" warning | **Leave alone** (same call the Meshtastic TX-disabled epic made). |
| Locales | `public/locales/en.json` — 13 `meshcore.receive_only.*` keys at `:5160-5172`, `banners.receive_only_meshcore` at `:115` | Verified present. Non-English is Weblate-managed — see §5.4. |

**Nothing new is proposed that an existing mechanism covers.** The three new things and why:

1. `MeshCoreVirtualNodeManager.isReceiveOnly()` — the VN's manager interface is intentionally
   narrow and does not currently expose it. No alternative: the server has no other handle on the
   manager.
2. `MeshCoreVirtualNodeServer.refuseIfReceiveOnly()` — the route-layer helper takes
   `(req, res)`; the VN speaks `(clientId, commandName)` over a socket. Not shareable.
3. `docs/features/meshcore-receive-only.md` — the epic mandates a user doc; the Meshtastic page
   documents a firmware kill switch and would be actively misleading if reused.

---

## 2. Part A design — what "refuse" looks like on the wire

This is the crux of the phase. The conclusions below are derived from
`node_modules/@liamcottle/meshcore.js@1.13.0/src/connection/connection.js`, which is both the
library MeshMonitor itself uses and the reference implementation of the companion protocol client.

### 2.1 What actually happens today (receive-only ON, no Phase 3)

Every VN handler is already inside a `try/catch` (WP2's Phase 1 audit was right about that), and
Phase 1 made every manager method these handlers call throw `TxDisabledError`. But the catch
blocks fall into **two different shapes**, and only one of them is safe:

| # | Command | Handler | Manager method (Phase 1 guard) | Today's reply | Client-visible result |
|---|---|---|---|---|---|
| 1 | `SendChannelTxtMsg` | `:1143` | `sendMessage` (`mgr:3072`) | `Err(BadState)` | ✅ promise rejects immediately |
| 2 | `SendTxtMsg` (Plain) | `:1172` | `sendMessageWithResult` (`mgr:3083`) | `Err(BadState)` | ✅ promise rejects immediately |
| 4 | `SendSelfAdvert` | `:768` | `sendAdvert` (`mgr:3669`) | `Err(BadState)` | ✅ promise rejects immediately |
| 3 | `SendTxtMsg` (CliData) → `handleSendCliTxtMsg` | `:1264` | `sendCliCommand` (`mgr:5185`) | `Sent(6)` at `:1272`, then **silence** | ❌ hangs to the app's own timeout |
| 5 | `SendLogin` | `:803` | `loginToNode` (`mgr:4787`) | `Sent(6)` at `:814`, then **silence** | ❌ hangs ~12 s → `reject("timeout")` |
| 6 | `SendTracePath` | `:846` | `tracePathRaw` (`mgr:4171`) | `Sent(6)` at `:855`, then **silence** | ❌ hangs ~30 s |
| 7 | `SendTelemetryReq` | `:882` | `requestRemoteTelemetryRaw` (`mgr:5725`) | `Sent(6)` at `:892`, then **silence** | ❌ hangs ~30 s |
| 8 | `SendStatusReq` | `:927` | `requestNodeStatus` (`mgr:4825`) | `Sent(6)` at `:937`, then **silence** | ❌ hangs ~30 s |
| 9 | `SendBinaryReq` → `handleGetNeighboursReq` | `:963` / `:1005` | `getNeighbours` (`mgr:4667`) | `Sent(6)` at `:1017`, then **silence** | ❌ hangs ~30 s |

So the honest current state is: **nothing transmits, but 6 of 9 commands leave the client waiting
out a timeout.** No frame is malformed and no desync occurs — but "hangs for 30 seconds" is not a
refusal, and the epic's exit criterion is a client that is *told* it cannot transmit.

### 2.2 The refusal frame: `Err(1)` with `ErrorCodes.BadState(4)`

**Evidence for `Err` over `Disabled`.** `connection.js:349-425` (`onFrameReceived`) routes each
response code to a handler that re-emits it as an event. Every command wrapper then registers
listeners for the codes it cares about:

- `sendTextMessage` (`:1047-1048`): `once(Sent)`, `once(Err)`.
- `sendChannelTextMessage` (`:1083-1084`): `once(Ok)`, `once(Err)`.
- `sendAdvert` (`:835-836`): `once(Ok)`, `once(Err)`.
- `login` (`:1682-1684`): `once(Err)`, `once(Sent)`, `once(LoginSuccess)`.
- `tracePath` (`:2414-2416`): `once(Sent)`, `on(TraceData)`, `once(Err)`.
- `getStatus` / `getTelemetry` / `sendBinaryRequest`: same three-listener shape.
- `exportPrivateKey` (`:1574-1576`): `once(PrivateKey)`, `once(Err)`, **`once(Disabled)`**.

`Disabled(15)` is listened for by **exactly one** wrapper — `exportPrivateKey`. Reply `Disabled`
to any of the 9 and the client emits an event with no listener; the promise never settles. Worse,
`sendTextMessage`, `sendChannelTextMessage` and `sendAdvert` have **no timeout of any kind**, so
those three would hang *forever*, not merely for the est-timeout. `Err` is the only refusal every
wrapper terminates on. `Disabled` stays where it belongs: `handleExportPrivateKey:654`.

**Evidence for `BadState(4)` over `UnsupportedCmd(1)`.** `onErrResponse` (`:556-561`) reads the
optional code byte and emits `{ errCode }`, but every `onErr` handler in the library is
`() => reject()` — the code is informational for meshcore.js and rendered (at most) by richer apps
such as meshcore-flutter. Three arguments settle it:

1. **Semantics.** `UnsupportedCmd` means "this device does not implement that command" — a
   capability statement an app may reasonably cache and use to hide a feature permanently.
   Receive-only is a *runtime state* that an operator flips off at will. `BadState` means "the
   device cannot do that right now", which is exactly true.
2. **Zero-delta on 3 handlers.** Commands 1, 2 and 4 already emit `Err(BadState)` today via their
   catch blocks. Choosing `BadState` makes the Phase 3 pre-check **byte-identical** to current
   behaviour for those three — the change is purely *when* the frame is written, not what it says.
   No app that works today can regress on them.
3. **Repo consistency.** `Err(BadState)` is already this file's "the node would not / could not do
   it" answer (`:750`, `:757`, `:773`, `:780`, `:1157`, `:1203`). `Err(UnsupportedCmd)` is reserved
   for "this port does not offer that command at all" (`:619` unknown command, `:731`
   admin-disabled, `:980` unknown binary sub-type). Receive-only is the former.

**Framing safety.** `encodeErr(ErrorCodes.BadState)` produces a 2-byte payload, written through
`send()` → `frameNodeToApp` → `[0x3e][0x02 0x00][0x01 0x04]`. The node→app framing is
length-prefixed and every payload is self-delimiting, so a refusal cannot desync a client's parser
regardless of what it was expecting. Exactly one frame is written per refused command.

### 2.3 The guard must run **before** the `Sent` frame

This is the structural reason an explicit pre-check is required and relying on the downstream
`TxDisabledError` throw is not merely untidy but *incapable* of working:

```js
// connection.js:1638-1641  (login)          // connection.js:2370-2373 (tracePath)
const onSent = (response) => {
    // remove error listener since we received sent response
    this.off(Constants.ResponseCodes.Err, onErr);
    …arm setTimeout(estTimeout)…
}
```

The client **tears down its `Err` listener the moment `Sent` arrives.** An `Err` written after the
`Sent` is emitted into the void. `getStatus`, `getTelemetry` and `sendBinaryRequest` follow the
identical pattern. Therefore:

> **Invariant (test-enforced):** for a refused command, the `Err` frame must be the **first and
> only** frame the server writes. No `Sent` may precede it.

Since the 6 Sent-first handlers write `Sent` *before* awaiting the manager, the throw physically
cannot be converted into a client-visible refusal at the catch site. The pre-check is not a
stylistic preference.

### 2.4 Placement: 8 call sites covering 9 commands

`handleSendCliTxtMsg` (`:1264`) is `private` and has exactly **one** caller —
`handleSendTxtMsg:1183`. A guard at the top of `handleSendTxtMsg` therefore covers both the Plain
DM and the CliData relay. Adding a second guard inside `handleSendCliTxtMsg` would be unreachable
code. Do not add it; add a one-line comment pointing at the caller's guard instead.

Guard sites, in file order:

| Handler | Insert immediately after the opening brace at | Command name for the log |
|---|---|---|
| `handleSendSelfAdvert` | `:768` (before the `try` at `:769`) | `SendSelfAdvert` |
| `handleSendLogin` | `:803` (before `let parsed;` at `:804`) | `SendLogin` |
| `handleSendTracePath` | `:846` (before `:847`) | `SendTracePath` |
| `handleSendTelemetryReq` | `:882` (before `:883`) | `SendTelemetryReq` |
| `handleSendStatusReq` | `:927` (before `:928`) | `SendStatusReq` |
| `handleSendBinaryReq` | `:963` (before `let parsed:` at `:964`) | `SendBinaryReq` |
| `handleSendChannelTxtMsg` | `:1143` (before `:1144`) | `SendChannelTxtMsg` |
| `handleSendTxtMsg` | `:1172` (before `:1173`) | `SendTxtMsg` |

**Guard-first ordering, deliberately.** Each guard runs *before* payload parsing and before
`resolveContactKey`. Consequences, all intended:

- A malformed payload on a refused command yields `Err(BadState)` rather than `Err(IllegalArg)`.
  The receive-only state is the more relevant fact, and both are `Err`.
- `SendTxtMsg` to an unknown contact prefix yields `Err(BadState)` rather than `Err(NotFound)`.
- `SendBinaryReq` is refused for **all** sub-types, including ones added later. Guarding after the
  sub-type dispatch would leave a future RF sub-type unguarded; guarding the envelope cannot.
- No parser runs on input from a client that is not permitted to act. Small hardening win.

### 2.5 The helper

Insert after `auditPkiExport()` (which ends at `:706`), before the `handleConfigCommand` JSDoc at
`:708`, so the three policy gates on this port — receive-only, `allowAdminCommands`, `allowPkiExport`
— sit together.

```ts
  /**
   * Receive-only refusal for the 9 TX-causing companion commands (#4547 Phase 3).
   * Returns true when it has ALREADY replied and the caller must return —
   * same contract as `rejectIfReceiveOnly()` in routes/meshcoreRouteShared.ts.
   *
   * MUST be called before the handler writes anything, in particular before the
   * `Sent(6)` that six of these handlers emit up front: meshcore.js drops its
   * `Err` listener the instant `Sent` arrives (connection.js:1641, :2373), so an
   * error written afterwards is silently discarded and the client waits out its
   * estimated timeout instead.
   *
   * Replies Err(BadState) — the only refusal every meshcore.js command wrapper
   * terminates on. Disabled(15) is listened for by exportPrivateKey() alone
   * (connection.js:1576) and would hang the untimed send/advert promises forever.
   *
   * Fails CLOSED: a manager that cannot answer is treated as receive-only, in
   * line with `isRfBridgeCommand()`'s fail-closed default (constants/meshcoreTx.ts).
   *
   * Logged at debug, matching the sibling `allowAdminCommands` refusal — a
   * companion app retries sends on its own schedule, so an info-level line here
   * would be a log flood. The operator-facing signal is the single state-change
   * info line from `MeshCoreManager.setReceiveOnly()`.
   */
  private refuseIfReceiveOnly(clientId: string, commandName: string): boolean {
    let receiveOnly: boolean;
    try {
      receiveOnly = this.options.manager.isReceiveOnly() !== false;
    } catch (err) {
      logger.warn(
        `[MeshCore VN ${this.sourceId}] receive-only check threw, refusing ${commandName}: ${(err as Error).message}`,
      );
      receiveOnly = true;
    }
    if (!receiveOnly) return false;
    logger.debug(
      `[MeshCore VN ${this.sourceId}] ${commandName} refused from ${clientId} (receive-only mode)`,
    );
    this.send(clientId, encodeErr(ErrorCodes.BadState));
    return true;
  }
```

`!== false` rather than `=== true` is the fail-closed shape: a manager that returns `undefined`
(an incomplete double, a stale build) blocks rather than transmits.

Call shape at each site:

```ts
    if (this.refuseIfReceiveOnly(clientId, 'SendTracePath')) return;
```

### 2.6 What is *not* changed, and why

- **The 6 `catch` blocks stay as they are.** If receive-only is flipped ON between the pre-check
  and the `await`, the manager still throws `TxDisabledError`, the catch logs a warning, and the
  client times out. Nothing transmits; the window is microseconds; adding a second refusal path
  after `Sent` cannot help because the client is no longer listening for `Err`. Documented as an
  accepted residual rather than engineered around.
- **`SetFloodScope` (`:531-535`) is untouched.** It replies `Ok` without applying and never
  transmits. Its inline comment warns that an `Err` here can be treated as a fatal handshake
  failure — a good reason not to widen the refusal surface beyond the 9.
- **Every read path is untouched:** `AppStart`, `DeviceQuery`, `GetContacts`, `GetChannel`,
  `GetBatteryVoltage`, `GetDeviceTime`, `SetDeviceTime`, `SyncNextMessage`, `ExportPrivateKey`,
  and all six `Set*` config commands (interview decision 2 explicitly allows local serial config,
  including `SetTxPower`). The live pushes — `MsgWaiting`, `ContactMsgRecv`/`ChannelMsgRecv`,
  `LogRxData(0x88)` OTA feed, `SendConfirmed` — all keep flowing.
- **The command surface is closed by construction.** `dispatchCommand`'s `default` branch (`:617-620`)
  answers every unhandled code with `Err(UnsupportedCmd)`. `ResetPath`, `ShareContact`,
  `SendRawData`, `AddUpdateContact`, `ImportContact`, `Reboot`, `GetStats` and the signing commands
  are not in the switch and are already refused. The 9 guarded handlers are the complete TX surface
  — and §3.5's inventory test keeps it that way.

### 2.7 Interface change

`MeshCoreVirtualNodeManager` (`:68`) gains, after `getContacts()` at `:72`:

```ts
  /**
   * True when this source is configured strictly receive-only (#4547). Sync and
   * cached on the manager — no DB read on the command path. The server refuses
   * the 9 TX-causing companion commands while this is true.
   */
  isReceiveOnly(): boolean;
```

`MeshCoreManager` already implements it (`meshcoreManager.ts:3989`) and is passed as
`manager: this` (`meshcoreManager.ts:1362`), so the production wiring needs **no** change. The
method is **required, not optional** — an optional method would default to "allowed", which is
fail-open and unacceptable for a safety gate. The only fallout is the test `FakeManager` (§3.1).

---

## 3. Part A test plan

All standard Vitest. All additions go in `src/server/meshcoreVirtualNodeServer.test.ts`.

### 3.1 Harness changes

`FakeManager` (`:61`) gains:

```ts
  receiveOnlyMock = vi.fn().mockReturnValue(false);
  isReceiveOnly() { return this.receiveOnlyMock() as boolean; }
```

Default `false` keeps all 12 existing describe blocks green unmodified — verify that before
writing new tests. Per-test override: `makeManager({ isReceiveOnly: () => true })`.

### 3.2 Refusal tests — one per command (9 tests)

New block: `describe('MeshCoreVirtualNodeServer — receive-only mode (#4547)', …)`, server built
with `makeManager({ isReceiveOnly: () => true })` and `allowAdminCommands: true` (so the CLI test
proves receive-only wins over an *enabled* admin flag, not that admin-off happened to block it).

For each of the 9, assert **all three**:

1. `payload[0] === ResponseCodes.Err` and `payload[1] === ErrorCodes.BadState`.
2. The frame is the **first** frame written — i.e. `client.request(...)` resolves with the `Err`,
   never with a `Sent`. This is the §2.3 invariant and the single most important assertion in the
   phase; a guard mistakenly placed after `encodeSent` passes assertion 1 and fails this one.
3. The corresponding manager mock was **not called** (`expect(manager.sendAdvertMock).not.toHaveBeenCalled()`).

| Test | Command frame | Mock asserted un-called |
|---|---|---|
| refuses SendChannelTxtMsg | `SendChannelTxtMsg` | `sendMessageMock` |
| refuses SendTxtMsg (Plain DM) | `SendTxtMsg`, `txtType=Plain`, known contact prefix | `sendMessageWithResultMock` |
| refuses SendTxtMsg (CliData / CLI relay) | `SendTxtMsg`, `txtType=CliData`, known prefix, `allowAdminCommands: true` | `sendCliCommandMock` |
| refuses SendSelfAdvert | `SendSelfAdvert` | `sendAdvertMock` |
| refuses SendLogin | `SendLogin` + 32-byte key + password | `loginToNodeMock` |
| refuses SendTracePath | `SendTracePath` + tag/auth/path | `tracePathRawMock` |
| refuses SendTelemetryReq | `SendTelemetryReq` + 32-byte key | `requestRemoteTelemetryRawMock` |
| refuses SendStatusReq | `SendStatusReq` + 32-byte key | `requestNodeStatusMock` |
| refuses SendBinaryReq/GetNeighbours | `SendBinaryReq` + key + `GetNeighbours` blob | `getNeighboursMock` |

Reuse the exact frame builders the existing per-command describe blocks already use (`:753`,
`:874`, `:938`, `:998`, `:1098`, `:1263`) — do not re-derive the byte layouts.

Plus two edge tests:

- **`SendBinaryReq` with an unknown sub-type is still refused as `BadState`, not `UnsupportedCmd`** —
  proves the envelope-level guard (§2.4) covers future sub-types.
- **`SendTxtMsg` to an unknown contact prefix returns `BadState`, not `NotFound`** — pins the
  documented guard-first ordering so a later "fix" that moves the guard below `resolveContactKey`
  is caught.

### 3.3 Read-path regression test (the "VN stays up" guarantee)

One test, same receive-only server, walking a full app session and asserting each read still works:

- `AppStart` → `SelfInfo` (not `Err`)
- `DeviceQuery` → `DeviceInfo`
- `GetDeviceTime` → `CurrTime`; `SetDeviceTime` → `Ok`
- `GetContacts` → `ContactsStart` / `Contact` / `EndOfContacts`
- `GetChannel(0)` → `ChannelInfo`
- `GetBatteryVoltage` → `BatteryVoltage`
- `SyncNextMessage` → `NoMoreMessages`
- `SetFloodScope` → `Ok`
- one `Set*` config command with `allowAdminCommands: true` → `Ok` (local serial config stays
  allowed per interview decision 2)
- `ExportPrivateKey` with `allowPkiExport: true` → `PrivateKey(14)`

Plus a live-push test: `manager.emitMessage(...)` still produces `MsgWaiting`, and
`manager.emitOtaPacket(...)` still produces `LogRxData(0x88)`, while receive-only is ON.

### 3.4 Wire-shape test with the real meshcore.js decoder

Mirrors the existing `:277-283` pattern but **without `any`** (`@typescript-eslint/no-explicit-any`
is an error and this file must not grow its baseline count):

```ts
interface DecoderLike {
  once(code: number, cb: (event: { errCode?: number }) => void): void;
  onFrameReceived(frame: Uint8Array): void;
}
const conn = new (Connection as unknown as new () => DecoderLike)();
```

Assert that feeding the refusal payload into a real `Connection` emits `ResponseCodes.Err` with
`errCode === ErrorCodes.BadState` — i.e. a real client parses the refusal through its normal
dispatch rather than hitting `onFrameReceived`'s `console.log("unhandled frame")` fallback
(`connection.js:424`).

### 3.5 Inventory test — the future-proofing guard

The analogue of Phase 1's denylist-coverage test. With receive-only ON, iterate
`Object.values(CommandCodes)`, send each as a bare one-byte frame, then assert that **none** of the
TX-capable manager mocks was called:

```
sendMessageMock, sendMessageWithResultMock, sendAdvertMock, loginToNodeMock,
tracePathRawMock, requestRemoteTelemetryRawMock, requestNodeStatusMock,
getNeighboursMock, sendCliCommandMock
```

Bare frames make most handlers reply `Err(IllegalArg)` on parse — that is fine and irrelevant; the
assertion is only "no TX method was reached". A new VN handler that transmits without a guard fails
this test the day it lands. Give it a comment saying so.

### 3.6 Receive-only OFF regression

The 12 existing describe blocks already cover the happy paths with the default `false`. Add one
explicit test that flips the flag at runtime — `receiveOnlyMock.mockReturnValue(true)`, assert a
`SendSelfAdvert` refusal, then `mockReturnValue(false)` and assert the same command now reaches
`sendAdvertMock` and replies `Ok`. This proves the guard reads live state and is not latched
(the Phase 2 latch hazard, in the VN's shape).

### 3.7 Fail-closed test

`makeManager({ isReceiveOnly: () => { throw new Error('boom'); } })` → `SendSelfAdvert` still gets
`Err(BadState)` and `sendAdvertMock` is not called.

---

## 4. Part B — documentation

### 4.1 New page: `docs/features/meshcore-receive-only.md`

Modeled on `docs/features/receive-only-mode.md` but **must not** copy its central claim — the
Meshtastic page says "It isn't a MeshMonitor-side restriction"; here the opposite is true and that
is the single most important thing on the page.

Required structure:

```
# MeshCore Receive-Only Mode

::: tip Added in 4.14 (#4547)
[one-sentence framing: per-source strict receive-only for MeshCore sources]
:::

::: danger MeshCore firmware has no transmit kill switch
[THE limitation, stated first, in plain words — see 4.2]
:::

## What it is
## What still works
## What is blocked
## Virtual Node access
## How to enable / disable it
## API behaviour
## Related
```

Content requirements per section:

- **What it is** — per-source setting `meshcoreReceiveOnly`, applies to *all* MeshCore source
  types (Companion and Repeater — interview decision 4), enforced across HTTP routes, schedulers,
  automations and the Virtual Node port.
- **What still works** — receiving and decoding; the packet log; the Analyzer Observer; contact,
  telemetry and route updates; local serial configuration (name, radio params, TX power, coords,
  channel CRUD, RTC sync, device query, reboot, contact import/export); read-only Virtual Node
  access; the local UART CLI except the `advert` verb.
- **What is blocked** — channel messages and DMs, self-adverts, remote CLI/admin, logins, path
  discovery and traceroute, telemetry and status requests, neighbour queries, node discovery,
  ANON_REQ, share-contact, discovery auto-responses, room posts, and every scheduler/automation
  that transmits (auto-pathfinding, auto-announce, timer triggers, auto-responder, auto-acknowledge,
  remote-telemetry and room-sync schedulers). State explicitly that automation **settings are
  preserved untouched** and resume exactly as configured when receive-only is turned off
  (interview decision 5) — with a "Paused — receive-only mode" note in the UI.
- **Virtual Node access** — the VN port stays up and serves reads (contacts, channels, message
  sync, device info, battery, time, config setters, PKI export where enabled) plus the live OTA
  packet feed. The 9 transmit commands are refused with a companion-protocol error, so a
  third-party MeshCore client sees a clean failure instead of a silent drop. Name the 9. State that
  this closes the last transmit path, since the VN port bypasses the HTTP API entirely.
- **How to enable / disable it** — MeshCore Settings → Receive-only mode. Note the confirmation
  dialog on **disable** (turning transmission back on) and that the change takes effect immediately
  without a reload.
- **API behaviour** — `409` with `code: "TX_DISABLED"` on the MeshCore transmit routes; the exact
  message string; a pointer to the API reference. Mention that two of them are `GET`
  (`GET /contacts/:pk/neighbours`, `GET /admin/status/:pk`) since that surprises people.

### 4.2 The firmware limitation — required wording constraints

Must appear **above the fold**, in a `::: danger` block, and must state, in short words:

1. MeshCore firmware exposes **no** radio-level transmit kill switch. Verified against
   `@liamcottle/meshcore.js` v1.13.0: the full `CommandCodes` set has no `txEnabled`, `disableTx`
   or `radioOff` equivalent; `SetTxPower(12)` lowers power but never stops transmission;
   `SetOtherParams(38)` carries only manual-add-contacts, telemetry modes and advert-location policy.
2. MeshMonitor therefore enforces receive-only **in software only**.
3. It **cannot** stop transmissions the node makes on its own, specifically:
   - link-layer acknowledgements, and
   - any advert schedule configured on the device outside MeshMonitor.
4. Anyone deploying this for a **regulatory or site-policy** reason must not treat it as a
   guarantee that the radio is silent. Contrast it, in one sentence, with the Meshtastic
   `lora.txEnabled` mode, which *is* a firmware kill switch — and link to that page.

Do not soften this into "may not stop". Do not bury it under "What it is".

### 4.3 Sidebar

`docs/.vitepress/config.mts`, `Protocol-Specific` group items (`:155-158`):

```ts
            { text: 'MeshCore', link: '/features/meshcore' },
            { text: 'MeshCore Receive-Only Mode', link: '/features/meshcore-receive-only' },
            { text: 'MeshCore Analyzer Observer', link: '/features/meshcore-analyzer-observer' }
```

### 4.4 Cross-links (4 files)

1. **`docs/features/receive-only-mode.md:65` — a factual correction, not a link.** It currently
   reads: *"**Not gated:** … and MeshCore sources (a different protocol with no equivalent flag)."*
   That has been false since Phase 1. Rewrite to point at the new page, e.g. *"MeshCore sources
   have their own equivalent — see [MeshCore Receive-Only Mode](/features/meshcore-receive-only) —
   enforced in software, because MeshCore firmware has no transmit kill switch."* Also add the page
   to that file's `## Related` list (`:86-91`).
2. **`docs/features/meshcore.md`** — add a short `## Receive-Only Mode` section (4-6 lines +
   the link). Place it near `## Radio Configuration` (`:521`) or `## Permissions` (`:502`);
   implementer's judgement, but it must be findable from the page's heading list.
3. **`docs/configuration/virtual-node.md`** — add `### Safety: receive-only mode` immediately after
   `### Safety: admin commands` (`:501`), inside the `## MeshCore Virtual Node` section (`:434`).
   Explain that when the source is receive-only, the VN keeps serving reads and the live packet
   feed while the 9 transmit commands are refused, and that this is independent of the
   `allowAdminCommands` and `allowPkiExport` toggles. Also add one line to `### What works` (`:452`)
   noting the receive-only caveat.
4. **`docs/features/meshcore-analyzer-observer.md`** — one line confirming the Observer keeps
   publishing under receive-only (it is an outbound MQTT/network publisher, not a radio path). Only
   if the page has a natural home for it; skip rather than force it.

### 4.5 API docs

**`docs/api/REST_API.md:104-118`** and the mirrored block in **`docs/api/API_REFERENCE.md:1104-1118`**
currently scope `409 TX_DISABLED` to Meshtastic only ("when the target source's LoRa radio has
`lora.txEnabled = false`"). Extend both blocks to name the second trigger, keeping the existing
JSON example and adding the MeshCore message string:

```
"error": "Transmission blocked: this MeshCore source is configured for receive-only operation.",
"code": "TX_DISABLED"
```

State the two causes side by side: Meshtastic — `lora.txEnabled = false`; MeshCore — the per-source
`meshcoreReceiveOnly` setting. Link both feature pages.

Add the MeshCore route list (from the epic's route inventory, verified against
`src/server/routes/meshcore*Routes.ts`), calling out the two `GET`s:

```
POST /api/sources/:id/meshcore/messages/send
POST /api/sources/:id/meshcore/rooms/login | /rooms/login-with-saved | /rooms/post
POST …/contacts/:pk/reset-path | /discover-path | /discover | /regions/discover
POST …/contacts/:pk/trace-path | /ping | /share | /telemetry/poll | /neighbors/request
GET  …/contacts/:pk/neighbours          ← GET
POST …/admin/login | /admin/cli | /admin/login-with-saved
GET  …/admin/status/:pk                 ← GET
POST …/cli                              (only the `advert` verb)
POST …/advert
POST …/automation/announce/send | /automation/timers/:triggerId/run
```

**`docs/api/API_REFERENCE.md:698` (`POST /api/settings`)** — add to that endpoint's error section:

- `400 INVALID_BOOLEAN_SETTING` — a strict-boolean setting was sent a value other than the exact
  strings `"true"` or `"false"`. Currently applies to `meshcoreReceiveOnly`
  (`src/server/routes/settingsRoutes.ts:339`). Note *why* it is strict: the server reads these with
  `raw === 'true'`, so `"1"` / `"yes"` / `"TRUE"` / `"on"` would persist and then read back as
  **false** — silently leaving transmission enabled on a source the operator believed was
  receive-only. Also add `meshcoreReceiveOnly` to the "Supported Settings" list as a per-source
  key.

If `REST_API.md` has its own `POST /api/settings` section, apply the same edit there; if it does
not (grep found none), leave it.

**`docs/api/API.md` — do not touch.** It carries an explicit outdated banner (`:3-10`) and the
Meshtastic TX-disabled epic deliberately left it alone. Same call here.

### 4.6 i18n

**Verified — no new keys are required for Part A.** The refusal is wire-level and has no UI string.
Phase 2's 13 keys are present in `public/locales/en.json`:
`meshcore.receive_only.{title,toggle_label,description,firmware_caveat,disable_confirm,control_tooltip,blocked_toast,paused_note,status_chip,saved_on,saved_off,save_failed,console_placeholder}`
(`:5160-5172`) plus `banners.receive_only_meshcore` (`:115`).

**Non-English locales are Weblate-managed** (`docs/features/translations.md:3, :36, :109` — "Weblate
will automatically detect the new string"; the repo has Weblate-authored translation PRs, e.g.
`4af8d1b3`). Confirmed: `meshcore.receive_only.*` appears **0 times** in `de.json` and `fr.json`,
which is the expected steady state for keys added days ago. **Do not hand-add translations to any
non-English locale file** — that conflicts with Weblate's round-trip.

Deliverable for this item is an audit, not an edit: confirm all 14 keys exist in `en.json`, confirm
every one is actually referenced from a component (grep), and report anything orphaned. Fix only
`en.json` if something is missing.

*Optional, only if it costs nothing:* one new English key noting in the MeshCore Virtual Node
settings section that VN clients cannot transmit while receive-only is on. Nice-to-have; skip if it
means restructuring the settings component.

---

## 5. Work packages

Four packages. WP2 depends on WP1. WP3 and WP4 are independent of everything and of each other, so
all three of WP1, WP3, WP4 can start immediately in parallel.

All agents share the one worktree — **file overlaps are listed per package and there are none
between packages.** Follow the repo's parallel-agent commit rule: use the pathspec form of
`git commit` (or `rtk proxy git`), never a bare `git commit -a`, so concurrent agents do not sweep
each other's files.

### WP1 — Virtual Node receive-only gate (production code)

**Files (exclusive):** `src/server/meshcoreVirtualNodeServer.ts`

1. Add `isReceiveOnly(): boolean` to `MeshCoreVirtualNodeManager` after `:72` (§2.7).
2. Add `refuseIfReceiveOnly()` after `auditPkiExport()` (`:706`) (§2.5).
3. Add the 8 guard calls at the sites in §2.4, each as the first statement of its handler.
4. Add the "guarded by the caller" comment in `handleSendCliTxtMsg` (`:1264`).
5. Update the class-level JSDoc (`:259-273`) with a one-line note that the 9 TX commands are
   refused under receive-only.

**Acceptance**
- `npm run typecheck` clean.
- `npx eslint src/server/meshcoreVirtualNodeServer.ts` reports nothing new, **and**
  `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` is empty.
- No `any` introduced (`no-explicit-any` count for this file must not grow in the baseline).
- Every guard is the **first statement** of its handler and precedes any `this.send(...)`
  — reviewer greps for `encodeSent` and confirms each is below a `refuseIfReceiveOnly` line.
- Existing VN test suite still passes (it will, once WP2 lands `FakeManager.isReceiveOnly`; until
  then a type error in the test file is expected and is WP2's to fix — WP1 must not silence it with
  a cast).

### WP2 — Virtual Node receive-only tests

**Depends on:** WP1 (needs the interface method and the guards).
**Files (exclusive):** `src/server/meshcoreVirtualNodeServer.test.ts`

1. `FakeManager.isReceiveOnly` + `receiveOnlyMock`, default `false` (§3.1). Confirm all 12 existing
   describe blocks pass **unmodified** before writing anything new.
2. New describe block with: 9 refusal tests (§3.2) each asserting Err-code, first-frame, and
   mock-not-called; the 2 edge tests; the read-path regression (§3.3); the live-push test; the
   meshcore.js decoder test (§3.4); the inventory test (§3.5); the flag-flip test (§3.6); the
   fail-closed test (§3.7).

**Acceptance**
- Full Vitest suite: 0 failures, `success: true` via the JSON reporter (per CLAUDE.md — the
  summary line alone is not sufficient).
- The first-frame assertion is present in all 9 refusal tests. Sanity-check it by temporarily
  moving one guard below its `encodeSent` and confirming the test fails; revert.
- The inventory test fails if a guard is removed. Verify by deleting one guard, running, reverting.
- No `any` in new test code (§3.4 gives the typed decoder pattern).
- `npx tsc --noEmit` with test files included reports no new errors (`tsconfig.json` excludes
  `*.test.ts`, so the normal `typecheck` will not catch these — Phase 1's reviewer note).

### WP3 — User documentation

**Files (exclusive):** `docs/features/meshcore-receive-only.md` (new),
`docs/.vitepress/config.mts`, `docs/features/receive-only-mode.md`, `docs/features/meshcore.md`,
`docs/configuration/virtual-node.md`, optionally `docs/features/meshcore-analyzer-observer.md`

1. Write the new page to §4.1's structure, with §4.2's limitation block above the fold.
2. Sidebar entry (§4.3).
3. The four cross-links (§4.4) — **including the `receive-only-mode.md:65` factual correction,
   which is a bug fix, not a nicety.**

**Acceptance**
- `npm run docs:build` (or the repo's VitePress build script) succeeds with no dead links.
- The firmware-limitation block is in a `::: danger` container, appears before the first `##`
  heading, and states all four points in §4.2.
- No emoji added to the page body beyond what sibling feature pages already use in headings.
- The blocked/allowed lists match Phase 1's actual behaviour — cross-check against
  `src/server/constants/meshcoreTx.ts` (`RF_BRIDGE_COMMANDS` / `SERIAL_ONLY_BRIDGE_COMMANDS` /
  `RF_LOCAL_CLI_VERBS`), not against this spec's prose.
- `grep -n "no equivalent flag" docs/features/receive-only-mode.md` returns nothing.

### WP4 — API documentation + i18n audit

**Files (exclusive):** `docs/api/REST_API.md`, `docs/api/API_REFERENCE.md`
**Read-only:** `public/locales/en.json` (edit only if a key is genuinely missing)

1. Extend both `409 TX_DISABLED` blocks to cover MeshCore, with the MeshCore message string and the
   route list (§4.5).
2. Document `400 INVALID_BOOLEAN_SETTING` on `POST /api/settings` and add `meshcoreReceiveOnly` to
   the supported-settings list (§4.5).
3. i18n audit per §4.6 — verify the 14 keys, verify each is referenced from a component, report
   orphans. **No non-English locale edits.**

**Acceptance**
- Every route listed in the API docs actually returns `409 TX_DISABLED` — spot-check at least the
  two `GET` routes against `src/server/routes/meshcoreContactsRoutes.ts` and
  `meshcoreAdminRoutes.ts`.
- `docs/api/API.md` is unmodified (`git diff --name-only` must not list it).
- `git diff --name-only public/locales/` lists at most `en.json`.
- The audit result is reported in the PR description, not written to a new file.

---

## 6. Exit criteria (Phase 3 / epic)

- A third-party MeshCore client connected to the VN port of a receive-only source **cannot
  transmit**, and receives a well-formed `Err(BadState)` as the first and only reply to each of the
  9 transmit commands — no hang, no timeout wait, no framing desync.
- The same client's reads all keep working: handshake, contacts, channels, message sync, device
  info, battery, time, config setters, PKI export (where enabled), and the live OTA packet feed.
- Full Vitest suite green (`success: true` via JSON reporter); `npm run typecheck` clean;
  `npm run lint:ci` clean of in-repo failures; `tsc` including test files clean.
- Docs shipped: new user page in the sidebar, the firmware limitation stated plainly and above the
  fold, `receive-only-mode.md`'s false "no equivalent flag" claim corrected, API docs covering
  `409 TX_DISABLED` on the MeshCore routes and `400 INVALID_BOOLEAN_SETTING` on `POST /settings`.

### Live validation (before the PR is marked ready)

Deploy to the dev container (`docker-compose.dev.yml` + `docker-compose.dev.local.yml`) against the
`MC-Sandbox` MeshCore source used for Phase 2, enable its Virtual Node, and connect a real MeshCore
client to the port. Confirm:

1. Handshake completes normally with receive-only ON (this is the one residual risk — the
   `SetFloodScope` comment at `:532` warns that an `Err` at the wrong point can be read as a fatal
   handshake failure; the 9 guarded commands are all post-handshake, but an app that auto-adverts
   on connect will get a refusal early and must not drop the socket).
2. Contacts, channels and message history load; the packet feed streams.
3. Sending a channel message and a DM both fail **promptly** in the app's UI, not after a timeout.
4. Turning receive-only off in MeshMonitor makes the same client transmit again with no reconnect.

Record the outcome in the epic doc's "Phase 3 deviations & findings" section, following the Phase 1
and Phase 2 precedent.

---

## 7. Risks / easy misses

1. **Guard placed after `encodeSent`.** Passes a naive "returns Err" test and is invisible in
   review. The first-frame assertion (§3.2 point 2) is the only thing that catches it.
2. **Using `Disabled(15)` because `handleExportPrivateKey` does.** Hangs 8 of 9 wrappers, three of
   them forever (no timeout).
3. **Making `isReceiveOnly` optional on the interface** to avoid touching `FakeManager`. That is
   fail-open on a safety gate.
4. **Guarding `handleGetNeighboursReq` instead of `handleSendBinaryReq`.** Leaves every future
   binary sub-type unguarded.
5. **Adding a second guard inside `handleSendCliTxtMsg`.** Unreachable; it has exactly one caller,
   already guarded.
6. **Info-level refusal logging.** A companion app retries on its own schedule; this is a log flood
   in production. Debug only.
7. **Hand-adding non-English translations.** Conflicts with Weblate's round-trip.
8. **Leaving `receive-only-mode.md:65` alone.** It actively tells users MeshCore has no equivalent
   flag, which this epic made false three phases ago.
