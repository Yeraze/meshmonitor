# Message Search Feature Design

**Date**: 2026-02-27
**Status**: Approved

## Overview

Add a unified message search feature that allows users to search across channels, DMs, and MeshCore messages with filters for case sensitivity, scope, sender, channel, and date range. Results are permission-aware and clicking a result navigates to the message in its original context.

## Requirements

- Search across standard messages (channels + DMs) and MeshCore messages
- Case-sensitive and case-insensitive search options
- Filter by: scope (all/channels/DMs/MeshCore), specific channels, sender node, date range
- Results respect per-channel and DM permission system
- Click-to-navigate: clicking a result opens the message in its original tab/channel
- Unified search panel accessible from both MessagesTab and ChannelsTab

## Approach: SQL LIKE/ILIKE Database Search

Use Drizzle ORM's `like()`/`ilike()` operators for substring matching on the `text` column. This is zero-dependency, works across all three database backends (SQLite/PostgreSQL/MySQL), and is appropriate for the typical MeshMonitor message volume and short message lengths.

### Database Considerations

- **SQLite**: `LIKE` is case-insensitive for ASCII only. Use `LOWER()` wrapping for reliable case-insensitive search.
- **PostgreSQL**: Use `ilike()` for case-insensitive, `like()` for case-sensitive.
- **MySQL**: `LIKE` is case-insensitive by default with utf8 collation. Use `BINARY` for case-sensitive.

## Backend Design

### New API Endpoint

`GET /api/v1/messages/search`

**Query parameters**:

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `q` | string | yes | - | Search text (substring match) |
| `caseSensitive` | boolean | no | `false` | Case-insensitive by default |
| `scope` | `'all'` \| `'channels'` \| `'dms'` \| `'meshcore'` | no | `'all'` | Message type filter |
| `channels` | string (comma-separated ints) | no | - | Specific channel IDs |
| `fromNodeId` | string | no | - | Filter by sender node |
| `startDate` | number (epoch) | no | - | Earliest timestamp |
| `endDate` | number (epoch) | no | - | Latest timestamp |
| `limit` | number | no | 50 | Max 100 |
| `offset` | number | no | 0 | Pagination |

**Response**:
```json
{
  "success": true,
  "count": 42,
  "data": [
    {
      "id": "msg-123",
      "text": "hello world",
      "fromNodeId": "!abcd1234",
      "fromNodeNum": 12345,
      "toNodeId": "!efgh5678",
      "toNodeNum": 67890,
      "channel": 0,
      "timestamp": 1709000000,
      "rxTime": 1709000001,
      "source": "standard"
    }
  ],
  "total": 150
}
```

MeshCore results include `source: "meshcore"` and use `fromPublicKey`/`toPublicKey` instead of node IDs.

### Database Layer

**New repository methods**:
- `MessagesRepository.searchMessages(query, options)` — Search standard messages table
- `MeshcoreMessagesRepository.searchMeshcoreMessages(query, options)` — Search MeshCore messages table

**Exposed via DatabaseService**:
- `searchMessagesAsync(query, options)`
- `searchMeshcoreMessagesAsync(query, options)`

### Permission Enforcement

- Reuses existing auth middleware for authentication
- Results filtered server-side:
  - Channel messages: only channels where user has `channel_X:read`
  - DMs: only if user has `messages:read`
  - Admin users see all results

## Frontend Design

### Search Panel (Modal)

**Trigger**: Search icon button in the Sidebar, below existing navigation icons.

**Modal structure**:
- Header: "Search Messages" + close button
- Search input: text field with magnifying glass, triggers search on Enter
- Filter controls:
  - Case sensitivity toggle (checkbox)
  - Scope dropdown: All / Channels / DMs / MeshCore
  - Channel multi-select (visible when scope includes channels)
  - Sender node autocomplete (from known nodes list)
  - Date range: start/end date pickers
- Results list (scrollable):
  - Context label: channel name or "DM with [node name]"
  - Sender node name
  - Timestamp
  - Message text with highlighted search term
  - Source indicator (standard vs MeshCore)
- Pagination: "Load more" button or infinite scroll

**Styling**: Catppuccin theme variables, follows SystemStatusModal CSS pattern.

### Click-to-Navigate

When a user clicks a search result:
1. Close the search modal
2. Switch to the appropriate tab (`channels` or `messages`)
3. Select the correct channel or DM conversation
4. Scroll to and briefly highlight the target message

This requires a lightweight navigation context or callback that the App component exposes to allow programmatic tab switching and message focusing.

### New Files

- `src/components/SearchModal/SearchModal.tsx` — Search modal component
- `src/components/SearchModal/SearchModal.css` — Styles
- `src/services/api.ts` — Add `searchMessages()` method to ApiService

### Modified Files

- `src/db/repositories/messages.ts` — Add `searchMessages()` method
- `src/db/repositories/meshcoreMessages.ts` — Add `searchMeshcoreMessages()` method
- `src/services/database.ts` — Expose search methods via facade
- `src/server/routes/v1/messages.ts` — Add search endpoint
- `src/components/Sidebar.tsx` — Add search icon trigger
- `src/App.tsx` — Add SearchModal and navigation context
- `src/components/MessagesTab.tsx` — Support message focus/highlight
- `src/components/ChannelsTab.tsx` — Support message focus/highlight

## Testing

- **Backend**: Unit tests for search repository methods, API endpoint tests with filters, permission enforcement tests
- **Frontend**: Component tests for SearchModal rendering, input handling, results display

## Future Enhancements (Not in Scope)

- Full-text search (FTS5/tsvector/FULLTEXT) for large deployments
- Regex search support
- Search result export
- Saved searches
