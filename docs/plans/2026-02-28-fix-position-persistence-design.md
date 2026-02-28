# Fix: Local Node Fixed Position Overwritten by Stale Broadcasts

**Date:** 2026-02-28
**Type:** Bug fix

## Problem

When a user sets a fixed position (via MeshMonitor config UI or Meshtastic CLI), the correct position is stored on the device. However, the device's firmware then broadcasts a position packet with **stale/old coordinates** (from before the change). MeshMonitor receives this packet, processes it through `processPositionMessageProtobuf`, and overwrites the database with the wrong position.

The packet monitor shows this as a 'tx' packet (because `from === localNode`), making it appear that MeshMonitor is sending the wrong position.

**Affected users:** Anyone using fixed position, especially noticeable with MQTT where there are no local radio nodes.

## Root Cause

`processPositionMessageProtobuf` in `meshtasticManager.ts` has no guard against overwriting the local node's position from received mesh broadcast packets when `fixedPosition=true`. It treats all position packets equally regardless of source.

## Fix

### Part A: Guard `upsertNode` for local node when `fixedPosition=true`

In `processPositionMessageProtobuf`, before calling `upsertNode`, check:
- Is this packet from the local node? (`fromNum === localNodeInfo.nodeNum`)
- Is `fixedPosition` enabled? (`actualDeviceConfig.position.fixedPosition === true`)

If both true, skip the `upsertNode` call. Continue inserting telemetry for historical tracking.

### Part B: Update DB immediately on `set_fixed_position`

When MeshMonitor sends a `set_fixed_position` admin command, also immediately update the local node's coordinates in the database via `upsertNode`. This ensures the DB is correct before any device response arrives.

Locations:
1. `server.ts` — REST API `setPositionConfig` handler (~line 6749)
2. `meshtasticManager.ts` — `setPositionConfig` method (~line 11085)

### What's unchanged
- Position processing for other nodes
- Position processing for local node when GPS is enabled (fixedPosition=false)
- Telemetry recording (always recorded)
- NodeInfo position during config sync (authoritative from device)
