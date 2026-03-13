# Key Mismatch Detection & Immediate Purge

**Date:** 2026-03-14
**Status:** Approved

## Problem

When a Meshtastic node re-keys (generates a new public key), other nodes in the mesh may have stale cached keys. MeshMonitor currently detects key mismatches only via PKI routing errors (PKI_FAILED, NO_CHANNEL). This is reactive — the user must first attempt communication that fails before the issue is surfaced.

A more proactive approach: when MeshMonitor receives a mesh-broadcast NodeInfo packet containing a public key that differs from what our database has stored, flag this as a key mismatch immediately.

## Key Authority Model

Understanding how keys flow through the system is critical to this design:

- **Mesh-received NodeInfo** (`processNodeInfoMessageProtobuf`): The node broadcasts its current key. This is the **authoritative source** — the key comes directly from the node. This path **overwrites** `publicKey` in our database (line 4182).
- **Device DB sync** (device NodeDB sync loop): The connected device reports what it has cached. For remote nodes, if this differs from what we already have, we **skip it** (line 5608-5614) since the device cache may be stale.

Therefore:
- Detection compares the **incoming mesh key** against the **existing stored key** (which itself came from a prior mesh-received NodeInfo or an earlier device sync)
- After detection, the mesh-received key overwrites `publicKey` as usual
- Resolution occurs when the device sync brings a key that **matches** our stored key (meaning the device has re-discovered the node with the correct key)

## Design

### Detection

**Trigger:** Mesh-received NodeInfo processing in `processNodeInfoMessageProtobuf`.

**Logic:**
1. NodeInfo arrives with `user.publicKey` (non-empty)
2. Convert to base64. Fetch `existingNode` from database
3. **Before the existing `publicKey` overwrite**, compare the incoming key against `existingNode.publicKey`
4. If they differ and the existing key is non-empty:
   - Set `keyMismatchDetected = true` on the node
   - Store `lastMeshReceivedKey` = the incoming key (full base64) on the node record
   - Log to `auto_key_repair_log` with action `'mismatch'`, including first 8 chars of old and new keys
   - Emit node update event for real-time frontend updates
5. The incoming key then overwrites `publicKey` as it does today (line 4182)

**Key comparison notes:**
- Only compare when both keys are non-empty (new nodes without a cached key are not mismatches)
- The existing stored key may have come from a previous mesh-received NodeInfo or a device sync
- The incoming key may be newer (node re-keyed) or could indicate spoofing

### Resolution

**Trigger:** Device DB sync processing (device NodeDB sync loop).

**Logic:**
1. During device DB sync, a node's key arrives from the device
2. If the node has `keyMismatchDetected = true` and `lastMeshReceivedKey` is set
3. Compare the device-synced key against `lastMeshReceivedKey`
4. If they match: the device has re-discovered the node with the correct key
   - Clear `keyMismatchDetected = false`
   - Clear `lastMeshReceivedKey = null`
   - Log to repair log with action `'fixed'`
   - This comparison happens **before** the existing skip-stale-key check, so the device sync key is allowed through when it resolves a mismatch
5. If they don't match: mismatch persists, leave flags in place

**Why this works after purge+rediscovery:** After purging a node from the device, the device re-discovers it via fresh NodeInfo exchange. The device now has the correct (new) key. On the next device DB sync, the device reports this key, which matches `lastMeshReceivedKey` (what we saw on mesh). Keys are aligned → mismatch clears.

### Immediate Purge (Optional Setting)

**Setting:** `autoKeyManagementImmediatePurge` (boolean, default false).

**Behavior when enabled:**
1. On mismatch detection (step 4 above), immediately:
   - Send `removeByNodenum` to the connected device (requires active connection)
   - Log to repair log with action `'purge'` and key fragments
   - Send NodeInfo request to trigger re-discovery
2. Node stays flagged as `keyMismatchDetected = true` until device sync resolves it
3. **Replaces** the exchange-then-purge cycle for mismatch-detected nodes
   - The repair scheduler skips nodes whose most recent log action is `'purge'` from immediate purge
   - Those nodes await resolution via the next device DB sync
4. If the device is disconnected when a mismatch is detected, the purge is skipped. The node remains flagged and the repair scheduler can pick it up later.

**Behavior when disabled:**
- Mismatch-detected nodes fall through to the existing exchange-attempt cycle
- After max exchange attempts, the existing auto-purge setting (if enabled) takes effect

**Prerequisite:** Auto-key management must be enabled for immediate purge to function.

### Database Changes

**Prerequisite: Port key repair logging to PostgreSQL/MySQL.** The existing `logKeyRepairAttempt` and `getKeyRepairLog` methods return no-ops for non-SQLite backends. These must be implemented as async methods before this feature can work on all backends. The `auto_key_repair_log` table already exists in PostgreSQL/MySQL (created by the init scripts), so only the query methods need porting.

**Migration 084** (idempotent, all 3 backends):

1. **Nodes table** — add `lastMeshReceivedKey`:
   - SQLite: `text`, nullable
   - PostgreSQL: `pgText`, nullable
   - MySQL: `varchar(128)`, nullable

2. **`auto_key_repair_log` table** — add key fragment columns:
   - `oldKeyFragment`: text/varchar(8), nullable — first 8 chars of base64 old key
   - `newKeyFragment`: text/varchar(8), nullable — first 8 chars of base64 new key

3. **Settings:**
   - `autoKeyManagementImmediatePurge` — stored via existing `/api/settings` endpoint

### Security Tab UI

New **"Key Mismatch"** section in `SecurityTab.tsx`, positioned after the Duplicate Keys section.

**Data source:** Query `auto_key_repair_log` for entries with action in `('mismatch', 'purge', 'fixed')`, grouped by node, most recent first. Limited to last 50 entries AND 7 days (whichever is more restrictive).

**Table layout:**

| Column | Description |
|--------|-------------|
| Node | Node name and ID (linked) |
| Detected | Timestamp when mismatch was detected |
| Old Key | First 8 chars of old key (monospace) |
| New Key | First 8 chars of new key (monospace) |
| Status | Pending / Purged / Fixed / Exhausted |
| Resolved | Timestamp when resolved (if applicable) |

**Status values:**
- **Pending** — mismatch detected, awaiting resolution
- **Purged** — node removed from device, awaiting re-discovery
- **Fixed** — keys aligned after device sync
- **Exhausted** — exchange attempts exhausted (if immediate purge disabled)

**Empty state:** "No key mismatch events detected"

### Auto-Key Management UI

**New toggle in `AutoKeyManagementSection.tsx`:**
- "Immediately purge nodes with mismatched keys"
- Positioned after the existing auto-purge setting
- Help text: "When a node broadcasts a different key than what your device has cached, immediately remove it from the device database to trigger re-discovery. If disabled, the standard exchange-then-purge cycle is used."
- Only visible/enabled when auto-key management is enabled

**Activity log table updates:**
- Add "Old Key" and "New Key" columns showing fragments when present
- Null for older log entries predating this feature

### API

**New endpoint:**
- `GET /api/security/key-mismatches` — returns recent mismatch history from repair log
  - Filtered to actions: `mismatch`, `purge`, `fixed`, `exhausted`
  - Includes node name, timestamps, key fragments, status
  - Requires `security:read` permission

**Updated endpoint:**
- `POST /api/settings` — accepts `autoKeyManagementImmediatePurge` setting

### Localization

Add translation keys to `public/locales/en.json` for:
- Security tab section header and empty state
- Status labels (Pending, Purged, Fixed, Exhausted)
- Column headers
- Auto-key management toggle label and help text

### Files Modified

| File | Change |
|------|--------|
| `src/server/meshtasticManager.ts` | Detection in NodeInfo processing, immediate purge logic, resolution in device sync, scheduler skip logic |
| `src/server/migrations/084_add_key_mismatch_columns.ts` | New migration for schema changes |
| `src/services/database.ts` | Migration registration, port key repair log methods to async for Postgres/MySQL, new methods for mismatch logging/querying, `lastMeshReceivedKey` support |
| `src/db/schema/nodes.ts` | Add `lastMeshReceivedKey` field to all 3 schemas |
| `src/components/SecurityTab.tsx` | New Key Mismatch history section |
| `src/components/AutoKeyManagementSection.tsx` | New immediate purge toggle, key fragment columns in activity log |
| `src/server/routes/securityRoutes.ts` | New endpoint for mismatch history |
| `src/server/routes/settingsRoutes.ts` | Handle new setting |
| `src/server/server.ts` | Load `autoKeyManagementImmediatePurge` setting on startup |
| `public/locales/en.json` | Translation keys for new UI elements |

### Edge Cases

1. **Node has no existing key:** Skip mismatch detection — this is a first-seen key, not a mismatch.
2. **Same key received again:** No action — only flag when keys differ.
3. **Multiple mismatches before resolution:** Update `lastMeshReceivedKey` to the latest mesh-received key. Log each new mismatch event. The resolution check uses the most recent `lastMeshReceivedKey`.
4. **Node purged but re-discovery fails:** Node stays flagged. The repair scheduler can pick it up on subsequent cycles if immediate purge is disabled.
5. **Server restart:** Mismatch state persists in DB (`keyMismatchDetected`, `lastMeshReceivedKey`). History persists in repair log.
6. **PostgreSQL/MySQL compatibility:** All queries use async methods. Migration is idempotent. Key fragment columns are nullable for backwards compatibility.
7. **Device disconnected during immediate purge:** Purge is skipped, node remains flagged. Repair scheduler or manual intervention can address later.
8. **Mismatch log `success` column:** For `'mismatch'` action entries, `success` is set to `null` (detection is not a success/fail operation).
