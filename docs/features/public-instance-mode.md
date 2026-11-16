# Public-Instance Mode

*Added in 4.16.0.*

Limit what strangers can see on a MeshMonitor you open to the public.

If signed-out visitors can read your dashboard, they can read node names, exact positions,
message text, and public keys. Public-instance mode removes or blurs that data before it
leaves the server. It applies to every signed-out viewer and to embed maps.

Signed-in users never see redacted data, whatever their role.

## Turn it on

Open **Settings** and find **Public-instance mode** (`settings-public-instance`).
The master switch starts off. Turn it on, then pick what to hide.

| Setting | Default | What it does |
|---|---|---|
| Public-instance mode (master switch) | Off | Nothing below applies until you turn this on. |
| Hide long names | On | Removes long names. Short name and node ID stay. |
| Hide public keys | On | Cuts MeshCore keys to a 12-hex prefix and removes Meshtastic keys. |
| Round times down to the hour | On | Rounds timestamps down to the hour. |
| Hide message text | On | Replaces message text with a placeholder. |

The four toggles only matter once the master switch is on. Each starts on, so switching
the master on gives you the strictest setup.

## Always on

These rules apply whenever the master switch is on. You cannot turn them off.

| Data | What a signed-out viewer sees |
|---|---|
| Positions | Snapped to a grid of about 1.5 km. If a node already reports a coarser precision, that coarser value stays. |
| Distances | Rounded to 1.5 km. |
| Bearings | Rounded to 10 degrees. |
| Altitudes | Rounded to 100 m. |
| Raw packet payloads | Dropped. |
| CSV, NDJSON, and file exports | Blocked. The server answers `403` with code `PUBLIC_INSTANCE_UNSUPPORTED_RESPONSE`. |

## What each toggle changes

**Hide long names.** Long names become empty. Short names and node IDs stay, so people can
still tell nodes apart. A sender name inside MeshCore channel text goes too, unless message
text is also hidden.

**Hide public keys.** MeshCore keys keep their first 12 hex characters. Meshtastic keys are
removed, along with key-fragment details from key-security checks.

**Round times down to the hour.** Last-heard times, message times, and similar fields drop
to the start of the hour.

**Hide message text.** Message text becomes `[hidden on this public instance]`. Mesh waypoint
names and descriptions get the same placeholder, since mesh users write them.

## What stays visible

- Map markers you create as the operator.
- GeoJSON layers and map styles.
- Short names, node IDs, and device roles.

## What it does not cover

- **The CoT/TAK feed.** The TCP feed sends exact positions to anyone who connects. Settings
  shows a warning when both the feed and public-instance mode are on. See
  [ATAK / CoT Integration](./atak#phase-3-cot-feed-atak-wintak-network-input).
- **The `/api/v1` token API.** Token holders are not signed-out viewers, so the mode skips
  them. Issue tokens only to people you trust with exact data.

## Related controls

Public-instance mode changes what signed-out viewers see. It does not decide whether they
can see a source, channel, or page at all.

- **Anonymous-user permissions.** To hide data entirely, take read access away from the
  anonymous user. Public-instance mode then has nothing left to redact for that data.
- **`ok_to_mqtt` filter.** A separate per-source setting (#6393) hides a node, and its data,
  from signed-out viewers when the node reached you over MQTT with `ok_to_mqtt` off and was
  never heard directly over RF on that source. It works with or without public-instance mode.
- **Embed maps.** [Embed maps](./embed-maps) always count as signed-out, even if a signed-in
  user opens the page that hosts them.

Pair this with your [Privacy Disclosures](./privacy-disclosures) so visitors know what you
show and what you hide.

## For developers

The server redacts API responses by field name. The catalogue lives in
`PUBLIC_INSTANCE_FIELD_CATALOGUE` in `src/server/utils/publicInstanceRedactor.ts`. The
middleware in `src/server/middleware/publicInstanceRedaction.ts` applies it to every
response for a signed-out viewer.

- A new field that carries a position, name, key, text, or timestamp must match the
  catalogue. Fix leaks in the catalogue, with a unit test, not in one route.
- `src/server/routes/publicInstance.sentinelAudit.test.ts` walks every `GET` route as a
  signed-out viewer and fails if a seeded sentinel value leaks. New routes need no setup;
  edit the table file only for routes the defaults cannot call.
- Frontend code must handle null long names and null keys. Use `getUserDisplayName`.
- Design notes: `docs/internal/dev-notes/PUBLIC_INSTANCE_MODE_EPIC.md`.
