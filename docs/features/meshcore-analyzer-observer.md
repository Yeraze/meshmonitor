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

- A **Companion** source (not a Repeater, not a Room Server) — only the Companion backend reports the packets this feature relays.
- The source connected at least once, so MeshMonitor knows the node's public key (and, in signed-token mode, can fetch the signing key from the device — or you can paste one by hand, see [Step 2](#step-2-provide-broker-credentials)).
- A fixed `SESSION_SECRET`. MeshMonitor encrypts the stored signing key **and** the stored broker password with keys derived from `SESSION_SECRET`. If yours is auto-generated, credential storage is disabled and the UI tells you so. See [Credential store](/features/meshcore#credential-store) for the same requirement on the remote-admin password store, and set `SESSION_SECRET=$(openssl rand -hex 32)` in your environment to enable it.
- A **broker URL** and **region code** from your region's analyzer operator, plus either a **token audience** (signed-token brokers) or a **username and password** (static-credential brokers).

## Step 1 — Enable and configure

Open the Dashboard, edit the MeshCore source, and expand the **Analyzer Observer** fieldset.

| Field | Example | Notes |
|---|---|---|
| Broker authentication | Signed token | How the broker checks who you are. See below. |
| Broker URL | `wss://mqtt-us-v1.letsmesh.net:443` | Accepts `ws://`, `wss://`, `mqtt://`, `mqtts://`, or a bare `host:port` (defaults to `mqtt://`). |
| Region (IATA) | `MCO` | A 3-letter IATA code for your region, or `test` for a local broker. Case-insensitive — MeshMonitor uppercases it on save. |
| Token audience | `meshcore-mqtt` | **Signed-token mode only.** Must match the broker's expected audience exactly, or the broker rejects your login. Ask your region's operator. Hidden in username/password mode. |

Check the enable box, fill in the fields, and save. Saving an Analyzer Observer change hot-swaps the publisher — it starts, stops, or reconfigures without bouncing the radio link, so your MeshCore connection stays up the whole time.

### Which authentication mode?

::: tip Added in 4.15 (#4595)
The **Username / password** mode exists for regional brokers that don't verify a signature.
:::

| Mode | Use it when | MQTT login |
|---|---|---|
| **Signed token (FL Mesh / LetsMesh)** | The broker verifies an Ed25519 token signed by your node — the FL Mesh / LetsMesh backbone convention. The default. | Username `v1_{PUBLIC_KEY}`, password a short-lived token MeshMonitor mints and renews. |
| **Username / password** | The broker takes a fixed MQTT login instead — for example [meshcoretel.ru](https://meshcoretel.ru), which uses `meshcore`/`meshcore` across its regions. | Exactly the username and password you store. Nothing expires, nothing renews. |

Either way, the topics stay the same: `meshcore/{REGION}/{YOUR_NODE_PUBLIC_KEY}/packets` and `.../status`. In username/password mode MeshMonitor takes that public key straight from the node (it's broadcast in every advert), so no signing key is needed at all.

::: warning Companion only
Both modes are Companion-only. The repeater/serial backend never reports the over-the-air packets this feature relays, so an observer on a Repeater would sit idle. The enable checkbox is disabled with an explanation when the source's device type is Repeater.
:::

## Step 2 — Provide broker credentials

Go to the source's **MeshCore → Configuration** page and open **Analyzer Observer**. What you see there follows the mode you picked in Step 1.

### Signed token — the signing key

The broker authenticates you as your node: it verifies a short-lived Ed25519 token signed with the node's own private key, and your broker username is `v1_{PUBLIC_KEY}`. MeshMonitor needs that key to sign tokens on your behalf.

- **Fetch from device** (preferred) — reads the 64-byte private key straight from the connected Companion. Requires the source to be connected.
- **Enter key manually** — paste a 128-character hex private key if you already have one. Use this when the source can't connect right now, or the key comes from elsewhere.

Either way, MeshMonitor stores the key **encrypted**, and no API ever returns it. Only the public key is shown, and it's shown truncated with a copy button.

::: warning The key is your node's identity
The signing key is the same key that proves your node's identity on the mesh. Treat a manually pasted key the same way you'd treat a password — anyone with it can publish to the broker as you.
:::

### Username / password — the broker login

Enter the **broker username** and **broker password** your region's operator publishes, then save.

The password gets the same treatment as the signing key: it is encrypted at rest with a key derived from `SESSION_SECRET`, it is never written into the source's config, and **no API ever returns it**. Only the username comes back (it isn't a secret — a non-TLS broker sees it in the clear anyway), so the page can show which account is configured. A password sent inside a source's config block is rejected outright.

Where the secret lives, precisely:

- On disk: one row per source in `meshcore_observer_credentials`, password as an AES-256-GCM envelope, username in the clear.
- In the process: decrypted only when the publisher builds its MQTT CONNECT packet. No route reads it.
- Who can write it: anyone with `configuration:write` **on that source**. Who can read it back: nobody, including admins.

::: warning Most of these brokers are plaintext MQTT
A static-credential broker on `mqtt://…:1883` has no TLS, so your username and password cross the network in the clear. Use a password you don't use anywhere else — with these shared regional logins (`meshcore`/`meshcore`), assume it's public.
:::

### If SESSION_SECRET changes

If `SESSION_SECRET` changes after a credential is stored, that credential can no longer be decrypted. The Configuration page shows a **rotated** warning in that case — re-import/re-paste the signing key, or re-enter the broker password, to recover. In signed-token mode the public key stays correct and visible throughout.

## Step 3 — Verify

Back on the Configuration page, the **Analyzer Observer** status block shows:

- **Connected** — the publisher has an open, authenticated connection to the broker.
- **Auth token expires** — signed-token mode only; static credentials never expire, so the row is hidden.
- **Packets published** — a running count since the publisher last started. Climbing means packets are flowing.
- **Last publish** — a relative timestamp; should stay recent while the mesh is active.

Once connected, check your region's analyzer site — your node should appear in its observers list, usually within a minute or two.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "No signing key stored" | Signed-token mode with no key yet | Click **Fetch from device**, or paste one |
| "No broker username/password stored" | Username/password mode with no credentials yet | Enter them on the Configuration page |
| "Key rotated" / "rotated" warning | `SESSION_SECRET` changed since the credential was stored | Re-import the key, or re-enter the password |
| Not connected, error mentions the token | `tokenAudience` doesn't match the broker's expected value | Match it exactly — check with your region's operator |
| "Broker rejected the observer username/password" | Wrong static credentials, or the broker actually wants a signed token | Re-check the login with your region's operator; if they publish a token audience instead, switch the mode back |
| Not connected, no error shown | Broker unreachable | Check the broker URL, scheme, and port |
| "The node has not reported its public key yet" | Username/password mode on a source that hasn't finished connecting | Connect the source — the topic path needs the node's public key |
| Dropped-packet count climbing | The broker socket was down when packets arrived | Expected during a broker outage — nothing is lost on the mesh, only unpublished |
| "Requires a Companion device" on save | The source's device type is Repeater | The Analyzer Observer works with Companions only, in both modes |

Published/dropped counters are cumulative since the publisher last started, and reset when the source reconnects or you change the observer config.

## Privacy and what is published

Be clear-eyed about this before you turn it on: **the raw hex of every OTA frame your Companion hears leaves your network and goes to a third-party broker.** Encrypted payloads stay encrypted in transit — MeshMonitor doesn't decrypt anything for the broker — but everything your radio can hear, someone else's server now has a copy of.

Per heard packet, MeshMonitor publishes:

- Timestamp, packet type, and route type
- Hop-path hashes
- SNR, RSSI, and packet length
- A packet hash
- The raw hex of the OTA frame

It also publishes a retained online/offline status message carrying your device name, model, firmware version, and radio parameters, plus live stats read off the attached Companion — battery voltage, uptime, noise floor, error and queue counters, and airtime. The status is republished every five minutes so those values stay current on the analyzer. Anything your firmware doesn't report is left out rather than sent as a placeholder.

If you're not comfortable with a third party seeing everything your node hears — even encrypted — don't enable this feature.

## What it does not do

- No subscribing to the broker
- No remote-serial or `serial/commands` support
- No advert transmission on your behalf
- No fan-out to multiple brokers at once
- No `raw`, `decoded`, or `debug` topic publishing

## Related

- [MeshCore Support](/features/meshcore) — source setup, credential store, and remote administration
