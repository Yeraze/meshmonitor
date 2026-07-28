# Automation Engine

<!-- This page documents the {{ token }} substitution syntax. The body is wrapped
     in a v-pre block so VitePress/Vue renders the literal double-brace tokens
     instead of evaluating them as Vue interpolation (which breaks the build). -->
<div v-pre>

::: tip New in 4.12
A generic, visual **"when this happens, do that"** builder — Home Assistant / Node-RED / IFTTT-inspired — that lets you create your own automations instead of relying on the hardcoded ones. It runs **globally across every source**, with optional per-source scoping.
:::

The Automation Engine lives on its own top-level **Automations** tab. It complements the
[legacy Automation features](/features/automation) (Auto Acknowledge, Auto Traceroute, Auto Ping,
Auto Responder, Auto Announce, …): those remain available and unchanged, while the engine is the
flexible "build it yourself" alternative. Where a legacy automation gives you one fixed form, the
engine lets you wire a **trigger → conditions → actions** graph for almost any behavior you can
describe.

## Overview

Each automation is a small graph built in a guided, linear builder:

```
WHEN  →  RULE (IF … THEN …)  →  optional FINALLY (combine the rules' results)
```

- **WHEN** — exactly one **trigger** that starts the automation (a message arrives, telemetry
  crosses a threshold, a schedule fires, …).
- **RULE** — one or more **conditions** that decide whether to act, each routing to its own
  **actions** (the IF/THEN). Conditions are routers with a *true* and a *false* path, so you build
  If / ElseIf / Else logic instead of the old fixed routing matrices.
- **FINALLY** *(optional)* — a combine step that runs its actions based on how the rules turned out:
  **ANY**, **ALL**, **NONE**, or **ALWAYS** (unconditionally).

Key properties:

- **Global by design.** An automation evaluates events from **all** connected sources at once
  (like Map Analysis), rather than being tied to a single radio. Use a **Source filter** condition
  (below) to scope a workflow to a subset of sources when you want.
- **Permission-gated.** The tab and its API are gated by a dedicated global `automations`
  permission, separate from the legacy per-source `automation` permission.
- **Cooldown / rate-limit** per automation, or **per node / per source+node** via the trigger's
  *Cooldown applies to* (below), prevents mesh spam, plus a per-run action cap and a loop guard
  so an automation can't runaway-recurse.
- **Variables** — a separate management area for user-defined values (constants and runtime
  flags/counters) referenced anywhere as `{{ var.name }}`.
- **Run log** — every fire is recorded with its per-step outcome for debugging.
- **JSON import/export** — automations export to JSON (personal node ids are rewritten to portable
  system tokens). Imported automations always land **disabled** for review.
- **Test / dry-run panel** — preview an automation against a synthetic event with no mesh traffic,
  no notifications, and nothing saved.

## Triggers

Every automation has exactly one trigger (the **WHEN**). Each trigger exposes a set of
`{{ trigger.* }}` fields you can use in conditions and message text (see [Tokens](#tokens)).

| Trigger | Fires when… | Notable options |
| --- | --- | --- |
| **A message is received** | A text/packet message arrives | `Text contains` (case-insensitive substring), `Text matches regex`, multi-channel match (`On channels` OR-list), legacy `On channel (name)`/`On channel #`, `From node #` |
| **A new node is discovered** | A node is seen for the first time | — |
| **A node is updated** | A node record changes (name, role, position, …) | — |
| **Telemetry is received** | A telemetry reading arrives | `Metric` filter (battery, voltage, temperature, channel utilization, air util TX, …) |
| **On a schedule** | A cron expression fires | 5-field cron expression |
| **A system event** | An engine/source lifecycle event | `System start`, `Source came online`, `Source went offline`, `Upgrade available` |
| **A node enters/leaves a region** | A node crosses a geofence | `Enters` / `Leaves` / `Moves while inside (dwell)`, plus a map region editor |

### Message trigger & channel-name matching

The message trigger can filter on text (substring or regex) and on the **channel**. Prefer matching
by **channel name** rather than raw slot index: the same logical channel can sit in a different slot
on different sources, so a name match is portable across your whole mesh.

- **On channels** *(multi-select)* — pick one or more channels (unified by name across your
  sources). The trigger fires when a message arrives on **any** of the selected channels — an
  OR-list — so a single automation can cover "channel A **or** channel C" without a separate copy
  per channel. Leave none selected to match any channel. When set, this **overrides** the two
  single-channel fields below. Matching is by channel name and works for both Meshtastic and
  MeshCore messages.
- **On channel (name)** — legacy single-channel name match (case-insensitive). Kept for
  backward compatibility with existing automations; the multi-select `On channels` above is
  preferred. Ignored when `On channels` is set.
- **On channel #** — the raw slot index, still available for single-source cases. Ignored when
  `On channels` is set.

Saved automations that used the old single-channel fields keep working unchanged — no migration
is needed.

### Schedule trigger (live cron)

The schedule trigger fires on a standard **5-field cron** expression (e.g. `0 * * * *` = top of
every hour). It is backed by a live [croner](https://github.com/Hexagon/croner) job:

- A cron job is armed per enabled schedule automation; **create / update / enable / disable /
  delete** all re-arm correctly (the old job is stopped first, so there are never stale or
  duplicate jobs).
- The **cooldown** is honored on each fire. A schedule trigger has no triggering message and no
  subject node, so its cooldown is always **automation-wide** — the *Cooldown applies to* field
  isn't offered here (see [Cooldown applies to](#cooldown-applies-to)).
- The cron is **validated at save time** (5-field, no seconds) — an invalid expression is rejected
  in the builder rather than silently never firing.

Because a schedule has no triggering message and no subject node, a **Send a message** action under
a schedule trigger **must name a target source** (see [Send a message](#send-a-message)).

### System trigger

Fires on engine/source lifecycle events: **System start** (MeshMonitor booted), **Source came
online**, **Source went offline**, and **Upgrade available** (a new release was detected). The
upgrade event exposes `{{ trigger.latestVersion }}` and `{{ trigger.currentVersion }}` for use in a
notification.

### Geofence trigger

Defines a geographic region and fires when a node **enters**, **leaves**, or **dwells (moves while
inside)** it. The region is drawn directly on a Leaflet map — either a **circle** (center + radius)
or a **polygon** — using the shared geofence map editor. Evaluation is shape-aware (point-in-circle
or polygon ray-cast). See also the dedicated [Geofence Triggers](/features/geofence-triggers) page.

### Cooldown applies to

The five triggers with a **Cooldown (seconds)** field — **A message is received**, **A new node is
discovered**, **A node is updated**, **Telemetry is received**, and **A node enters/leaves a
region** — also get a **Cooldown applies to** select, directly beneath it. It's hidden until you set
a non-zero cooldown, and setting the cooldown back to `0` hides it again without losing your choice
— the value is remembered if you raise the cooldown again later. (Schedule and System triggers have
no cooldown field at all, so they get no scope field either.)

| Value | Meaning |
| --- | --- |
| **The whole automation (one shared timer)** | One timer for the whole rule — the default, and what an automation with no scope set (including every automation saved before this feature existed) behaves as. On a busy channel, acking one sender suppresses the ack to the next one until the window elapses. |
| **Each node separately** | One timer per subject node (the message sender, the telemetry/geofence node, …) — acking one range-tester no longer suppresses the ack to the next. |
| **Each node, per source** | One timer per (source, node) — the same physical node heard via two sources (e.g. a Meshtastic TCP link and an MQTT bridge) cools down independently. |

**Worked example** — `trigger.message` on channel `Primary`, cooldown `60`, scope **Each node
separately**:

| t | event | verdict |
| --- | --- | --- |
| 0s | node 111 sends "test" | fires |
| 5s | node 222 sends "test" | **fires** (under *The whole automation* this would be suppressed) |
| 20s | node 111 sends "test" | suppressed — `cooldown active — 40s remaining (node 111)` |
| 70s | node 111 sends "test" | fires (window elapsed) |

Under **Each node, per source**, node 111 heard on `tcp-1` and on `mqtt-1` cools down independently
— a message on one source never suppresses the ack on the other.

**Degraded fallback, honestly stated.** Per-node/per-source scoping needs a subject to key off. When
an event has none, the cooldown falls back to one shared timer — the same behaviour as *The whole
automation* — rather than never firing or never cooling down. This applies to:

- **Schedule** and **System** triggers (no triggering message, so no subject node at all).
- **MeshCore channel messages.** MeshCore **DMs and room posts** get real per-sender cooldown, keyed
  by the sender's public key — the same identity Auto-Acknowledge's own per-node cooldown uses. A
  **channel** post cannot, on any design: the protocol carries no per-sender identity on a channel
  packet, only a synthetic per-channel slot key shared by *every* sender on that channel, so keying
  off it would look per-node while actually being per-channel.

The live trace names which fallback applied, e.g. `cooldown active — 12s remaining (automation-wide
(this event has no subject node))`.

## Conditions

Conditions form the **IF** of each rule. Each condition is a *router*: matched events follow its
**true** path to one set of actions, and non-matching events can follow a **false** path to a
different set — this is how If / ElseIf / Else is built.

| Condition | What it checks |
| --- | --- |
| **Always (no filtering)** | A pass-through that always matches — use it when a rule should act unconditionally |
| **Number comparison** | A numeric field (`==`, `!=`, `>`, `<`, `>=`, `<=`). Fields come from the event (e.g. hop count, SNR/RSSI), the hydrated **node** record (battery, hops away, role, position, age, …), or the node's **latest telemetry**. The value can be a literal or `{{ var.name }}` |
| **Text comparison** | A string field (`contains`, `equals`, `starts with`, `ends with`, `matches regex`, `doesn't contain`) over message text, node name/role, etc. |
| **Source is one of…** | The **Source filter** — restricts the workflow to a chosen subset of sources (the "global but scopeable" knob). Leave empty to allow any source |
| **Distance from a point** | The subject node is within / farther than *N* km of a reference lat/lon |
| **Variable check** | Compares a [user-defined variable](#variables) against a literal or another value; with no operator it tests "is set / flag raised?" |
| **Time of day** | The current time is within an `HH:MM`–`HH:MM` window |

A missing or undefined field never throws — numeric/string comparisons against it simply evaluate
**false**.

### FINALLY combine modes

The optional FINALLY step runs its own actions based on the combined results of the preceding rules:

- **ANY** — at least one rule matched.
- **ALL** — every rule matched.
- **NONE** — no rule matched.
- **ALWAYS** — run unconditionally, regardless of the rules.

To make a rule contribute *only* its true/false result to a FINALLY combine (without doing anything
itself), give it the **Do nothing** action (see below).

## Actions

Actions are the **THEN**. A rule's true path (and/or false path, and/or the FINALLY step) runs one
or more actions.

### Send a tapback (reaction)

Reacts to the triggering message with an emoji. Minimal by design — it carries no routing logic
(the conditions do the routing).

- **Emoji source** — *A fixed emoji* (default; what every existing automation does before this
  field existed) or *The message's hop count*.
- Hop-count mode reacts with `*️⃣` for a direct (0-hop) message and `1️⃣`–`7️⃣` above, clamping at
  `7️⃣` — the same table Auto-Acknowledge uses, so the two features never drift apart.
- Triggers with no hop information (a Schedule or System trigger wired to a tapback, or a message
  whose hop data is missing) record a **skipped no-op**, not a run failure.
- The **Emoji** field is hidden while hop-count mode is selected; your fixed emoji is remembered if
  you switch back to it later.
- MeshCore sources are still skipped — MeshCore has no tapback concept on the protocol.
- **Send via sources** — which radios send the reaction. Leave none to use the source that
  triggered the automation — but a source **is required** for source-less triggers (System events
  and Schedules).

### Send a message

Sends text to a channel or as a DM, with full `{{ }}` token interpolation in the body.

- **Send via sources** — a multi-select of which radios to transmit through. **MQTT sources are
  receive-only and excluded.** Both **Meshtastic and MeshCore** sources are valid send targets.
  Leave it empty to use the source that triggered the automation — but a source **is required** for
  source-less triggers (System events and Schedules).
- **On channels** — a multi-select of channels, **unified across sources by protocol + name** and
  shown with **MC / MT badges**. The correct local slot is resolved per source, and a Meshtastic
  channel is never sent to a MeshCore source (and vice-versa). Disabled channel slots are excluded.
  Raw channel PSKs are never sent to the browser.
- **DM to node #** — send as a direct message instead of to a channel (Meshtastic only — MeshCore
  sends always go to a channel/region, never a DM-by-node). `{{ trigger.from }}` replies to the
  sender.
- **Reply to the triggering message** — on **Meshtastic** this threads the reply as a tapback (via
  the triggering packet id). MeshCore has no packet-id/thread concept on the wire, so on **MeshCore**
  this instead **auto-prepends the sender mention** `@[<senderLabel>]: ` to the outgoing text — the same
  `@[Name]:` markup the in-app reply button uses — so an automation can reply to whoever sent the
  triggering message without hand-writing the mention. The label comes from
  `{{ trigger.senderLabel }}` (sender name → channel name → id), so even an anonymous channel post
  still gets a sensible mention; if nothing at all can be resolved nothing is prepended, and if your
  text already begins with an `@[…]` mention it is left as-is (no double mention). See
  [Universal message tokens](#universal-message-tokens-meshtastic--meshcore) — reference the sender via
  `{{ trigger.senderLabel }}` / `{{ trigger.fromName }}`, not the raw `{{ trigger.from }}`.
- **MeshCore scope** *(advanced; MeshCore sources only — ignored by Meshtastic)* — which region a
  MeshCore message floods to: **Inherit (channel / source default)**, **Match the triggering
  message's scope** (reply on the same region it arrived on), **Unscoped (flood, no region)**, or
  **A specific region…** — the latter reveals a **Region** picker (token-aware). See
  [Regions / Scopes](/features/meshcore#regions-scopes).

The overall send is a **source × channel matrix**: each selected source posts to the matching local
slot of each selected channel.

> **MeshCore channel-send auto-retry** — because a MeshCore channel/broadcast send is an unacked
> flood, the `Send message` action (like every automated MeshCore channel sender) can optionally be
> resent once if no repeater is heard re-flooding it within 30 seconds. This is a global, opt-in,
> one-shot behavior (off by default) configured in **Settings → MeshCore Messaging**; it never
> retries user-typed messages, never retries direct messages (those have their own always-on ACK
> retry), and the resend can never trigger a fresh automation. See
> [Automated Channel-Send Auto-Retry](/features/meshcore#automated-channel-send-auto-retry).

### Manage the node

Runs an admin/management operation on the subject node: **Favorite / Unfavorite**, **Ignore /
Unignore**, or **Delete**.

### Request data from a node

Asks a node to report data — the automation equivalent of the manual request buttons. Works on
**both Meshtastic and MeshCore** sources.

- **Request** — what to ask for: **Telemetry**, **Position (Meshtastic)**, **Traceroute / path**,
  **Node info exchange (Meshtastic)**, **Neighbor info**, or **Announce self (advert)**.
- **Telemetry type** — which metric set to ask for, when the request is **Telemetry**.
- **Via sources** — which radio(s) to send the request through. Leave empty to use the triggering
  source — but a source **is required** for source-less triggers (Schedule / System).
- **Target node** — node # (Meshtastic) or contact public key (MeshCore). Leave blank to target the
  triggering node. Not used for **Announce self**.
- **Channel #** *(advanced; Meshtastic only)* — which channel to send the request on (e.g. a private
  sensor channel); ignored by MeshCore.

### Send a notification (Apprise)

Dispatches an out-of-band notification through [Apprise](/features/notifications) with a `Title`,
`Body` (both token-interpolated), and a **Severity** (Info / Success / Warning / Failure). It
resolves the Apprise endpoint from the normal chain (per-source → global → `APPRISE_URL` → bundled
service), and you can optionally supply inline **Apprise URL(s)** to override the target.

### Run a script

Runs a script file from the server's **`$DATA_DIR/scripts`** folder (the same directory the Auto
Responder uses) when the automation fires.

- **Script** — picked from a dropdown of files in the scripts directory.
- The trigger context is passed to the script as **`MM_*` environment variables**:
  `MM_TRIGGER_TYPE`, `MM_SOURCE_ID`, `MM_NODE_NUM`, `MM_TIMESTAMP`, and each trigger field as
  `MM_<UPPER_SNAKE_NAME>` (object values are JSON-stringified). Message-style aliases (`MESSAGE`,
  `FROM_NODE`, …) are provided for compatibility with existing scripts.
- **Store result in** *(optional)* — captures the script's JSON stdout into a variable. Use a
  **`json`** typed variable and index into the result later with `{{ var.name.field }}` (see
  [Variables](#variables) and [Tokens](#tokens)).
- A non-zero exit code is recorded as an action error on the run. Path-traversal protection, the
  interpreter pick, and the execution timeout are reused from the existing script runner.

> The script itself does **not** send messages — capture its output into a variable, then use a
> separate **Send a message** action to relay it.

### Set a variable / flag

Writes a **dynamic** [variable](#variables): **Set to value**, **Increment by**, **Raise flag**, or
**Clear / lower flag**. Read-only constants can't be written here.

### Do nothing

A no-op action. Use it so a rule contributes only its true/false outcome to a FINALLY combine step
without performing any action of its own.

### Pause

Waits a number of seconds (0–300) before the next action in the branch runs — a bounded, in-process
delay that serializes naturally with the sequential action executor, so later actions in the same
branch wait for it. Use it to space out a sequence, e.g. `Message trigger → Pause → Send a message`
to let a repeater finish transmitting before replying. The pause only lasts for this run and is not
durable across a restart; the dry-run [simulator](#testing-dry-run) resolves it instantly instead of
actually waiting.

## Recipe — per-channel range-test acks (issue #4340)

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
  [Cooldown applies to](#cooldown-applies-to). This keys the throttle off the sending node, so
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

## Variables

Variables are a separate, first-class management area under the Automations tab. A variable is
referenced everywhere as `{{ var.name }}` and participates in conditions, actions, and text
interpolation.

**Two roles** (a single `readonly` flag):

- **Constant** (`readonly`) — you set the value directly in the Variables UI (e.g.
  `lowBatteryThreshold = 20`). Automations may read it but never write it. This is the
  "thresholds / config" case.
- **Dynamic** — managed by automations at runtime via **Set a variable / flag** (flags, counters,
  last-seen values).

**Types:** `string`, `integer`, `float`, `boolean`, `flag`, and `json`.

- A **`flag`** is a boolean that **auto-clears after a configured duration**. It's the anti-spam
  primitive: *"have I already welcomed this node in the last 24 h?"* — raise the flag when you act,
  and a `Variable check` that the flag is **not** set gates the next run. Expiry is evaluated at
  read time, so it survives restarts.
- A **`json`** variable holds structured data — typically the captured output of a **Run a script**
  action — and is indexed with nested access (below).

**Scopes** decide what the value is keyed by:

| Scope | One value per… |
| --- | --- |
| `global` | the whole instance |
| `source` | source connection |
| `node` | physical node (shared across sources) |
| `sourceNode` | a (source, node) pair |

For scoped variables the key is resolved from the trigger context automatically — `node` /
`sourceNode` bind to the trigger's **subject node**, `source` / `sourceNode` to the trigger's
source. Schedule and system triggers have no subject node, so a node-scoped variable there needs an
explicit reference.

**Nested access:** for `json` variables (and any object value), index into fields with
`{{ var.name.a.b }}`. Referencing the whole variable renders it as JSON. Variable **names must be
dot-free identifiers** so the `name.path` split is unambiguous.

## Tokens

Text fields that support substitution (message body, DM-to, notification title/body, condition
values, the set-variable value) accept **double-brace tokens**:

| Token | Resolves to |
| --- | --- |
| `{{ trigger.* }}` | A field from the current trigger (e.g. `{{ trigger.text }}`, `{{ trigger.fromId }}`, `{{ trigger.hops }}`, `{{ trigger.value }}`, `{{ trigger.latestVersion }}`). The available fields depend on the trigger type |
| `{{ trigger.hopEmoji }}` | The message trigger's hop count as an emoji — `*️⃣` direct, `1️⃣`–`7️⃣` (`7️⃣` = 7 or more). Same mapping as the tapback's hop-count mode above. Blank when the hop count is unknown |
| `{{ trigger.sourceId }}` / `{{ trigger.timestamp }}` | Available for every trigger; `timestamp` renders as a local date/time |
| `{{ var.name }}` | A user-defined variable; `{{ var.name.field }}` for nested `json` access |
| `{{ NOW }}` | The current time, rendered as a local `YYYY-MM-DD HH:mm:ss` |

### Universal message tokens (Meshtastic + MeshCore)

A **message** trigger (`trigger.message`) fires on both protocols, so these tokens are **standardized**
to mean the same thing on each — use them and your automation is portable:

| Token | Meshtastic | MeshCore |
| --- | --- | --- |
| `{{ trigger.senderLabel }}` | Node long/short name, else `!hex` id | Parsed sender name, else channel name, else pubkey/`channel-<idx>` |
| `{{ trigger.fromName }}` | Node long name → short name → id | Parsed sender name (from the `Name:` body prefix / resolved contact) |
| `{{ trigger.channelName }}` | Channel name (empty on a DM) | Channel name (empty on a DM / room post) |
| `{{ trigger.isDM }}` / `{{ trigger.isChannel }}` | Direct message / channel broadcast | Direct message / channel post |
| `{{ trigger.protocol }}` | `meshtastic` | `meshcore` |

`{{ trigger.senderLabel }}` is the **"just works" label for addressing a reply** — it always resolves
to something usable. Prefer it (or `{{ trigger.fromName }}`) over the **raw identity** tokens:

- `{{ trigger.from }}` / `{{ trigger.fromId }}` are **raw identity**: on Meshtastic the node number /
  `!hex` id; on MeshCore the sender's public key — or, for a channel message (which carries no
  per-sender key on the wire), the synthetic `channel-<idx>` slot key, **not** a sender identity.

### In-builder validation

Token-bearing fields render with live highlighting so typos surface immediately:

- A **recognized** token is shown **blue**.
- An **unrecognized** token (a typo like `{{ trigger.lastestVersion }}`, or an unknown variable) is
  shown **red with a wavy underline**, and is also listed inline below the field
  ("Unrecognized token(s): … — check for typos").

Recognition is built from the trigger's token set plus your known variable names. It's a
**non-blocking hint** — it won't stop you saving, so a valid-but-unenumerated token is never
falsely rejected.

### Substitutions help drawer

A **`?`** button at the top of the builder opens a docked, non-modal **Substitutions** sidebar that
stays open while you edit. It lists every `{{ trigger.* }}` token for the current trigger type (and
the rest), plus `{{ var.* }}` and `{{ NOW }}`, so you can author tokens without leaving the field.

## Testing (dry-run)

The builder includes a **▶ Test panel** that runs the automation against a **synthetic event** with
**no mesh IO, no Apprise dispatch, and nothing persisted**. It returns the full trace — whether the
trigger matched, each condition's verdict, the resolved action parameters, and any simulated
variable writes. A **Run a script** action is stubbed in the dry-run, so testing never spawns a
process.

You supply the synthetic inputs the conditions need:

- **Message inputs** — text, plus **SNR**, **RSSI**, and a **Via MQTT** toggle (so
  `{{ trigger.snr }}` / `{{ trigger.rssi }}` can be exercised, including the MQTT case where signal
  metrics are absent).
- **Subject-node facts** — **Hops away**, channel utilization, air-util TX, node SNR, altitude, and
  more, so `node.*` conditions can actually be made true.
- **System Event** and telemetry **Metric** are dropdowns (not free text, which would silently
  no-match on a typo); a **From source** selector lets you exercise the **Source filter** condition;
  and a schedule trigger dry-runs as matched.

The result is rendered human-readably — the interpolated message text, the tapback emoji, the
notification title/body/URLs — with the raw resolved parameters behind a toggle. When a run matches
the trigger but no action fires, the panel explains that every condition went false and points at
which inputs/facts to change.

</div>

## Live trace ("view logs")

Where the dry-run Test panel exercises a rule against a **synthetic** event, the **live trace**
watches **real events** flowing through a rule without sending anything itself. Each rule in the
Automations list has a **Trace** button that opens a live debug view of just that rule; once armed,
every event that reaches the rule is streamed to the panel in real time (over the dashboard socket),
showing **why it did or didn't run**:

- **fired** — the trigger matched and the action steps ran; the per-step trace is shown.
- **prefiltered** — the event was filtered out before the conditions ran (e.g. wrong source/channel),
  with the reason.
- **cooldown** — the rule matched but was suppressed by its cooldown window. The reason names the
  key that was cooling down, e.g. `cooldown active — 40s remaining (node 111)` or
  `cooldown active — 12s remaining (automation-wide (this event has no subject node))` (see
  [Cooldown applies to](#cooldown-applies-to)).

The panel keeps the most recent entries in a rolling buffer and **auto-stops after 5 minutes** (and
on close or disconnect), so a trace never runs unbounded.
