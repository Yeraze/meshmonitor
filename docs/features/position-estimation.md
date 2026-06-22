# Position Estimation

::: tip New in 4.9.3
Position Estimation now lives in **Global Settings** (it was previously tucked into a per-source Automation tab), and gained a **Maximum acceptable accuracy** cutoff. On the map, the uncertainty circles are now controlled by the **Show Accuracy** toggle.
:::

MeshMonitor can estimate a location for nodes that never report GPS, by pooling
the geometry already present in your mesh data — traceroutes and NeighborInfo —
into a single best-guess position per node.

## How it works

Estimation is a **global, cross-source batch job**. It runs on a schedule (not
in realtime) and pools observations from **every Meshtastic source**, including
the embedded MQTT broker and MQTT bridges. MeshCore sources are excluded.

Two kinds of geometric constraint feed the solver:

- **Traceroutes** — each `A → X → B` segment anchors the intermediate node `X`
  toward its positioned path-neighbors, biased by per-hop SNR.
- **NeighborInfo** — each direct-RF-range pair anchors the unpositioned side to
  the positioned side.

The solver computes an SNR- and time-weighted centroid of the anchor
observations, plus an **uncertainty radius** (in km):

- A node seen from a **single anchor** can only be placed "within radio range",
  so it gets a conservative default radius (~5 km).
- A node seen from **multiple converging anchors** gets a much smaller radius
  (weighted RMS distance ÷ √effective-sample-size).

For the full math behind the accuracy circle — the SNR/time weighting, the
weighted centroid, the effective-sample-size confidence blend, and worked
examples — see **[Estimated Accuracy](/features/estimated-accuracy)**.

Estimates are written to a global table — one row per physical node — so every
source shows the same estimate. A node that later reports a real position is
dropped from the estimate set automatically.

## Configuring estimation

Open **Global Settings** (the ⚙️ gear in the dashboard sidebar) → **Position
Estimation**. The controls are global and require `settings:write`.

| Control | What it does |
| --- | --- |
| **Enable** | Turns the scheduled estimator on/off. On by default. |
| **Calculation frequency** | How often the batch job runs (3 / 6 / 12 / 24 hours). Default 6h. |
| **Lookback window** | How far back observations are pooled (1 / 3 / 7 / 14 / 30 days). Default 7 days. |
| **Maximum acceptable accuracy (km)** | Estimates whose uncertainty radius is **larger** than this are discarded instead of stored — so low-confidence guesses don't litter the map with huge circles. **`0` = no limit.** |
| **Recalculate now** | Runs the job immediately. The last-run summary shows how many nodes were estimated, how many observations were pooled, and how many were **discarded** by the accuracy cutoff. |

### Choosing a maximum accuracy

The single biggest source of oversized circles is the ~5 km single-anchor
default. If your map is cluttered with large dashed circles, set **Maximum
acceptable accuracy** to roughly **2–3 km**: nodes that can only be placed
"somewhere within radio range" are dropped, while well-triangulated nodes
(seen from several directions) are kept. Already-stored estimates that no
longer qualify are cleared on the next run.

## Viewing estimates on the map

Two independent per-user map toggles live in the **Map Features** panel
(Nodes map / dashboard map):

- **Show Estimated Positions** — shows the estimated node **markers**.
- **Show Accuracy** — shows the **uncertainty circle** around each estimated
  node (and the precision-bits accuracy regions for GPS nodes). Turning it off
  declutters the map while keeping the markers.

An estimated node's uncertainty circle is drawn only when **both** toggles are
on, so a circle never appears without its marker. The circle radius is the
node's computed `uncertaintyKm` — a small circle means a confident,
multi-anchor estimate; a large one means the node could only be placed loosely.

## Permissions & API

The estimator's status and controls map to the global `settings` resource:

- `GET /api/settings/position-estimation/status` — `settings:read`
- `POST /api/settings/position-estimation/run-now` — `settings:write`
- Settings are saved through `POST /api/settings` — `settings:write`

## Related

- [Estimated Accuracy](/features/estimated-accuracy) — the accuracy-circle algorithm in depth
- [Global Settings](/features/global-settings)
- [Interactive Maps](/features/maps)
- [Multi-Source](/features/multi-source)
