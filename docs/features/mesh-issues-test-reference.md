# Mesh Issues Test Reference

Quick-reference for every test in the [Mesh Issues Analysis](./mesh-issues)
report. Each test carries a short ID — a letter for the tier and a number
for the rule — so you can read a finding like **B3** and know at a glance
what it checks and why it fired.

## Naming scheme

| Letter | Tier | What it examines |
| --- | --- | --- |
| **A** | Node health | Per-node telemetry: roles, airtime, power, mobility, behavior |
| **B** | RF adjacency graph | Relationships between nodes: who hears whom, routing weight, coverage |
| **C** | Node flags | Flags from other MeshMonitor detectors, plus broadcast-rate checks |

The number after the letter identifies the specific rule within that tier.
Some rules have a letter suffix (e.g. **A2a**, **A2b**) when two related
checks share the same data but fire on different conditions.

## Severity levels

| Level | Meaning |
| --- | --- |
| **critical** | A condition that actively harms the mesh (e.g. a large router cluster) |
| **warning** | A problem worth fixing — performance or reliability is degraded |
| **info** | Noteworthy but not urgent — a suggestion or something to watch |

---

## Tier A — Node health

These tests read per-node data directly: role, airtime utilization, battery,
uptime resets, and position history.

### A1 — Deprecated role

| | |
| --- | --- |
| **Fires when** | A node's role is set to REPEATER or ROUTER_CLIENT |
| **Severity** | warning |
| **Threshold** | None — any node with either role triggers it |
| **Why it matters** | Both roles are legacy holdovers. Meshtastic's own guidance recommends ROUTER_LATE for dedicated routing and CLIENT or CLIENT_BASE for everything else. REPEATER and ROUTER_CLIENT may behave unpredictably on current firmware. |
| **What to do** | Change the node's role to ROUTER_LATE (if it is a fixed, powered router) or CLIENT_BASE (if it is fixed and powered but not meant to route). |

### A2a — Chatty node

| | |
| --- | --- |
| **Fires when** | A node's mean `airUtilTx` over 24 hours exceeds the ceiling, with at least 6 telemetry samples |
| **Severity** | warning |
| **Threshold** | **8%** `[official]` — from Meshtastic's ROUTER_LATE documentation. Tunable in settings. |
| **Why it matters** | A single node using more than ~8% of the channel crowds out everyone else on the same frequency. On a busy mesh this cascades into collisions and retransmissions. |
| **What to do** | Check the node's broadcast intervals (position, telemetry), hop limit, and whether it is running chatty modules. Lower the intervals or reduce the hop limit. |

### A2b — Congested area / Congested node

| | |
| --- | --- |
| **Fires when** | **Area:** 3+ nodes in one ~5.5 km geographic bin have a mean `channelUtilization` above the ceiling. **Node:** 1–2 nodes in a bin exceed the ceiling but there aren't enough neighbors to confirm area-wide congestion. |
| **Severity** | warning (area) / info (single node) |
| **Threshold** | **25%** `[official]` — from Meshtastic's ROUTER_LATE documentation. Tunable in settings. |
| **Why it matters** | High channel utilization means packets are competing for airtime. Above 25%, the channel is congested and packet loss climbs. |
| **What to do** | Identify the chattiest nodes in the area (often flagged by A2a as well). Reduce broadcast intervals, lower hop limits, or split traffic across channels. |

### A3 — Infra node on failing power

| | |
| --- | --- |
| **Fires when** | An infrastructure-role node (not externally powered, battery ≠ 101%) has either 2+ uptime resets in 7 days or battery below 20% |
| **Severity** | warning (resets) / info (low battery only) |
| **Threshold** | **20% battery floor**, 2 resets minimum, 7-day window `[MeshMonitor]` |
| **Why it matters** | A router that keeps rebooting or is about to die takes routes with it. Other nodes learn routes through it, then lose them on each reset — causing retransmissions and temporary black holes. |
| **What to do** | Check the power source. Solar nodes may need a larger panel or battery. If the node can't stay powered reliably, change its role to CLIENT so the mesh doesn't depend on it. |

### A4 — Mobile infra node

| | |
| --- | --- |
| **Fires when** | An infrastructure-role node's observed position span exceeds the mobility distance threshold |
| **Severity** | warning |
| **Threshold** | **500 m** `[MeshMonitor]`, tunable in settings. Requires at least 17-bit position precision (~305 m). |
| **Why it matters** | Routers and repeaters are expected to be stationary. A moving infrastructure node advertises positions that other nodes use for routing decisions — those decisions go stale as soon as it moves. |
| **What to do** | If the node is genuinely mobile, change its role to CLIENT. If it's stationary but GPS drift causes the span, consider fixing its position or raising the mobile-span threshold. |

### A5 — Cosplay router

| | |
| --- | --- |
| **Fires when** | A ROUTER-role node has `isUnmessagable=false` (firmware ≥2.5.0), or broadcasts telemetry with a median interval under 2 hours (at least 5 samples) |
| **Severity** | info |
| **Threshold** | **2 h median**, 5 samples minimum, firmware ≥2.5.0 for the unmessagable check `[MeshMonitor]` |
| **Why it matters** | A true router should be quiet — minimal telemetry, not accepting messages. A node set to ROUTER that still broadcasts like a client gets the routing priority of a router without the quiet behavior the mesh expects from one. |
| **What to do** | If the node is meant to be a user-facing device, change it to CLIENT or CLIENT_BASE. If it's meant to route, check that its telemetry and position intervals match router best practices. |

---

## Tier B — RF adjacency graph

These tests build a graph of which nodes can hear each other — from
traceroutes, NeighborInfo, and (where enabled) packet-log receptions — then
evaluate the structure of that graph.

### B1 — Router cluster

| | |
| --- | --- |
| **Fires when** | 2 or more ROUTER/REPEATER-role nodes are mutually audible (within the cluster distance limit) **and** their non-cluster client neighbors overlap significantly |
| **Severity** | warning (2–3 nodes) / critical (4+ nodes) / info (inferred-only evidence) |
| **Threshold** | Cluster size 2 (warning), 4 (critical). Distance guard: **30 km** default, tunable. Client overlap: **90%** (same as B2). `[MeshMonitor]` |
| **Why it matters** | Routers that can hear each other **and serve the same clients** compete for the same traffic. Each one rebroadcasts the same packets, multiplying airtime without improving coverage. |
| **What to do** | Keep one router in the area and change the others to CLIENT_BASE (if they need to stay powered and connected) or CLIENT. Spread routers so each one covers a distinct area the others can't reach. |

#### How the detection works

B1 is the most involved rule in the report. It builds on an **RF adjacency
graph** shared with several other Tier B rules, then runs a two-pass clique
extraction to find clusters of routers that can all hear each other.

**Step 1 — Build the RF graph.** The graph records which nodes can hear
which, assembled from three evidence sources:

| Source | Evidence class | Type |
| --- | --- | --- |
| **NeighborInfo** | `neighborInfo` | Direct |
| **Traceroute adjacent-hop links** | `traceroute` | Direct |
| **MQTT gateway heard a node at 0 hops with real SNR** | `gatewayDirect` | Direct |
| **Two nodes both directly heard by the same MQTT gateway** | `gatewayCoReception` | Inferred |

The graph maintains two adjacency maps: one with only **direct** edges
(the first three classes), and one with **all** edges including inferred
co-reception. NeighborInfo rows are deduped by `(nodeNum, neighborNum,
timestamp)` to collapse cross-source duplicates (the same packet arriving
via TCP and via N MQTT gateways).

**Step 2 — Filter to cluster-eligible roles.** Only nodes with role
ROUTER, ROUTER_CLIENT, or REPEATER are candidates. ROUTER_LATE is
deliberately excluded — it is the recommended fix, so including it would
make the remedy re-raise the finding.

**Step 3 — Apply the distance guard.** Before clustering, every edge is
checked against the `routerClusterMaxLinkKm` threshold (default **30 km**,
tunable 1–500 km). If both nodes have known positions, the great-circle
distance must be within the limit. If either node lacks a usable position
the edge is kept (fail-open). This guard exists because MQTT-bridged
firmwares can record traceroute "hops" between repeaters 100+ km apart
that never happened over RF, carrying plausible SNR that no other filter
can catch.

**Step 4 — Extract cliques (two passes).** The algorithm finds **cliques**,
not connected components — every member of a cluster must be adjacent to
every other member. This avoids the transitivity problem where a chain of
genuine short links could merge far-apart routers into one finding whose
endpoints never actually hear each other.

The extraction is greedy and deterministic:

1. Compute each candidate's "restricted degree" (count of neighbors also
   in the candidate set that pass the distance guard).
2. Sort candidates by restricted degree descending, then by node number
   ascending (for determinism).
3. For each unassigned seed in priority order, grow a clique by admitting
   every unassigned candidate (in the same order) that is adjacent to ALL
   current members.
4. Emit cliques of size 2 or larger. Mark all members as assigned — each
   router appears in at most one finding.

This runs in **two passes**:

- **Pass 1 (direct evidence only):** Extracts cliques over the
  direct-adjacency map (neighborInfo, traceroute, gatewayDirect edges).
  These clusters have strong evidence of mutual audibility.
- **Pass 2 (inferred evidence, leftovers only):** Extracts cliques among
  nodes not assigned in pass 1, using the full adjacency map (including
  gatewayCoReception). These clusters are marked `inferredOnly` — the
  evidence only proves a shared gateway heard both routers, not that the
  routers hear each other.

**Step 5 — Check client overlap.** Mutual audibility alone does not make a
cluster redundant. A backbone of well-sited routers that each covers a
different set of local clients is healthy infrastructure. Before emitting a
finding, B1 computes the pairwise overlap of each member's **non-cluster
direct neighbors** (their "clients"):

1. For each member, collect their direct neighbors minus other cluster
   members.
2. For each pair where both members have at least 3 clients (the same
   minimum B2 uses), compute the overlap ratio: shared clients divided by
   the smaller set's size.
3. Take the maximum pairwise overlap across all computable pairs.

The outcome depends on this overlap:

- **Max overlap ≥ 90%** (at least one pair serves nearly identical
  clients): the finding proceeds — this cluster is genuinely redundant.
- **Max overlap < 90%** and at least one pair was computable: the finding
  is **suppressed entirely** — the members serve distinct coverage areas.
- **No pair computable** (not enough non-cluster neighbor data): the
  finding proceeds as-is — we can't prove the cluster is harmless, so it
  stays visible.

**Step 6 — Assign severity and confidence.**

| Condition | Severity | Confidence |
| --- | --- | --- |
| `inferredOnly` (pass 2 cluster) | info | low |
| Direct evidence, 4+ members | critical | high or medium |
| Direct evidence, 2–3 members | warning | high or medium |

Confidence is **high** when every internal edge has neighborInfo or
traceroute evidence, **medium** when some edges rely only on gatewayDirect.

**Step 7 — Select the best-sited member.** For the recommendation text, the
rule picks one member to keep as the router — the one with the highest
direct-adjacency degree (most RF neighbors), ties broken by most positioned
direct edges, then lowest node number. The others are recommended for
demotion to CLIENT_BASE or CLIENT.

**Lifecycle:** A cluster's identity key includes its size and a hash of its
members. If a router is removed or added, the old finding auto-closes after
the configured clean-run count and a new finding is created for the changed
cluster.

### B2 — Redundant router

| | |
| --- | --- |
| **Fires when** | One infra node's direct-neighbor set is ≥90% covered by another's, both with at least 3 neighbors |
| **Severity** | warning |
| **Threshold** | **90% overlap**, 3 neighbors minimum `[MeshMonitor]` |
| **Why it matters** | Two routers that serve almost exactly the same set of nodes are redundant — the mesh gains little from the second one, but pays the airtime cost of its rebroadcasts. |
| **What to do** | Relocate or re-role one of the pair. If both locations matter for reliability, consider changing one to CLIENT_BASE so it stays connected without routing. |

### B3 — Asymmetric link

| | |
| --- | --- |
| **Fires when** | The directional mean SNR between two nodes differs by more than the ceiling, with at least 3 samples per direction |
| **Severity** | warning (infra endpoint involved) / info (both clients) |
| **Threshold** | **6 dB** `[MeshMonitor]`, tunable in settings |
| **Why it matters** | An asymmetric link means one side hears the other well but not the reverse. Packets route through the strong direction but acknowledgments fail on the weak return — causing retransmissions, phantom routes, and unreliable delivery. |
| **What to do** | Check antennas, feedlines, and siting on the weaker side. Asymmetry usually points to a hardware or placement difference, not a firmware issue. |

### B4 — Idle router

| | |
| --- | --- |
| **Fires when** | An infra node is heard directly but carries less than 1% of its area's traceroute hops, while a peer carries more than 10% |
| **Severity** | info |
| **Threshold** | **1% / 10% hop share split**, 20 minimum area paths `[MeshMonitor]` |
| **Why it matters** | A router that exists but carries no traffic is using airtime (rebroadcasts, telemetry) without contributing to connectivity. The mesh routes around it, which means its placement or configuration isn't helping. |
| **What to do** | Investigate why traffic avoids this node — poor SNR to neighbors, a better-placed peer, or misconfigured hop limits. If it genuinely isn't needed, change it to CLIENT_BASE or remove it. |

### B5 — Load-bearing CLIENT

| | |
| --- | --- |
| **Fires when** | A non-infra node appears as an intermediate hop in 10+ traceroutes and carries 25%+ of its area's paths |
| **Severity** | warning (not fixed and powered) / info (fixed and powered) |
| **Threshold** | **10 traceroutes**, **25% area share** `[MeshMonitor]` |
| **Why it matters** | A client node the mesh depends on for routing is a single point of failure — it may be battery-powered, mobile, or turned off at any time. The mesh treats it as a router by accident. |
| **What to do** | If the node is stationary and powered, promote it to ROUTER_LATE or CLIENT_BASE so the mesh can rely on it intentionally. If it's mobile or battery-powered, deploy a dedicated router nearby to take over its routing role. |

### B6 — Hop horizon

| | |
| --- | --- |
| **Fires when** | Over 50% of a node's deduplicated observed packets arrive with `hopLimit=0`, from at least 20 packets |
| **Severity** | info |
| **Threshold** | **50% exhausted ratio**, **20 packets** minimum `[MeshMonitor]` |
| **Why it matters** | Packets arriving at hop limit 0 can't be rebroadcast — they've used all their hops reaching this node. If most traffic arrives exhausted, this node sits at the edge of the mesh's reach and may not be able to relay anything onward. |
| **What to do** | Consider adding a router between this node and the mesh core, or raising the default hop limit on nearby nodes (with care — higher hop limits multiply airtime). |

### B7 — Coverage shadow

| | |
| --- | --- |
| **Fires when** | An MQTT-only node (never heard over RF) falls inside a nearby router's observed RF range |
| **Severity** | info |
| **Threshold** | Minimum 3 range samples, 25 km range cap `[MeshMonitor]`. **Off by default** (toggle in settings). |
| **Why it matters** | A node that only appears via MQTT but sits within RF range of a router suggests the RF path isn't working — the node may have an antenna problem, be on the wrong frequency, or be blocked by terrain. |
| **What to do** | Verify the node's RF configuration (frequency, region, modem preset) matches its neighbors. Check for antenna or siting issues. If the node is intentionally MQTT-only, dismiss the finding or mute B7. |

---

## Tier C — Node flags

These tests fold in flags computed by other MeshMonitor services and add one
broadcast-rate check of their own.

### C1 — Excessive packet rate

| | |
| --- | --- |
| **Fires when** | The `isExcessivePackets` flag is set (MeshMonitor's own detector, deduplicated across vantages) |
| **Severity** | warning |
| **Threshold** | Set by the packet-rate detector, not by this rule |
| **Why it matters** | A node sending far more packets than normal floods the channel. This may be a firmware bug, a misconfigured module, or a stuck broadcast loop. |
| **What to do** | Check the node's packet log for the source of the flood. Common causes: store-and-forward replay, a position module stuck in fast-lock mode, or a third-party integration sending too often. |

### C1 — Key security issue

| | |
| --- | --- |
| **Fires when** | Any of: low-entropy key, duplicate key, or key mismatch is flagged |
| **Severity** | warning |
| **Threshold** | Set by the key-security detector |
| **Why it matters** | A weak or mismatched encryption key compromises the node's security and can prevent it from communicating with peers that expect a different key. |
| **What to do** | See the [Security](./security) documentation for guidance on key management. Regenerate the node's key or resolve the mismatch. |

### C1 — Clock offset

| | |
| --- | --- |
| **Fires when** | The `isTimeOffsetIssue` flag is set |
| **Severity** | info |
| **Threshold** | **30 minutes**, set by `TIME_OFFSET_THRESHOLD_MINUTES` environment variable |
| **Why it matters** | A node with a drifted clock timestamps its packets incorrectly, which confuses message ordering, telemetry graphs, and time-based analysis. |
| **What to do** | Connect the node to a phone (to sync time via Bluetooth) or ensure it has GPS lock. Nodes without a time source drift over time. |

### C2 — Over-broadcasting

| | |
| --- | --- |
| **Fires when** | A non-tracker node's deduplicated position **or** telemetry median inter-arrival time falls below the floor, with at least 6 samples |
| **Severity** | warning (unpowered or under half the floor) / info (otherwise) |
| **Threshold** | **300 seconds** `[MeshMonitor]`, tunable in settings |
| **Why it matters** | Frequent broadcasts consume airtime that could carry actual messages. A node sending position every 60 seconds uses 5x the airtime of one sending every 300 seconds — and each broadcast is rebroadcast by every router that hears it. |
| **What to do** | Raise the node's position and telemetry broadcast intervals. 300 seconds (5 minutes) is a reasonable floor for most nodes. TRACKER, SENSOR, and TAK_TRACKER roles are exempt from this rule — they are designed to report frequently. |

---

## Threshold sources

Thresholds marked `[official]` come from Meshtastic's own ROUTER_LATE
documentation. Thresholds marked `[MeshMonitor]` are MeshMonitor's own
judgement — chosen to avoid false positives on small or sparse meshes.

Five thresholds are tunable in **Global Settings > Mesh Issues Analysis**:

| Setting | Default | Rules affected |
| --- | --- | --- |
| Air utilization TX ceiling | 8% | A2a |
| Channel utilization ceiling | 25% | A2b |
| Mobile span | 500 m | A4 |
| Link SNR asymmetry | 6 dB | B3 |
| Broadcast interval floor | 300 s | C2 |
| Router cluster max link | 30 km | B1 (distance guard) |

All other thresholds are fixed in code. See the
[Mesh Issues Analysis](./mesh-issues#where-the-thresholds-come-from)
documentation for the full constant table.

## Related

- [Mesh Issues Analysis](./mesh-issues) — the full feature documentation, including settings, permissions, API, and report navigation
- [Analysis & Reports](./analysis-reports) — the workspace that hosts this and other analytical reports
- [Traffic Management](./traffic-management) — related controls for managing mesh airtime
