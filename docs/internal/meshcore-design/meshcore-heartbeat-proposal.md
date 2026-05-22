# MeshCore Source Heartbeat — Design Proposal

**Status:** Proposal
**Author:** Merlin
**Target:** Per-source `MeshCoreManager` (companion-USB + companion-TCP). Repeater (direct-serial) covered in §6.

---

## 1. Motivation

MeshMonitor already has a configurable keepalive heartbeat for **Meshtastic TCP** sources (issues #2609 / #2616). It is implemented inside `TcpTransport` (`src/server/tcpTransport.ts`): the transport sends a `ToRadio.Heartbeat` every N seconds, the firmware replies with a `FromRadio.QueueStatus`, and that reply refreshes `lastDataReceived`. The reply is local-only — it never enters the mesh — so the heartbeat doubles as both:

1. A bidirectional liveness signal for quiet (`CLIENT_MUTE`) nodes that would otherwise look idle and be reconnected by the stale-data detector.
2. A fast dead-host detector: missing 3 consecutive replies trips the stale-connection handler in `heartbeatIntervalMs × 3` instead of waiting for the 5-minute idle timeout or the OS-level TCP keepalive (~12 min).

**MeshCore sources have neither feature today.** `MeshCoreManager.connect()` is one-shot; if the bridge process dies, the USB cable is unplugged, or the TCP companion link drops, nothing brings the manager back. There is also no liveness probe — the connection status only flips when something else (a user command, the telemetry poller) happens to fail.

We want the same guarantees for MeshCore that the Meshtastic transport already provides:

- **Detect** a dead local link within a few seconds, not "next time someone tries to send a command".
- **Reconnect** automatically with exponential backoff and a configurable cap.
- **Configurable** per source (interval, timeout, failure threshold, backoff parameters).
- **Zero mesh impact** — strictly local between MeshMonitor and the directly-attached node.

---

## 2. Existing implementation we're modelling on (Meshtastic TCP)

Relevant code:

- `src/server/tcpTransport.ts:43-124` — `heartbeatIntervalMs` / `heartbeatPayloadFactory` / `heartbeatTimer`, `setHeartbeatInterval()`.
- `src/server/tcpTransport.ts:404-503` — `startHealthCheck`, `startHeartbeat`, `stopHeartbeat`, `checkConnection` (effective timeout = `heartbeatIntervalMs × 3` when heartbeat is on).
- `src/server/tcpTransport.ts:224-241` — `scheduleReconnect()` with exponential backoff: `min(initialDelay × 2^(attempts-1), maxDelay)`. Reconnect runs forever until `disconnect()` clears `shouldReconnect`.
- `src/server/meshtasticManager.ts:629-645` — `encodeHeartbeatToRadio()` builds the `ToRadio.heartbeat` payload.
- `src/server/meshtasticManager.ts:766-779` — wires `heartbeatIntervalSeconds` from `sources.config` into `tcpTransport.setHeartbeatInterval()`.
- `src/server/routes/sourceRoutes.ts:322-340` — heartbeat changes are detected and trigger a manager rebuild (it's baked in at construct-time).

Key design properties to preserve:

- **Don't update liveness from the send side.** Kernel socket buffers swallow writes to dead hosts for minutes, so `socket.write()` returning success is not proof of life. Liveness only comes from a **reply** to the heartbeat.
- **Effective stale timeout = heartbeatInterval × 3.** Three missed replies = dead.
- **Heartbeat is configurable; `0` = disabled** to preserve prior behaviour.

---

## 3. Why we can't drop the same transport into MeshCore

MeshCore is architecturally different:

```
   Meshtastic TCP                       MeshCore companion
   ───────────────                      ────────────────────
   Node                                 Node
    │                                    │
    │  ToRadio.heartbeat                 │  sendBridgeCommand('get_device_time')
    ▼  (4-byte framed protobuf)          ▼  (JSON line over stdin)
   TcpTransport                         scripts/meshcore-bridge.py  ← Python process
    │                                    │
    │  TCP                                │  python-meshcore library
    ▼                                    ▼
   Radio node                           SerialConnection / TCPConnection / BLE
                                         │
                                         ▼
                                        Radio node
```

There is no Node-owned socket and no protobuf framing on this side; everything goes through the **Python bridge** (`scripts/meshcore-bridge.py`). The bridge owns the serial / TCP / BLE link to the node and exposes a JSON command/response protocol over stdin/stdout. The Node side (`MeshCoreManager`, `src/server/meshcoreManager.ts`) is just an RPC client to that bridge.

So the heartbeat for MeshCore lives **one layer up** from where the Meshtastic heartbeat lives — at the `MeshCoreManager` level, not the transport. It calls a real local-only RPC at the bridge, gets a response, and treats that as the liveness signal.

This also means heartbeat failure has two distinct shapes:

| Failure                            | Symptom                                              |
| ---------------------------------- | ---------------------------------------------------- |
| Bridge process died                | `sendBridgeCommand` throws `Bridge not ready`        |
| Node stopped responding over local | Bridge command times out / `success: false`          |

Both should converge on the same outcome: declare the source disconnected, tear down the bridge, start the reconnect loop.

---

## 4. The probe — what to send for the heartbeat

The bridge already exposes several **strictly-local** commands (`scripts/meshcore-bridge.py:36-38, 484-548`):

> The `get_stats` / `get_device_time` / `device_query` commands hit only the locally-connected node over its companion-protocol serial/BLE link. They never put a packet on the air, so they are safe to poll on a fixed interval.

Candidates ranked by cost:

1. **`get_device_time`** (RTC read). One-byte request, ~8-byte response. Already exposed as `MeshCoreManager.getDeviceTime()` (`src/server/meshcoreManager.ts:1405-1416`). **Recommended.**
2. `device_query` — small but returns ~10 fields; heavier than needed for liveness alone.
3. `get_stats type=core` — returns battery, uptime, queue. Useful as a *bonus*: a heartbeat that also refreshes a battery / uptime gauge for free.

There is a `'ping'` command in the bridge (`scripts/meshcore-bridge.py:124-125`) but it just returns `'pong'` synchronously from Python — it proves the bridge process is alive but says **nothing about the node**. Insufficient for our liveness goal.

**Decision: use `get_device_time` as the heartbeat probe.** It is the cheapest probe that actually proves the local node is responding over the companion-protocol link.

A future enhancement could make the probe selectable (`heartbeatProbe: 'get_device_time' | 'get_stats_core' | 'device_query'`) so operators can fold an existing telemetry pull into the heartbeat and skip a separate poll, but v1 hardcodes `get_device_time`.

---

## 5. Proposed design

### 5.1 Where the code lives

A new private class `MeshCoreHeartbeat` inside `meshcoreManager.ts`, owned 1:1 by `MeshCoreManager`. The manager:

- Constructs it lazily during `connect()` after the bridge is `ready` and the initial `get_self_info` / `get_contacts` calls have succeeded.
- Stops it inside `disconnect()` before tearing down the bridge.
- Resets/restarts it on every successful reconnect.

Keeping it inside `meshcoreManager.ts` (not a peer file) matches how `TcpTransport` keeps its heartbeat private — the manager is the only sensible owner of the bridge lifecycle, and the heartbeat is just one more lifecycle concern on top of it.

### 5.2 State machine

```
   ┌────────────────┐                          ┌────────────────┐
   │  Disconnected  │  start()  ─────────────► │   Connecting   │
   └────────────────┘                          └───────┬────────┘
            ▲                                          │ connect succeeds
            │ giveUp (max attempts)                    ▼
            │                                  ┌────────────────┐
   ┌────────┴───────┐  N consecutive failures  │   Connected    │
   │  Reconnecting  │ ◄────────────────────────│ (heartbeating) │
   └────────┬───────┘                          └────────────────┘
            │ attempt N — exponential backoff           ▲
            └─────────────────────────────► (back to Connecting)
```

Per state:

- **Connected**: heartbeat timer fires every `heartbeatIntervalSeconds`. Each tick calls `sendBridgeCommand('get_device_time', {}, timeout=heartbeatTimeoutMs)`. On success → reset `consecutiveFailures = 0`, update `lastSuccessfulProbeAt`. On failure → increment counter; if `>= heartbeatMaxFailures`, transition to Reconnecting.
- **Reconnecting**: heartbeat timer stopped. `scheduleReconnect()` runs `connect(this.config)` after the current backoff delay. Backoff is computed identically to `TcpTransport`: `min(initialDelay × 2^(attempts-1), maxDelay)`. After `reconnectMaxAttempts` (0 = forever), transition to a terminal Failed state and emit `'reconnect_giveup'`.
- **Connecting / Failed**: same as today's `connect()` path, plus state bookkeeping.

The state lives on `MeshCoreManager` itself (a single `private connectionState` enum) so existing accessors (`isConnected()`, `getStatus()`) keep working. `connected: true` only when state === `Connected`.

### 5.3 Concurrency / re-entrancy guards

The Meshtastic transport has a known set of races we should not repeat:

1. **`disconnect()` during a reconnect.** Set `shouldReconnect = false` first (mirrors `TcpTransport.disconnect()`), clear the reconnect timer, then tear down. The reconnect closure must early-return if `shouldReconnect === false`.
2. **Heartbeat probe arriving after disconnect.** Probe handler checks the current state at the *end* — if state is no longer `Connected`, drop the result.
3. **Overlapping probes.** If a probe takes longer than the interval, we hold a `probeInFlight` flag and skip the next tick rather than queueing a second probe. (The Python bridge serializes commands itself, so two concurrent `sendBridgeCommand`s wouldn't break it — but stacking timeouts is messy and offers no extra signal.)
4. **Bridge stdout truncation.** If `sendBridgeCommand` hangs because the bridge stopped producing newlines, the per-command `timeout` (defaulted to `heartbeatTimeoutMs`, **not** the existing 30 s default in `sendBridgeCommand`) ensures we fail fast. This is the single most important behaviour change in the manager: the heartbeat must time out in seconds, not 30 s.

### 5.4 Public surface on `MeshCoreManager`

Additions, all optional / non-breaking:

```ts
class MeshCoreManager extends EventEmitter {
  // new
  getHeartbeatStatus(): {
    state: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
    consecutiveFailures: number;
    lastSuccessfulProbeAt: number | null;  // ms epoch
    nextReconnectAt: number | null;        // ms epoch when reconnecting
    reconnectAttempts: number;
  };

  // new events
  // 'heartbeat_ok'       — fired on every successful probe; payload { sourceId, latencyMs }
  // 'heartbeat_failed'   — fired on every failed probe; payload { sourceId, consecutiveFailures, error }
  // 'reconnecting'       — fired when entering Reconnecting; payload { sourceId, attempt, nextDelayMs }
  // 'reconnect_giveup'   — fired after reconnectMaxAttempts exhausted
}
```

Pre-existing events (`'connected'`, `'disconnected'`, `'message'`, etc.) keep their current contract.

### 5.5 Wiring from source config

The MeshCore source config blob (`MeshCoreSourceConfig` in `src/server/meshcoreRegistry.ts:19-28`) gains:

```ts
interface MeshCoreSourceConfig {
  // existing
  transport?: 'usb' | 'serial' | 'tcp';
  port?: string; serialPort?: string; baudRate?: number;
  tcpHost?: string; tcpPort?: number;
  deviceType?: 'companion' | 'repeater';
  autoConnect?: boolean;

  // new
  heartbeatIntervalSeconds?: number;   // 0 = disabled. default 30.
  heartbeatTimeoutMs?: number;         // default 5000.
  heartbeatMaxFailures?: number;       // default 3.
  reconnectInitialDelayMs?: number;    // default 1000.
  reconnectMaxDelayMs?: number;        // default 60000.
  reconnectMaxAttempts?: number;       // default 0 (forever).
}
```

`meshcoreConfigFromSource()` is extended to forward these onto the runtime `MeshCoreConfig` shape. `MeshCoreManager.connect(config)` reads them and constructs `MeshCoreHeartbeat` accordingly.

`sourceRoutes.ts` already rebuilds the MeshCore manager whenever the source config changes (`src/server/routes/sourceRoutes.ts:353-365` — disconnect + recreate + reconnect), so no special change-detection is required for the heartbeat fields. They are picked up on the next reconnect like any other config.

### 5.6 Defaults rationale

| Setting                        | Default | Why                                                                       |
| ------------------------------ | ------- | ------------------------------------------------------------------------- |
| `heartbeatIntervalSeconds`     | `30`    | Aggressive enough to detect death within ~90 s, gentle on the bridge.     |
| `heartbeatTimeoutMs`           | `5000`  | Bridge round-trips are <100 ms locally; 5 s catches a hung node fast.     |
| `heartbeatMaxFailures`         | `3`     | Matches Meshtastic's "3× interval = dead" rule.                           |
| `reconnectInitialDelayMs`      | `1000`  | Same as `TcpTransport` default — fast first retry.                        |
| `reconnectMaxDelayMs`          | `60000` | Same cap as `TcpTransport`. After ~6 attempts (1+2+4+8+16+32 s) we plateau at 60 s. |
| `reconnectMaxAttempts`         | `0`     | Forever, matches `TcpTransport`. Operators can cap it if they want.       |

These can all be overridden per-source. `heartbeatIntervalSeconds = 0` disables the whole feature and gives us today's behaviour back for users who explicitly want it.

### 5.7 Status / observability

- `GET /api/sources/:id/status` already returns the manager status (`MeshCoreManager.getStatus()`). Extend that payload to include `heartbeat: getHeartbeatStatus()` so the UI / external monitors can see "last successful probe 14 s ago, 0 failures, reconnect attempt 0".
- Emit a `dataEventEmitter` event on every heartbeat state transition (not on every probe — that's chatty) so the WebSocket layer can push the change to dashboards without polling.
- Log on transitions only (`Connected → Reconnecting`, `Reconnecting (attempt N)`, `Reconnect succeeded`, `Reconnect give-up`). **Do not** log every successful probe — at the default cadence that's 2880 lines per source per day.

### 5.8 Tests

Mirror the structure of `tcpTransport.test.ts` and `meshcoreManager.telemetry.test.ts`:

- `meshcoreManager.heartbeat.test.ts`
  - Probe success → emits `heartbeat_ok`, resets failure counter, doesn't touch state.
  - N consecutive probe failures → transitions to Reconnecting, emits `reconnecting`.
  - Reconnect attempt sequence: backoff is `1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, …`.
  - `disconnect()` during Reconnecting cancels the pending reconnect timer.
  - Probe arriving after `disconnect()` is dropped (no state churn).
  - `reconnectMaxAttempts > 0` triggers `reconnect_giveup` after that many failed attempts.
  - `heartbeatIntervalSeconds = 0` → no heartbeat timer, no state changes.
- Existing `meshcoreManager.telemetry.test.ts` continues to pass — the telemetry poller is a peer to the heartbeat, not a replacement.

Use `vi.useFakeTimers()` for the cadence assertions; mock `sendBridgeCommand` to control success/failure/timeout.

---

## 6. Edge cases & gotchas

1. **Repeater (direct-serial) devices** don't use the bridge — `connectSerialDirect()` opens a raw `SerialPort` and exchanges text CLI commands (`src/server/meshcoreManager.ts:656-812`). A meaningful heartbeat there would be a CLI no-op like `ver`, but the Companion code path explicitly warns against sending `ver` because it corrupts Companion binary state (`meshcoreManager.ts:309-311`). For Repeater, a `ver` heartbeat is fine — the firmware mode is explicit. **v1 scope: companion only.** Repeater heartbeat (using `ver` or equivalent over the readline parser) is a small follow-up.

2. **BLE companion link.** Currently routed through the Python bridge same as serial/TCP, so this design covers it for free. Worth a smoke test on real BLE hardware because BLE has its own teardown semantics (the bridge may emit a different error than for USB unplug).

3. **`lastMeshTxAt` must not be touched by the heartbeat.** That field is the cross-source RF throttling primitive (`meshcoreManager.ts:259-267`) and is only stamped by code that actually transmits on the mesh. The heartbeat is local-only and must remain invisible to mesh-traffic accounting. Same rule as Meshtastic's "don't update `lastDataReceived` on heartbeat send".

4. **Telemetry poller overlap.** `MeshCoreTelemetryPoller` already calls `getDeviceTime` etc. on its own ~5-minute cadence. The heartbeat (default 30 s) will pull `get_device_time` more often. That's fine — they share the same bridge command path; no special coordination needed. A future "fold the telemetry poller into the heartbeat" optimisation is possible but not required.

5. **Source reload races.** When a user edits the source config, `sourceRoutes.ts` does `remove(source.id)` + `getOrCreate` + `connect`. The old heartbeat's timers are owned by the old `MeshCoreManager` instance and torn down inside its `disconnect()`. As long as `disconnect()` clears `shouldReconnect` *before* killing the bridge, no orphan reconnect can stomp on the new instance.

6. **Tests that touch `MeshCoreManager` without a real bridge.** Existing tests inject a fake `sendBridgeCommand`. The heartbeat must be **opt-in for tests** (interval = 0 by default in unit-test fixtures, or constructed with a `__testNoHeartbeat: true` flag) so we don't see phantom heartbeat-failed events polluting unrelated suites.

7. **Bridge stdout deadlock.** If the Python bridge stops emitting newlines for any reason, `sendBridgeCommand` would hang. Today the default `30000` ms timeout (`meshcoreManager.ts:514`) bounds that. The heartbeat passes its own shorter timeout (`heartbeatTimeoutMs`, default 5 s), so a hung bridge gets caught one heartbeat interval sooner than via any other command path.

8. **Process supervision.** When we declare a node disconnected and tear down the bridge, the Python subprocess might still be alive and holding the USB / TTY. `disconnect()` already calls `bridgeProcess.kill()` (`meshcoreManager.ts:349`), but in practice `SIGTERM` doesn't always release `/dev/ttyACM0` instantly. Worth verifying on hardware: if reconnect fires before the kernel reaps the old process, the new bridge's `SerialConnection(/dev/ttyACM0)` open could fail with `EBUSY`. If that happens, we already retry with backoff — but consider a one-shot `SIGKILL` after a 2 s `SIGTERM` grace if testing shows it.

---

## 7. Rollout plan

1. **Slice A — manager support, default off.** Land `MeshCoreHeartbeat` and the new config fields with `heartbeatIntervalSeconds` defaulting to `0`. Behaviour unchanged for everyone.
2. **Slice B — flip default to `30 s`.** After Slice A bakes for a release. Update `meshcoreConfigFromSource` defaults; document the change in the release notes.
3. **Slice C — UI.** Surface heartbeat status + the six new fields on the source edit form. Parallel to the existing Meshtastic heartbeat row in the dashboard (`src/pages/DashboardPage.tsx` already references `heartbeatIntervalSeconds` for Meshtastic).
4. **Slice D — Repeater support.** Add a CLI-based heartbeat path for `firmwareType === 'repeater'` using a benign `ver` probe.
5. **Future — telemetry/heartbeat fusion.** Optional: let the heartbeat probe be `'get_stats_core'` so it also feeds the telemetry table on its faster cadence.

---

## 8. Open questions

- **Probe selectability in v1?** Worth shipping `heartbeatProbe` enum from day 1 even if we only support `get_device_time`, to avoid a schema churn later.
- **Should heartbeat failure feed `inactiveNodeNotificationService`?** Today that service notices nodes that stop being heard over the air. A local-link disconnect is a different signal and probably deserves its own notifier channel rather than borrowing the inactive-node path.
- **Effective stale timeout exposure.** Meshtastic UI shows "X minutes since last data" derived from `lastDataReceived`. MeshCore equivalent would be `Date.now() - lastSuccessfulProbeAt`. Worth surfacing in the per-source status panel.
