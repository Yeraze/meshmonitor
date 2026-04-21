# Global Settings

::: tip New in 4.0
4.0 split "settings" into **global** (one per deployment) and **per-source** (one per connection). The **Global Settings** page, reachable from the dashboard sidebar, holds everything that doesn't belong to a specific source.
:::

## Opening Global Settings

Click the **gear / settings icon** in the dashboard sidebar (it collapses into a hamburger on mobile). The Global Settings page is admin-gated — regular users see their own **Profile / Preferences** page instead.

![Global Settings page with tabbed sections](/images/features/global-settings.png)

## What lives here

### Appearance

- Theme (15+ built-ins + custom themes)
- Default map center and zoom (honored by embed maps and the dashboard)
- Default map tileset (OSM, MapTiler, custom TileServer GL)
- Date/time format applied to all logs and panels

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

### System Backup / Restore

- Create / download / restore system backups (includes the new `sources` table)
- Schedule automatic backups
- See [System Backup](/features/system-backup) for the full workflow

### Housekeeping

- Auto heap management (periodic memory reclamation on Postgres/MySQL)
- Maintenance windows (message purge, telemetry retention, auto-delete-by-distance)

## Per-source settings (for comparison)

Anything that depends on *which* node you're connected to lives on the source, not here. Open **Dashboard → Edit Source** for:

- Connection details (host/port/device/credentials)
- Virtual Node
- Auto-Responder, Auto-Announce, Auto-Traceroute, Auto-Ack
- Scheduled Messages
- Permissions

See [Multi-Source](/features/multi-source) for the full per-source list.

## Related

- [Settings (user-facing overview)](/features/settings)
- [Multi-Source](/features/multi-source)
- [System Backup](/features/system-backup)
