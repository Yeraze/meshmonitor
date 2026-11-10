# Spec: #6278, configurable `{text}` length in message notifications

## Maintainer decisions (2026-11-10, binding)
All recommended: two per-(user, source) settings (Web Push/desktop; Apprise), blank = 100 so nothing changes until a user opts in, range 20-1000, body cap scales to at most 1000, emoji-safe truncation, Web Push payload byte guard; desktop shares the push value; title stays 150. Migration: next free number at implementation time.


## Findings
- **Hard limits.** All in `src/utils/notificationTemplate.ts`:
  - `MESSAGE_TEXT_MAX = 100` at :55, applied once at :234: `text: truncate(cleanValue(context.text), MESSAGE_TEXT_MAX)`.
  - `MESSAGE_BODY_RENDERED_MAX = 400` and `MESSAGE_TITLE_RENDERED_MAX = 150` at :51-52, applied in `renderOne` at :210.
  - `truncate()` at ~:160 uses `substring(0, max-3)+'...'`. It can split a surrogate pair (emoji), which leaves a lone surrogate. This is a latent bug, separate from the issue.
- **One render path for every protocol.** `renderMessageNotification` runs in the server, in the route validation and in the UI preview (`NotificationFormatSection.tsx:72-73`). All per-recipient sends go through `renderMessagePayloadForUserAsync` (`src/server/utils/notificationFiltering.ts:604-626`). It reads the exact `(userId, sourceId)` row and passes the templates only. It is called by three services:
  - Web Push: `pushNotificationService.ts:570`
  - Apprise: `appriseNotificationService.ts:487`
  - Desktop: `desktopNotificationService.ts:169`. Desktop is gated by `enableWebPush`, sent once per machine, using the first passing user's templates.
  - The function does not know which service is calling it. Adding that is a one-argument change.
- **Default-render callers.** These render with no prefs. Anonymous push subscribers and the debug log use this result:
  - `messagePushNotifier.ts:168`. This is the shared notifier: Meshtastic TCP, MQTT and MeshCore all go through it (P11 spec §1, :23, :93).
  - `reticulumManager.ts:1164` (Reticulum DMs).
- **Service limits.**
  - **Web Push** (`pushNotificationService.ts:398`) sends the whole `JSON.stringify(wirePayload)`: title, body, data, tag and so on. The encrypted record limit is about 4078 bytes. There is no byte guard today. A 400-character body of 4-byte characters is about 1.6 KB, so there is room, but not unbounded.
  - **Apprise** (`appriseNotificationService.ts:316`) POSTs `{urls,title,body}` to apprise-api. Apprise's default overflow mode is `upstream`, so it passes the body through unchanged. Per-target caps:
    | Target | Body cap |
    |---|---|
    | Discord | 2000 |
    | Pushover | 1024 |
    | Telegram | 4096 |
    | ntfy | about 4 KB |
    | SMS targets | 160 |

    Users can add `?overflow=split` or `?overflow=truncate` to the URL.
  - **Desktop** uses node-notifier. The operating system clips long text itself.
- **Mesh text size.**
  - Meshtastic and MQTT text is at most about 233 bytes.
  - MeshCore text is at most about 160 bytes.
  - Only Reticulum (LXMF) can be longer.
  - So a `{text}` limit of about 250 already shows every Meshtastic and MeshCore message in full. The 400 body cap fits sender plus text. The reported Discord cut is purely the 100-character token limit.
- **Prefs plumbing.** Templates were added by migration 196 as nullable columns on `user_notification_preferences`, one row per `(user, source)`. A new column touches:
  - schema: `src/db/schema/notifications.ts:84-85`, :123, :193 (three dialects)
  - repo: `src/db/repositories/notifications.ts` interface :74, write :342, read :1406
  - `src/server/utils/notificationFiltering.ts` `NotificationPreferences` :52-83 and the legacy blob :278
  - defaults: `src/utils/notificationDefaults.ts:47,92`. `PREF_FIELDS` in `notificationRoutes.ts:305` is derived from these, so the PUT route accepts new keys automatically.
  - route validation: `notificationRoutes.ts` ~:405-430, where the numeric checks for `lowBatteryThreshold` and `waypointRadiusKm` live
  - `src/cli/migrate-db.ts:97-98` column map
  - UI: `NotificationsTab.tsx` interface :45-100 and `NotificationFormatSection` at :1401
  - hand-written PG and MySQL DDL in `src/db/repositories/notifications.test.ts` :127 and :271
  - `src/server/test-helpers/messageNotificationFixture.ts`
- **Not a global setting.** `VALID_SETTINGS_KEYS` (CLAUDE.md) does not apply. That path is for admin-wide settings. Apprise URLs and templates are per `(user, source)`, so this belongs in the prefs row.
- **Stale comment.** The comment at `NotificationsTab.tsx:1399` says "message notifications don't fire for MeshCore". That is no longer true after P11. The section is gated by `caps.messageFilters`.
- **Latest migration** is 228 (`228_refile_meshcore_mqtt_slot_channels.ts`), so the next number is 229. Check open PRs for a clash before using it.

## Design (shared, protocol-agnostic)
1. **`notificationTemplate.ts`**
   - Add `MESSAGE_TEXT_MAX_DEFAULT = 100`, `MESSAGE_TEXT_MAX_MIN = 20` and `MESSAGE_TEXT_MAX_LIMIT = 1000`.
   - Add `resolveMessageTextMax(v: number|null|undefined): number`. It clamps the value; null means the default.
   - Add `validateMessageTextMax(v)`, returning an error object or null, for the route.
   - Change the signature to `renderMessageNotification(ctx, templates?, opts?: { textMax?: number|null })`.
   - The rendered body cap becomes `min(MESSAGE_BODY_RENDERED_LIMIT, max(400, textMax + 300))` with `MESSAGE_BODY_RENDERED_LIMIT = 1000`. This leaves room for the `[nodeName]` prefix under Pushover's 1024 and Discord's 2000. Title stays at 150.
   - Make `truncate` code-point safe with `Array.from`, so an emoji is never cut in half.
2. **Per service, chosen by the caller.** Change the signature to `renderMessagePayloadForUserAsync(userId, payload, sourceId, sourceName, service: 'push'|'desktop'|'apprise')`.
   - push and desktop use `prefs.messageTextMaxPush`.
   - apprise uses `prefs.messageTextMaxApprise`.
   - This changes text only, never who is notified or how many sends go out (the #5593 invariant). The three call sites pass their own service.
3. **Web Push byte guard.** In `sendToSubscription`, if `Buffer.byteLength(JSON.stringify(wirePayload)) > 3800`, shorten `body` code-point-safely until it fits. This is protection against oversized payloads, independent of the user setting.
4. **Default-render callers** (`messagePushNotifier.ts:168`, `reticulumManager.ts:1164`) are unchanged and use the default limit. Anonymous subscribers keep 100.
5. **UI.** In `NotificationFormatSection`, add two number inputs: "Message text length: Web Push / desktop" and "Message text length: Apprise". Blank means the default, and the range is 20 to 1000. Help text: "Mesh messages are at most about 230 characters; Apprise targets have their own caps (Discord 2000, Pushover 1024, SMS 160)". The live preview passes `textMax`, and the sample text in `public/locales/en.json:2884` needs a longer variant so the preview shows the cut. Show the Apprise input only when Apprise is enabled for the row.

## Migration: yes, on all three backends
Add `229_add_notification_text_max.ts` using the 196 pattern with `addColumnIfMissing*`. It is nullable, has no backfill and is idempotent.

| Backend | Columns |
|---|---|
| SQLite | `message_text_max_push INTEGER`, `message_text_max_apprise INTEGER` |
| PostgreSQL | `"messageTextMaxPush" INTEGER`, `"messageTextMaxApprise" INTEGER` |
| MySQL | `messageTextMaxPush INT NULL`, `messageTextMaxApprise INT NULL` |

Register it in `src/db/migrations.ts` with a `settingsKey`. Use the `/migration` skill. Existing rows stay NULL, which means the default, so nothing changes until a user opts in.

## Work packages
- **WP1, template core.** Files: `src/utils/notificationTemplate.ts` plus its test. Tests:
  - the default is still 100
  - `textMax` of 250, 1000 and above 1000 (clamped)
  - the body cap scales with `textMax`
  - a template that uses `{{ text }}` twice still respects the body cap
  - an emoji at the cut point is not split
  - `validateMessageTextMax` rejects non-integers, values out of range and strings
- **WP2, schema and migration.** Files: migration 229 plus `.test.ts` and `.pgmysql.test.ts`; `src/db/migrations.ts`; `src/db/schema/notifications.ts` (three tables); `src/db/repositories/notifications.ts` (interface, write and read mapping; anything not a positive integer reads as null); `src/utils/notificationDefaults.ts`; the `NotificationPreferences` type and legacy blob in `notificationFiltering.ts`; `src/cli/migrate-db.ts`; hand-written DDL in `notifications.test.ts`; `messageNotificationFixture.ts`. Tests:
  - round-trip null and a value on all three backends, with the PG and MySQL containers up, because those suites skip silently otherwise
  - per-source isolation: a value saved for source A does not affect source B (extend `notifications.perSource.test.ts`)
- **WP3, route.** File: `src/server/routes/notificationRoutes.ts`. Validate both fields as integers or null, 400 when invalid, and normalise blank to null. Tests: extend `notificationRoutes.templates.test.ts` and `.perSource.test.ts`.
- **WP4, delivery.** Files: `notificationFiltering.ts` (service argument), `pushNotificationService.ts` (pass `'push'`, add the byte guard), `appriseNotificationService.ts` (`'apprise'`), `desktopNotificationService.ts` (`'desktop'`). Tests:
  - extend `messageNotification.rendering.test.ts`: a 200-character message with Apprise set to 500 arrives in full on Apprise and cut on push at the default
  - `messageNotification.sendCount.test.ts`: send counts are unchanged
  - a byte-guard unit test with a 4-byte-character body
  - a MeshCore source case to show protocol parity
- **WP5, UI and i18n.** Files: `NotificationFormatSection.tsx` plus its test, `NotificationsTab.tsx` (interface and pass-through), `public/locales/en.json`, and fix the stale comment. Tests: the input clamps and stores null when blank, and the preview reflects `textMax`.
- **WP6, docs.** Update the notifications user docs. Add a hint about Apprise `?overflow=split` for targets with short limits.

## Open questions (recommended answer first)
1. **Per service or a single per-user value?** Recommend **per service, stored per `(user, source)`**: two columns, one for push and desktop, one for Apprise. It matches the issue ("Web Push short, Discord long"), and both services already live in the same row. A single value would make users pick between a short push preview and the full Discord text. A global admin setting does not fit, because Apprise URLs are per user.
2. **Defaults.** Recommend leaving both NULL, meaning 100, so existing users see no change. Alternative: make the Apprise default 250, which would fix every Meshtastic and MeshCore message out of the box. Ask the user before changing the default (CLAUDE.md, "Ask the user before you pick a limit").
3. **Maximum.** Recommend 1000 for both settings, with the rendered body capped at 1000. That is safe for Pushover and Discord. Truncation for SMS-style targets is left to Apprise `overflow=`. Is a per-Apprise-URL limit wanted? Recommend no; the Apprise URL parameter covers it.
4. **Title length (150).** Recommend not making it configurable now.
5. **Desktop.** Recommend sharing the push value, because desktop is already gated by `enableWebPush`. Giving desktop its own column adds clutter for a single-machine feature.

## Out of scope
- Configurable title length, or limits for other notification types (new node, low battery, waypoint, server events). Those strings do not go through the `{text}` token.
- Per-Apprise-URL limits, or splitting long bodies into several messages inside MeshMonitor.
- Reworking the anonymous-subscriber default render.
- Changing Apprise's overflow behaviour on the server side.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/utils/notificationTemplate.ts
- /home/yeraze/Development/meshmonitor/src/server/utils/notificationFiltering.ts
- /home/yeraze/Development/meshmonitor/src/db/repositories/notifications.ts (with /home/yeraze/Development/meshmonitor/src/db/schema/notifications.ts and the new src/server/migrations/229_*.ts)
- /home/yeraze/Development/meshmonitor/src/server/services/pushNotificationService.ts (byte guard; Apprise and desktop are one-line changes)
- /home/yeraze/Development/meshmonitor/src/components/NotificationFormatSection.tsx
