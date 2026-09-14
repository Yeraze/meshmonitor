# Message Search

MeshMonitor includes a unified message search feature that lets you search across all your channels, direct messages, and MeshCore messages. Results are permission-aware and clicking a result navigates directly to the message in its original context.

## Opening Search

There are two ways to open the search panel:

- Click the **Search** icon (🔍) in the sidebar, located below Channels and Messages
- Press **Ctrl+K** (or **Cmd+K** on macOS) from anywhere in the application

## Searching Messages

Type at least 2 characters in the search field and press **Enter** or click **Search**. Results appear below the filters, showing the most recent matches first.

Each result displays:

- **Context label** — the channel name (e.g., "Channel 0", "Channel meshmonitor") or "DM with [node name]" or "MeshCore"
- **Sender** — the node's long name and short name
- **Timestamp** — when the message was sent
- **Message text** — with matching terms highlighted in yellow

## Filters

You can narrow your search using the following filters:

| Filter | Description |
|--------|-------------|
| **Case Sensitive** | Toggle to match exact letter casing. Off by default (case-insensitive search). |
| **Scope** | Choose which message types to search: **All**, **Channels**, **DMs**, or **MeshCore**. |
| **Channel** | When scope includes channels, filter to a specific channel. |
| **Sender** | Filter by a specific sender node. |
| **Date From / Date To** | Restrict results to a date range. |

## Click-to-Navigate

Clicking a search result closes the search panel and navigates to the message in its original location:

- **Channel messages** — switches to the Channels tab, selects the correct channel, and scrolls to the message with a brief highlight
- **Direct messages** — switches to the Messages tab and opens the conversation with the sender
- **MeshCore messages** — switches to the MeshCore tab

The target message is highlighted with a yellow pulse animation for a few seconds so you can easily spot it.

## Pagination

Search returns up to 25 results at a time. If there are more matches, a **Load More** button appears at the bottom of the results list to fetch the next page.

## Permissions

Search results respect the existing permission system:

- **Channel messages** — only channels where you have read permission are included
- **Direct messages** — only visible if you have the `messages:read` permission
- **Admin users** — see all results across all channels and DMs

## API Endpoint

The search feature is also available via the REST API for programmatic access:

```
GET /api/v1/messages/search
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | yes | — | Search text (minimum 2 characters) |
| `caseSensitive` | boolean | no | `false` | Case-sensitive matching |
| `scope` | string | no | `all` | `all`, `channels`, `dms`, or `meshcore` |
| `channels` | string | no | — | Comma-separated channel IDs to filter |
| `fromNodeId` | string | no | — | Filter by sender node ID |
| `startDate` | number | no | — | Earliest timestamp (epoch seconds) |
| `endDate` | number | no | — | Latest timestamp (epoch seconds) |
| `limit` | number | no | 50 | Max results per page (max 100) |
| `offset` | number | no | 0 | Pagination offset |

::: tip API Authentication
The `/api/v1/messages/search` endpoint requires a valid API token (Bearer authentication). The frontend uses session-based authentication via `/api/messages/search` which is not intended for external use.
:::

## Related Documentation

- [Configuration Search](/features/configuration-search) — finding a settings section, rather than a message
- [Settings](/features/settings) — general MeshMonitor settings
- [Channel Database](/features/channel-database) — additional channel configurations
- [MeshCore](/features/meshcore) — MeshCore messaging
- [Security](/features/security) — permissions and access control
