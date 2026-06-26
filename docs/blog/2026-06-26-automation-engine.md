---
id: news-2026-06-26-automation-engine
title: MeshMonitor 4.12.0 — Build Your Own Automations
date: '2026-06-26T18:00:00Z'
category: feature
priority: important
minVersion: 4.12.0
---
For a while now, MeshMonitor's automations have been a fixed menu: Auto Acknowledge, Auto Traceroute, Auto Ping, Auto Responder, Auto Announce. Each one does a single, well-defined job. They're great — but if you wanted something they didn't already do, you were out of luck.

Not anymore. MeshMonitor 4.12.0 introduces the **Automation Engine** — a generic, visual *"when this happens, do that"* builder, in the spirit of Home Assistant, Node-RED, and IFTTT. It lives on its own top-level **Automations** tab, and it lets you wire up your own behavior instead of relying on the hardcoded ones. The legacy automations remain exactly as they were; the engine is the build-it-yourself alternative.

## The shape of an automation

Every automation is a small graph you build in a guided, linear editor:

```
WHEN  →  RULE (IF … THEN …)  →  optional FINALLY
```

- **WHEN** — exactly one **trigger** that starts things off.
- **RULE** — one or more **conditions** that decide whether to act, each routing to its own **actions**. Conditions are routers with a *true* and *false* path, so you get If / ElseIf / Else logic.
- **FINALLY** — an optional combine step that runs based on how the rules turned out: **ANY**, **ALL**, **NONE**, or **ALWAYS**.

Automations run **globally** — they evaluate events from *every* connected source at once, just like Map Analysis — with an optional **Source filter** condition when you want to scope one down. They're gated by a dedicated `automations` permission, carry a per-automation cooldown and loop guard, log every run for debugging, and export/import as JSON (imports land disabled for review).

## Triggers, conditions, actions

**Triggers** — a message arrives (with channel-name matching and substring/regex filters), a node is discovered or updated, telemetry crosses a threshold, a **cron schedule** fires ([#3726](https://github.com/Yeraze/meshmonitor/pull/3726)), a system event happens (start, source online/offline, **upgrade available**), or a node **enters/leaves a geofence** drawn right on the map ([#3721](https://github.com/Yeraze/meshmonitor/pull/3721)).

**Conditions** — number and text comparisons over the event, the hydrated node record (battery, hops, role, position, age…), or its latest telemetry; a source filter; distance from a point; a variable check; and a time-of-day window. A missing field never throws — it just evaluates false.

**Actions** — send a tapback, **send a message** (with a "Send via sources" multi-select and unified "On channels" picker that badges MeshCore vs Meshtastic), manage a node, fire an **Apprise notification**, or **run a script** from your data directory with `MM_*` environment variables and a JSON-typed result you can reference later ([#3746](https://github.com/Yeraze/meshmonitor/pull/3746)).

## Variables and tokens

You can define your own **variables** — constants or runtime flags/counters — in a dedicated management area, with global/source/node scopes and nested access into JSON values. And everywhere you can type text, you can drop in **substitution tokens** that resolve at run time:

```text
Node {{ trigger.fromId }} just reported {{ trigger.value }} at {{ NOW }}.
Last seen counter: {{ var.seenCount }}
```

The builder validates tokens as you type — recognized tokens turn blue, typos get a red wavy underline ([#3727](https://github.com/Yeraze/meshmonitor/pull/3727), [#3739](https://github.com/Yeraze/meshmonitor/pull/3739)) — and a Substitutions drawer lists every token available for the current trigger.

## Test before you ship

Every automation has a built-in **Test panel**: run it against a synthetic event — set SNR/RSSI/Via-MQTT, hops-away, node facts — with **no mesh traffic, no notifications, and nothing saved**. The panel shows the interpolated message, the chosen action, and, when nothing fires, explains which condition went false and what to change.

## Try it

The Automation Engine is in the new **Automations** tab in 4.12.0. The full guide — triggers, conditions, actions, variables, tokens, and the test panel — is in the [Automation Engine documentation](/features/automation-engine).

This feature shipped across a series of PRs: [#3653](https://github.com/Yeraze/meshmonitor/issues/3653) (the engine), [#3721](https://github.com/Yeraze/meshmonitor/pull/3721), [#3726](https://github.com/Yeraze/meshmonitor/pull/3726), [#3727](https://github.com/Yeraze/meshmonitor/pull/3727), [#3739](https://github.com/Yeraze/meshmonitor/pull/3739), and [#3746](https://github.com/Yeraze/meshmonitor/pull/3746).
