# Coverage Report

The Coverage Report is a passive, measured coverage map: dots on a map,
coloured by signal, built from real position packets your radios already
heard. It replaces the Range Test module Meshtastic firmware 2.8 removed —
but works differently. Range Test made two nodes trade dedicated test
packets. Coverage Report needs no dedicated test traffic at all: drive a node
that broadcasts its position, and every receiver that hears it becomes a
data point.

## MeshMonitor sends nothing

**This feature sends zero packets.** It only records position packets a
Meshtastic source already received over RF. MeshMonitor never pushes
configuration to your survey node and never requests anything from the mesh
to build this report. The only airtime cost is the survey node's own
position broadcasts — see [How to survey](#how-to-survey) below for the
numbers.

## How to survey

Take one node with GPS for a drive (or walk) around the area you want to
map, with position broadcast turned on. Recommended settings on that node:

- **hop_limit 0** — the position travels no further than direct radio range,
  which is what a coverage map wants to measure.
- **Smart position** enabled — it honours `hop_limit 0` rather than
  overriding it with the firmware default of 3.
- **Position interval 30 seconds or more** — more frequent broadcasts add
  airtime without adding much new coverage data.

**Receiver firmware caveat:** a receiving node only keeps a zero-hop
(`hop_limit 0`) packet on firmware **2.7.20 or later** — older firmware
drops packets with `hop_start == 0` before it even decrypts them. If any
node in your mesh that might hear the survey drive runs older firmware, use
**hop_limit 1** instead. A direct copy still shows as 0 hops in the report;
the cost is that each neighbour now rebroadcasts the packet once too.

Airtime cost at a 30-second position interval:

| `hop_limit` | Tx per fix | % of channel per hour |
| --- | --- | --- |
| 0 | 1 | ~2% |
| 1 | 2–4 | ~4–8% |
| 3 | 4–8 | ~8–16% |

These are rough estimates (a position packet takes about 0.5–0.6 s on
LongFast) and scale with how many neighbours rebroadcast. `hop_limit 3` is
shown for reference only — it is not recommended for surveying.

The report's own **Setup guidance** panel (collapsed by default, below the
map) repeats this same recommendation and table.

## Reading the report

Open **Analysis & Reports** from the dashboard sidebar, then click the
**Coverage Report** card.

### Filters

- **Time range** — presets (1 h, 6 h, 24 h default, 3 days, 7 days) or a
  custom from/to range with an **Apply** button. Nothing refetches until you
  click a preset, click Apply, or click Refresh.
- **Sender** — narrow to one survey node, or leave on **All**. The dropdown
  shows each sender's name, `!id`, and how many fixes it produced in the
  current window.
- **Receivers** — every receiver that has heard anything in the retention
  window, grouped by source and sorted by how many receptions each has. Each
  row is marked **Local** (your own radio) or **Gateway** (an MQTT gateway).
  Search by name or `!id`, use **Select all** / **Select none**, or tick a
  whole source group at once. All are selected by default.
- **MQTT recording status** — each MQTT source shows **Recording** or
  **Off**. When it's off, **Turn on in source settings** opens that source's
  toggle.
- **Hops** — Any, or an exact hop count 0–7. Check **Up to this many hops**
  to turn it into a ceiling instead of an exact match.
- **Colour by** — SNR (default) or RSSI.
- **Refresh** — re-runs the current filters against the latest data. The
  report does not poll in the background.

### The map

Each dot is one physical position fix. Its colour is the **best** (highest)
reading among the receptions currently in scope — with one receiver
selected, that receiver's own reading. Receiver locations are drawn as
larger, distinctly outlined markers with a permanent name label.

Click a dot to see every reception of that fix within your current filter:
receiver name, SNR, RSSI, whether it arrived **direct** or **relayed** (with
the hop count and the relaying node's short ID), and the distance between
the fix and that receiver. RSSI can be blank ("—") when the receiving
firmware didn't report it; SNR is blank the same way. A path shows as
**Unknown** rather than a hop count when the packet's zero-hop bitfield
isn't present — that happens on firmware older than 2.5.0.

The legend shows the same four signal bands (Excellent / Good / Fair /
Poor) used elsewhere in MeshMonitor, plus **No data**. For a fix heard with
one or more hops, the colour reflects the **last relay's link**, not a
straight line back to the original sender — the dot's position is the
sender's, but its colour describes the hop that actually reached the
receiver you're looking at.

A **truncation banner** appears if a window returns more than the report
will load (about 10,000 rows); narrow the time range or filters to see the
rest. An **empty state** explains that only receptions recorded since you
upgraded to a MeshMonitor version with this feature appear — there is no
backfill from data collected before that.

## What gets recorded

**Meshtastic radio (RF) sources** record receptions **always**. A position
packet that arrived over MQTT on a radio source is skipped, since an
MQTT-relayed copy's SNR isn't your radio's own reading.

**MQTT sources** (broker and bridge) record only when you turn it on, per
source, under **Settings → Coverage recording** for that source. It is off by
default. Once on, every gateway that uplinks a position packet becomes a
receiver, with the SNR and RSSI that gateway measured, so one drive can show
what every gateway in the area heard.

- **Volume:** a regional feed adds about 12,000–14,000 rows a day (about
  90,000–100,000 rows, 35–50 MB, over 7 days of retention). A world-wide
  `msh/#` feed can reach about 1 million rows a day and several GB a week.
  There is no cap beyond retention; the toggle asks you to confirm.
- **Not recorded:** a gateway's own position, packets a gateway reports it
  got over MQTT or UDP, packets with a stale receive time (more than 10
  minutes old, from a wrong gateway clock or a late queue flush), and
  gateways on your ignore list.
- **Missing nodes:** nodes that turn off "OK to MQTT" aren't uplinked by
  gateways on public brokers, so they never appear.
- Rows only start from when you turn recording on; nothing is back-filled.

MeshMonitor stores **one row per distinct path**: the same fix heard
directly and heard again relayed through a different neighbour are two
separate rows, because they describe two different links. An exact repeat
of the same path (a retransmission of the identical packet through the
identical relay) collapses into the one row already stored — first copy
wins, later copies aren't merged in.

## Retention

Open **Global Settings → Coverage Report** to set how many days of receptions are
kept, from **1 to 90**, default **7**. This is a single, deployment-wide
setting, not a per-source one. An hourly background sweep deletes rows older
than the configured window. **Lowering the value deletes older data on the
next sweep, and that cannot be undone** — the settings field warns about
this before you save.

## Privacy

A position only appears on the Coverage Report if it would also appear on
the [Map Analysis](./map-analysis) positions layer: hidden-from-map nodes,
private overrides you don't hold the permission to view, and channels
without "view on map" enabled are all excluded, using the same checks as
`/api/analysis/positions`. You also need **read** permission on a source to
see its receivers, senders, or receptions at all — a source you can't read
contributes nothing to the report.

## What's next

Planned follow-ups (not yet built, and not scheduled): MeshCore receptions,
likely-gap detection, saved surveys exempt from retention, a summary panel,
and CSV/GeoJSON export.

## Related

- [Analysis & Reports](./analysis-reports) — the workspace this report's
  card lives in
- [Map Analysis](./map-analysis) — the positions layer this report reuses
  the same visibility rules from
- [Packet Monitor](./packet-monitor) — the opt-in per-source packet logs,
  a different feature with its own retention model
- [Global Settings](./global-settings) — where the retention window is configured
