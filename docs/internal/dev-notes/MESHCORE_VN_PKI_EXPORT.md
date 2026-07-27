# MeshCore Virtual Node — private-key export (`ExportPrivateKey`, cmd 23)

**Origin:** discussion #3933 — a user running
[Remote-Terminal for MeshCore](https://github.com/jkingsman/Remote-Terminal-for-MeshCore)
against MeshMonitor's Virtual Node hit:

> Community MQTT needs the radio's private key to authenticate, but it isn't
> available. Your radio firmware may not support key export
> (`ENABLE_PRIVATE_KEY_EXPORT=1`), or you're connecting through a proxy that
> doesn't forward the key-export command.

MeshMonitor **was** that proxy. `MESHCORE_VN_ADMIN_FORWARDING.md` deferred
`ExportPrivateKey`(23) as "warrants its own design + review" — this is that
design.

## What it does

Some MeshCore tooling authenticates *as the node itself* by signing with the
node's Ed25519 identity key, so it asks the connected "radio" to hand that key
over. The VN now answers `ExportPrivateKey`(23) instead of letting it fall
through to `default:` → `Err(UnsupportedCmd)`.

The key is **not** MeshMonitor's to invent. `source_pki_keys` holds *Meshtastic*
X25519 keys and is unrelated. The VN relays the physical node's own key via the
already-tested `MeshCoreManager.exportPrivateKey()` → native-backend
`export_private_key` → `meshcore.js connection.exportPrivateKey()` path that
backs the existing `GET /api/sources/:id/meshcore/config/private-key` route.

**Consequence:** the physical node's firmware must itself be built with
`ENABLE_PRIVATE_KEY_EXPORT=1`. This feature removes MeshMonitor as a blocker; it
cannot conjure a key a node refuses to give.

## Why a separate flag, not `allowAdminCommands`

`allowPkiExport` is its own opt-in, defaulting to `false`. The two gates are
independent in both directions, and there are tests asserting that.

Admin commands let a client *change* the node; you can undo a bad radio setting.
The private key lets a client *become* the node — on any mesh, indefinitely,
with no way for anyone to distinguish the copy from the original, and no
revocation. The VN port has **no per-client authentication**, so anyone who can
reach it can take the identity. That is a different decision from "I trust this
app to set my TX power", and it deserves its own checkbox. Firmware gates it
behind a compile-time flag for the same reason.

## Response semantics (what the app sees)

| Situation | Response |
|---|---|
| `allowPkiExport` off | `Disabled(15)` — the manager is never called |
| node returned nothing (offline, or firmware without the flag) | `Err(BadState)` |
| node returned a short/malformed key | `Err(BadState)` |
| manager threw | `Err(BadState)` |
| success | `PrivateKey(14)` + 64 raw key bytes |

`Disabled(15)` rather than `Err` for the off case is deliberate: it is
byte-identical to what real firmware built *without* `ENABLE_PRIVATE_KEY_EXPORT`
returns, and `meshcore.js` turns it into a distinct `reject("disabled")`. Apps
therefore surface an accurate "key export unavailable" message instead of a
generic failure or a silent hang.

**Never zero-pad a short key.** `meshcore.js`'s `onPrivateKeyResponse` reads a
fixed 64 bytes with no length check, so a padded reply would look like a valid
key to the app. `encodePrivateKey()` validates 128-char hex and throws;
`handleExportPrivateKey` converts that throw into `Err(BadState)`.

## Auditing

Each served export writes an audit row (`meshcore_vn_export_private_key`,
resource `configuration`) carrying the source id, VN client id, and client IP.
`userId` is `null` — the VN port has no session to attribute it to, which is
precisely why the row matters. The write is fire-and-forget and can never fail
the export; `ChannelsDb.auditLogAsync` is optional so injected test doubles
don't have to stub it.

## Drive-by: `getClientDetails()` on the MeshCore VN

Surfacing `allowPkiExport` in the Info tab meant reading
`GET /api/status/virtual-node/status` — which turned out to be broken for
MeshCore sources entirely. `statusRoutes` calls `vn.getClientDetails()` on
whichever VN a manager exposes; the Meshtastic VN implements it, the MeshCore VN
never did. Any MeshCore source with a VN enabled threw `TypeError`, and the
route's `catch` flattened that into a 500 for **every** source in the response.

Fixed on both ends: `MeshCoreVirtualNodeServer.getClientDetails()` now exists
(same `{ id, ip, connectedAt, lastActivity }` shape as the Meshtastic one, so the
shared Info tab component renders both), and the route duck-types the call so one
missing method degrades that single source instead of the whole endpoint.

## Known limitation: MeshCore VN config is not hot-swappable

`sourceRoutes` only hot-swaps virtual-node config for `meshtastic_tcp` sources,
and `MeshCoreManager` has no `reconfigureVirtualNode()`. Its VN server is
constructed once, on connect (`startVirtualNodeServer`), and reads
`allowPkiExport` as a `readonly` field at construction.

So toggling the checkbox on a **connected** MeshCore source does not take effect
until the source reconnects. This is pre-existing behaviour shared with
`allowAdminCommands` (#3905), not new here — but it is a real footgun for a
security toggle, and worth fixing separately by giving `MeshCoreManager` a
`reconfigureVirtualNode()` that restarts the VN server in place.

## Still out of scope

- **`ImportPrivateKey`(24)** — overwrites the node's identity. Destructive, and
  it has no business on an unauthenticated TCP port. Remains
  `Err(UnsupportedCmd)`.
- **Repeater (serial-CLI) sources** — Companion (`meshcore.js`) only, like the
  rest of the VN.
