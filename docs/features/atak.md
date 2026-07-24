# ATAK / CoT Integration

MeshMonitor understands the Meshtastic **ATAK plugin** wire format and can
re-publish mesh positions as a **Cursor-on-Target (CoT)** feed that ATAK and
WinTAK clients subscribe to directly. The integration ships in three phases,
all tracked under [issue #3691](https://github.com/Yeraze/meshmonitor/issues/3691):

1. **Packet decoding** — ATAK plugin packets are decoded in the Packet Monitor
   and ATAK GeoChat messages are persisted into Messages.
2. **Map contacts** — ATAK device positions render as team-colored markers on
   MeshMonitor's maps.
3. **CoT feed** — a streaming TCP server that pushes mesh nodes and ATAK
   contacts to ATAK/WinTAK as native CoT `<event>` XML.

::: tip Meshtastic sources only
ATAK's plugin protocol (`TAKPacket`, portnum 72) is Meshtastic-specific — it
does not exist on MeshCore. Phases 1 and 2 below apply to Meshtastic sources
only. The Phase 3 CoT feed is the exception: it also synthesizes CoT events
for positioned **MeshCore** nodes, since the feed's job is publishing
everything MeshMonitor knows, not just what arrived over the ATAK plugin.
:::

## Phase 1 — Packet decoding & GeoChat messages

Meshtastic's official ATAK plugin uses `TAKPacket` (portnum 72,
`ATAK_PLUGIN`) to carry position reports (PLI), chat (GeoChat), delivery
receipts, and arbitrary detail payloads. MeshMonitor decodes this in the
[Packet Monitor](/features/packet-monitor):

| Packet Type | What you see |
|-------------|--------------|
| `ATAK_PLUGIN` (72) | `[ATAK PLI …]` for position reports, `[ATAK GeoChat …]` for chat (also delivered to Messages), `[ATAK detail …]`, or `[ATAK GeoChat receipt]` — full decoded `TAKPacket` in the detail view |
| `ATAK_PLUGIN_V2` (78) | Firmware 2.8+ rich CoT, zstd-compressed — shown as `[ATAK V2 (not decoded), N bytes]`. Decoding is a planned follow-up. |
| `ATAK_FORWARDER` (257) | Third-party [ATAK Forwarder](https://github.com/paulmandal/atak-forwarder) packets — identified by name only, not decoded (it's not the official plugin format). |

ATAK **GeoChat** messages are also persisted into MeshMonitor's Messages —
as a channel message or a DM depending on the mesh envelope, with the text
prefixed `[ATAK <callsign>]` and push notifications enabled. Compressed
(`is_compressed=true`) GeoChat text is labeled rather than decoded (unishox2
decompression is out of scope).

## Phase 2 — ATAK contacts on the map

Every ATAK PLI (position) report is persisted as a per-source **ATAK
contact** and rendered as a team-colored callsign marker on the per-source
Nodes map, the Dashboard map, and the Map Analysis canvas.

- Toggle: **Show ATAK Contacts** in the **Map Features** panel (default off).
- Marker color follows the ATAK team color (Cyan, Red, Green, …); the popup
  shows callsign, team, role, battery, course, speed, altitude (HAE), and
  last-seen time.
- **Stale after 15 minutes** without a fresh report — the marker dims and the
  popup shows a **STALE** badge.
- **Retained for 24 hours** after the last report, then purged.
- Contacts without a valid position (e.g. a Null Island fix) are stored but
  not plotted.
- Served at `GET /api/sources/:id/atak/contacts` (requires `nodes:read` on
  the source).

See [Interactive Maps](/features/maps#atak-contacts) for how ATAK contacts
fit alongside the other map layers.

## Phase 3 — CoT feed (ATAK/WinTAK network input)

MeshMonitor can run a plaintext TCP server that streams CoT `<event>` XML —
the format ATAK and WinTAK natively consume as a "network input." Point ATAK
at MeshMonitor's IP and port, and it sees every ATAK contact and every
positioned mesh node as a map contact, with no REST polling or app plugin
required.

### What's in the feed

- **ATAK contacts** — every contact from the Phase 2 `atak_contacts` table,
  across all sources.
- **Meshtastic nodes** — every positioned node across all Meshtastic sources,
  including nodes learned over MQTT.
- **MeshCore nodes** — every positioned node across all MeshCore sources
  (MeshCore has no native ATAK wire format, so these are synthesized
  server-side rather than decoded from a plugin packet).

A node that also has an ATAK contact (e.g. a phone running both the mesh
radio and the ATAK plugin) appears as **two** CoT events — the EUD and the
mesh radio are different real-world things, so they are deliberately not
de-duplicated.

**Private position overrides are never included.** If a node's position has
been overridden and marked private, it is excluded from the feed entirely.

### Delivery model

- A full snapshot is sent to each client **immediately on connect**.
- The full snapshot is then **re-sent to every connected client every 30
  seconds**. ATAK de-duplicates events by `uid` and honors each event's
  `stale` time, so a periodic resend of unchanged events is a cheap, reliable
  refresh — no per-event push/diffing logic is needed.
- Events go stale (and ATAK will grey/drop them) after:
  - **15 minutes** for ATAK contacts (matches the map behavior in Phase 2).
  - **60 minutes** for mesh nodes (Meshtastic and MeshCore).
- The server is receive-only: inbound bytes from ATAK clients are discarded.
  MeshMonitor does not send TAKPackets back onto the mesh.
- Up to **16 concurrent clients**.

### Enabling the feed

1. Sign in as an admin and open **Settings → ATAK / CoT Feed**.
2. Check **Enable CoT feed**.
3. Set **Feed port** (default `8088`).
4. Save. The feed binds on `0.0.0.0:<port>` inside the container immediately
   — no restart required.

The feed is **off by default**.

### Adding MeshMonitor as an ATAK network input

In ATAK (or WinTAK):

1. Open **Settings → Network Connections** (or **Import** → **Network
   Import**, depending on ATAK version).
2. Add a new **Streaming TAK Server / Network Input**.
3. Protocol: **TCP**.
4. Host: the IP or hostname where MeshMonitor is reachable.
5. Port: the value from **Feed port** above (default `8088`).
6. No credentials — the feed has no authentication (see the security note
   below).

Once connected, ATAK contacts and mesh nodes should appear on the map within
a few seconds (immediate snapshot on connect), refreshing every 30 seconds.

::: warning Security: plaintext, unauthenticated, trusted networks only
The CoT feed has **no encryption and no authentication**. Anyone who can
reach the configured port can read every mesh node's live position and every
ATAK contact's position. It binds on `0.0.0.0` (not `localhost`) because
ATAK EUDs are typically remote.

- Keep the feed **off** unless you're actively using it.
- Only expose the port on a trusted network (LAN, VPN) — do not port-forward
  it directly to the internet.
- TLS support is a deferred follow-up, not currently available.
:::

### Docker Compose Example

```yaml
services:
  meshmonitor:
    image: ghcr.io/yeraze/meshmonitor:latest
    container_name: meshmonitor
    ports:
      - "8080:3001"
      - "8088:8088"   # ATAK/CoT feed (enable in Settings after first boot)
    volumes:
      - meshmonitor-data:/data
    restart: unless-stopped

volumes:
  meshmonitor-data:
```

The CoT feed is off by default — publish the port in your compose file, then
enable it in **Settings → ATAK / CoT Feed** as described above.

### Kubernetes/Helm Example

```yaml
service:
  type: LoadBalancer
  ports:
    - name: http
      port: 80
      targetPort: 3001
    - name: atak-cot
      port: 8088
      targetPort: 8088
```

After the pod starts, open **Settings → ATAK / CoT Feed** and enable it.
