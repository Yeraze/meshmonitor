# Global Settings

::: tip New in 4.0
4.0 split "settings" into **global** (one per deployment) and **per-source** (one per connection). The **Global Settings** page, reachable from the dashboard sidebar, holds everything that doesn't belong to a specific source.
:::

## Opening Global Settings

Click the **gear icon** titled **Global Settings** in the dashboard sidebar footer (it collapses into a hamburger on mobile). The Global Settings page is admin-gated — regular users see their own **Profile / Preferences** page instead.

![Global Settings page with tabbed sections](/images/features/global-settings.png)

## What lives here

MeshMonitor has three settings pages. **Device Configuration** (satellite icon, per source) holds what MeshMonitor writes to, or does on, the radio. **Settings** (gear icon, per source) holds what MeshMonitor stores and does for that one source. **Global Settings** holds what applies to the whole install. MeshCore and Reticulum source pages link here from the foot of their left nav rail and from the top of their Settings page.

### Appearance

- Theme (15+ built-ins + custom themes)
- Default map center and zoom (honored by embed maps and the dashboard)
- Default map tileset (OSM, MapTiler, custom TileServer GL)
- Date/time format applied to all logs and panels
- **Default Landing Page** (admin-only) — what users see at the root URL: **Unified View** (default) or any configured source. See [Settings → Default Landing Page](/features/settings#default-landing-page).

### Localization

- System language (Weblate-sourced translations, 20+ locales)
- Units (metric / imperial)

### Notifications

- Push notification VAPID keys (auto-generated)
- Security Digest Apprise URL (weak-key / duplicate-key alerts — lives under the Security tab)
- News popup toggle (controls whether the dashboard renders the news feed)

Individual Apprise URLs (per user, per source) are not here — users configure those in their own **Settings → Notifications** page.

### Security

- Session lifetime
- Anonymous access policy
- MFA enforcement defaults
- Rate-limiter thresholds
- **PKI direct message decryption**: the install-wide enable switch (the per-source switch is on each source's **Settings** page). See [PKI Direct Message Decryption](/features/pki-dm-decryption).
- **Reliable PKI**: the default for every source, Off or As needed (each Meshtastic source can override it on its **Settings** page). See [Reliable PKI](/features/reliable-pki).

### Channel Database

Server-side decryption keys (admin only). See [Channel Database](/features/channel-database).

### Reticulum Settings

The destination retention cap. It applies to every Reticulum source. A Reticulum source's own Settings page holds only a pointer to it.

### Privacy

::: tip New in 4.13
:::

- **Discourage search engine & LLM indexing** — opt-in, off by default. When enabled, MeshMonitor adds an `X-Robots-Tag: noindex, nofollow` header to every response and serves a disallow-all `/robots.txt`, asking crawlers not to index the dashboard. Both are advisory (a crawler must choose to honor them); the `/robots.txt` body is offered alongside the header because some reverse proxies (e.g. Cloudflare tunnels) strip custom response headers at the edge.

### System Backup / Restore

- Create / download / restore system backups (includes the new `sources` table)
- Schedule automatic backups
- See [System Backup](/features/system-backup) for the full workflow

### Housekeeping

- Auto heap management (periodic memory reclamation on Postgres/MySQL)
- Maintenance windows (message purge, telemetry retention, auto-delete-by-distance)

### Position Estimation

::: tip New in 4.9.3
Position Estimation moved here from the per-source Automation tab — it's a single global, cross-source batch job, so it belongs in Global Settings.
:::

Estimate locations for GPS-less nodes by pooling traceroute and NeighborInfo geometry across **all** Meshtastic sources. Controls: enable, calculation frequency, lookback window, a **Maximum acceptable accuracy** cutoff (discards low-confidence estimates), and **Recalculate now**. Gated by `settings:write`. See [Position Estimation](/features/position-estimation).

### Coverage Report

A single **RF reception retention** field, 1–90 days (default 7), controlling
how long the [Coverage Report](/features/coverage-report) keeps recorded
receptions before an hourly sweep deletes them. It's a global, deployment-wide
setting, not a per-source one. Lowering the value **permanently deletes**
older receptions on the next sweep — the field warns about this before you
save. Gated by `settings:write`.

## Per-source settings (for comparison)

Anything that depends on *which* node you're connected to lives on the source, not here. Open **Dashboard → Edit Source** for:

- Connection details (host/port/device/credentials)
- Virtual Node
- Auto-Responder, Auto-Announce, Auto-Traceroute, Auto-Ack
- Scheduled Messages
- Permissions
- PKI direct message decryption switch (Meshtastic)
- Reliable PKI override (Meshtastic)
- MQTT Bridge Configuration (bridge sources)
- Receive-only mode, saved regions, node display, and message filters (MeshCore)

See [Multi-Source](/features/multi-source) for the full per-source list.

## Related

- [Settings (user-facing overview)](/features/settings)
- [Multi-Source](/features/multi-source)
- [System Backup](/features/system-backup)
