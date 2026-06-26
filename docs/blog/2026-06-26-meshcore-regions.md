---
id: news-2026-06-26-meshcore-regions
title: MeshMonitor 4.12.0 — MeshCore Regions & Scopes
date: '2026-06-26T18:05:00Z'
category: feature
priority: important
minVersion: 4.12.0
---
As MeshCore meshes have grown, so has the noise. To keep a busy area from drowning in re-flooded traffic, MeshCore added the concept of **regions** (also called **scopes**) — a way to tag flood traffic so repeaters only forward what's meant for them. MeshMonitor 4.12.0 brings first-class support for regions to the MeshCore experience.

## What is a region / scope?

A region is a named tag attached to a flooded packet. MeshCore derives a *transport key* from the region name and uses it to decide whether a repeater should forward a packet — there's no parent/child hierarchy, just name matching. Operators in dense areas configure their repeaters with `region denyf *`, which **stops forwarding of legacy, unscoped flood packets** — so any sender that wants its traffic to propagate *must* tag it with the right region. (An alternative, `flood.max.unscoped`, lets a limited number of unscoped packets through instead.)

If you've ever joined a regional MeshCore network — say a "Germany" or a Pacific-Northwest mesh — and found your messages weren't getting anywhere, a missing scope tag is very often why.

The MeshCore project documents all of this in detail:

- [Region Filtering](https://blog.meshcore.io/2026/01/20/region-filtering) — the original explanation of scoped group channels and repeater filtering.
- [Default Scope Region](https://blog.meshcore.io/2026/04/17/default-scope) — the v1.15 "default scope" for companions and repeaters.
- [MeshCore CLI Commands](https://docs.meshcore.io/cli_commands/) — including `region`, `region denyf`, and `flood.max.unscoped`.
- [MeshCore Docs & FAQ](https://docs.meshcore.io/faq/) — general reference.

## What MeshMonitor 4.12.0 adds

**Per-channel and per-source scope.** Each MeshCore channel can carry a Region/Scope, and each source gets a default scope (`meshcoreDefaultScope`) in MeshCore Settings. In 4.12.0 the scope is applied to **all** originated flood traffic — channel messages, DMs, adverts, remote-admin logins, remote telemetry, and remote CLI — so your traffic actually propagates on a `denyf`'d mesh.

**Discover Regions.** A one-click sweep ([#3765](https://github.com/Yeraze/meshmonitor/pull/3765)) queries the repeaters you can reach directly (zero hops), routes the query straight to them, and reports back the regions they advertise — distinguishing "no nearby repeaters" from "repeaters that reported no regions."

**Per-message overrides.** Need to send a single message into a different region without changing your defaults? A scope control next to the compose box lets you override the region for just that message ([#3704](https://github.com/Yeraze/meshmonitor/pull/3704)). It's one-off and never persisted, with a datalist of discovered regions.

**See the scope on received messages.** Incoming messages now show the region they were sent with ([#3762](https://github.com/Yeraze/meshmonitor/pull/3762)): 🌐 for no scope, 🔒 with the region name when it's known, or 🔒 with a short hex code when it isn't — so you can tell at a glance whether a message arrived scoped, and to which region.

**A saved-regions catalog.** Regions you discover or use are kept in a catalog ([#3783](https://github.com/Yeraze/meshmonitor/pull/3783)), and region pickers throughout the UI offer them as suggestions, so you're not retyping names or hunting for hex codes.

## Try it

Open a MeshCore source, head to **Settings** to set a default scope, add a Region/Scope to a channel, or hit **Discover Regions** to see what's around you. The full walkthrough is in the [MeshCore documentation](/features/meshcore#regions-scopes).

Regions support landed across [#3667](https://github.com/Yeraze/meshmonitor/issues/3667) and PRs [#3704](https://github.com/Yeraze/meshmonitor/pull/3704), [#3762](https://github.com/Yeraze/meshmonitor/pull/3762), [#3765](https://github.com/Yeraze/meshmonitor/pull/3765), and [#3783](https://github.com/Yeraze/meshmonitor/pull/3783).
