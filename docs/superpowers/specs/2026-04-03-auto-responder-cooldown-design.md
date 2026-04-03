# Auto-Responder Per-Node Cooldown

**Issue:** #2565
**Date:** 2026-04-03
**Status:** Approved

## Problem

A malicious user can flood the mesh with trigger words (e.g., "test", "ping") to overwhelm auto-responders. With enough MeshMonitor instances responding, this can degrade mesh performance.

## Solution

Add per-node cooldown rate limiting to Auto-Acknowledge (global setting) and Auto-Responder (per-trigger setting). After responding to a node, ignore further triggers from that node for a configurable duration.

## Scope

| Feature | Cooldown Scope | Default | Storage |
|---------|---------------|---------|---------|
| Auto-Acknowledge | Global to feature | 60 seconds | Settings key (`autoAckCooldownSeconds`) |
| Auto-Responder | Per trigger | 0 seconds (disabled) | Field in trigger JSON (`cooldownSeconds`) |

Auto-Welcome is excluded — it naturally fires once per new node and isn't abusable.

## Auto-Acknowledge

### New Setting

| Key | Type | Default |
|-----|------|---------|
| `autoAckCooldownSeconds` | number | `60` |

Add to `VALID_SETTINGS_KEYS`. Add getter/setter in `database.ts` following the existing `autoAck*` pattern.

### Server Logic

In `meshtasticManager.ts`, add an in-memory `Map<number, number>` (`nodeNum → lastResponseTimestamp`) as a class property.

In `checkAutoAcknowledge()`, after the existing skip checks (ignored nodes, incomplete nodes) but before sending the response:
1. Read `autoAckCooldownSeconds` from settings
2. If cooldown > 0, check if `Date.now() - map.get(nodeNum) < cooldownSeconds * 1000`
3. If in cooldown: log at debug level, return without responding
4. After sending response: `map.set(nodeNum, Date.now())`

### UI

Add a numeric input to `AutoAcknowledgeSection.tsx` labeled "Per-node cooldown (seconds)". Place near the existing ignore/skip settings. Same save/load/change-detection pattern as other settings in that component.

## Auto-Responder

### Trigger Schema Change

Add `cooldownSeconds` field to the trigger object in the `autoResponderTriggers` JSON array:

```typescript
interface AutoResponderTrigger {
  trigger: string;
  response: string;
  responseType: 'text' | 'http' | 'script' | 'traceroute';
  channels: (number | 'dm' | 'none')[];
  cooldownSeconds?: number;  // NEW — default 0 (disabled)
  // ... existing fields
}
```

No migration needed — missing field defaults to 0 (disabled). Existing triggers are unaffected.

### Server Logic

In `meshtasticManager.ts`, add an in-memory `Map<string, number>` (`"triggerIndex:nodeNum" → lastResponseTimestamp`) as a class property.

In `checkAutoResponder()`, after a trigger pattern matches but before executing the response:
1. Read `cooldownSeconds` from the matched trigger (default 0)
2. If cooldown > 0, check if `Date.now() - map.get(key) < cooldownSeconds * 1000`
3. If in cooldown: log at debug level, continue to next trigger
4. After sending response: `map.set(key, Date.now())`

### UI

Add a "Cooldown (seconds)" numeric input to each trigger's config in `TriggerItem.tsx`. Default 0 (disabled).

## In-Memory Maps

- Not persisted to database — cooldowns reset on server restart (acceptable for short durations)
- No explicit cleanup — stale entries are a nodeNum + timestamp (8 bytes each), negligible memory even for thousands of nodes
- Per-node, not global — node A being in cooldown doesn't affect node B

## What This Does NOT Include

- Global cooldown (the entire feature paused for all nodes)
- Strike counts or exponential backoff
- Persistent cooldown state across restarts
- Cooldown for Auto-Welcome, Auto-Announce, or other automation types
