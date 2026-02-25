# Exchange Position with Selectable Channel (#2021)

## Problem

Meshtastic position precision is a per-channel setting. Users often keep Primary (public) with coarse/disabled position sharing for privacy, while sharing precise positions on a private secondary channel. The current Exchange Position button sends the request on the node's stored channel (usually Primary), so the response may be imprecise or empty even when both devices could share precise data on a shared private channel.

## Solution

Add a split-button UI to the Exchange Position action, allowing users to override the channel used for the position request. The main button retains current default behavior; a dropdown arrow lets the user pick a specific channel.

## Architecture

### Backend

**`server.ts` — `/api/position/request` endpoint**

Accept an optional `channel` field in the request body. If provided and valid (0-7), use it. Otherwise fall back to `node?.channel ?? 0` (current behavior).

```typescript
const channel = (req.body.channel !== undefined && req.body.channel >= 0 && req.body.channel <= 7)
  ? req.body.channel
  : (node?.channel ?? 0);
```

No changes needed to `meshtasticManager.sendPositionRequest()` or `meshtasticProtobufService.createPositionRequestMessage()` — they already accept a channel parameter.

### Frontend

**`App.tsx` — `handleExchangePosition`**

Change signature from `(nodeId: string) => Promise<void>` to `(nodeId: string, channel?: number) => Promise<void>`. Pass the optional `channel` in the POST body.

**`MessagesTab.tsx` — Split button**

Replace the single Exchange Position button (lines 1601-1620) with a split-button:

- **Main button** (left): Sends with no channel override (default behavior)
- **Dropdown toggle** (right): Small `▾` arrow that opens a channel picker popover
- Selecting a channel immediately sends the position request on that channel
- Channel list comes from the existing `channels` prop (already filtered of disabled channels)
- Uses `channel.id` for values (consistent with #2024 fix)
- Dropdown closes on selection or outside click

**Props change for MessagesTab:**

```typescript
handleExchangePosition: (nodeId: string, channel?: number) => Promise<void>;
```

### i18n

Add translation key `messages.exchange_position_channel` for the dropdown tooltip (e.g., "Select channel for position exchange").

### Data Flow

1. User clicks dropdown arrow on split-button
2. Channel list appears (Primary, Secondary, etc.)
3. User selects a channel (e.g., "MESH_FLOW (Ch 2)")
4. `handleExchangePosition(nodeId, 2)` called
5. `App.tsx` sends `POST /api/position/request { destination: nodeNum, channel: 2 }`
6. Backend uses channel 2 instead of node's stored channel
7. Clicking the main button (no dropdown) uses current default behavior

### Testing

- **Backend**: Test `/api/position/request` respects `channel` body param, validates 0-7 range, falls back to node channel when omitted
- **Frontend**: Test split-button renders, dropdown shows channels, callback receives channel param

## Files Modified

- `src/server/server.ts` — Accept optional `channel` in position request endpoint
- `src/App.tsx` — Update `handleExchangePosition` signature and API call
- `src/components/MessagesTab.tsx` — Split-button UI for Exchange Position
- `public/locales/en.json` — Add translation key
