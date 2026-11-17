# Automation Engine Recipes

Worked [Automation Engine](/features/automation-engine) setups you can copy, and how to move Auto Acknowledge into the Engine. Field-by-field details are in the [reference](/features/automation-engine-reference).

<!-- The body is wrapped in v-pre so VitePress shows {{ token }} literally instead of
     evaluating it as a Vue expression (which breaks the build). -->
<div v-pre>

## Recipe — per-channel range-test acks (issue #4340) {#recipe-per-channel-range-test-acks-issue-4340}

A common base-station setup runs a busy **primary** community channel plus a quieter secondary
channel (call it **RangeTest**) set aside for range testers. The operator wants an ack on the
primary channel to redirect testers to RangeTest, while the ack on RangeTest itself says something
appropriate for people who are already there. One global Auto-Acknowledge body can't be true in
both places at once — this recipe answers it with two small automations.

**The key insight:** a hop-count tapback is a **separate packet** whose entire payload is the
reaction emoji. Moving the "how many hops did that take" signal into the tapback frees the whole
text body for channel-specific wording — exactly the byte pressure the issue describes.

### Automation A — "Range-test ack — Primary"

**WHEN** *A message is received*
- **Text contains:** `test` — or use **Text matches regex** `\b(test|ping)\b` for word-boundary
  matching so it doesn't fire on "latest" or "pingpong".
- **On channels:** `Primary`.
- **Cooldown (seconds):** `60`. **Cooldown applies to:** *Each node separately* — see
  [Cooldown applies to](/features/automation-engine-reference#cooldown-applies-to). This keys the throttle off the sending node, so
  acking one range-tester no longer suppresses the ack to the next one who pings inside the same
  60 seconds.

**THEN**
1. `Send a tapback (reaction)` → **Emoji source:** *The message's hop count*.
2. `Send a message` → leave **On channels** empty (it replies on the triggering channel), body:

   ```
   {{ trigger.hopEmoji }} {{ trigger.senderLabel }} {{ trigger.hops }}h {{ trigger.snr }}dB · range tests → #RangeTest
   ```

### Automation B — "Range-test ack — RangeTest"

Identical trigger, except **On channels:** `RangeTest`.

**THEN** the same hop-count tapback, plus a body that doesn't repeat the channel redirect (they're
already there):

```
{{ trigger.hopEmoji }} {{ trigger.senderLabel }} {{ trigger.hops }}h SNR {{ trigger.snr }} RSSI {{ trigger.rssi }}
```

### Tapback-only variant

Delete the `Send a message` action from both automations. The hop-count reaction alone answers a
range test — direct-or-how-many-hops — at 7 bytes and zero channel noise. Add the text action back
only where you actually want channel-specific wording.

### Why two automations, not one with two rules

The obvious alternative — one automation, trigger on `Primary, RangeTest`, then two rules gated by
a text condition on the channel — isn't available today: the **Text comparison** condition's field
picker (`Field` on `condition.string`) offers *Message text*, *Sender node id*, *Recipient node id*,
and *MeshCore scope/region* for a message trigger, but not the channel name. Use the two-automation
form above; it costs one extra automation, not any extra typing per rule.

### Byte budget

Keycap emoji (`*️⃣`, `1️⃣`…`7️⃣`) are **7 bytes each** in UTF-8 (base character + `U+FE0F` +
`U+20E3`, 1 + 3 + 3 bytes). `{{ trigger.hopEmoji }}` therefore costs 7 bytes wherever it appears in
a text body — one more reason the tapback (whose entire payload *is* the emoji) is the cheaper way
to carry that signal than embedding it in text.

With representative values (`senderLabel` = `N0CALL-1`, 3 hops, SNR `-6.5`, RSSI `-110`), the two
example bodies above come out to:

| Body | Bytes (`getUtf8ByteLength`) |
| --- | --- |
| Automation A ("… range tests → #RangeTest") | 56 |
| Automation B ("… SNR … RSSI …") | 38 |

Both are far under any applicable limit, leaving plenty of headroom to make the wording friendlier.
On the limit itself: the issue's **237 bytes** is the Meshtastic LoRa on-air MTU — the *total*
packet size, including its 16-byte header, not the usable text payload. The protobuf definitions
(`protobufs/meshtastic/mesh.proto`, `Constants.DATA_PAYLOAD_LEN`) put the actual `Data` payload
budget behind that header at **233 bytes**, a few bytes tighter than 237 once the header is
accounted for. Separately, **MeshMonitor's own `MAX_MESSAGE_BYTES = 200`** constant
(`src/server/constants/meshtastic.ts`) is a self-imposed, more conservative cap — but it is enforced
only by the HTTP compose route (`routes/v1/messages.ts`, used by the message-composer UI and the
public API). The Automation Engine's **Send a message** action does not go through that route: it
calls the source manager's `sendTextMessage()` directly, so it is **not** subject to the 200-byte
check or to any MeshMonitor-side truncation. In practice this means an automation body can use the
full ~233-byte protocol budget if it needs to — but for this recipe there's no need to get anywhere
near it.

### Closing the loop

Auto-Acknowledge stays a single global body by design; this recipe answers issue #4340 without
adding a second configuration axis to it, by moving the per-channel branching into the Automation
Engine feature built for exactly that. Two short automations — one per channel — replace the
would-be per-channel Auto-Acknowledge field, and the hop-count tapback carries the "how many hops
did that take" signal for free, in its own packet, regardless of which text (if any) accompanies it.

## Recipe — Meshtastic ↔ MeshCore bridge {#recipe-mt-mc-bridge}

MeshMonitor can bridge **text messages** between a Meshtastic channel and a MeshCore channel — a
message posted on one side is relayed to the other, tagged with where it came from. This is built
entirely on the Automation Engine (a matched **pair** of automations, one per direction), not a
native protocol bridge, so it's fully visible and editable like any other automation.

**Text only.** Positions and telemetry are not bridged — neither manager has a "relay this position"
primitive today.

### One-click: the Template Gallery

1. **Automation Engine** → **Browse templates** → **MT↔MC Bridge**.
2. In the wizard, pick a **Meshtastic source + channel** and a **MeshCore source + channel** (and,
   optionally, override **Max relays per minute** — see [flood safety](#flood-safety) below).
3. Install. This creates **two** automations — `MT_to_MC_Bridge` and `MC_to_MT_Bridge` — both
   **disabled**.
4. Open each in the builder, review the trigger/condition/action wiring below, then enable both.

### Manual construction

If you'd rather build it yourself (or want to see exactly what the template installs), it's a pair
of near-identical automations:

**Automation A — "MT → MC Bridge"**

**WHEN** *A message is received*
- **On channels:** your Meshtastic channel (e.g. `Bridge`).
- **Source filter** (condition): the Meshtastic source.
- **Rate limit:** `20` actions / `60` seconds — see [flood safety](#flood-safety). Set via the
  automation's JSON today (no dedicated builder field yet — see [Rate limit](/features/automation-engine-reference#rate-limit-flood-ceiling)).

**RULE** (all conditions must match — this is the AND chain)
1. **Number comparison:** `isDM == 0` — channel broadcasts only; a DM was never meant for the other
   mesh.
2. **Text comparison:** Message text **doesn't contain** `MT@`.
3. **Text comparison:** Message text **doesn't contain** `MC@`.

**THEN**
- `Send a message` → **Send via sources:** the MeshCore source. **On channels:** your MeshCore
  channel. Body:

  ```
  {{ trigger.protocolShort }}@{{ trigger.fromName }}: {{ trigger.text }}
  ```

**Automation B — "MC → MT Bridge"** is the mirror image: trigger on the **MeshCore** source/channel,
same two `notContains` guards, and the `Send a message` action targets the **Meshtastic**
source/channel instead.

### Flood safety {#flood-safety}

::: warning Read this before you enable a bridge
A bridge relays traffic from one mesh straight onto another. A poorly configured one can flood the
destination mesh with unwanted traffic — this exact failure mode has actually happened in the
MeshCore community. The recipe above layers three independent safeguards; understand all three
before you flip either automation on.
:::

1. **Content guard** (the two `notContains` conditions). Without it, a message relayed MT→MC would
   land back in front of the MC→MT automation looking like any other MeshCore channel post, get
   relayed straight back to Meshtastic, and bounce forever — an amplifying loop, not a one-time
   relay. Tagging every relayed message with its origin (`MT@…` / `MC@…`) and refusing to *re-relay*
   anything already carrying **either** tag breaks the cycle: it also protects against a remote node
   on the far side simply echoing a bridged message back at you, not just against MeshMonitor's own
   sends.
2. **Rate limit** — a flood ceiling on each direction (default 20 relays / 60 seconds), independent
   of how many different senders are triggering it. Keep this conservative; it's your last line of
   defense if something upstream ever does start looping.
3. **Channel scoping + DM exclusion** — bridge one specific, low-traffic channel, never a busy
   community/primary channel, and never DMs (the `isDM == 0` guard enforces the DM exclusion; the
   channel filter on each trigger enforces the scoping). A busy channel bridged both ways is exactly
   the OverMesh scenario this recipe exists to avoid.

**Start small.** Install both automations **disabled**, review them, enable them against one quiet
test channel first, and watch the destination mesh for a few minutes before trusting it. Widen scope
(a busier channel, a second channel pair) only deliberately, one step at a time — not by pointing an
existing bridge pair at a wider channel filter and hoping.

## Recipe — Meshtastic ↔ Reticulum DM relay {#recipe-mt-ret-relay}

MeshMonitor can relay **direct messages** between one Meshtastic node and one LXMF destination on a
Reticulum source — for example a handheld on your mesh talking to an LXMF bot that only exists on
Reticulum. Like the [Meshtastic ↔ MeshCore bridge](#recipe-mt-mc-bridge) it is a matched pair of
Automation Engine rules, not a native bridge, and it needs the Reticulum send support from #6143
(v4.17.2 or later). The [Forwarding](/features/automation-messages#forwarding) section cannot do this: it
forwards within one source only.

**Text only.** LXMF titles, fields and attachments are not relayed, and nothing is relayed to or
from a channel: LXMF has no channels, and a Meshtastic channel post was never meant for one
destination.

### Manual construction

**Automation A — "MT → RET Relay"**

**WHEN** *A message is received*
- **Rate limit:** `5` actions / `60` seconds. Set via the automation's JSON today (see
  [Rate limit](/features/automation-engine-reference#rate-limit-flood-ceiling)).
- Leave **From** empty on the trigger and filter the sender with a condition instead — on a
  Reticulum source the trigger's **From** field never matches, so keep both rules the same shape.

**RULE** (all conditions must match)
1. **Source is one of…:** the Meshtastic source.
2. **Number comparison:** `isDM == 1` — direct messages to your node only.
3. **Text comparison:** **Sender node id** `equals` the handheld's node id, e.g. `!a5d0d27c`. `equals` is an
   exact match, so type node ids and LXMF hashes in lowercase, as MeshMonitor stores them.
4. **Text comparison:** Message text **doesn't contain** `[fwd]`.

**THEN**
- `Send a message` → **Send via sources:** the Reticulum source. **DM to node #:** the LXMF
  destination hash (32 hex characters). Body:

  ```
  [fwd] {{ trigger.fromName }}: {{ trigger.text }}
  ```

**Automation B — "RET → MT Relay"** is the mirror image: **Source is one of…** the Reticulum source,
**Sender node id** `equals` the LXMF hash, the same `[fwd]` guard, and `Send a message` via the
Meshtastic source with **DM to node #** set to the handheld's node **number** (decimal, so
`!a5d0d27c` is `2781926012`). Skip the `isDM` condition on this side — every LXMF message is a DM.
Body:

  ```
  [fwd] {{ trigger.fromName }}: {{ trigger.text }}
  ```

### Before you enable it

- **The two sides must know each other.** The LXMF destination only receives from MeshMonitor's own
  LXMF identity, and most LXMF clients and bots ignore a sender they have never seen announce. Use
  **Announce now** on the Reticulum source first, and make sure the destination has announced so
  MeshMonitor has a path to it.
- **Keep replies short.** A Meshtastic text message holds about 200 bytes. The Automation Engine
  sends the body as it is, so a long LXMF reply is not cut down for the radio; the `[fwd] name: `
  prefix counts too. A bot on the Reticulum side should keep its answers to one packet.
- **Loop guard.** The `[fwd]` condition on both rules stops a relayed message from being relayed
  again, the same way the `MT@` / `MC@` tags do in the MeshCore bridge, and MeshMonitor never fires
  a message trigger for its own sends. The rate limit is the last line of defence. See
  [flood safety](#flood-safety).
- **Install disabled, test with one message each way,** then watch the destination for a few
  minutes before trusting it. **Run now** cannot exercise these rules: its synthetic event has no
  source, so **Source is one of…** fails. A real message is the only test.

## Converting Auto-Acknowledge to an automation

The built-in [Auto Acknowledge](/features/automation-messages#auto-acknowledge) feature predates the engine and
keeps working unchanged. A **Convert to an Automation…** button in its settings section (a
source's **Automation** tab → **Auto Acknowledge**) turns an existing per-source configuration into one or two editable
automations, so you can move to the engine without re-typing anything. The button is disabled with
a tooltip while you have unsaved Auto Acknowledge edits — converting always uses the last **saved**
configuration.

### What the dialog shows

Opening the dialog builds a preview; nothing is written until you confirm:

- **One card per automation that will be created**, with its rules rendered as plain-English
  `IF … THEN …` statements.
- A **conversion report** in four groups — **Not convertible** (always shown, even when empty),
  **Converted**, **Approximated**, and **Deprecated (nothing to convert)** — one entry per
  Auto-Acknowledge setting or template token, naming exactly what it became or why it didn't
  convert.
- An **existing-conversion banner**, if this source was already converted before, with a **Replace
  them** checkbox to update those automations in place instead of creating duplicates.
- Two checkboxes: **Enable the new automation now** (pre-checked to match whether Auto
  Acknowledge itself is currently enabled) and **Turn off Auto-Acknowledge for this source**,
  checked by default.

### Up to two automations, not always one

Most configurations convert to a single automation. You get **two** — named `… (Channels)` and
`… (Direct messages)` — only when the Channel and Direct halves of the response matrix both have at
least one cell with **Message** or **Tapback** enabled. This isn't a style choice: an automation's
channel filter also applies to direct messages, but Auto-Acknowledge's channel allowlist only ever
gated **channel** replies, never DMs. Sharing one automation would silently start filtering your
Direct replies by channel too — a behaviour change, not a faithful conversion. The dialog always
states up front how many automations it's about to create and why.

### Your Auto-Acknowledge settings are kept

Checking **"Turn off Auto-Acknowledge for this source"** flips only the feature's own on/off
switch (`autoAckEnabled`) — every other Auto-Acknowledge setting (the regex, message templates,
channel allowlist, ignore list, cooldown, delay, …) is left exactly as configured. If the converted
automation doesn't match what you wanted, re-enable Auto-Acknowledge and you get your original
behavior back with nothing to reconfigure.

### What doesn't convert

A few settings have no automation equivalent, and are named individually in the **Not convertible**
group rather than silently dropped:

- **`autoAckTestMessages`** — a UI-only scratchpad for pasting sample text; no server code reads
  it. Use the engine's own [Test panel](/features/automation-engine#testing-dry-run) instead.
- **`autoAckMaxAttempts`** — this is a per-source *queue* setting
  (`MessageQueueService.resolveDmMaxAttempts()`), not something Auto-Acknowledge itself reads. It
  keeps governing this source's other automated DMs after conversion regardless of whether you
  convert. If you want the same resend behavior on the converted automation, add it yourself via
  **Send a message**'s [**DM resend attempts**](/features/automation-engine-reference#send-a-message) field — the converter doesn't
  infer it.
- **`autoAckMaxResponses`** — Auto-Acknowledge waits 5 to 30 seconds before it answers a channel
  message and stays quiet once that many other nodes have replied or sent a tapback (see [Maximum
  Number of Responses](/features/automation-messages#auto-ack-max-responses)). The engine has no "wait, then
  check for other responses" step, so a converted channel automation answers every matching
  message at once. Keep Auto-Acknowledge itself if you rely on this.
- An **empty channel allowlist**. An empty Auto-Acknowledge allowlist means the feature never
  acknowledged *any* channel message — not "every channel" — so the converter creates no Channel
  automation for it rather than one that would newly answer on every channel.
- A channel with a **blank name**, or an allowlist where every listed channel is
  missing/disabled/blank — the report names the index, and that index (or the whole Channel
  automation, if none resolve) is dropped rather than emitted as an unfiltered, mesh-wide trigger.
- A handful of message template tokens with no engine equivalent (`{SHORT_NAME}`, `{RABBIT_HOPS}`,
  `{LAST_HOP}`, `{TRANSPORT}`, `{VERSION}`, `{DURATION}`, `{FEATURES}`, `{NODECOUNT}`,
  `{DIRECTCOUNT}`, `{IP}`, `{PORT}`) — left verbatim in the converted message text so you can see
  and fix them.

Some conversions are **approximated** rather than exact, and are called out as such in the report:
`{HOPS}`/`{NUMBER_HOPS}` becomes `{{ trigger.hops }}`, which — unlike Auto-Acknowledge's own hop
count — is unfloored, so a hopless packet renders blank instead of `0`; `{SNR}`/`{RSSI}` render
blank instead of Auto-Acknowledge's literal `N/A` when unavailable; `{DATE}`/`{TIME}` become
`{{ NOW }}`, which is *send* time in a fixed format rather than *receive* time in your preferred
format; and a pre-send delay becomes one blocking `action.delay` before the first send, rather than
Auto-Acknowledge's own non-blocking timer applied independently to the tapback and the reply.

Auto-Acknowledge and the converter pick the *Direct* reply template the same way: on ZeroHop cells
only. An IP message at 0 hops lands in the IP row and gets the standard template.

</div>
