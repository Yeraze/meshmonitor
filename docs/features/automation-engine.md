# Automation Engine

<!-- This page shows the {{ token }} syntax. The body is wrapped in a v-pre block so VitePress
     prints the double-brace tokens as text instead of evaluating them as Vue (which breaks the build). -->
<div v-pre>

The Automation Engine is MeshMonitor's rule builder: **when this happens, do that**. It is the recommended way to automate MeshMonitor. One rule can watch every source, check conditions, keep variables, send messages, run scripts and send notifications.

Open it from **Automation Engine** in the dashboard sidebar. You need the global `automations` permission to see it.

::: tip Built-in automations
Each source also has a set of fixed, older automations in its **Automation** view (MeshCore: **Automations**): Auto Acknowledge, Auto Traceroute, Timer Triggers and so on. They keep working. Several have no Engine equivalent yet. See [Automation](/features/automation) for which to use.
:::

## Pages in this section {#pages}

| Page | What it covers |
|---|---|
| This page | What the Engine is, your first automation, templates, testing and live trace |
| [Reference](/features/automation-engine-reference) | Every trigger, condition, action, variable and token |
| [Recipes](/features/automation-engine-recipes) | Range-test acks per channel, Meshtastic ↔ MeshCore bridge, Meshtastic ↔ Reticulum relay, and converting Auto Acknowledge |
| [Writing automation scripts](/developers/auto-responder-scripting) | Scripts for the **Run a script** action |

## Your first automation {#first-automation}

Get a notification when a node's battery runs low:

1. Open **Automation Engine** and click **Browse templates**.
2. Pick **Device Health**, tick **Alert on low battery %**, and set the threshold.
3. Click **Install**. The new automation lands turned off so you can check it.
4. Open it, click **▶ Test** to dry-run it, then turn on **Enabled**.

The alert goes out through [Apprise](/features/notifications), so set that up first. To build a rule from scratch, click **+ New automation** and pick a trigger, then add conditions and actions. The [reference](/features/automation-engine-reference) lists them all.

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
  ([Conditions](/features/automation-engine-reference#conditions)) to scope a workflow to a subset of sources when you want.
- **Permission-gated.** The page and its API need the global `automations`
  permission, separate from the per-source `automation` permission the built-in automations use.
- **Cooldown / rate-limit** per automation, or **per node / per source+node** via the trigger's
  [*Cooldown applies to*](/features/automation-engine-reference#cooldown-applies-to), prevents mesh spam, plus a per-run action cap and a loop guard
  so an automation can't runaway-recurse.
- **Airtime cutoff.** Sends pause on a Meshtastic source whose Channel Utilization is over its
  [cutoff](/features/automation#airtime-cutoff); the rule's other steps still run. See
  [Airtime cutoff](/features/automation-engine-reference#airtime-cutoff).
- **Variables** — a separate management area for user-defined values (constants and runtime
  flags/counters) referenced anywhere as `{{ var.name }}`.
- **Run log** — every fire is recorded with its per-step outcome for debugging.
- **JSON import/export** — automations export to JSON (personal node ids are rewritten to portable
  system tokens). Imported automations always land **disabled** for review.
- **Test / dry-run panel** — preview an automation against a synthetic event with no mesh traffic,
  no notifications, and nothing saved.

## Template Gallery

Building a graph from scratch is one path into the engine; the **Template Gallery** is the other —
a **Browse templates** button next to **+ New automation** on the Automation Engine page opens a card grid
of prebuilt automations. Pick one, fill in a small wizard (which sources/channels it should use), and
it installs — **disabled**, for review, the same as any imported automation — ready to open in the
visual builder, check over, and enable.

The gallery ships with these templates today:

- **Auto-Ack** — acknowledges direct, zero-hop text messages with a tapback or a reply, reproducing
  the common "answer range testers who hit me directly" pattern as an editable automation instead of
  a fixed feature toggle.
- **MT↔MC Bridge** — relays channel text both ways between a Meshtastic channel and a MeshCore
  channel, tagged with its protocol of origin. See [Recipe — Meshtastic ↔ MeshCore
  bridge](/features/automation-engine-recipes#recipe-mt-mc-bridge) for the full walkthrough, including the
  flood-safety guidance you should read before enabling it.
- **Device Health** — a one-click starter for node-health alerts: low battery or voltage, high
  temperature, channel utilization or noise floor, a node gone silent or heard again, a reboot, lost
  external power, and a steadily draining battery. Tick the alerts you want, and optionally limit
  them to some sources or nodes (leave both empty to watch everything). The wizard installs one
  automation per alert, each pre-wired to send an Apprise notification. Automations land disabled
  for review, so you can tune thresholds before flipping them on. The silent and heard-again alerts
  work for Meshtastic and MeshCore nodes; the reboot, power and draining-battery alerts are
  Meshtastic only. The **clock out of sync** alert is MeshCore only. It reads a node's clock from
  the adverts MeshMonitor already hears, so it sends nothing. It fires after two samples in a row
  are off by more than the threshold (300 seconds by default, 120 to 86400), once per episode, and
  at most 10 times an hour. A repeater whose clock was never set reads "Clock not set". MQTT
  sources are not sampled. A MeshCore-only alert, "a repeater gains a confirmed new neighbour", is
  covered under [New neighbour confirmed](/features/automation-engine-reference#new-neighbour-confirmed).
- **Timed Announcement** — posts a message to the Meshtastic and MeshCore channels you pick, on a
  repeat (every 5 minutes up to once a day), between a start and an end time. It turns itself off
  when the event ends. See [Timed events](/features/automation-engine-reference#timed-events-start-end-and-time-zone).

Every template installs through the same [JSON import](#overview) path as a hand-exported automation
(`POST /api/automations/import`), so it lands disabled, and a template that installs a **pair** of
automations (like the Bridge) reports each one's install result separately — a partial failure on one
automation doesn't silently swallow the other.

## Triggers {#triggers}

A trigger starts an automation: a message, a node event, telemetry, a schedule, a geofence, a system event and more. Each trigger also sets the cooldown and rate limit. See [Triggers](/features/automation-engine-reference#triggers).

- <span id="sent-by"></span>[Sent by](/features/automation-engine-reference#sent-by): match messages from people, automations, or both.
- <span id="geofence-trigger"></span>[Geofence trigger](/features/automation-engine-reference#geofence-trigger)
- [Schedule trigger (live cron)](/features/automation-engine-reference#schedule-trigger-live-cron)
- <span id="cooldown-applies-to"></span>[Cooldown applies to](/features/automation-engine-reference#cooldown-applies-to) and <span id="rate-limit-flood-ceiling"></span>[Rate limit](/features/automation-engine-reference#rate-limit-flood-ceiling)

## Conditions {#conditions}

Conditions decide whether to act. See [Conditions](/features/automation-engine-reference#conditions).

## Actions {#actions}

Actions do the work: send a message or tapback, request data, run a script, notify, manage or reboot a node, and more. See [Actions](/features/automation-engine-reference#actions).

- [Send a message](/features/automation-engine-reference#send-a-message)
- <span id="trace-meshcore-paths-on-a-schedule"></span>[Trace MeshCore paths on a schedule](/features/automation-engine-reference#trace-meshcore-paths-on-a-schedule)
- [Run a script](/features/automation-engine-reference#run-a-script)
- <span id="turn-forwarding-on-or-off"></span>[Turn forwarding on or off](/features/automation-engine-reference#turn-forwarding-on-or-off)
- <span id="broadcast-a-waypoint"></span>[Broadcast a waypoint](/features/automation-engine-reference#broadcast-a-waypoint)
- <span id="pause"></span>[Pause](/features/automation-engine-reference#pause)

## Variables {#variables}

Named values your automations read and write as `{{ var.name }}`. See [Variables](/features/automation-engine-reference#variables).

## Tokens {#tokens}

`{{ trigger.* }}`, `{{ node.* }}`, `{{ steps.* }}` and other substitutions for message text and conditions. See [Tokens](/features/automation-engine-reference#tokens).

## Recipe — per-channel range-test acks (issue #4340) {#recipe-per-channel-range-test-acks-issue-4340}

Moved to [Recipes](/features/automation-engine-recipes#recipe-per-channel-range-test-acks-issue-4340).

## Recipe — Meshtastic ↔ MeshCore bridge {#recipe-mt-mc-bridge}

Moved to [Recipes](/features/automation-engine-recipes#recipe-mt-mc-bridge). Read <span id="flood-safety"></span>[Flood safety](/features/automation-engine-recipes#flood-safety) before you turn a bridge on.

## Recipe — Meshtastic ↔ Reticulum DM relay {#recipe-mt-ret-relay}

Moved to [Recipes](/features/automation-engine-recipes#recipe-mt-ret-relay).

## Converting Auto-Acknowledge to an automation {#converting-auto-acknowledge-to-an-automation}

Moved to [Recipes](/features/automation-engine-recipes#converting-auto-acknowledge-to-an-automation).

## Testing (dry-run)

The builder includes a **▶ Test panel** that runs the automation against a **synthetic event** with
**no mesh IO, no Apprise dispatch, and nothing persisted**. It returns the full trace — whether the
trigger matched, each condition's verdict, the resolved action parameters, and any simulated
variable writes. A **Run a script** action is stubbed in the dry-run, so testing never spawns a
process.

When a script step stores its result for **This run only**, the panel shows a **Sample script
output** box for each named step. Type what the script would print — text or JSON — and the later
steps render it, so you can see the message exactly as it would be sent. Left blank, the script
prints nothing; a message built only from it then shows as **not sent**, which is what the
[empty-send rule](/features/automation-engine-reference#the-empty-send-rule) does in a real run. A write to a variable that a real run
would refuse (unknown, read-only, wrong type) shows as a failed step here too.

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
Automation Engine list has a **Trace** button that opens a live debug view of just that rule; once armed,
every event that reaches the rule is streamed to the panel in real time (over the dashboard socket),
showing **why it did or didn't run**:

- **fired** — the trigger matched and the action steps ran; the per-step trace is shown.
- **prefiltered** — the event was filtered out before the conditions ran (e.g. wrong source/channel),
  with the reason.
- **cooldown** — the rule matched but was suppressed by its cooldown window. The reason names the
  key that was cooling down, e.g. `cooldown active — 40s remaining (node 111)` or
  `cooldown active — 12s remaining (automation-wide (this event has no subject node))` (see
  [Cooldown applies to](/features/automation-engine-reference#cooldown-applies-to)).

The panel keeps the most recent entries in a rolling buffer and **auto-stops after 5 minutes** (and
on close or disconnect), so a trace never runs unbounded.
