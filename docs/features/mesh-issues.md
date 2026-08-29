# Mesh Issues Analysis

Mesh Issues Analysis is a scheduled health report that reads data your sources
have already collected — node telemetry, traceroutes, NeighborInfo, and
(where enabled) packet-log receptions — and surfaces the routing and RF
problems that data already shows. It does not probe the mesh to find them.

## The passive guarantee

**This feature sends zero packets.** It never generates a traceroute, never
polls a node, and never sends a message. Every finding comes from packets
your node or your MQTT sources already received and stored. "Run analysis
now" runs the same read — it is passive too.

This matters because LoRa is a shared, half-duplex medium: a feature that
looks cheap on a desk with one node becomes mesh-wide congestion on a busy
channel with 200. A health report earns the right to run on a schedule (24
hours by default) only by staying entirely off the air. See the [Mesh Impact
checklist](https://github.com/Yeraze/meshmonitor/blob/main/CLAUDE.md#mesh-impact-checklist)
for the reasoning this feature was built against.

## How it works

Analysis is a **global, cross-source batch job**, structurally identical to
[Position Estimation](./position-estimation): it runs on a schedule (not in
realtime), pools data from every source you can read, and stores findings in
one global table. MeshCore sources are excluded — `meshcore_nodes` has no
`role`/`airUtilTx` equivalent for the rules below to evaluate.

Findings are grouped into three tiers, run in order:

- **Tier A — Node health.** Reads `nodes` and `telemetry` directly: battery,
  uptime, airtime/channel utilization, and the position history of
  infrastructure-role nodes.
- **Tier B — RF adjacency graph.** Builds a graph of which nodes can hear each
  other from traceroutes, NeighborInfo, and (where enabled) the MQTT/Meshtastic
  packet logs, then evaluates router clustering, redundancy, link asymmetry,
  and coverage over that graph.
- **Tier C — Node flags.** Folds in flags other MeshMonitor services already
  compute (packet-rate, key-security, and clock-offset detectors) and adds one
  new check of its own: nodes broadcasting position or telemetry far more
  often than the mesh needs.

Each finding tracks its own lifecycle: **new**, **reopened** (closed, then
seen again), **updated** (still open, evidence refreshed), or **closed**
(stopped recurring). A finding is never deleted outright — see
[Dismissing and auto-close](#dismissing-and-auto-close).

## What each rule means

`[official]` marks a threshold sourced from Meshtastic's own ROUTER_LATE
guidance. `[MeshMonitor]` marks MeshMonitor's own judgement — reasonable,
but not an official number, and usually tunable (see [Settings](#settings)).

### Tier A — Node health

| Rule | Fires when | Threshold | Severity |
| --- | --- | --- | --- |
| **A1** Deprecated role | Node's role is REPEATER or ROUTER_CLIENT | — | warning |
| **A2a** Chatty node | Mean `airUtilTx` over 24 h exceeds the ceiling, ≥6 samples | 8% `[official]`, tunable | warning |
| **A2b** Congested area | ≥3 nodes in one ~5.5 km bin, mean `channelUtilization` over the ceiling | 25% `[official]`, tunable | warning |
| **A2b** Congested node | 1–2 nodes in a bin exceed the ceiling — not enough neighbors to confirm area-wide congestion | 25% `[official]`, tunable | info |
| **A3** Infra node on failing power | Infrastructure role, not powered (battery ≠101), and either ≥2 uptime resets in 7 days or battery <20% | 20% battery floor `[MeshMonitor]` | warning (resets) / info (battery only) |
| **A4** Mobile infra node | Infrastructure role whose observed position span exceeds the mobility distance | 500 m `[MeshMonitor]`, tunable | warning |
| **A5** Cosplay router | ROUTER role with `isUnmessagable=false` (firmware ≥2.5.0), or broadcasting telemetry with a median interval under 2 hours (≥5 samples, needs the packet log) | 2 h median, 5 samples `[MeshMonitor]` | info |

### Tier B — RF adjacency graph

| Rule | Fires when | Threshold | Severity |
| --- | --- | --- | --- |
| **B1** Router cluster | ≥2 ROUTER/REPEATER-role nodes are mutually audible | cluster size 2 `[MeshMonitor]` | warning (≥2), critical (≥4), info (inferred-only evidence) |
| **B2** Redundant router | One infra node's direct-neighbor set is ≥90% covered by another's, both with ≥3 neighbors | 90% overlap `[MeshMonitor]` | warning |
| **B3** Asymmetric link | Directional mean SNR between two nodes differs by more than the ceiling, ≥3 samples per direction | 6 dB `[MeshMonitor]`, tunable | warning (infra endpoint involved) / info |
| **B4** Idle router | An infra node is heard direct but carries <1% of its area's traceroute hops while a peer carries >10% | 1%/10% split `[MeshMonitor]` | info always |
| **B5** Load-bearing CLIENT | A non-infra node appears as an intermediate hop in ≥10 traceroutes and ≥25% of its area's paths | 25% area share `[MeshMonitor]` | warning (not fixed+powered) / info |
| **B6** Hop horizon | Over 50% of a node's deduped observed packets arrive with `hopLimit=0`, ≥20 packets | 50%/20 packets `[MeshMonitor]` | info |
| **B7** Coverage shadow | An MQTT-only node (never RF-heard) falls inside a nearby router's observed RF range | — (info only) | info, **default rule toggle** |

### Tier C — Node flags

| Rule | Fires when | Threshold | Severity |
| --- | --- | --- | --- |
| **C1** Excessive packet rate | `isExcessivePackets` flag is set (own detector, deduped across vantages) | — | warning |
| **C1** Key security issue | Any of low-entropy key, duplicate key, or key mismatch is flagged | — | warning |
| **C1** Clock offset | `isTimeOffsetIssue` flag is set | 30 min, fixed by `TIME_OFFSET_THRESHOLD_MINUTES` (env) | info |
| **C2** Over-broadcasting | A non-tracker node's deduped position **or** telemetry median inter-arrival falls under the floor, ≥6 samples | 300 s `[MeshMonitor]`, tunable | warning (unpowered or under half the floor) / info |

C2 exempts TRACKER, SENSOR, and TAK_TRACKER roles — those roles exist to
report frequently by design, and the rule would otherwise fire on every
correctly configured device of that type. A node with no known role is
skipped rather than assumed innocent or guilty.

## Where the thresholds come from

Only two numbers here are official Meshtastic guidance, both from the
firmware's ROUTER_LATE documentation:

- **ChUtil (channel utilization) above 25%** means an RF area is congested.
- **AirUtilTX above 7–8%** means a single node is using too much of the
  channel. MeshMonitor uses 8% as the default ceiling.

Every other number — cluster sizes, overlap ratios, hop-share splits, sample
minimums, window lengths — is MeshMonitor's own judgement, chosen to avoid
false positives on a small or sparse mesh rather than derived from an
official source. Five of them are exposed as [tunable
settings](#settings); the rest stay fixed in code, listed here for reference:

| Constant | Value | Rule(s) |
| --- | --- | --- |
| Chatty-node minimum samples | 6 | A2a |
| Utilization window | 24 h | A2a, A2b |
| Congested-area minimum nodes | 3 | A2b |
| Geographic bin size | ~0.05° (~5.5 km) | A2b |
| Battery-low floor | 20% | A3 |
| Battery minimum samples | 3 | A3 |
| Uptime-reset minimum count | 2 | A3 |
| Power window | 168 h (7 days) | A3, A4 |
| Minimum position precision | 17 bits (~305 m) | A4 |
| Unmessagable-aware firmware floor | 2.5.0 | A5 |
| Telemetry-cadence median ceiling | 2 h | A5 |
| Telemetry-cadence minimum samples | 5 | A5 |
| Directional-SNR minimum samples | 3 per direction | B3 |
| Gateway-direct minimum receptions | 3 | evidence class 3 |
| Gateway cell size cap | 64 nodes | evidence class 3 |
| Gateway SNR sample cap | 25 per edge | evidence class 3 |
| Redundant-router minimum neighbors | 3 | B2 |
| Redundant-router overlap ratio | 90% | B2 |
| Idle-router minimum area paths | 20 | B4 |
| Idle-router max hop share | 1% | B4 |
| Idle-router peer min hop share | 10% | B4 |
| Load-bearing minimum traceroutes | 10 | B5 |
| Load-bearing minimum area share | 25% | B5 |
| Hop-horizon exhausted ratio | 50% | B6 |
| Hop-horizon minimum packets | 20 | B6 |
| Coverage-shadow minimum range samples | 3 | B7 |
| Coverage-shadow range cap | 25 km | B7 |
| Router-cluster warning size | 2 | B1 |
| Router-cluster critical size | 4 | B1 |
| Over-broadcast minimum samples | 6 | C2 |
| Auto-close clean-run count | 3 | all rules |
| Evidence list cap | 25 entries | all list-shaped evidence |

## Acting on findings

The recommendations in this report never suggest ROUTER, and never say
"promote". Meshtastic's own guidance is that ROUTER is a legacy role kept for
compatibility, not a fix to reach for. Depending on the finding, the right
move is usually one of:

- **CLIENT** — the default for a mobile or non-infrastructure node. If a
  node shows up in a load-bearing or redundant-router finding but isn't
  fixed and powered, deploying another CLIENT nearby (not upgrading this
  one) is the fix.
- **CLIENT_BASE** — for a node that is fixed and powered but not meant to
  route for others; the natural landing spot for a mobile-flagged
  infrastructure node (A4) or an over-committed CLIENT (B5) once it's
  confirmed stationary.
- **ROUTER_LATE** — the modern replacement for ROUTER/ROUTER_CLIENT/REPEATER
  when a location genuinely needs a dedicated router. It routes with lower
  priority so it doesn't dominate a busy channel.

Some findings point to hardware or siting, not a role change at all — B3
(asymmetric link) usually means an antenna, feedline, or siting difference,
and A3 (infra node on failing power) means checking the power budget.

## Coverage and why a rule is silent

Not every rule can evaluate on every install. A **coverage preface** at the
top of the report states, in plain language, what evidence a run actually
had and which rules went quiet for lack of it:

- **B3, B6, and B7 lean on optional data.** B3 (asymmetric link) needs
  traceroutes or MQTT-derived SNR samples; B6 (hop horizon) needs a packet
  log (Meshtastic or MQTT) enabled; B7's evidence gets stronger with an MQTT
  source enabled, though it can still fire without one. The preface tells you
  which of these are off, as a hint — never as an instruction to turn
  something on. Both packet logs are opt-in, per-source features with their
  own storage cost, and this report doesn't get to make that call for you.
- **B7 estimates range, it doesn't model terrain.** A router's "observed
  range" is the farthest positioned direct neighbor it has actually heard,
  capped at 25 km. It has no idea about hills or buildings between two
  points — a hill on one bearing doesn't shrink the estimate on a clear
  bearing 90° away.
- **B6's hop delta is a lower bound.** Firmware 2.7+ gives favourite-router
  hops zero cost, so a packet can travel further than its `hopLimit`
  decrements suggest. B6 can under-flag as a result — never over-flag.
- **C2's candidate gate is a mean, not the median it reports.** Finding
  candidates cheaply for a mesh-wide scan requires a fast first pass; the
  final number shown is always a true median, but the initial gate uses a
  mean, which can miss a node that broadcasts in a tight burst and then goes
  silent for days. This is deliberately the safe direction to be wrong in.
- **A5's telemetry-cadence clause needs the packet log.** The second
  "cosplay router" signal — a ROUTER broadcasting telemetry far more often
  than the 12-hour role default (median under 2 hours, at least 5 samples) —
  reads broadcast `TELEMETRY_APP` receptions from the packet log, which is
  opt-in and off by default. With the packet log disabled the clause reports
  itself as unavailable and A5 falls back to the `isUnmessagable` clause
  alone; it never fires on missing data.

## Dismissing and auto-close

Dismissing a finding hides it **for every user** — it's administrative state,
not a per-viewer preference — and is reversible at any time by restoring it.
Dismissing does not stop a finding's lifecycle: if the underlying condition
is still there on the next run, a dismissed finding still gets its evidence
refreshed; only its visibility changes.

A finding that stops recurring **auto-closes** after a number of consecutive
clean runs — the "Auto-close after" setting, default 3 (about 3 days at the
default 24-hour cadence), clamped to 1–20. Disabling a tier or a rule doesn't
delete its existing findings; they simply stop reappearing and auto-close the
same honest way. If you set the analysis frequency much faster than 24 hours,
the auto-close window shrinks along with it (a 1-hour cadence auto-closes in
about 3 hours); much slower, and it lengthens correspondingly.

## Settings

Open **Global Settings** (the gear icon in the dashboard sidebar) → **Mesh
Issues Analysis**. The controls are global and require `settings:write`.

**Schedule**

| Setting | Default | Notes |
| --- | --- | --- |
| Enabled | on | Turns the whole scheduled job on or off. |
| Analysis frequency | 24 hours | How often the batch job runs. |
| Lookback window | 168 hours (7 days) | How far back telemetry/traceroute data is pooled. |
| Traceroute pair bucket | 6 hours | How the traceroute corpus dedupes repeated observations of the same node pair before sampling. |

**Rules**

| Setting | Default | Notes |
| --- | --- | --- |
| Tier A | on | Node health rules (A1–A5). |
| Tier B | on | RF adjacency graph rules (B1–B7). |
| Tier C | on | Node-flag rules (C1, C2). |
| Coverage shadow (B7) | on | Separate toggle inside Tier B — this is the one rule observed firing at pathological volume (500+ findings) on a busy mesh, so it can be turned off without disabling the rest of Tier B. |

**Thresholds**

| Setting | Default | Range | Provenance |
| --- | --- | --- | --- |
| Airtime TX ceiling | 8% | 1–50% | `[official]` |
| Channel utilization ceiling | 25% | 5–100% | `[official]` |
| Mobile span | 500 m | 50–50,000 m | `[MeshMonitor]` |
| Link SNR asymmetry | 6 dB | 1–30 dB | `[MeshMonitor]` |
| Broadcast interval floor | 300 s | 30–3,600 s | `[MeshMonitor]` |
| Auto-close after | 3 clean runs | 1–20 | `[MeshMonitor]` |

Every value is **clamped when read**, not rejected on save: an out-of-range
number you enter is silently pulled back to the nearer bound the next time
the scheduler (or this settings page) reads it, so a bad value degrades to a
bounded run instead of an unbounded one. Saving these settings never runs
analysis and never resets the schedule's last-run timer — use **Run
analysis now** for that.

A **Run analysis now** button triggers an immediate, still-passive run. If
one is already in progress, a second click is rejected rather than queued.
The last-run line below the controls shows when analysis last completed and
how many findings it produced; after a container restart, this line is
recovered from the last successful run's stored summary rather than going
blank until the next scheduled run.

## Overlap with the Security tab

C1's three findings — excessive packet rate, key security, and clock offset —
surface the exact same node flags the [Security tab](./security) already
shows. That's intentional, not a bug: C1 doesn't add new detection,
it puts those flags in the same health report as the routing and RF
findings, with dismiss/restore and the same auto-close lifecycle every other
finding gets. If you see a node flagged both places, they're the same
underlying signal — dismissing it here doesn't clear it there, and vice
versa, since the two features track state independently.

## Permissions & API

Findings and status map to permitted **source read access**; the routes
gate the same way `resolvePermittedSourceIds` does elsewhere in the app —
a caller who can't read any source gets an empty/forbidden response rather
than a 500. Dismissing and restoring, and the scheduled job's manual
trigger, require the global `settings:write` permission, with a visibility
check that returns 404 (not 403) for a finding whose contributing sources
you can't read — so a `settings:write` holder with narrow source access
can't dismiss, or even discover the existence of, a finding outside their
permitted sources.

- `GET /api/analysis/mesh-issues` — list findings for your permitted sources
- `GET /api/analysis/mesh-issues/status` — scheduler status, resolved
  thresholds, and the last run's coverage summary
- `POST /api/analysis/mesh-issues/run-now` — trigger a run immediately (`settings:write`)
- `POST /api/analysis/mesh-issues/:id/dismiss` / `/restore` — hide/unhide a
  finding for everyone (`settings:write`, plus the visibility check above)
- Settings are saved through `POST /api/settings` (`settings:write`)

## Related

- [Analysis & Reports](./analysis-reports) — the cross-source reports workspace this feature's report card lives in
- [Position Estimation](./position-estimation) — the other global, scheduled, cross-source batch job this feature is modeled on
- [Global Settings](./global-settings)
- [Packet Monitor](./packet-monitor) — the opt-in packet logs that strengthen B3/B6/B7's evidence
- [Multi-Source](./multi-source)
