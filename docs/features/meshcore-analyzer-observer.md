# MeshCore Analyzer Observer

::: tip Added in 4.14 (#4457)
Publish packets your MeshCore Companion hears to a MeshCore Analyzer MQTT broker (FL Mesh, LetsMesh, or a compatible regional broker), so your node counts as an observer.
:::

## What it is

The Analyzer Observer relays every packet your MeshCore Companion hears to a MeshCore-Analyzer-compatible MQTT broker. Your node then shows up on that broker's regional analyzer as an observer — without a second app fighting your Companion for the serial port.

**This is observation-only.** MeshMonitor:

- Never subscribes to the broker
- Never injects broker traffic back onto the mesh
- Never transmits on your behalf

It publishes what the radio already heard. Nothing more.

Because it only ever publishes outbound to a broker over the network, the Analyzer Observer keeps running unaffected when a source is in [receive-only mode](/features/meshcore-receive-only) — receive-only blocks the radio path, not this one.

## Requirements

- A **Companion** source (not a Repeater, not a Room Server) — the Analyzer Observer needs the device's signing key, and only Companions can export one.
- The source connected at least once, so MeshMonitor can fetch the key from the device (or you can paste one by hand — see [Step 2](#step-2-provide-the-signing-key)).
- A fixed `SESSION_SECRET`. MeshMonitor encrypts the stored signing key with a key derived from `SESSION_SECRET`. If yours is auto-generated, key storage is disabled and the UI tells you so. See [Credential store](/features/meshcore#credential-store) for the same requirement on the remote-admin password store, and set `SESSION_SECRET=$(openssl rand -hex 32)` in your environment to enable it.
- A **broker URL**, **region code**, and **token audience** from your region's analyzer operator (for example, FL Mesh or LetsMesh).

## Step 1 — Enable and configure

Open the Dashboard, edit the MeshCore source, and expand the **Analyzer Observer** fieldset.

| Field | Example | Notes |
|---|---|---|
| Broker URL | `wss://mqtt-us-v1.letsmesh.net:443` | Accepts `ws://`, `wss://`, `mqtt://`, `mqtts://`, or a bare `host:port` (defaults to `mqtt://`). |
| Region (IATA) | `MCO` | A 3-letter IATA code for your region, or `test` for a local broker. Case-insensitive — MeshMonitor uppercases it on save. |
| Token audience | `meshcore-mqtt` | Must match the broker's expected audience exactly, or the broker rejects your login. Ask your region's operator. |

Check the enable box, fill in the three fields, and save. Saving an Analyzer Observer change hot-swaps the publisher — it starts, stops, or reconfigures without bouncing the radio link, so your MeshCore connection stays up the whole time.

::: warning Companion only
Repeaters cannot export a signing key, so the enable checkbox is disabled with an explanation when the source's device type is Repeater.
:::

## Step 2 — Provide the signing key

The broker authenticates you as your node: it verifies a short-lived Ed25519 token signed with the node's own private key, and your broker username is `v1_{PUBLIC_KEY}`. MeshMonitor needs that key to sign tokens on your behalf.

Go to the source's **MeshCore → Configuration** page and open **Analyzer Observer**.

- **Fetch from device** (preferred) — reads the 64-byte private key straight from the connected Companion. Requires the source to be connected.
- **Enter key manually** — paste a 128-character hex private key if you already have one. Use this when the source can't connect right now, or the key comes from elsewhere.

Either way, MeshMonitor stores the key **encrypted**, and no API ever returns it. Only the public key is shown, and it's shown truncated with a copy button.

::: warning The key is your node's identity
The signing key is the same key that proves your node's identity on the mesh. Treat a manually pasted key the same way you'd treat a password — anyone with it can publish to the broker as you.
:::

If `SESSION_SECRET` changes after a key is stored, the key can no longer be decrypted. The Configuration page shows a **key rotated** warning in that case — re-import from the device or re-paste the key to recover. The public key stays correct and visible throughout.

## Step 3 — Verify

Back on the Configuration page, the **Analyzer Observer** status block shows:

- **Connected** — the publisher has an open, authenticated connection to the broker.
- **Packets published** — a running count since the publisher last started. Climbing means packets are flowing.
- **Last publish** — a relative timestamp; should stay recent while the mesh is active.

Once connected, check your region's analyzer site — your node should appear in its observers list, usually within a minute or two.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "No signing key stored" | You haven't fetched or pasted a key yet | Click **Fetch from device**, or paste one |
| "Key rotated" warning | `SESSION_SECRET` changed since the key was stored | Re-import from the device, or re-paste it |
| Not connected, error mentions the token | `tokenAudience` doesn't match the broker's expected value | Match it exactly — check with your region's operator |
| Not connected, no error shown | Broker unreachable | Check the broker URL, scheme, and port |
| Dropped-packet count climbing | The broker socket was down when packets arrived | Expected during a broker outage — nothing is lost on the mesh, only unpublished |
| "Requires a Companion device" on save | The source's device type is Repeater | The Analyzer Observer works with Companions only |

Published/dropped counters are cumulative since the publisher last started, and reset when the source reconnects or you change the observer config.

## Privacy and what is published

Be clear-eyed about this before you turn it on: **the raw hex of every OTA frame your Companion hears leaves your network and goes to a third-party broker.** Encrypted payloads stay encrypted in transit — MeshMonitor doesn't decrypt anything for the broker — but everything your radio can hear, someone else's server now has a copy of.

Per heard packet, MeshMonitor publishes:

- Timestamp, packet type, and route type
- Hop-path hashes
- SNR, RSSI, and packet length
- A packet hash
- The raw hex of the OTA frame

It also publishes a retained online/offline status message carrying your device name, model, firmware version, and radio parameters.

If you're not comfortable with a third party seeing everything your node hears — even encrypted — don't enable this feature.

## What it does not do

- No subscribing to the broker
- No remote-serial or `serial/commands` support
- No advert transmission on your behalf
- No fan-out to multiple brokers at once
- No `raw`, `decoded`, or `debug` topic publishing

## Related

- [MeshCore Support](/features/meshcore) — source setup, credential store, and remote administration
