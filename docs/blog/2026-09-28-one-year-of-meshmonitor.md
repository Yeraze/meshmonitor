---
id: news-2026-09-28-one-year-of-meshmonitor
title: One Year of MeshMonitor - A Year in Development
date: '2026-09-28T15:00:00Z'
category: announcement
priority: normal
tags: [milestone, retrospective, community, stats]
---

MeshMonitor turned one. The first commit landed on **25 September 2025**. As of **28 September 2026**, that is **368 days** of near-daily work. This post looks back at the year in numbers.

All figures come straight from the git history, measured against the v4.16.2-rc5 tag. Read them as a snapshot, not a scoreboard.

## The headline number

**4,104 commits in 368 days.** That works out to about **11 commits a day**, every day, weekends included.

The project recorded work on **362 of those 368 days**. Six days off in a year. The longest unbroken run was a **164-day streak**, from 9 April to 19 September 2026 — more than five months without a gap.

## What the commits did

The year splits cleanly by commit type:

- **968 features** — new capability
- **1,353 fixes** — more fixes than features, which is the healthy ratio for software people actually run
- **780 chores** — dependency bumps, releases, housekeeping
- **151 docs**, **141 refactors**, and a scatter of tests and CI work

## Releases

- **420 release tags** across the year
- **71 minor version lines**, from the earliest v3 builds to today's v4.16.2-rc5
- Roughly a tagged build every **1.3 days** on average

## When the work happened

The busiest single day was **3 February 2026 with 43 commits**. The busiest month was **February 2026 with 478**.

Most commits landed in the **early afternoon** — noon, 1 PM and 3 PM were the three peak hours. Only about **13%** of commits came between 10 PM and 6 AM, so this was mostly daylight work, not a series of all-nighters. **Monday** was the most productive weekday by a clear margin.

## The busiest corners of the code

The files that changed most across the year (dependency locks and generated files excluded):

- `src/server/meshtasticManager.ts` — the radio manager, touched **551 times**
- `src/server/server.ts` — **470**
- `src/services/database.ts` — **390**
- `src/App.tsx` — **365**

No surprise that the radio connection layer and the database saw the most churn. That is where the meshes stress the code.

## Who built it

- **Randall Hand** authored **3,305 commits** — about **81%** of the total
- **Dependabot** contributed **426** keeping dependencies current
- **Weblate** translators added roughly **170** across two bot accounts
- Community contributors, including Midnight Cowboy and Nearl Crews, filed the rest

Every translation, bug report, packet capture and pull request from the community shaped the year. Several of this year's best fixes started as a capture from someone running a mesh far larger than any test bench.

## What a year of this built

A quick tour of what shipped over twelve months, without listing every release:

- **MeshCore support** — a whole second protocol, from first ingest to channel management, coverage reporting and virtual nodes
- **The automation engine** — triggers, templates and packet-hash matching
- **Firmware management** — OTA updates driven from the browser
- **Coverage Report** — measured RF coverage maps built from real receptions
- **Likely-aircraft and asset tracking** — ADS-B flight matching, trails and timeline playback
- **Per-source permissions, OIDC, MFA** and a long run of security hardening
- **The desktop app**, **embedded MQTT broker**, **estimated positions**, **impersonation detection** — and hundreds of fixes that never made a headline but kept large meshes connected

## Thank you

One year, 4,104 commits, and a community that keeps reporting the hard bugs. Here is to the next one.

The full history is in the [CHANGELOG](https://github.com/Yeraze/meshmonitor/blob/main/CHANGELOG.md). The current build is **v4.16.2-rc5**.
