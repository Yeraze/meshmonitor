# Key Mismatch Detection & Immediate Purge

**Date:** 2026-03-14
**Status:** Approved

## Problem

When a Meshtastic node re-keys (generates a new public key), other nodes in the mesh may have stale cached keys. MeshMonitor currently detects key mismatches only via PKI routing errors (PKI_FAILED, NO_CHANNEL). This is reactive — the user must first attempt communication that fails before the issue is surfaced.

A more proactive approach: when MeshMonitor receives a mesh-broadcast NodeInfo packet containing a public key that differs from what our database has stored (sourced from the connected device's NodeDB sync), flag this as a key mismatch immediately.

## Design

### Detection

**Trigger:** Mesh-received NodeInfo packet processing (`meshtasticManager.ts`, ~line 4180).

**Logic:**
1. NodeInfo arrives with `user.publicKey` (non-empty)
2. Convert to base64, compare against `existingNode.publicKey` in our database
3. If they differ and the existing key is non-empty:
   - Set `keyMismatchDetected = true` on the node
   - Store `lastMeshReceivedKey` = the new key (full base64) on the node record
   - Log to `auto_key_repair_log` with action `'mismatch'`, including first 8 chars of old and new keys
   - Emit node update event for real-time frontend updates
4. Do **not** overwrite the stored `publicKey` — only device DB sync updates that

**Key comparison notes:**
- Only compare when both keys are non-empty (new nodes without a cached key are not mismatches)
- The stored key comes from device NodeDB sync (authoritative source)
- The mesh-received key may be newer (node re-keyed) or could indicate spoofing

### Resolution

**Trigger:** Device DB sync processing (`meshtasticManager.ts`, ~line 5596).

**Logic:**
1. During device DB sync, when we receive a node's key from the device
2. If the node has `keyMismatchDetected = true` and `lastMeshReceivedKey` is set
3. Compare the device-synced key against `lastMeshReceivedKey`
4. If they match: keys are aligned
   - Clear `keyMismatchDetected = false`
   - Clear `lastMeshReceivedKey = null`
   - Log to repair log with action `'fixed'`
5. If they don't match: mismatch persists, leave flags in place

### Immediate Purge (Optional Setting)

**Setting:** `autoKeyManagementImmediatePurge` (boolean, default false).

**Behavior when enabled:**
1. On mismatch detection (step 3 above), immediately:
   - Send `removeByNodenum` to the connected device
   - Log to repair log with action `'purge'` and key fragments
   - Send NodeInfo request to trigger re-discovery
2. Node stays flagged as `keyMismatchDetected = true` until device sync resolves it
3. **Replaces** the exchange-then-purge cycle for mismatch-detected nodes
   - The repair scheduler skips nodes whose most recent log action is `'purge'` from immediate purge
   - Those nodes await resolution via the next device DB sync

**Behavior when disabled:**
- Mismatch-detected nodes fall through to the existing exchange-attempt cycle
- After max exchange attempts, the existing auto-purge setting (if enabled) takes effect

**Prerequisite:** Auto-key management must be enabled for immediate purge to function.

### Database Changes

**Migration 084** (idempotent, all 3 backends):

1. **Nodes table** — add `lastMeshReceivedKey`:
   - SQLite: `text`, nullable
   - PostgreSQL: `pgText`, nullable
   - MySQL: `varchar(128)`, nullable

2. **`auto_key_repair_log` table** — add key fragment columns:
   - `oldKeyFragment`: text/varchar(16), nullable — first 8 chars of base64 old key
   - `newKeyFragment`: text/varchar(16), nullable — first 8 chars of base64 new key

3. **Settings:**
   - `autoKeyManagementImmediatePurge` — stored via existing `/api/settings` endpoint

### Security Tab UI

New **"Key Mismatch"** section in `SecurityTab.tsx`, positioned after the Duplicate Keys section.

**Data source:** Query `auto_key_repair_log` for entries with action in `('mismatch', 'purge', 'fixed')`, grouped by node, most recent first. Limited to last 50 entries or 7 days.

**Table layout:**

| Column | Description |
|--------|-------------|
| Node | Node name and ID (linked) |
| Detected | Timestamp when mismatch was detected |
| Old Key | First 8 chars of old key (from DB) |
| New Key | First 8 chars of new key (from mesh) |
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
  - Filtered to actions: `mismatch`, `purge`, `fixed`
  - Includes node name, timestamps, key fragments, status
  - Requires `security:read` permission

**Updated endpoint:**
- `POST /api/settings` — accepts `autoKeyManagementImmediatePurge` setting

### Files Modified

| File | Change |
|------|--------|
| `src/server/meshtasticManager.ts` | Detection in NodeInfo processing, immediate purge logic, clear on device sync, scheduler skip logic |
| `src/server/migrations/084_add_key_mismatch_columns.ts` | New migration for schema changes |
| `src/services/database.ts` | Migration registration, methods for mismatch logging/querying, `lastMeshReceivedKey` support |
| `src/db/schema/nodes.ts` | Add `lastMeshReceivedKey` field to all 3 schemas |
| `src/components/SecurityTab.tsx` | New Key Mismatch history section |
| `src/components/AutoKeyManagementSection.tsx` | New immediate purge toggle, key fragment columns in activity log |
| `src/server/routes/securityRoutes.ts` | New endpoint for mismatch history |
| `src/server/routes/settingsRoutes.ts` | Handle new setting |
| `src/server/server.ts` | Load `autoKeyManagementImmediatePurge` setting on startup |

### Edge Cases

1. **Node has no existing key:** Skip mismatch detection — this is a first-seen key, not a mismatch.
2. **Same key received again:** No action — only flag when keys differ.
3. **Multiple mismatches before resolution:** Update `lastMeshReceivedKey` to the latest mesh-received key. Log each new mismatch event. The resolution check uses the most recent `lastMeshReceivedKey`.
4. **Node purged but re-discovery fails:** Node stays flagged. The repair scheduler can pick it up on subsequent cycles if immediate purge is disabled.
5. **Server restart:** Mismatch state persists in DB (`keyMismatchDetected`, `lastMeshReceivedKey`). History persists in repair log.
6. **PostgreSQL/MySQL compatibility:** All queries use async methods. Migration is idempotent. Key fragment columns are nullable for backwards compatibility.
