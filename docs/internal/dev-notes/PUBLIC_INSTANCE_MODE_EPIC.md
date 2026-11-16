# Public-Instance Mode Epic (#5156)

## Goal

One operator-level switch that limits what signed-out viewers (the `anonymous`
account) and public embeds can see. Signed-in users are never redacted.

Already shipped under #5156: privacy/terms/contact links (#5162) and the
per-source `ok_to_mqtt` consent filter (#6393). Turning off anonymous read
entirely already works through the anonymous account's permissions.

## Decisions (user, 2026-11-16)

| Topic | Decision |
|---|---|
| Scope | One global setting, default **off**. Not per source. |
| Positions | Always coarsened when the mode is on: snap to a ~1.5 km grid (Meshtastic `precision_bits` 14). A position that is already coarser passes unchanged. |
| Field toggles | Each toggle is set by the admin in Settings, default **on** once the mode is on: hide long names (short name + id stay), hide public keys (Meshtastic PKI keys; MeshCore keys beyond the id prefix), round timestamps, hide message text. |
| Timestamps | Round down to **1 hour**. |
| Message text | Rows stay listed; the body becomes a placeholder. |
| CoT/TAK feed | **Not** covered. Document it, and warn in Settings when both the CoT feed and the mode are on. |
| Mechanism | One response redactor (middleware wrapping `res.json`) on the API router and the embed router. It walks the JSON payload and redacts by field name. Fails closed: if redaction throws, the request gets an error, never the unredacted body. |
| Audit | A sentinel test seeds unique values (long name, exact lat/lon, key, message text, raw bytes), calls every anonymous-readable GET route with every permission granted to anonymous, and fails if any sentinel appears in a response. |

## Surface survey (2026-11-16)

About 40 anonymous-readable routes. The #6393 helpers are wired into each route
by hand, and the MeshCore, Reticulum and packet routes have no privacy hooks.
Socket.io refuses signed-out connections, so polling (`/api/poll`) is the
anonymous live path. Embeds run with `req.user = null`. `isAnonymousViewer`
(`src/server/utils/mqttConsentVisibility.ts`) treats null as anonymous.
`/api/v1/*` needs an API token and is out of scope. Raw packet payloads (hex
or bytes) encode exact positions and text and must be dropped.

## Phases

- [ ] **Phase 1 — Settings, redactor, middleware.** Five settings keys
  (`VALID_SETTINGS_KEYS`), Settings UI section, a pure redactor module with
  unit tests, and middleware mounted on the API and embed routers. Exit: the
  mode is off by default with no behaviour change; when on, the redactor's
  unit tests cover every field class; typecheck, lint:ci and the suite are green.
- [ ] **Phase 2 — Sentinel audit.** A route-walk test over every mount in
  `server.ts` plus the embed router, run as anonymous with all grants, scanning
  responses for the sentinels. Fix every leak it finds in the redactor's field
  catalogue (not per route). Exit: the audit is green, and a new GET route that
  leaks a sentinel fails CI.
- [ ] **Phase 3 — UI and docs.** The frontend copes with redacted values:
  missing long name falls back to short name, a message-body placeholder,
  coarse-position styling where needed, the CoT warning. User docs and
  dev-notes. Exit: browser-checked as a signed-out viewer, screenshots in the PR.
