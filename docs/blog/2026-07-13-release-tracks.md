---
id: news-2026-07-13-release-tracks
title: Two Release Tracks — Choose Your Cadence
date: '2026-07-13T18:00:00Z'
category: release
priority: important
---
For a while now, MeshMonitor has shipped *fast* — often a new release every day or two. If you're an enthusiast who likes to ride the edge, that's been great. But a lot of you told us the same thing, in different words: MeshMonitor "releases too often." A near-daily stream of updates meant constant upgrade churn and a steady low hum of maintenance for people who just want a stable dashboard on the wall that keeps working.

We heard you. Starting today, MeshMonitor publishes on **two tracks**, and you get to pick the one that fits how you run it.

## The two tracks

**Fast track — `ghcr.io/yeraze/meshmonitor:dev`**

The `:dev` tag moves with **every pre-release (RC)**. That's a near-**daily** cadence — the newest features and fixes land here first, at RC-grade stability. If you're an enthusiast, a tester, or you just like being early, this is your track. It's the same firehose MeshMonitor has always been, now on its own clearly labelled tag.

**Stable track — `ghcr.io/yeraze/meshmonitor:latest`**

The `:latest` tag moves **only when a stable release ships** — a near-**weekly** cadence. Changes are batched up and get more testing time on `:dev` before they graduate here. This is the calm, dependable track, and it's the **default recommendation for most users**.

## Details worth knowing

- **Rolling major/minor tags follow stable only.** The `:4` and `:4.13` convenience tags track the **stable** release train, just like `:latest`. They will not jump ahead to an RC.
- **Exact versions are always pinnable.** Every release — RC or stable — still publishes its precise version tag: `:4.13.0-rc3`, `:4.12.5`, and so on. If you want to lock to one specific build, pin the exact tag and nothing will move under you.
- **Already on `:latest`? Nothing changes** — except your upgrades get fewer and calmer. You'll keep receiving stable releases on the same tag you already use.
- **One caveat on `:dev`.** Right after a stable release ships, `:dev` may briefly point at an image that's *older* than `:latest` — the most recent RC that preceded the stable cut — until the next RC is published. This is expected and self-corrects the moment the next RC lands.
- **Desktop, LXC, and Helm users:** the tag mechanics above are Docker-specific, but the **stable release cadence applies to you too**. You'll see the same near-weekly rhythm of stable releases; there's simply no separate `:dev` firehose to opt into.

## Which track should I choose?

- **You run MeshMonitor as a set-and-forget dashboard, or in production for others.** → Stay on **`:latest`** (or pin `:4` / `:4.13`). Fewer, better-tested upgrades.
- **You love new features the day they exist, you help us shake out bugs, or you're chasing a fix that just merged.** → Switch to **`:dev`** and ride the edge with us.
- **You need absolute reproducibility.** → Pin an exact version tag like `:4.12.5` and upgrade on your own schedule.

When in doubt, `:latest` is the right answer.

## Switching to the fast track

If you want the fast track, it's a one-line change in your `docker-compose.yml`:

```yaml
image: ghcr.io/yeraze/meshmonitor:dev
```

Then `docker compose pull && docker compose up -d`. To go back to the stable track, point `image:` back at `ghcr.io/yeraze/meshmonitor:latest`.

## Thank you

This change came straight from your feedback, and it's the kind of feedback that makes MeshMonitor better for everyone — the folks who want the newest bits *and* the folks who want a quiet, reliable dashboard. Both are first-class now. Keep it coming.
