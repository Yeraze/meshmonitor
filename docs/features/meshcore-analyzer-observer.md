# MeshCore Analyzer Observer

::: tip Added in 4.14 (#4457), multi-broker in 4.16 (#5014)
Publish packets your MeshCore Companion hears to one or more MeshCore Analyzer MQTT brokers — MeshMapper, LetsMesh, or a compatible regional broker — so your node counts as an observer everywhere you choose.
:::

## What it is

The Analyzer Observer relays every packet your MeshCore Companion hears to one or more MeshCore-Analyzer-compatible MQTT brokers. Your node then shows up on each broker's regional analyzer as an observer — without a second app fighting your Companion for the serial port.

**This is observation-only.** MeshMonitor:

- Never subscribes to any broker
- Never injects broker traffic back onto the mesh
- Never transmits on your behalf

It publishes what the radio already heard, to as many brokers as you configure. Nothing more.

Because it only ever publishes outbound to a broker over the network, the Analyzer Observer keeps running unaffected when a source is in [receive-only mode](/features/meshcore-receive-only) — receive-only blocks the radio path, not this one.

## Contribute to MeshMapper

[MeshMapper](https://meshmapper.net) is a community-run coverage map for MeshCore, built from packets that observer nodes like MeshMonitor forward to it. You don't need extra hardware or a second app to contribute — the Analyzer Observer already speaks MeshMapper's ingestion protocol, and MeshMonitor ships a one-click preset for it.

To start contributing:

1. Open the Dashboard, edit your MeshCore source, and expand the **Analyzer Observer** fieldset.
2. Check the enable box, and set the **Region (IATA)** code for your area (e.g. `MCO`).
3. Click the **MeshMapper** preset button — it fills in a broker row with the right URL and token audience, no typing required.
4. Optionally, also click **LetsMesh US** or **LetsMesh EU** for redundancy. MeshMapper ingests from both LetsMesh regions too and dedupes packets it sees from more than one broker, so publishing to both gives you a fallback path for free.
5. Save. Then, on the source's **MeshCore → Configuration** page, fetch or paste the signing key so the presets (all signed-token mode) can authenticate — see [Step 2](#step-2-provide-broker-credentials).

Once connected, your node should appear on meshmapper.net within a minute or two.

Contributing to MeshMapper is **passive**, like every use of this feature: MeshMonitor relays only packets the radio already heard, and transmits nothing extra on the mesh. Turning this on costs no airtime.

## Requirements

- A **Companion** source (not a Repeater, not a Room Server) — only the Companion backend reports the packets this feature relays.
- The source connected at least once, so MeshMonitor knows the node's public key (and, in signed-token mode, can fetch the signing key from the device — or you can paste one by hand, see [Step 2](#step-2-provide-broker-credentials)).
- A fixed `SESSION_SECRET`. MeshMonitor encrypts the stored signing key **and** every stored broker password with keys derived from `SESSION_SECRET`. If yours is auto-generated, credential storage is disabled and the UI tells you so. See [Credential store](/features/meshcore#credential-store) for the same requirement on the remote-admin password store, and set `SESSION_SECRET=$(openssl rand -hex 32)` in your environment to enable it.
- For each broker: a **broker URL**, plus either a **token audience** (signed-token brokers) or a **username and password** (static-credential brokers). A shared **region code** covers every broker on the source.

## Step 1 — Enable and configure

Open the Dashboard, edit the MeshCore source, and expand the **Analyzer Observer** fieldset. Check the enable box, set the region code, then build your broker list — up to **8 brokers** per source.

### Region

| Field | Example | Notes |
|---|---|---|
| Region (IATA) | `MCO` | A 3-letter IATA code for your region, or `test` for a local broker. Case-insensitive — MeshMonitor uppercases it on save. This is shared by every broker on the source — it's the region segment of the MQTT topic, not a per-broker setting. |

### Brokers

Each broker gets its own row, added either from a preset button or blank (**Custom…**):

| Field | Example | Notes |
|---|---|---|
| Label (optional) | `MeshMapper` | A friendly name shown on the status panel. Never sent to the broker. |
| Broker URL | `wss://mqtt-us-v1.letsmesh.net:443` | Accepts `ws://`, `wss://`, `mqtt://`, `mqtts://`, or a bare `host:port` (defaults to `mqtt://`). |
| Broker authentication | Signed token | How MeshMonitor authenticates to *this* broker — see [Which authentication mode?](#which-authentication-mode) below. Each broker picks its own; a source can mix signed-token and username/password rows. |
| Token audience | `mqtt.meshmapper.net` | **Signed-token mode only.** Must match this broker's expected audience exactly, or it rejects the login. Hidden in username/password mode. |

Remove a row with the trash icon next to it. There's no per-broker enable/disable toggle — removing the row is how you turn one broker off without touching the others.

### One-click presets

| Preset | Broker URL | Token audience | Auth mode |
|---|---|---|---|
| MeshMapper | `wss://mqtt.meshmapper.net:443` | `mqtt.meshmapper.net` | Signed token |
| LetsMesh US | `wss://mqtt-us-v1.letsmesh.net:443` | `mqtt-us-v1.letsmesh.net` | Signed token |
| LetsMesh EU | `wss://mqtt-eu-v1.letsmesh.net:443` | `mqtt-eu-v1.letsmesh.net` | Signed token |
| Custom… | *(blank)* | *(blank)* | Signed token |

A preset button just appends a pre-filled row — every field on it stays editable afterward, including switching it to username/password mode. Clicking the same preset twice adds a duplicate URL, which is rejected on save; remove the extra row instead.

Check the enable box, fill in the fields, and save. Saving an Analyzer Observer change hot-swaps the publisher — it starts, stops, or reconfigures every broker without bouncing the radio link, so your MeshCore connection stays up the whole time.

::: tip Upgrading from a single-broker config
If your source still has the pre-4.16 single-broker layout, opening the fieldset shows exactly one broker row, pre-filled from your existing URL and audience. Nothing on disk changes until you save — the first save after upgrading rewrites the stored config into the broker-list format automatically. Open the modal and cancel, and nothing changes.
:::

## Multiple brokers

Each broker in the list runs independently:

- Its own URL, authentication mode, token audience, and — in username/password mode — its own stored credential.
- Its own connection. If one broker is unreachable or rejects your credentials, the others keep publishing; a bad broker doesn't take the rest down.
- Its own counters: connection state, packets published, packets dropped, last publish time, and last error, all shown separately on the [status panel](#step-3-verify).

The signing key is the exception — it's one Ed25519 key per source (the node's own identity), shared by every signed-token-mode broker on that source. You import or paste it once, and every signed-token row uses it.

There's no per-broker rate limiting or packet filtering: every broker in the list receives every packet the Companion hears, exactly as a single-broker setup did. That's also why the cap exists — **8 brokers per source** keeps the stored config small and keeps the number of outbound MQTT connections a single Companion has to carry bounded.

## Which authentication mode?

::: tip Added in 4.14.1 (#4595)
The **Username / password** mode exists for regional brokers that don't verify a signature.
:::

| Mode | Use it when | MQTT login |
|---|---|---|
| **Signed token (FL Mesh / LetsMesh)** | The broker verifies an Ed25519 token signed by your node — the FL Mesh / LetsMesh backbone convention. The default, and what all three presets use. | Username `v1_{PUBLIC_KEY}`, password a short-lived token MeshMonitor mints and renews. |
| **Username / password** | The broker takes a fixed MQTT login instead — for example [meshcoretel.ru](https://meshcoretel.ru), which uses `meshcore`/`meshcore` across its regions. | Exactly the username and password you store for that broker. Nothing expires, nothing renews. |

Either way, the topics stay the same per broker: `meshcore/{REGION}/{YOUR_NODE_PUBLIC_KEY}/packets` and `.../status`. In username/password mode MeshMonitor takes that public key straight from the node (it's broadcast in every advert), so no signing key is needed at all for that broker.

Auth mode is set per broker row, so a source can publish to a signed-token broker (like MeshMapper) and a username/password broker at the same time.

::: warning Companion only
Every mode is Companion-only. The repeater/serial backend never reports the over-the-air packets this feature relays, so an observer on a Repeater would sit idle. The enable checkbox is disabled with an explanation when the source's device type is Repeater.
:::

## Step 2 — Provide broker credentials

Go to the source's **MeshCore → Configuration** page and open **Analyzer Observer**. The status panel there lists one card per configured broker; what you need to enter depends on each broker's mode.

### Signed token — the signing key

The broker authenticates you as your node: it verifies a short-lived Ed25519 token signed with the node's own private key, and your broker username is `v1_{PUBLIC_KEY}`. MeshMonitor needs that key to sign tokens on your behalf — once stored, it's used for **every** signed-token broker on the source, not just one.

- **Fetch from device** (preferred) — reads the 64-byte private key straight from the connected Companion. Requires the source to be connected.
- **Enter key manually** — paste a 128-character hex private key if you already have one. Use this when the source can't connect right now, or the key comes from elsewhere.

Either way, MeshMonitor stores the key **encrypted**, and no API ever returns it. Only the public key is shown, and it's shown truncated with a copy button.

::: warning The key is your node's identity
The signing key is the same key that proves your node's identity on the mesh. Treat a manually pasted key the same way you'd treat a password — anyone with it can publish to any of your signed-token brokers as you.
:::

### Username / password — the broker login

Each username/password broker has its own separate credential, matched to it by its URL. Enter the **broker username** and **broker password** your region's operator publishes for that specific broker, then save.

Each password gets the same treatment as the signing key: it is encrypted at rest with a key derived from `SESSION_SECRET`, it is never written into the source's config, and **no API ever returns it**. Only the username comes back (it isn't a secret — a non-TLS broker sees it in the clear anyway), so the page can show which account is configured for that broker. A password sent inside a source's config block is rejected outright.

Where the secret lives, precisely:

- On disk: one row per source *and* broker in `meshcore_observer_credentials`, password as an AES-256-GCM envelope, username in the clear.
- In the process: decrypted only when the publisher builds that broker's MQTT CONNECT packet. No route reads it.
- Who can write it: anyone with `configuration:write` **on that source**. Who can read it back: nobody, including admins.

**Save order matters.** A broker's credential can only be stored once that broker exists in the source's saved config — on a brand-new source, save the source first (which creates the broker), then come back to this page to set its password. The Dashboard fieldset's "Configuration" shortcut button takes you straight there.

::: warning Most of these brokers are plaintext MQTT
A static-credential broker on `mqtt://…:1883` has no TLS, so your username and password cross the network in the clear. Use a password you don't use anywhere else — with these shared regional logins (`meshcore`/`meshcore`), assume it's public.
:::

### If SESSION_SECRET changes

If `SESSION_SECRET` changes after a credential is stored, that credential can no longer be decrypted. The Configuration page shows a **rotated** warning for the affected broker in that case — re-import/re-paste the signing key, or re-enter that broker's password, to recover. In signed-token mode the public key stays correct and visible throughout, for every broker.

## Step 3 — Verify

Back on the Configuration page, the **Analyzer Observer** section shows an aggregate status block, followed by a **Brokers** panel with one card per configured broker:

- **Connected** — whether that broker has an open, authenticated connection.
- **Auth token expires** — signed-token brokers only, shown as an absolute date/time; static-credential brokers never expire, so the row is hidden.
- **Packets published** — a running count since the publisher last started for that broker. Climbing means packets are flowing to it.
- **Packets dropped** — packets heard while that broker's socket was down; nothing is lost on the mesh, only left unpublished to that one broker.
- **Last publish** — a relative timestamp for that broker; should stay recent while the mesh is active.
- **Last error** — the most recent connection or auth failure for that broker, if any.

A broker that isn't configured yet, or has no usable key/credential stored, shows a warning row explaining what's missing instead of counters.

Once a broker shows **Connected**, check that broker's analyzer site — your node should appear in its observers list, usually within a minute or two.

### Dashboard badge

The MeshCore source's card on the Dashboard shows a compact `OBS c/N` badge whenever the Analyzer Observer is enabled — `N` is the number of brokers you've configured, `c` is how many are currently connected. A green dot means at least one broker is up; a grey dot means none are. If status can't be determined yet (or your account lacks `nodes:read` on that source), the badge shows `OBS N` with a "status unavailable" tooltip instead of a fake `0/N`.

## Troubleshooting

The rows below now apply **per broker** — a source with several brokers can show one broker healthy and another failing at the same time; check each broker's card on the Configuration page rather than assuming one status for the whole source.

| Symptom | Cause | Fix |
|---|---|---|
| "No signing key stored" | A signed-token broker with no key yet | Click **Fetch from device**, or paste one — this fixes every signed-token broker on the source at once |
| "No broker username/password stored" | A username/password broker with no credentials yet | Enter them for that broker on the Configuration page |
| "Key rotated" / "rotated" warning | `SESSION_SECRET` changed since the credential was stored | Re-import the key (fixes all signed-token brokers), or re-enter the affected broker's password |
| One broker not connected, error mentions the token | That broker's `tokenAudience` doesn't match its broker's expected value | Match it exactly — check with that broker's operator |
| "Broker rejected the observer username/password" | Wrong static credentials for that broker, or it actually wants a signed token | Re-check the login with that broker's operator; if they publish a token audience instead, switch that row's mode back |
| One broker not connected, no error shown | That broker is unreachable | Check that row's URL, scheme, and port |
| "The node has not reported its public key yet" | A username/password broker on a source that hasn't finished connecting | Connect the source — the topic path needs the node's public key |
| Dropped-packet count climbing on one broker | That broker's socket was down when packets arrived | Expected during a broker outage — nothing is lost on the mesh, only unpublished to that broker |
| "Requires a Companion device" on save | The source's device type is Repeater | The Analyzer Observer works with Companions only, in every mode |
| Save blocked with a duplicate-broker message | Two rows normalize to the same URL (e.g. clicking the same preset twice) | Remove the extra row |
| Save blocked with "At most 8 brokers are allowed" | The list is at the cap | Remove a row before adding another |

Published/dropped counters are cumulative per broker since the publisher last started, and reset when the source reconnects or you change the observer config.

## Privacy and what is published

Be clear-eyed about this before you turn it on: **the raw hex of every OTA frame your Companion hears leaves your network and goes to every broker you configure.** Encrypted payloads stay encrypted in transit — MeshMonitor doesn't decrypt anything for any broker — but everything your radio can hear, each broker's operator now has a copy of. Adding a second or third broker (for redundancy, or because MeshMapper and LetsMesh both want your data) means a second or third copy leaves your network, not a filtered subset.

Per heard packet, MeshMonitor publishes to each configured broker:

- Timestamp, packet type, and route type
- Hop-path hashes
- SNR, RSSI, and packet length
- A packet hash
- The raw hex of the OTA frame

It also publishes a retained online/offline status message carrying your device name, model, firmware version, and radio parameters, plus live stats read off the attached Companion — battery voltage, uptime, noise floor, error and queue counters, and airtime. The status is republished every five minutes on each broker so those values stay current on that broker's analyzer. Anything your firmware doesn't report is left out rather than sent as a placeholder.

If you're not comfortable with a third party seeing everything your node hears — even encrypted — don't enable this feature. If you're comfortable with one broker but not another, only add the one you trust.

## What it does not do

- No subscribing to any broker
- No remote-serial or `serial/commands` support
- No advert transmission on your behalf
- No packet filtering, rate limiting, or bounding-box scoping — every broker gets every packet
- No `raw`, `decoded`, or `debug` topic publishing

## Related

- [MeshCore Support](/features/meshcore) — source setup, credential store, and remote administration
