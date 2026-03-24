# Channel Move/Swap Message Migration

## Problem

Messages store `channel` as a slot index (0-7). When a channel is moved to a different slot (via config import or manual save), message history stays on the old slot index, causing messages to appear under the wrong channel.

## Solution

Detect channel moves/swaps by comparing PSKs before and after a channel configuration change, then migrate messages to follow the channel content.

## Trigger Points

1. `PUT /api/channels/:id` — individual channel save
2. `POST /api/channels/:slotId/import` — import to specific slot
3. `POST /api/channels/import-config` — bulk config URL import

## Detection Logic

Before applying channel changes, snapshot all 8 slots `{id, psk}`. After applying, compare PSKs:

- **Move** (A→B): PSK from slot A now appears in slot B, slot A has different/no PSK
- **Swap** (A↔B): PSK from slot A in slot B AND PSK from slot B in slot A

Match by PSK (base64 string equality). Ignore slots with empty/null PSK.

## Message Migration

All within a single database transaction:

1. For a **move** (A→B): `UPDATE messages SET channel = B WHERE channel = A`
2. For a **swap** (A↔B): Use temp value to avoid conflicts:
   - `UPDATE messages SET channel = -99 WHERE channel = A`
   - `UPDATE messages SET channel = A WHERE channel = B`
   - `UPDATE messages SET channel = B WHERE channel = -99`

Transaction rolls back entirely on any error — no partial moves.

## Implementation

### New method: `MessageRepository.migrateMessagesForChannelMoves(moves: {from: number, to: number}[])`

- Accepts a list of `{from, to}` pairs
- Runs all UPDATEs in a single transaction
- Handles swap detection (if A→B and B→A both appear, use temp value)
- Returns `{success: boolean, rowsAffected: number}`
- Logs each move with row counts

### Caller logic (in server.ts channel endpoints):

```typescript
// Before applying changes
const beforeSnapshot = await databaseService.channels.getAllChannels(); // [{id, psk}, ...]

// Apply channel changes (existing code)
...

// After applying changes
const afterSnapshot = await databaseService.channels.getAllChannels();

// Detect moves by comparing PSKs
const moves = detectChannelMoves(beforeSnapshot, afterSnapshot);

// Migrate messages if any moves detected
if (moves.length > 0) {
  await databaseService.messages.migrateMessagesForChannelMoves(moves);
}
```

### Helper: `detectChannelMoves(before, after): {from, to}[]`

Pure function. For each slot in `before` that has a non-empty PSK:
- Find where that PSK ended up in `after`
- If it's in a different slot, record `{from: oldSlot, to: newSlot}`

## Scope

- Only `messages` table
- Only device channel slots (0-7)
- Does not affect channel database entries (>=100) or DMs (-1)
- Does not affect `packet_log`

## Error Handling

- Entire migration is transactional — rollback on any failure
- Channel config changes succeed even if message migration fails (log error, don't block)
- Audit log: log detected moves and row counts at INFO level
