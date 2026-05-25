# MQTT Bridge — Per-Gateway Identity (design)

Design for changing how MeshMonitor's MQTT bridge presents itself to upstream
brokers. Today a bridge connects once with a fixed `mm-bridge-<sourceId>-…`
Client ID and publishes every local node's traffic through that single
connection. This document proposes maintaining one upstream connection per
local gateway, using each gateway's nodeId hex as the MQTT Client ID, plus a
stable per-broker identity for self-originated traffic.

> **Read this first if you're about to:** touch `MqttBridgeManager`,
> `MqttBrokerClient`, the `sources` table schema, or anything in
> `src/server/mqttBrokerManager.ts` that emits `local-packet`.

## TL;DR

- **Brokers grow a stable `nodeId` (8-hex).** Generated once per broker
  source, persisted on the `sources` row. This is the broker's identity for
  its own upstream actions — primarily the downlink subscriber connection.
- **Bridges open one upstream connection per `gateway_id`.** Each connection
  uses `clientId = '!' + hex8(gateway)`, lazily created on first publish for
  that gateway and held open for the bridge's lifetime.
- **The broker-identity connection doubles as the subscriber.** When the
  pool entry's gateway equals the broker's nodeId, that single connection
  handles both subscribe and the broker's own publishes — sidesteps the
  MQTT 3.1.1 §3.1.4 mandatory-disconnect rule for duplicate Client IDs.
- **`per_gateway` is the default forwarding mode.** Legacy single-identity
  mode stays available as `forwardingMode: 'single'` per bridge for operators
  on brokers with tight per-user connection caps.
- **No HA-collision risk.** Two MeshMonitor instances cannot share a local
  node at the transport layer (TCP/serial/BLE all exclusive), so they
  cannot produce the same `gateway_id` in their local-packet streams, so
  they cannot collide on upstream Client IDs.

## Why we're doing this

### The trigger

`mqtt.areyoumeshingwith.us` (and any similarly-configured public broker)
gates CONNECT on Client ID. Tested wire behavior with `uplink/uplink`
credentials:

| clientId                         | CONNACK | result          |
|----------------------------------|---------|-----------------|
| `!428c1418` (8-hex node format)  | 0       | accepted        |
| `mm-bridge-…-a7pfeox0`           | 4       | rejected        |
| `mosquitto-k99vj7ua`             | 4       | rejected        |
| `!` alone                        | 4       | rejected        |
| `428c1418` (hex, no bang)        | 4       | rejected        |

Same credentials in every row. The broker is matching the CONNECT
clientId against `^!\[0-9a-f]{8,}$` and returning CONNACK 4 to anything
else. MeshMonitor's current `mm-bridge-…` prefix will never match,
regardless of credential correctness.

### Why a simple Client ID override is wrong

The obvious fix — let the operator type any Client ID into the bridge
config — would force every uplink for every local gateway through a single
forged identity. The wire would say "all this traffic came from
`!aabbccdd`" when in reality it came from N different gateways. That
breaks downstream observers tracking per-node availability and corrupts
public mesh dashboards (mqtt.meshtastic.org, MQTTExplorer, other
MeshMonitor instances) that key off MQTT-protocol Client ID.

The correct fix is to make MeshMonitor's bridge behave the way the
firmware itself does when a node publishes directly to MQTT: each gateway
gets its own connection with its own Client ID.

## Architecture

### Two concepts, distinct identities

```
┌─────────────────────────────────────────────────────────────────┐
│ MeshMonitor instance                                            │
│                                                                 │
│  ┌────────────┐    ┌────────────┐    ┌────────────┐             │
│  │  USB node  │    │  USB node  │    │  USB node  │             │
│  │  !aabbccdd │    │  !11223344 │    │  !55667788 │             │
│  └──────┬─────┘    └──────┬─────┘    └──────┬─────┘             │
│         │                 │                 │                   │
│         ▼                 ▼                 ▼                   │
│  ┌─────────────────────────────────────────────────┐            │
│  │  Embedded broker (source type=mqtt_broker)      │            │
│  │  nodeId = !cafe1234   ← own stable identity     │            │
│  └─────────────────────┬───────────────────────────┘            │
│                        │ local-packet events                    │
│                        ▼                                        │
│  ┌─────────────────────────────────────────────────┐            │
│  │  Bridge (source type=mqtt_bridge)               │            │
│  │  forwardingMode = per_gateway                   │            │
│  │                                                 │            │
│  │  Publisher pool, lazy-keyed on gateway_id:      │            │
│  │    !aabbccdd ──► upstream conn A (publish)      │            │
│  │    !11223344 ──► upstream conn B (publish)      │            │
│  │    !55667788 ──► upstream conn C (publish)      │            │
│  │    !cafe1234 ──► upstream conn D (subscribe +   │            │
│  │                  broker's own publishes)        │            │
│  └─────────────────────────┬───────────────────────┘            │
└────────────────────────────┼────────────────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  Upstream MQTT       │
                  │  broker              │
                  └──────────────────────┘
```

### Broker identity

- New field: `sources.nodeId` (TEXT, 8-hex), nullable. Populated only on
  rows where `type = 'mqtt_broker'`.
- Generated on broker creation as a random 32-bit hex string. Persisted
  forever. Operator can manually regenerate via the broker source settings
  UI (with a warning that any upstream broker tracking the old ID will
  see it as a new node).
- Surfaced in the broker source's status panel so operators can see what
  identity their broker is publishing under.
- Decoupled from any actual mesh-attached node. The broker is a venue,
  not a node — it just needs *an* identity for MQTT clientId purposes.

### Bridge publisher pool

`MqttBridgeManager` maintains:

```ts
private publishers: Map<number, MqttBrokerClient> = new Map();
//                       ^ gatewayNum (uint32)
```

On every `local-packet`:

1. Extract `gateway_id` from `p.envelope.packet?.gateway_id` (or fall back
   to deriving from the topic suffix if the envelope's field is unset —
   firmware ≥2.5 sets it reliably).
2. Look up the pool entry for that gateway. If absent, create one:
   - `clientId = '!' + gatewayNum.toString(16).padStart(8, '0')`.
   - Call `client.connect()` (async — queue the publish, don't drop it).
3. Once connected, call `client.publish(topic, payload, retained)`.

The pool entry for `gateway == broker.nodeId` is special: it's the same
connection that holds the downlink subscriptions. Both come up at bridge
`start()` time (not lazily) so the subscriber is always ready.

### Why the dual-role broker connection

MQTT 3.1.1 §3.1.4 (and MQTT 5 §3.1.4) require the broker to disconnect
any existing session when a new CONNECT arrives with the same Client ID.
If we ran a *separate* subscriber connection with `clientId = brokerNodeId`
AND a publisher pool entry with the same Client ID when the broker itself
needs to publish (e.g., a self-originated keepalive or status message),
the upstream would kick one off and the bridge would flap.

Folding subscribe and broker-self-publish onto the same connection sidesteps
this entirely. It's also wire-faithful: a real Meshtastic node that
subscribes to a channel and also publishes uses one MQTT connection for
both.

### Lifecycle

- **Connect:** lazy on first publish for the gateway. Broker-identity
  connection is eager (at bridge start) so subscriptions are ready
  immediately.
- **Disconnect:** never, while the bridge is running. Reconnects use the
  existing mqtt.js `reconnectPeriod: 5000` with per-client jitter (±20%,
  see below).
- **Bridge stop:** all pool entries are gracefully closed in parallel.

Idle-timeout-and-disconnect is intentionally deferred. At realistic node
counts (1-10 USB nodes per host) the connection cost is trivial and the
benefit of "next publish is instant, no CONNACK round-trip" outweighs the
socket savings.

### Last-Will (LWT)

Each per-gateway connection sets an LWT:

- topic: `msh/<region>/<network>/2/e/<channelHash>/!<gatewayHex>` (or whatever
  the operator's `rootTopic` resolves to)
- payload: the same encoded MQTT ServiceEnvelope a firmware node would
  publish on disconnect (probably an empty envelope or a NODEINFO with
  the `disconnect` flag — we'll match firmware behavior exactly).
- retain: false, qos: 0.

This means when MeshMonitor restarts (or the local source for a gateway
goes offline and the connection is closed), upstream observers see a
real disconnect signal for the gateway, not just for "the bridge."

### Echo suppression unchanged

The existing echo-cache is bridge-scoped (`uplinkEchoes` / `downlinkEchoes`
in `mqttBridgeManager.ts`), keyed on `topic + packetId`. It works
regardless of which pool entry did the publish: when the upstream broker
echoes back to the subscriber, the matching entry's still there.

### Filters unchanged

`uplinkFilter.preFilter(p.topic, p.envelope)` still runs once per
local-packet before pool dispatch. No filter change.

## Failure modes

### Upstream broker has a per-username connection cap

E.g., `max_connections_per_user = 3` and the operator has 5 local
gateways. The first 3 publisher connections succeed; the 4th and 5th hit
CONNACK 5 (NOT_AUTHORIZED) or get TCP-rejected.

Detection: at bridge start, if more than ~25% of publisher connections
fail with CONNACK 4 or 5 within the first 60 seconds, surface a hint via
`permissionMessage`:

> "Broker appears to be rejecting per-gateway connections (3 of 5 failed).
> Try switching this bridge to single-identity mode in the source
> settings."

The hint is best-effort — it doesn't auto-flip the mode. Operators get
the diagnostic and choose.

### Broker-cap escape hatch

`forwardingMode: 'single'` on the bridge restores legacy behavior: one
upstream connection with `clientId = 'mm-bridge-<sourceId>-<random>'`,
all publishes ride it. No code change in this mode — it's the existing
path, preserved verbatim.

### Reconnect storms

If the upstream broker bounces, N publisher connections all schedule a
reconnect. Currently `MqttBrokerClient` uses `reconnectPeriod: 5000` flat
(`mqttBrokerClient.ts:89`). We add per-client jitter on connect:

```ts
reconnectPeriod: 5000 + Math.floor(Math.random() * 2000) - 1000  // ±1s
```

Trivial change, prevents N simultaneous CONNECT bursts on broker recovery.

### Forged gateway_id

A buggy or malicious local node could put a fake `gateway_id` in its
envelope. The bridge would then publish under a Client ID it has no
mesh-level right to claim. Practically this is bounded — the operator
controls which devices connect to their own embedded broker — but as a
defense-in-depth check, the pool could refuse to create entries for
gateway IDs that haven't been observed in the local sources' node lists
(`databaseService.nodes.getAllNodes(localSourceId)`).

Deferred to v2 unless a real exploit emerges. v1 trusts the envelope.

## Data-model changes

### Migration NNN: add `sources.nodeId`

```ts
// SQLite
db.exec(`ALTER TABLE sources ADD COLUMN nodeId TEXT`);
// Backfill broker rows with random 8-hex
const brokerRows = db.prepare(
  `SELECT id FROM sources WHERE type = 'mqtt_broker' AND nodeId IS NULL`
).all();
for (const row of brokerRows) {
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  db.prepare(`UPDATE sources SET nodeId = ? WHERE id = ?`).run(hex, row.id);
}
```

(With parallel PG and MySQL paths per the standard migration recipe in
`CLAUDE.md`.)

### Bridge config gains `forwardingMode`

```ts
export type MqttBridgeForwardingMode = 'per_gateway' | 'single';

export interface MqttBridgeSourceConfig {
  // …existing fields…
  forwardingMode?: MqttBridgeForwardingMode;  // default 'per_gateway'
}
```

No migration needed — absence reads as `per_gateway` by default. Existing
bridges silently adopt the new behavior on upgrade.

### Status surface

`MqttBridgeManager.getStatus()` grows:

```ts
publishers?: Record<string, {
  clientId: string;       // '!aabbccdd'
  connected: boolean;
  publishes: number;
  lastPublishAt: number | null;
  lastError: string | null;
}>;
```

Keyed by gateway hex. Empty when `forwardingMode === 'single'`.

## Implementation arc — three independent PRs

Each ships and is tested in isolation before the next starts.

### PR 1: Broker identity (no behavior change)

- Migration adding `sources.nodeId`, with backfill.
- Repository methods to read/regenerate.
- Settings UI on the broker source: read-only display + "Regenerate" button
  (with confirm dialog warning that observers will see it as a new node).
- Surface in the broker status panel.
- Tests: migration count bump, repository round-trip, idempotent on
  re-run.

No bridge changes. Pure data foundation.

### PR 2: Per-gateway publisher pool, opt-in

- New `MqttBridgePublisherPool` class.
- `forwardingMode` config field plumbed through `MqttBridgeSourceConfig`,
  the create/update API routes, and the bridge-edit form UI.
- Default remains `single` in PR 2 so the change is invisible.
- LWT per pool entry.
- Reconnect jitter in `MqttBrokerClient`.
- Per-publisher `getStatus().publishers` surface.
- Tests: pool dispatch by gateway_id, lazy creation, error per-pool-entry
  doesn't kill the bridge, LWT structure.

### PR 3: Default-on + subscriber unification

- Default `forwardingMode` flips to `per_gateway`.
- The broker-identity pool entry takes over the subscriber role; the legacy
  `mm-bridge-…` connection is no longer used in per_gateway mode.
- Startup CONNACK-4/5-rate detection emits the "switch to single?" hint
  via `permissionMessage` when triggered.
- Release note documenting the behavior change.
- Tests: subscriber-on-broker-pool-entry path, hint emission threshold.

After PR 3 the legacy single-connection code path is still present (for
operators who opt back into `single`), but is no longer the default.

## Open questions

These don't block the design but want operator input before the
implementing PR:

1. **LWT payload shape.** Match firmware's exact bytes, or use an empty
   envelope? Firmware-faithful is more compatible with observers; empty is
   simpler. Lean firmware-faithful.

2. **`nodeId` regeneration as a hard reset or soft.** When operator
   regenerates, do we offer to gracefully publish disconnect notices on
   the old identity first? Or just close the old subscriber and open a
   new one? Soft is more polite; hard is one line of code.

3. **Per-gateway stats retention.** Pool entries for transient gateways
   (e.g., a USB node briefly plugged in) accumulate in the status surface
   forever in v1. Worth an eviction policy in v2 if anyone complains.

4. **Surfacing `gateway_id` provenance in the UI.** Once we publish
   per-gateway, the bridge status panel could show "5 gateways currently
   publishing upstream" as a small table. Easy v1 polish if PR 2 is
   already touching the UI.
