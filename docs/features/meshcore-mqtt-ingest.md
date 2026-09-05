# MeshCore MQTT Ingest

::: tip Added in 4.17 (#5040)
Subscribe to a MeshCore Analyzer MQTT broker and see a whole region's traffic — packets, nodes and channel messages — without your radio having to hear any of it.
:::

## What it is

A `meshcore_mqtt` source **reads** a MeshCore-Analyzer-compatible broker. Where the [Analyzer Observer](/features/meshcore-analyzer-observer) publishes what *your* Companion heard, this consumes what **every observer in a region** heard.

That is the whole point: your radio hears its own earshot, while a region feed carries the coverage of every node publishing to that broker.

**This source has no radio.** It cannot transmit, and that is structural rather than a policy — its `sourceType` excludes it from every code path that drives a device, so there is nothing to accidentally re-enable.

## What you get, and what you don't

| Works | Does not, and cannot |
|---|---|
| Packet Monitor for the whole region | **Direct messages** — encrypted to their recipient, and you are not it |
| Nodes discovered from adverts (name, role, position) | **Contacts, CLI, remote admin** — there is no device to ask |
| Channel messages, where you hold the channel key | **Sending anything** — no radio |
| Observer battery / uptime, and noise floor as telemetry | |

The right-hand column is not a roadmap. Those are consequences of reading someone else's observations rather than operating a node, and no future phase removes them.

## Setting one up

**Dashboard → Add source → MeshCore MQTT ingest.**

| Field | Notes |
|---|---|
| **Broker URL** | `wss://`, `ws://`, `mqtts://`, `mqtt://`, or bare `host:port`. One broker per source. |
| **Region (IATA)** | The region segment of the topic, e.g. `MCO`. Upper-cased on save — a lower-case entry would subscribe to nothing. |
| **Username / Password** | Only for brokers using fixed credentials. Leave both blank for an open broker. |
| **Verify TLS certificate** | On by default. Only lower it for a local broker with a self-signed cert. |
| **Connect automatically** | Off means the source is configured but must be connected by hand. |

The source subscribes to `meshcore/{REGION}/+/packets` and `meshcore/{REGION}/+/status`.

### One broker per source

Deliberate. Add a second source for a second broker — creating two sources on the same broker **and** region is rejected with a 409, because per-observer de-duplication is scoped per source, so a duplicate feed would collapse nowhere and silently double every count.

### Credentials need a fixed `SESSION_SECRET`

Same requirement as the Analyzer Observer. Note that a broker password here is stored as **plaintext** in the source's config — it is withheld from non-admin API responses, but it is not encrypted at rest. Use a broker account you are comfortable storing that way.

## Duplicates: what collapses and what doesn't

A region feed delivers the same frame once per observer that heard it. Different surfaces treat that differently, on purpose:

- **Packets keep every copy.** One row per observer, because differing SNR/RSSI per observer *is* the coverage data. The Packet Monitor's **Grouped** toggle collapses them for reading: one row per frame, showing how many observers heard it and the best signal any of them reported.
- **Channel messages collapse to one row.** A message is a message; twenty copies would be twenty rows in your message list and twenty notifications. The de-duplication is per source, so a message your own radio *also* heard keeps its own row under that source, labelled.

In the grouped view, an **Observers** count of `Local` means your own radio heard the frame — not that nobody did.

## Channel messages

Channel traffic is decrypted with the channel keys you already hold. You do not need to add channels to the ingest source — it reads keys from **every** source, which is how the codebase treats decryption keys generally.

Only channels you hold a key for are readable; everything else on the feed stays encrypted and is simply skipped.

::: warning A clock-less sender can hide a repeat
MeshCore encrypts `timestamp | flags | text`. When a sender's clock is unset the timestamp is `0`, so two separate transmissions of *identical text on the same channel* are byte-identical on the wire and the second is treated as a duplicate. There is nothing to distinguish them; the alternative would break de-duplication for every observer.
:::

## Adverts and node discovery

ADVERT frames are unencrypted and self-describing, so the feed yields node names, device roles and positions. Those nodes appear on the map and in node lists for this source.

::: warning Advert signatures are not verified
An advert is self-signed, and this source ingests frames published by strangers, so **a forged advert can create a node or move an existing one on this source**. Per-source scoping bounds the damage to this source's rows — a device-backed source is unaffected — but nothing blocks it at write time.

The signature is decoded and available; enforcing it is a deliberate non-default, because verification costs real CPU per advert on a busy feed and the device-backed path does not verify either.
:::

Two things adverts deliberately do **not** do:

- `lastHeard` uses the advert's own timestamp, **capped at now**, so neither a replayed frame nor a forged future timestamp can park a node at the top of your "last heard" ordering.
- An advert position is recorded as a *static* fix, so a real telemetry position keeps precedence.

## Observer status

The `/status` topic carries the **publishing observer's own** battery, uptime and noise floor — not stats about nodes it overheard. Battery and uptime are stored against that observer's node row.

Noise floor is stored as telemetry, under `mc_status_noise_floor` — the same series a device-backed MeshCore source writes, so an ingest observer graphs beside a device-backed one. It appears per observer on the **Telemetry** page.

It is telemetry rather than a value on the node row because the useful question ("is this band getting more congested?") is about a trend, and a single latest reading cannot answer it. Samples are throttled to one per observer per minute — observers heartbeat every 5 minutes, so no real reading is dropped; the throttle only collapses the retained-status replay that arrives on every reconnect.

::: tip Unit
Stored as `dB` to match the existing series. Ambient RF noise is really dBm, but splitting one series across two units to correct a label would be the worse bug.
:::

A status heartbeat does **not** refresh `lastHeard`: it proves the observer can reach its broker, not that it is reachable over the air.

## Retention

A region feed is far higher volume than one radio's earshot, so it has its own cap rather than sharing the device default:

| Setting | Default |
|---|---|
| `meshcore_mqtt_packet_log_max_count` | **50,000** rows per source |
| `meshcore_packet_log_max_age_hours` | 24 hours |

Both are editable in the Packet Monitor's settings. At 50,000 rows expect roughly 50–100MB of database per source — worth noticing on a Pi or a small container volume.

Packet capture is opt-in, as it is for every monitor.

## Mesh impact

**None.** This source only ever subscribes; it transmits nothing and costs no airtime. Notifications and automations fire once per distinct message, not once per observer that relayed it.
