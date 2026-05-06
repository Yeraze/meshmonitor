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

---

## MM-SEC-5 — Authenticated disclosure of local-node PKI private key via `GET /api/device/security-keys`

**Severity:** High.
**Affected versions:** All releases up to and including v4.2.1.
**Fixed in:** PR (this commit on `main`); shipping in next release.
**Reporter:** External researcher (follow-on audit).

### Issue

`GET /api/device/security-keys` returned the local node's `actualDeviceConfig.security` blob — both the public key and the **base64-encoded private key** — to any authenticated caller. The route's gate was `requireAuth()` only; no resource permission was checked. The route source comment named the intended property ("Private key is sensitive - requires authentication") but the gate did not enforce admin scope.

### Impact

The local node's PKI private key permits the holder to decrypt PKI-encrypted DMs received by the local node, forge signed packets from the local node (NodeInfo, position broadcasts, channel-signed payloads, admin-channel responses), and impersonate the local node to any party that holds its public key. The device private key is broader-scoped than a channel PSK — a PSK authenticates one channel, the device key authenticates the device across every PKI interaction.

### Operator mitigation (pre-patch)

Audit user accounts and disable any non-admin account whose `is_active` is `true`. Block `GET /api/device/security-keys` at the reverse proxy for non-admin sessions until the patch is deployed.

### Fix

Replace `requireAuth()` with `requireAdmin()` on `apiRouter.get('/device/security-keys', …)` in `src/server/server.ts`. The route now matches the rest of the admin-only device surface (`/admin/*`, `/push/vapid-subject`).

---

## MM-SEC-6 — Cross-channel PSK disclosure via `GET /api/channels/debug`

**Severity:** Medium.
**Affected versions:** All releases up to and including v4.2.1.
**Fixed in:** PR (this commit on `main`); shipping in next release.
**Reporter:** External researcher (follow-on audit).

### Issue

`GET /api/channels/debug` was a `SELECT * FROM channels` pass-through (`databaseService.channels.getAllChannels()`) gated on the unrelated `messages:read` permission. Any caller holding `messages:read` received the raw 32-byte `psk` for every channel, bypassing both the per-channel `channel_${id}:read` gate and the `transformChannel` projection that MM-SEC-2 established as the canonical pattern for read-class channel endpoints. Deployments that grant `messages:read` to anonymous made it anonymous-exploitable.

### Impact

Same as MM-SEC-2: PSK disclosure permits decryption of on-air channel traffic and injection of signed traffic on every disclosed channel.

### Operator mitigation (pre-patch)

Block `GET /api/channels/debug` at the reverse proxy. The route had no UI consumers — `/api/channels` and `/api/channels/all` cover the legitimate use cases.

### Fix

Route deleted. Comment in `src/server/server.ts` records why; the api-exercise smoke test (`tests/api-exercise-test.sh`) drops its `/channels/debug` check.

---

## MM-SEC-7 — Cross-channel PSK disclosure via `GET /api/sources/:id/channels`

**Severity:** Medium.
**Affected versions:** All releases up to and including v4.2.1.
**Fixed in:** PR (this commit on `main`); shipping in next release.
**Reporter:** External researcher (follow-on audit).

### Issue

Same root cause as MM-SEC-2/MM-SEC-6 — `databaseService.channels.getAllChannels(sourceId)` was passed straight to `res.json()` with `psk` intact. The route's gate (`messages:read`, scoped to the URL's source) is unrelated to channel cryptographic material. PR #2905 patched the three sibling endpoints in `server.ts` but missed this one, which lives in `src/server/routes/sourceRoutes.ts`.

### Impact

Identical to MM-SEC-6.

### Operator mitigation (pre-patch)

Block `GET /api/sources/:id/channels` at the reverse proxy until the patch is deployed; non-source-aware clients should keep using `/api/channels`.

### Fix

The route now uses `optionalAuth()` plus a per-row `channel_${id}:read` check scoped to the URL's source, then projects through `transformChannel` so the raw PSK is never serialized. Admins still see all channels (no PSK in any case).

---

## MM-SEC-8 — Inconsistent credential strip on `GET /api/sources/:id`

**Severity:** Low.
**Affected versions:** All releases up to and including v4.2.1.
**Fixed in:** PR (this commit on `main`); shipping in next release.
**Reporter:** External researcher (follow-on audit).

### Issue

`GET /api/sources` (list) destructures `password` and `apiKey` out of each source's `config` blob before responding (`sourceRoutes.ts:54`). The adjacent `GET /api/sources/:id` (singular) returned the raw row, including credentials, to any caller with `sources:read`. The two routes treated the same data class differently.

### Impact

Low — `sources:read` is not granted to anonymous in the standard public-viewer config, and the resource description for `sources` (`src/types/permission.ts`) does not explicitly say credentials are out of scope. Filed because two adjacent routes in the same file disagreed on the strip; the list endpoint's `void password; void apiKey; // intentionally stripped` comment was the stronger signal, and the MM-SEC-1 pattern (secrets are admin-only regardless of resource grant) aligns with that.

### Fix

Both endpoints now route through a shared `stripSourceSecrets(source, isAdmin)` helper. Admins still receive the full record (the source-edit UI re-posts the same blob it loaded); everyone else gets `password` and `apiKey` removed from `config`. A single helper prevents the inconsistency from recurring.

---

## Coverage that's locked in

- `src/server/utils/channelView.test.ts` — asserts `transformChannel` never includes `psk`, exposes `pskSet`, and the whitelist is exact.
- `src/server/routes/settingsRoutes.test.ts` — three cases covering anonymous, non-admin, and admin paths through the secret strip.
- `src/server/services/systemBackupService.tables.test.ts` — asserts `push_subscriptions`, `sessions`, and `backup_history` are never in the system-backup allowlist (lock-in for MM-SEC-1 footnote 1).
- `src/server/routes/sourceRoutes.security.test.ts` — MM-SEC-7 (PSK never serialized; per-channel filter enforced for non-admins; admin still sees all channels) and MM-SEC-8 (admins receive `password`/`apiKey`, non-admins do not, on both list and singular endpoints).
- `src/server/routes/sourceRoutes.permissions.test.ts` — updated for MM-SEC-7's new gate (`/sourceB/channels` returns `200 []`, not `403`).
- MM-SEC-5 (`/api/device/security-keys`) and MM-SEC-6 (`/api/channels/debug` deletion) live in the `server.ts` monolith and are exercised by `tests/api-exercise-test.sh` plus the manual reproduction in this advisory; lifting them into Vitest is tracked under "Outstanding" below.

## Outstanding

- Move VAPID + apprise + analytics secrets from the `settings` k/v table into a dedicated `secrets` table (structural follow-up to MM-SEC-1's defense-in-depth strip).
- Extract the legacy `/api/messages*` and channel-mutator endpoints from the `server.ts` monolith into dedicated route files so MM-SEC-3 / MM-SEC-4 / MM-SEC-5 / MM-SEC-6 patches can grow integration-test coverage without dragging the whole server into a Vitest harness.
- Document the VAPID key rotation procedure in operator-facing docs.
- Document `sources:read` scope explicitly in `src/types/permission.ts`'s resource description (ties off the ambiguity called out in MM-SEC-8).

## Credits

Reported by an external security researcher who reviewed the MeshMonitor REST surface in May 2026 and provided actionable findings with references to the affected source lines. The follow-on audit (MM-SEC-5 through MM-SEC-8) was contributed by The Official Mesh Admin <officialmeshadmin@proton.me>. Validation, fixes, and this advisory were prepared in coordination with the researchers.
