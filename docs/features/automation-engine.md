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
- **Cooldown / rate-limit** per automation prevents mesh spam, plus a per-run action cap and a
  loop guard so an automation can't runaway-recurse.
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
| **A message is received** | A text/packet message arrives | `Text contains` (case-insensitive substring), `Text matches regex`, channel match, `From node #` |
| **A new node is discovered** | A node is seen for the first time | — |
| **A node is updated** | A node record changes (name, role, position, …) | — |
| **Telemetry is received** | A telemetry reading arrives | `Metric` filter (battery, voltage, temperature, channel utilization, air util TX, …) |
| **On a schedule** | A cron expression fires | 5-field cron expression |
| **A system event** | An engine/source lifecycle event | `System start`, `Source came online`, `Source went offline`, `Upgrade available` |
| **A node enters/leaves a region** | A node crosses a geofence | `Enters` / `Leaves` / `Moves while inside (dwell)`, plus a map region editor |

### Message trigger & channel-name matching

The message trigger can filter on text (substring or regex) and on the **channel**. Prefer matching
by **channel name** (`On channel (name)`) rather than raw slot index: the same logical channel can
sit in a different slot on different sources, so a name match is portable across your whole mesh.
The raw `On channel #` index is still available for single-source cases.

### Schedule trigger (live cron)

The schedule trigger fires on a standard **5-field cron** expression (e.g. `0 * * * *` = top of
every hour). It is backed by a live [croner](https://github.com/Hexagon/croner) job:

- A cron job is armed per enabled schedule automation; **create / update / enable / disable /
  delete** all re-arm correctly (the old job is stopped first, so there are never stale or
  duplicate jobs).
- The per-automation **cooldown** is honored on each fire.
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
- **DM to node #** — send as a direct message instead of to a channel. `{{ trigger.from }}` replies
  to the sender.
- **Reply to the triggering message** — thread the reply to the message that fired the automation.
- **MeshCore scope** *(advanced; MeshCore sources only — ignored by Meshtastic)* — which region a
  MeshCore message floods to: **Inherit (channel / source default)**, **Match the triggering
  message's scope** (reply on the same region it arrived on), **Unscoped (flood, no region)**, or
  **A specific region…** — the latter reveals a **Region** picker (token-aware). See
  [Regions / Scopes](/features/meshcore#regions-scopes).

The overall send is a **source × channel matrix**: each selected source posts to the matching local
slot of each selected channel.

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
| `{{ trigger.sourceId }}` / `{{ trigger.timestamp }}` | Available for every trigger; `timestamp` renders as a local date/time |
| `{{ var.name }}` | A user-defined variable; `{{ var.name.field }}` for nested `json` access |
| `{{ NOW }}` | The current time, rendered as a local `YYYY-MM-DD HH:mm:ss` |

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
- **cooldown** — the rule matched but was suppressed by its cooldown window.

The panel keeps the most recent entries in a rolling buffer and **auto-stops after 5 minutes** (and
on close or disconnect), so a trace never runs unbounded.
