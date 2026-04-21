# Store &amp; Forward

::: tip New in 4.0 (Phase 0)
MeshMonitor is now a Store &amp; Forward **client**. It recognizes S&amp;F server nodes on your mesh and can request history from them. Full server functionality remains on the node itself.
:::

## What is Store &amp; Forward?

Meshtastic's Store &amp; Forward module lets a powered node (usually a mains-powered repeater) cache messages while recipients are offline, then replay them on request. Nodes acting as S&amp;F servers are marked as `is_store_forward_server` in their device metadata.

## What MeshMonitor does

- **Detects S&amp;F servers** — nodes with the S&amp;F server flag are visually marked in the Nodes list and on the map
- **Labels relayed messages** — messages that arrived `via_store_forward` are tagged in the message history so you can distinguish them from direct traffic
- **Receives replays** — when an S&amp;F server pushes `ROUTER_TEXT_DIRECT` / `ROUTER_TEXT_BROADCAST` history to the mesh, MeshMonitor ingests those messages and tags them accordingly
- **Preserves S&amp;F metadata across upgrades** — two new database fields (`is_store_forward_server`, `via_store_forward`) were added in migrations 034 and 035

::: info Passive client only
MeshMonitor does not actively request history from S&amp;F servers — it reacts to replays the server decides to push. Enabling S&amp;F history requests (a `CLIENT_HISTORY` message) is on the roadmap.
:::

## When it helps

- Intermittent coverage — messages you missed while out of range are still retrievable
- Shared repeaters — a community repeater acts as a message buffer for the whole mesh
- Debugging — spot messages that transited an S&amp;F peer instead of direct RF

## Configuration

Store &amp; Forward itself is configured on the **device** (firmware config, not MeshMonitor). Use the [device configuration](/features/device) UI or the Meshtastic mobile app to:

1. Enable the Store &amp; Forward module on the node
2. Choose whether it runs as a server, client, or both
3. Tune retention (history entries, record time window)

Once the node reports S&amp;F capability to MeshMonitor (it comes through as part of device info), MeshMonitor's S&amp;F awareness activates automatically — no per-source configuration needed.

## Related

- [Device Configuration](/features/device)
- [Message Search](/features/message-search)
- Meshtastic firmware S&amp;F docs: <https://meshtastic.org/docs/configuration/module-config/store-and-forward/>
