# Auto Favorite Design

## Overview

Automatically favorite eligible nodes for zero-cost hop routing on Meshtastic networks. When enabled, MeshMonitor detects nearby (0-hop) nodes that qualify for zero-cost hop preservation and favorites them on the locally connected device.

Background: [Zero-Cost Hops & Favorite Routers](https://meshtastic.org/blog/zero-cost-hops-favorite-routers/)

## Firmware Behavior (verified against Router.cpp)

A hop is preserved (not decremented) when ALL conditions are met:

1. Local node role is ROUTER, ROUTER_LATE, or CLIENT_BASE
2. Not the first hop of the packet
3. Previous relay node is in the favorites list AND has role ROUTER, ROUTER_LATE, or CLIENT_BASE

Note: The firmware accepts CLIENT_BASE as a valid favorite relay, which deviates from the blog post (which only mentions ROUTER/ROUTER_LATE).

## Settings

Stored in DB via `/api/settings` key-value store (no migration needed):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoFavoriteEnabled` | `'true'/'false'` | `'false'` | Master enable/disable |
| `autoFavoriteStaleHours` | `string (number)` | `'72'` | Hours before auto-unfavoriting a stale node |
| `autoFavoriteNodes` | `string (JSON array)` | `'[]'` | Node numbers managed by auto-favorite (not manually favorited) |

## Eligibility Rules

| Local Node Role | Auto-Favorite Targets | Rationale |
|---|---|---|
| CLIENT_BASE (12) | All 0-hop nodes (any role) | CLIENT_BASE treats all favorites as ROUTER_LATE priority |
| ROUTER (2) | 0-hop nodes with role ROUTER, ROUTER_LATE, or CLIENT_BASE | Only these participate in zero-cost relay |
| ROUTER_LATE (11) | 0-hop nodes with role ROUTER, ROUTER_LATE, or CLIENT_BASE | Same as ROUTER |
| Any other role | Feature disabled (invalid config warning in UI) | No benefit |

## Architecture: Event-Driven + Periodic Sweep

### Trigger 1: Event-Driven (on NodeInfo update)

New method `checkAutoFavorite(nodeNum, nodeId)` called from `processNodeInfoMessageProtobuf()` alongside existing `checkAutoWelcome()`.

Logic:
1. Check `autoFavoriteEnabled` setting
2. Check `supportsFavorites()` (firmware >= 2.7.0)
3. Skip if it's the local node
4. Get local node's role; bail if not CLIENT_BASE, ROUTER, or ROUTER_LATE
5. Get target node from DB; check `hopsAway === 0`
6. If local role is ROUTER/ROUTER_LATE, also check target's role is ROUTER/ROUTER_LATE/CLIENT_BASE
7. If not already favorited: `setNodeFavorite(nodeNum, true)` + `sendFavoriteNode(nodeNum)` + add to `autoFavoriteNodes`
8. Use `Set<number>` guard to prevent duplicate concurrent operations

### Trigger 2: Periodic Sweep (staleness cleanup)

Runs on `setInterval` every 60 minutes, scheduled during startup.

Logic:
1. Check `autoFavoriteEnabled`
2. Get all node numbers from `autoFavoriteNodes` list
3. For each: unfavorite if `lastHeard` older than `autoFavoriteStaleHours`, or `hopsAway > 0`, or role changed to ineligible (for ROUTER/ROUTER_LATE local)
4. Unfavorite via `setNodeFavorite(false)` + `sendRemoveFavoriteNode()` + remove from `autoFavoriteNodes`
5. When feature is disabled, sweep runs once to clean up all auto-favorited nodes

### Manual vs Auto Distinction

- `autoFavoriteNodes` JSON list tracks which nodes were auto-managed
- Manual favorites are never in this list and never touched by the sweep
- If user manually unfavorites an auto-favorited node, remove it from the list (hook into existing favorite API endpoint)

## Frontend: AutoFavoriteSection.tsx

New component in the Automation tab, following the `AutoPingSection` pattern (self-managed state via `useSaveBar`).

### UI Elements

1. **Info blurb** with "Read more" link to the Meshtastic blog post
2. **Status/warning banner** showing:
   - Valid config: role name + firmware version + what will be auto-favorited
   - Invalid role warning (not ROUTER/ROUTER_LATE/CLIENT_BASE)
   - Firmware too old warning (< 2.7.0)
3. **Enable checkbox**
4. **Staleness threshold** input (hours)
5. **Auto-Favorited Nodes list** (read-only, shows node name, role, hops)

### Integration in App.tsx

- Add nav entry: `{ id: 'auto-favorite', label: 'Auto Favorite' }`
- Add `<AutoFavoriteSection baseUrl={baseUrl} />` in automation tab
- Component fetches device info for role/firmware detection internally

## Edge Cases

| Scenario | Behavior |
|---|---|
| Node not connected | Catch error on device sync, mark in DB, retry on next sweep |
| Node changes role | Next sweep detects ineligible role, unfavorites |
| Node goes multi-hop | Next sweep detects hopsAway > 0, unfavorites |
| User manually unfavorites auto-node | Remove from autoFavoriteNodes list, auto won't re-add |
| User manually favorites a node | Not in autoFavoriteNodes, sweep never touches it |
| Multiple rapid NodeInfo updates | Set guard prevents duplicates |
| Feature disabled | Sweep runs once to clean up, clears autoFavoriteNodes |
| Firmware < 2.7.0 | Feature is no-op, UI shows warning |

## Out of Scope

- Managing favorites on remote nodes (local only)
- Database migrations (uses existing columns + settings store)
- Overriding manual favorites
