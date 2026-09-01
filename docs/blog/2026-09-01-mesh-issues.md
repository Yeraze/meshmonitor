---
id: news-2026-09-01-mesh-issues
title: Mesh Issues — a passive health report for your mesh
date: '2026-09-01T18:00:00Z'
category: feature
priority: normal
minVersion: 4.15.2
tags: [mesh-issues, analysis, meshtastic, feedback]
---

**MeshMonitor v4.15.2** ships a new **Mesh Issues** report. It scans the data you already collect and turns it into a ranked list of things worth fixing, without sending a single packet.

The report groups findings into three tiers:

- **Tier A — Node health**: deprecated roles, chatty nodes, congested areas, infra nodes on failing power.
- **Tier B — RF adjacency**: router clusters, redundant routers, asymmetric links, load-bearing clients, coverage shadows.
- **Tier C — Node flags**: key-security warnings, over-broadcasting, time-offset issues.

You can view findings **By Issue** (per-rule tables with sortable columns) or **By Node** (every finding for a single node in one place), dismiss anything not worth acting on, and click a node name to jump straight to its DM thread on the right source.

Every rule has a short two-letter ID like **B1** or **C2**. The [Mesh Issues Test Reference](https://meshmonitor.org/features/mesh-issues-test-reference) explains each one, its threshold, and what to do about it.

## This is version 1

The rules are conservative and the thresholds are tuned to a few real meshes, not everyone's. Some findings will be noise for you. Some real problems it won't catch yet. Please try it and tell us what worked or what didn't:

- **Useful signals** — which findings actually led you to fix something?
- **False positives** — which rules keep flagging things you don't care about?
- **Missing rules** — what would you want it to catch?

Open an issue at [github.com/Yeraze/meshmonitor/issues](https://github.com/Yeraze/meshmonitor/issues) with the label **mesh-issues**, or drop a note wherever you already reach us. Every piece of feedback will shape the next round of thresholds and rules.

Full docs: [Mesh Issues Analysis](https://meshmonitor.org/features/mesh-issues) · [Test Reference](https://meshmonitor.org/features/mesh-issues-test-reference).
