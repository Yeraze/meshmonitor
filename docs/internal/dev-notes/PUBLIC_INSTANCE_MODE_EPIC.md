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
| Derived geometry | Always coarsened when the mode is on, so coarse positions cannot be trilaterated: distances to the nearest 1.5 km, bearings/headings to 10°, altitudes to 100 m (exact 0 and null pass). User decision 2026-11-16. |
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

- [x] **Phase 1 — Settings, redactor, middleware.** Five settings keys
  (`VALID_SETTINGS_KEYS`), Settings UI section, a pure redactor module with
  unit tests, and middleware mounted on the API and embed routers. Exit: the
  mode is off by default with no behaviour change; when on, the redactor's
  unit tests cover every field class; an integration test on real routes
  (`/api/nodes`, `/api/poll`) shows the same seeded node exact for a signed-in
  user and trimmed for an anonymous one; typecheck, lint:ci and the suite are green.
- [x] **Phase 2 — Sentinel audit.** A route-walk test over every mount in
  `server.ts` plus the embed router, run as anonymous with all grants, scanning
  responses for the sentinels. Fix every leak it finds in the redactor's field
  catalogue (not per route). Exit: the audit is green, and a new GET route that
  leaks a sentinel fails CI.
- [ ] **Phase 3 — UI and docs.** The frontend copes with redacted values:
  missing long name falls back to short name, a message-body placeholder,
  coarse-position styling where needed, the CoT warning. User docs and
  dev-notes. A component test renders the node list, node detail and messages
  from a signed-in and an anonymous payload and asserts exact vs trimmed values
  on screen (user request 2026-11-16). Exit: browser-checked signed in and
  signed out, side-by-side screenshots in the PR.

## Phase 1 notes (2026-11-16)

- Coordinates always snap: to the declared precision when it is 1–13 bits,
  else to 14. An exact override beside a coarse precision field cannot leak.
- Numeric strings (PG/MySQL BIGINT, BigInt JSON) are redacted like numbers.
- A config read failure answers 503 to anonymous viewers; signed-in users pass.
- `json()` always redacts for anonymous viewers, even on exempt routes; only a
  pre-serialised `send()` honours the exempt marker.
- Bare `distance` is treated as km; setting-like `*Distance` keys are rounded
  too (accepted over-redaction).

## Phase 2 notes (2026-11-16)

Audit: `src/server/routes/publicInstance.sentinelAudit.test.ts` (helpers in
`test-helpers/publicInstanceAudit.ts` and `routerWalker.ts`, exceptions in
`publicInstance.sentinelAudit.table.ts`). It walks the real `/api` router
(built by `createApiRouter`) and `/api/embed`, calls every GET as an anonymous
viewer with all grants and every toggle on, and scans bodies and headers for
seeded sentinels (coordinates, names, keys, text, raw payloads, timestamps,
geometry) in Meshtastic, MeshCore, Reticulum, MQTT and embed data. It then
replays each raw body with one toggle at a time, and prints an over-redaction
report. About 83 routes reach data; floors in the table file only go up.

**Adding a route.** Nothing to do: the walker finds it and the audit calls and
scans it. Touch the table file only when needed: `ROUTE_OVERRIDES` for params the
defaults cannot fill (or a required query), `EXPECT_ERROR` for a 5xx the fakes
cause by design, `SKIP` for a route that cannot run (filesystem, stream). A key
that matches no route fails the audit. A new field that leaks is fixed in the
redactor catalogue, with a unit test, never per route.

**Out of the audit.** `/api/privacy` (operator policy documents),
`/api/scripts` (script filenames), `/api/v1` (token API; the middleware
bypasses it), and every non-GET route.

**Leaks found and how each was fixed (all in the catalogue or walker):**
- Names under keys the catalogue missed (`from_node_longName`, `fromNodeName`,
  `toNodeName`, `localName`, `node_name`): added to `longNames`
  (`/_longName$/` pattern). The Reticulum `remote-status` hit came from a fake
  with an invented `displayName`; the real reply has none, so the fake was fixed.
- `keySecurityIssueDetails` (8-char key fragment): `publicKeys.exact`, nulled;
  the boolean flags stay.
- `uncertaintyKm`, `positionEstimateUncertaintyKm`, and the
  `estimatedUncertainty` map keyed by node id: km class (nearest 1.5). New
  `valueMaps` rule: a classified parent key whose value is a plain object applies
  the class to that object's numeric leaves (one level, keys are ids).
- `/messages/first-unread` `channels` / `directMessages` maps and `seqCursor`:
  the two map keys are too generic alone, so `timestamps.gatedValueMaps`
  matches each only beside the other. `seqCursor` is the newest message
  timestamp, so it is a timestamp.
- Waypoints come from mesh users (WAYPOINT_APP), so their `name` and
  `description` are user content: `messageText.gated` on the `waypointId`
  sibling. Map markers are created by the operator in the UI (`createdByUserId`,
  no mesh path), the same as geojson layers and embed profile text, and stay
  visible; their audit seed is not a sentinel.
- MeshCore sender name inside channel text: confirmed in
  `meshcoreManager` (`plain.senderName ? plain.text : mc1ChannelBody(plain.text)`:
  without a sender name the stored text is the wire `Name: body`). New value
  rule `EMBEDDED_SENDER_NAME`: with hideLongNames on and hideMessageText off,
  strip a leading `^[^:\n]{1,32}: ` from `text` on a channel-shaped object
  (`messageType` channel, or a `channel-` id in `fromPublicKey`, `toPublicKey`
  or `fromNodeId`) that has no name field of its own.

**Over-redaction report.** One candidate: `/sources/:id/mqtt/native`
`config.longName`, the operator's own node identity. Kept redacted, consistent
with hiding long names.

