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
- **Virtual channels** (Channel Database entries) — included when you have that entry's read grant
- **MeshCore messages** — a channel needs `channel_N:read` or `messages:read`; MeshCore DMs need `messages:read`
- **Admin users** — see all results across all channels and DMs

In-app search reads stored messages, so MeshCore sources are searchable whether or not they are connected.

## API Endpoint

The search feature is also available via the REST API for programmatic access:

```
GET /api/v1/sources/{sourceId}/messages/search
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | yes | — | Search text (minimum 2 characters) |
| `caseSensitive` | boolean | no | `false` | Case-sensitive matching |
| `scope` | string | no | `all` | `all`, `channels`, `dms`, or `meshcore` (any other value returns 400) |
| `channels` | string | no | — | Comma-separated channel IDs to filter |
| `fromNodeId` | string | no | — | Filter by sender node ID |
| `startDate` | number | no | — | Earliest message time (epoch **milliseconds**) |
| `endDate` | number | no | — | Latest message time (epoch **milliseconds**) |
| `limit` | number | no | 50 | Max results per page (max 100) |
| `offset` | number | no | 0 | Pagination offset |

::: tip API Authentication
The `/api/v1/sources/{sourceId}/messages/search` endpoint requires a valid API token (Bearer authentication) with `messages:read` on that source. It searches stored messages, so MeshCore history is found whether or not the source is connected, and applies the same channel and DM rules as in-app search. `{sourceId}` may be `default`. The frontend uses session-based authentication via `/api/messages/search` which is not intended for external use.
:::

## Exporting Messages (CSV)

The **Unified Messages** page has an **Export** button that downloads stored messages as a CSV file, for event logs and after-action reports (for example an ARRL Simulated Emergency Test).

Pick what to include:

| Filter | Description |
|--------|-------------|
| **Sources** | Which sources to export. All are selected by default. |
| **Channels** | All channels, or only the ones you tick. Channels match by name across sources, as in the channel picker. |
| **Include** | Channel messages and DMs, channel messages only, or DMs only. |
| **Contains any of** | Comma-separated words. A message is kept if it contains **any** of them. Matching ignores case and finds the word anywhere in the text. |
| **Leave out messages with** | Comma-separated words. A message containing any of them is dropped. |
| **From / To** | Date and time range, entered in your browser's time zone. |
| **Sender ID** | One sender: a Meshtastic node ID (`!abcd1234`), or a MeshCore public key prefix or channel sender name. |
| **Time zone** | IANA zone (for example `America/New_York`) for the `local_time` column. Defaults to your browser's zone. |
| **Include emoji reactions** | Reactions (tapbacks) are left out unless you tick this. |

The file has one row per stored message, oldest first, across all selected sources. A message heard by two sources appears twice, once per source; the `source` column tells them apart. Traceroute replies are never exported.

| Column | Contents |
|--------|----------|
| `timestamp_utc` | ISO 8601 time in UTC |
| `local_time` | `YYYY-MM-DD HH:mm:ss` in the chosen time zone |
| `network` | `Meshtastic` or `MeshCore` |
| `source` | Source name |
| `channel` | Channel name, or `DM` |
| `sender_name` | Node long name (Meshtastic) or sender name (MeshCore) |
| `sender_id` | Node ID or MeshCore public key (blank for MeshCore channel messages, which carry only a name) |
| `destination` | `broadcast` for channel messages, else the recipient ID |
| `message` | Message text |
| `message_id` | Meshtastic packet ID (blank for MeshCore) |
| `rssi`, `snr`, `hops` | Reception details where known |

The file is UTF-8 with a byte-order mark and CRLF line endings, so Excel opens it with emoji and accented names intact. Cells that start with `=`, `+`, `-` or `@` get a leading `'` so a message can never run as a spreadsheet formula.

Exports stop at **100,000 rows**. When a file is cut short, its last line starts with `TRUNCATED:`; narrow the date range or filters to get the rest.

**Permissions:** the export includes exactly what you can read in the message views. Sources and channels you have no read grant on are skipped silently, DMs need `messages:read`, and a user with no grants gets a file with only the header row. The export reads the database only and sends nothing over the mesh.

The endpoint is `GET /api/messages/export` (session auth). List filters repeat the key: `source`, `channel`, `include`, `exclude`. Other parameters: `type` (`all`, `channels`, `dms`), `start` / `end` (UTC epoch milliseconds), `sender`, `includeReactions=true`, `tz`. It is rate limited to 6 exports per minute per client (local network addresses are exempt).

## Related Documentation

- [Configuration Search](/features/configuration-search) — finding a settings section, rather than a message
- [Settings](/features/settings) — general MeshMonitor settings
- [Channel Database](/features/channel-database) — additional channel configurations
- [MeshCore](/features/meshcore) — MeshCore messaging
- [Security](/features/security) — permissions and access control
