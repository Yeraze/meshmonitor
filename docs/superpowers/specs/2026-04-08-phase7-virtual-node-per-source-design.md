# Phase 7 — Per-Source Virtual Node

**Status:** Draft
**Date:** 2026-04-08
**Target:** MeshMonitor 4.0 (`feature/4.0`)

## Context

MeshMonitor 4.0 transforms the backend from a single-node singleton into a multi-source platform where each `MeshtasticManager` instance owns its own transport, data scope, and lifecycle. The Virtual Node feature — which re-exposes a connected Meshtastic node as a TCP endpoint for third-party clients — was built against the old singleton model:

- A single `VirtualNodeServer` instance is stashed on `global.virtualNodeServer` at startup.
- Configuration comes from three env vars: `ENABLE_VIRTUAL_NODE`, `VIRTUAL_NODE_PORT`, `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS`.
- Packet broadcasts to virtual-node clients are hard-coded into the legacy singleton's packet path in `server.ts` (lines ~1253, ~1529).

In the multi-source world this is broken: only the first TCP source ever reaches the broadcast hooks, there is no way to expose a second source as its own virtual endpoint, and port/admin settings cannot vary per source.

This phase makes Virtual Node a per-source feature owned by `MeshtasticManager`, configured through the same add/edit source UI users already use for host and port.

## Goals

1. Each `meshtastic_tcp` source can independently enable, configure, and expose its own Virtual Node TCP endpoint.
2. Virtual Node configuration lives in the source record and is edited through the source add/edit UI.
3. Packet broadcasts to virtual-node clients flow only from the owning source (no cross-source leakage).
4. The legacy `global.virtualNodeServer` is removed entirely.
5. The legacy `ENABLE_VIRTUAL_NODE` / `VIRTUAL_NODE_PORT` / `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS` env vars are removed — this is an intentional breaking change, documented in release notes.

## Non-Goals

- Virtual Node support for `mqtt` or `meshcore` source types. Virtual Node is Meshtastic-TCP-specific in this phase.
- Auto-assignment of ports. Users pick ports explicitly; the server rejects collisions.
- A global "master" Virtual Node that aggregates multiple sources. Each source has its own.

## Design

### 1. Data model

Virtual Node configuration is nested inside the existing `sources.config` JSON blob. No migration, no new columns.

```ts
interface MeshtasticTcpSourceConfig {
  host: string;
  port: number;
  virtualNode?: {
    enabled: boolean;
    port: number;                 // required when enabled
    allowAdminCommands: boolean;  // default false
  };
}
```

- `virtualNode` is omitted (or `enabled: false`) for sources that do not expose a virtual endpoint.
- Non-`meshtastic_tcp` sources ignore the field entirely; route validation rejects it for other types.

### 2. Backend architecture

**`MeshtasticManager` owns its Virtual Node server.**

- Constructor receives the full source config and, if `virtualNode.enabled`, instantiates a `VirtualNodeServer` using the source-scoped port and admin flag. The instance is stored on `this.virtualNodeServer`.
- `start()` awaits `this.virtualNodeServer?.start()` after the transport connects.
- `stop()` awaits `this.virtualNodeServer?.stop()` before the transport disconnects.
- Every broadcast site currently using `global.virtualNodeServer` (in `server.ts`) moves into the manager's own packet-receive path and calls `this.virtualNodeServer?.broadcastToClients(...)`. These hooks already run once per received packet on each manager instance, so per-source isolation is automatic.
- `global.virtualNodeServer` is deleted. `server.ts` no longer imports `VirtualNodeServer` and no longer starts one at boot.

**Hot reconfigure without full source restart:**

- `MeshtasticManager.reconfigureVirtualNode(config: VirtualNodeConfig | undefined)`:
  - If a VN server is running, stop it.
  - If the new config has `enabled: true`, construct and start a new `VirtualNodeServer` with the new port/admin flag.
  - Otherwise leave `this.virtualNodeServer` undefined.
- `SourceManagerRegistry.updateSource(sourceId, newConfig)` detects VN-config diffs and calls `reconfigureVirtualNode`. Transport (host/port for the upstream Meshtastic connection) changes still trigger a full manager restart as today; only the VN sub-feature hot-swaps.

### 3. Source CRUD + validation

`sourceRoutes` gains validation in the create and update handlers:

- If `source.type !== 'meshtastic_tcp'` and `virtualNode` is present → reject with 400.
- If `virtualNode.enabled === true`:
  - `virtualNode.port` must be a positive integer in `[1, 65535]`.
  - Port must not equal the source's own TCP connect `port` (can't bind to the port you're also connecting out to on the same host — rare in practice but a clear user error).
  - Port must not collide with any other source's VN port. The check reads all sources, parses their configs, and compares. This is race-free enough: the source CRUD endpoints are admin-only and low-frequency.
  - On collision, return 409 with a message naming the conflicting source.

On successful update, `sourceRoutes` calls `sourceManagerRegistry.updateSource(sourceId, newConfig)` which either hot-swaps the VN or restarts the manager as appropriate.

### 4. Frontend (add/edit source UI)

The TCP source form (`SourceEditModal` or equivalent) gains a collapsible **Virtual Node** section below the existing host/port fields:

- **Enable Virtual Node** toggle (default off).
- When enabled:
  - **Port** — number input, required, no default. Placeholder text suggests a common value like `4403`.
  - **Allow admin commands** — checkbox, default off. Subtitle warns: "Third-party clients connected to the virtual node can send admin commands to your Meshtastic node. Leave off unless you trust the clients."
- Client-side validation:
  - Warns (but does not block) if the VN port equals the TCP `port` field.
  - Shows the server's 409 collision error inline with the offending source name.

`SourceListPage` source cards get a small badge when a virtual node is active: **`VN:4403`** (or similar). Badge is absent when VN is disabled.

### 5. Removal of env vars

Breaking change, called out in release notes:

- Delete `virtualNodeEnabled`, `virtualNodePort`, `virtualNodeAllowAdminCommands` from `src/server/config/environment.ts`.
- Delete the virtual-node startup block in `server.ts` (around line 337) and the broadcast call sites that reference `global.virtualNodeServer`.
- Release notes: *"Virtual Node configuration moved from env vars to per-source settings. Users who previously set `ENABLE_VIRTUAL_NODE` must re-enable Virtual Node on their source via **Sources → Edit → Virtual Node** after upgrading to 4.0."*

### 6. Testing

- **Unit — `MeshtasticManager`:**
  - Constructor wires a `VirtualNodeServer` when `virtualNode.enabled`.
  - Constructor leaves `this.virtualNodeServer` undefined when disabled.
  - `reconfigureVirtualNode` stops the existing server and starts a new one with updated settings.
  - `reconfigureVirtualNode(undefined)` stops and clears.
- **Unit — `sourceRoutes` validation:**
  - Rejects non-TCP source types with VN config.
  - Rejects port collisions across sources with 409.
  - Rejects VN port equal to upstream TCP port.
- **Integration:**
  - Two TCP sources each with VN enabled on different ports — packets received on source A only reach source A's VN clients.
- **System test:** Update `tests/test-virtual-node.sh` to create a source with VN enabled via the API (replacing the current env-var-based launch), then verify a TCP client can connect on the configured VN port.

## Files to Modify

| File | Change |
|------|--------|
| `src/server/meshtasticManager.ts` | Own `virtualNodeServer`, wire start/stop, add `reconfigureVirtualNode`; move broadcast call sites into the manager |
| `src/server/server.ts` | Delete global VN startup block, delete `global.virtualNodeServer` references, remove `VirtualNodeServer` import |
| `src/server/sourceManagerRegistry.ts` | `updateSource` detects VN-config diff and calls `reconfigureVirtualNode` |
| `src/server/routes/sourceRoutes.ts` | Add VN validation (type check, port range, collision check) |
| `src/server/config/environment.ts` | Remove `virtualNode*` env vars |
| `src/server/virtualNodeServer.ts` | No interface change; constructor already takes config |
| `src/components/SourceEditModal.tsx` (or equivalent) | Add Virtual Node form section |
| `src/pages/SourceListPage.tsx` | Add `VN:PORT` badge on source cards |
| `tests/test-virtual-node.sh` | Rewrite to use per-source API |
| Release notes / CHANGELOG | Document the breaking change |

## Open Questions

None at this time. All major design decisions have been confirmed with the user:

1. Env vars are fully removed (not honored as fallback).
2. Virtual Node is `meshtastic_tcp`-only.
3. Ports are user-specified with server-side collision check.
4. `VirtualNodeServer` instances are owned by `MeshtasticManager`.
