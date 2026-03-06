# Design: Decouple Node List Visibility from Map Permissions

**Date:** 2026-03-06
**Status:** Approved

## Problem

Currently, `filterNodesByChannelPermission()` in `nodeEnhancer.ts` completely removes nodes from the API response when the user lacks `viewOnMap` permission on the node's channel. This makes the node list blank for users without map access, even though they should still be able to see that nodes exist.

## Approach

Stop filtering nodes out entirely. Instead, return all nodes but strip sensitive fields based on per-channel permissions. This mirrors Meshtastic protocol behavior where nodes are visible via unencrypted packet headers even without shared channel keys.

## Permission Tiers Per Node

Each node has a `channel` property. The user's permissions on that channel determine what data is included:

| Data | No Permission | `read` Only | `viewOnMap` |
|------|--------------|-------------|-------------|
| Node ID (hex) | yes | yes | yes |
| Long name / Short name | no (show node ID) | yes | yes |
| Last heard | yes | yes | yes |
| Hops away | yes | yes | yes |
| Channel indicator | yes | yes | yes |
| SNR / RSSI | yes | yes | yes |
| Battery level | no | yes | yes |
| Telemetry indicator | no | yes | yes |
| Weather indicator | no | yes | yes |
| PKC indicator | no | yes | yes |
| Remote Admin indicator | no | yes | yes |
| MQTT indicator | no | yes | yes |
| Role | no | yes | yes |
| Position / Altitude | no | no | yes |
| Distance | no | no | yes |
| Mobile status | no | no | yes |
| Position indicator | no | no | yes |
| Map marker | no | no | yes |
| "View on Map" button | no | yes | yes |

## "Hide Incomplete Nodes" Integration

Nodes with no `read` permission show only the node ID (no long/short name). These look like incomplete nodes and will be hidden when the "Hide incomplete nodes" setting is enabled.

## Backend Changes

### `nodeEnhancer.ts`
- Replace `filterNodesByChannelPermission()` with `applyChannelPermissionsToNodes()` that:
  - Returns ALL nodes (no filtering)
  - Computes a `permissionLevel` per node: `'none' | 'read' | 'viewOnMap'`
  - Strips fields based on permission level before sending to client
  - For `none`: strip user info (longName, shortName, role), telemetry, position, battery, all indicators
  - For `read`: strip position, altitude, distance, mobile status
  - For `viewOnMap`: return full node data

### `/api/poll` in `server.ts`
- Replace `filterNodesByChannelPermission()` call with `applyChannelPermissionsToNodes()`
- Map-specific rendering already checks for lat/lng presence, so stripping position handles markers automatically

### Frontend (`NodesTab.tsx`)
- Use the `permissionLevel` field to conditionally render indicators and the "View on Map" button
- Nodes without names (permissionLevel 'none') will naturally be treated as incomplete nodes
