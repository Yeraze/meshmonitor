# MeshMonitor Security Advisory — May 2026

**Status:** Fixed on `main` (pending release).
**Reporter:** External researcher (anonymous-by-request).
**Disclosure:** Coordinated; researcher has been credited in PR descriptions.

This advisory documents four authorization issues in the MeshMonitor REST API: three high-severity findings reachable by anonymous callers under the standard public-viewer configuration (MM-SEC-1/2/3) and one medium-severity authenticated-user privilege escalation (MM-SEC-4).

---

## MM-SEC-1 — Anonymous disclosure of VAPID private key (and other settings) via `GET /api/settings`

**Severity:** High.
**Affected versions:** All releases up to and including v4.2.0.
**Fixed in:** PR [#2904](https://github.com/Yeraze/meshmonitor/pull/2904) (commit on `main`); shipping in next release.

### Issue

`GET /api/settings` returned every row from the `settings` table that wasn't `source:`-prefixed, with no permission gate. The push-notification service auto-generates a VAPID keypair on first start and persists both the public **and private** keys into that same table. Effect: any unauthenticated visitor could retrieve the deployment's VAPID private key.

Other secret-bearing keys exposed by the same path:
- `securityDigestAppriseUrl` — Apprise URLs commonly embed SMTP / Slack / Discord webhook / Telegram credentials
- `analyticsConfig` — provider tokens

### Impact

With the VAPID private key plus a subscriber's `endpoint`/`p256dh`/`auth`, an attacker can deliver arbitrary push notifications to that subscriber's browser under the legitimate site's name and icon. This is a high-quality phishing vector because push notifications bypass spam filters and surface on the lock screen / notification tray.

The subscription material is not currently exposed via any HTTP route on `main`, and is excluded from system-backup tarballs (locked in by `systemBackupService.tables.test.ts`). Realistic exploitation therefore requires the attacker to obtain that material via some other path (a future bug, server-side compromise, or out-of-band leak).

### Operator mitigation (pre-patch)

1. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` via environment variables.
2. Rotate the auto-generated key by deleting the three `vapid_*` rows from the `settings` table and restarting. Existing browser subscriptions are invalidated; clients re-subscribe transparently on next visit.
3. Block `GET /api/settings` at the reverse proxy for unauthenticated callers.

### Fix

`SECRET_SETTINGS_KEYS` (explicit) + `SECRET_SETTINGS_KEY_PATTERN` (tail regex `*_private_key|*_secret|*_token`) drive a `stripSecretSettings(map, isAdmin)` helper applied to both the global and source-merged response shapes. Public VAPID key is still returned (browsers need it to subscribe).

---

## MM-SEC-2 — Anonymous disclosure of all channel PSKs via `/api/channels` and `/api/poll`

**Severity:** High.
**Affected versions:** All releases up to and including v4.2.0.
**Fixed in:** PR [#2905](https://github.com/Yeraze/meshmonitor/pull/2905); shipping in next release.

### Issue

`GET /api/channels`, `GET /api/channels/all`, and the `/api/poll` channels section returned raw `getAllChannels()` rows verbatim — including the 32-byte `psk` symmetric key for every channel. The endpoints gated on `channel_0:read`, which is granted to anonymous callers in the standard public-viewer configuration.

The `channels` section of `/api/poll` correctly applied per-channel visibility filtering (so hidden channels were omitted from the channels array) but still pushed the full DB row of permitted channels including their PSKs.

### Impact

A Meshtastic channel PSK is the symmetric key that both authenticates and encrypts traffic on that channel. Disclosure lets an attacker:
- decrypt all currently observable on-air traffic on the channel
- decrypt all previously recorded traffic
- inject signed traffic indistinguishable from legitimate users

### Operator mitigation (pre-patch)

Revoke `channel_0:read` from the anonymous user. This breaks the public dashboard for logged-out visitors but is the only way to fully close the leak without code changes.

### Fix

`transformChannel` (with `getRoleName`) hoisted from `routes/v1/channels.ts` into a shared `src/server/utils/channelView.ts` module. The whitelist explicitly omits `psk` and exposes a derived `pskSet: boolean` so callers can answer "is a PSK configured?" without seeing the key. The legacy `/api/channels`, `/api/channels/all`, and the `/api/poll` channels section all route through this helper now. Static `channel_0:read` gate replaced with a per-row `hasPermission(user, channel_${id}, read)` check; admins always see all.

---

## MM-SEC-3 — Anonymous disclosure of hidden-channel message content via `/api/poll`

**Severity:** High.
**Affected versions:** All releases up to and including v4.2.0.
**Fixed in:** PR [#2906](https://github.com/Yeraze/meshmonitor/pull/2906); shipping in next release.

### Issue

The `/api/poll` messages section, `GET /api/messages`, and `GET /api/messages/unread-counts` all gated on `channel_0:read || messages:read` and then returned message content / unread counts spanning every channel. The only filter applied to the messages array was `msg.channel !== -1` (DM exclusion).

Sibling sections of the same poll handler (channels, unread-counts) already correctly applied a per-channel `read` filter; the messages section did not.

### Impact

A user with `channel_0:read` (anonymous in default config) received the full text of messages on hidden channels. Reproduced by the researcher: 1 visible channel, 84 messages spanning 3 channels including the operator's hidden one.

### Operator mitigation (pre-patch)

Revoke `channel_0:read` from the anonymous user (same as MM-SEC-2). Operators who have not configured any hidden channels are not exposed to MM-SEC-3 specifically, but PSK disclosure under MM-SEC-2 still applies.

### Fix

Each of the three sites now pre-computes an `authorizedChannelIds: Set<number>` from per-channel `read` permissions, then filters: DMs require `messages:read`; channel messages require both the legacy gate AND `authorizedChannelIds.has(msg.channel)`. Same approach applied to the unread-counts handler.

---

## MM-SEC-4 — Channel-mutator privilege escalation between authenticated users

**Severity:** Medium (authenticated-user only; not anonymous-exploitable).
**Affected versions:** All releases up to and including v4.2.0.
**Fixed in:** PR [#2907](https://github.com/Yeraze/meshmonitor/pull/2907); shipping in next release.

### Issue

Five channel-mutation endpoints all gated on a static `channel_0:read|write` permission while operating on `:id` from the URL:

- `GET /api/channels/:id/export` — gate `channel_0:read`, returns the actual PSK
- `PUT /api/channels/:id` — gate `channel_0:write`
- `DELETE /api/channels/:id` — gate `channel_0:write`
- `POST /api/channels/:slotId/import` — gate `channel_0:write`
- `POST /api/channels/reorder` — gate `channel_0:write`, mutates every slot

A user granted only `channel_0:write` could rename, re-PSK, delete, import-into, or reorder **any** channel — including channels the operator deliberately walled off via the per-channel permission model.

### Impact

Authenticated-user-only privilege escalation. Anonymous defaults do not grant write permissions, so this is not anonymous-exploitable. Severity is medium because it requires a compromised or coerced authenticated account that already has at least `channel_0:write`.

### Operator mitigation (pre-patch)

Audit accounts that hold `channel_0:write` and revoke from any user that was not intended to have full per-channel write access.

### Fix

Each endpoint now uses `requireAuth()` plus a per-row `hasPermission(req.user, channel_${id}, ...)` check using the URL's actual id. For `reorder`, every slot whose contents change requires write permission; permutations are cycle-closed so checking destination slots covers source slots. Admins always pass.

---

## Coverage that's locked in

- `src/server/utils/channelView.test.ts` — asserts `transformChannel` never includes `psk`, exposes `pskSet`, and the whitelist is exact.
- `src/server/routes/settingsRoutes.test.ts` — three new cases covering anonymous, non-admin, and admin paths through the secret strip.
- `src/server/services/systemBackupService.tables.test.ts` — asserts `push_subscriptions`, `sessions`, and `backup_history` are never in the system-backup allowlist (lock-in for MM-SEC-1 footnote 1).

## Outstanding

- Move VAPID + apprise + analytics secrets from the `settings` k/v table into a dedicated `secrets` table (structural follow-up to MM-SEC-1's defense-in-depth strip).
- Extract the legacy `/api/messages*` and channel-mutator endpoints from the `server.ts` monolith into dedicated route files so the MM-SEC-3 / MM-SEC-4 patches can grow integration-test coverage without dragging the whole server into a Vitest harness.
- Document the VAPID key rotation procedure in operator-facing docs.

## Credits

Reported by an external security researcher who reviewed the MeshMonitor REST surface in May 2026 and provided actionable findings with references to the affected source lines. Validation, fixes, and this advisory were prepared in coordination with the researcher.
