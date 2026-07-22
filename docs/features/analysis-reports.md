# Analysis & Reports

The **Analysis & Reports** workspace is a global, cross-source analytics page that runs analytical reports against the telemetry, position, and routing data MeshMonitor has collected from every source you can read. It lives at `/reports` and is linked from the bottom of the dashboard sidebar (right under *Map Analysis*).

Two reports are currently bundled with the workspace: **Solar Monitoring Analysis** and **NodeInfo Enrichment** — see below. The card-grid landing page is designed to host additional reports over time without changing the routing or navigation surface.

## Solar Monitoring Analysis

Identifies solar-powered nodes by analyzing battery and voltage telemetry over a configurable lookback window and looking for the characteristic morning-low → afternoon-peak charging curve, followed by overnight discharge. Ports the proven detection algorithm from MeshManager.

### What gets analyzed

For every node in your permitted sources, the report scans the following telemetry types over the lookback window:

- `batteryLevel` (preferred when ≥ 3 readings/day are present)
- `voltage`
- `ch1Voltage`, `ch2Voltage`, `ch3Voltage` (INA voltage channels)

A daily pattern is recorded when the metric shows:

- A morning low (06:00–10:00 UTC) and an afternoon peak (12:00–18:00 UTC)
- Sufficient daily variance (≥ 10% for battery, ≥ 0.3 V for voltage) **or** a "high-efficiency" candidate that stays above 90% / 4.1 V with smaller swings
- A peak hour between 10:00 and 18:00 UTC and a sunrise hour ≤ 12:00 UTC

A node becomes a **solar candidate** when at least 50% of its analyzed days show a pattern (33% for high-efficiency candidates that consistently stay above 98%).

### Running the report

1. Open the dashboard, click **Analysis & Reports** in the sidebar.
2. Click the **Solar Monitoring Analysis** card.
3. Set the **Lookback (days)** between `1` and `90` (default `7`) and click **Run analysis**.
4. *(Optional)* Click **Run forecast** to project battery state across the next several days using the forecast.solar production estimates.

The summary row shows the lookback window, total nodes analyzed, solar nodes detected, average charging hours per day, and average overnight discharge hours per day.

### Per-node card

Each detected node renders an expandable card with:

- **Solar score** (% of analyzed days that showed a clear pattern)
- **Average charge / discharge rates** (per hour)
- **Detected metrics** (`battery`, `voltage`, INA channel names)
- **Insufficient solar warning** when projected daily charging cannot keep up with overnight discharge
- A **Recharts** time-series chart showing:
    - Battery / voltage line
    - Solar production area overlay (Wh, right axis) when forecast.solar data is available
    - Reference levels: green at 100% / 4.2 V (full), yellow at 50% / 3.7 V (nominal), red at 20% / 3.3 V (low)
    - **Forecast simulation** as a mauve dashed extension when *Run forecast* has been triggered
- A **Recent daily patterns** table (date, sunrise / peak / sunset times and values, rise, fall, charge rate /h, discharge rate /h)

### Forecast simulation

The forecast endpoint compares projected daily Wh totals from forecast.solar to the lookback's historical average. Each day is flagged **Low** if it falls below 75% of the historical average. For every solar candidate, the report simulates the next ~5 days of battery state by running the node's measured charge and discharge rates against the forecast factor for each day:

- **Sunrise** point: battery after the overnight discharge
- **Peak** point: battery after the daylight charge (modulated by `forecast_factor = forecast_wh / avg_historical_wh`, clamped 0–1.5)
- **Sunset** point: battery after a small afternoon drain

Nodes whose simulated minimum drops below `50%` (battery) or `3.5 V` (voltage) are listed as **Nodes predicted at risk** so operators can intervene before they go offline.

Solar production must already be configured under **Settings → Solar Monitoring** for the forecast to produce useful output. See the [Solar Monitoring guide](./solar-monitoring) for set-up details.

## NodeInfo Enrichment

Scans every node visible on more than one source for blank NodeInfo fields — Long Name, Short Name, Hardware Model, Role, MAC Address, Public Key, Firmware — that another source's record for the same physical node can fill, and lets you copy the missing data across sources. It generalizes the per-node "Copy NodeInfo" dialog (available from the node detail panel) into a batch view spanning every source you can read.

### What gets analyzed

For every node seen on two or more of your permitted sources, the report checks the fields above for blanks. Each row in the report table is one **(node, target source)** pair — a specific source's record for a specific node that is missing at least one field — and lists:

- The **fillable fields** for that row (only the ones actually blank on the target and present on the donor)
- The **donor source**: whichever other source holds the most complete record for that node. Completeness is ranked by number of non-blank fields, with the most recently updated record winning ties.

### Running the report

1. Open the dashboard, click **Analysis & Reports** in the sidebar.
2. Click the **NodeInfo Enrichment** card.
3. Review the summary tiles — **Nodes**, **Targets**, **Fillable fields** — above the table.
4. Click **Fix** on a row to apply just that (node, target source) pair, or **Fix All** to apply every row currently listed.
5. Click **Refresh** to re-run the analysis, e.g. after applying fixes or after new NodeInfo has arrived over the mesh.

### Applying fixes

Applying a row is **fill-blanks-only**: it writes only the fields that are currently empty on the target source's record and never overwrites a field that already has a value — even if the analysis backing the row has gone stale since the page loaded. This makes Fix and Fix All safe to click at any time.

An **Also push to device NodeDB** toggle (default off) sits above the table. When enabled, each node that gets enriched also receives the same NodeInfo-exchange nudge as the manual Copy NodeInfo dialog's push option (`sendNodeInfoRequest` on the node's channel). This generates mesh traffic, so leave it off if you only want to update MeshMonitor's own database.

Because a row reflects only its single best donor, fixing it can uncover further blanks: if that donor didn't have every missing field, the row disappears but the node may resurface with a different (partial) donor on the next analysis. Click **Refresh** (or re-run the report) until the table drains to fully converge a node across all sources.

> **On-demand only.** This report has no background scheduler — it runs interactively whenever you open the card or click Refresh/Fix.

## Permissions

### Solar Monitoring

Both solar endpoints are scoped to the requesting user's permitted source IDs:

- Admins see all enabled sources
- Non-admin users see sources where they hold `nodes:read`
- An optional `?sources=id1,id2` query param restricts the analysis further (intersected with permitted IDs)

### NodeInfo Enrichment

- **Analysis** (`GET /api/nodes/enrichment/analysis`) only ever computes over sources the caller holds `nodes:read` on — admins see every source, anonymous/unauthenticated callers see none (an empty, but never a `403`, response).
- **Applying** (`POST /api/nodes/enrichment/apply`) requires `nodes:read` on the donor source and `nodes:write` on every target source referenced by the request. A single missing grant rejects the whole batch with `403 FORBIDDEN` — partial application of an under-permissioned batch never happens.

The page itself is publicly routable for both reports; only the underlying data is gated.

## API

### Solar Monitoring

Two endpoints under the existing `/api/analysis/*` namespace:

- `GET /api/analysis/solar-nodes?lookback_days=N&sources=…`
- `GET /api/analysis/solar-forecast?lookback_days=N&sources=…`

See the [REST API reference](https://github.com/Yeraze/meshmonitor/blob/main/docs/api/REST_API.md) for the full request/response shapes.

### NodeInfo Enrichment

Two endpoints under `/api/nodes/enrichment/*` (also mirrored at `/api/v1/nodes/enrichment/*`), using the standard `{ success, data }` response envelope:

- `GET /api/nodes/enrichment/analysis` — returns `{ nodes: [...], summary: { nodeCount, targetCount, fieldCount } }`.
- `POST /api/nodes/enrichment/apply` — body `{ items: [{ nodeNum, targetSourceId, donorSourceId }], pushToNodeDb? }`, returns `{ applied: [...], totalFieldsCopied }`.

Error codes: `INVALID_REQUEST` / `INVALID_ITEM` (400, malformed request body), `FORBIDDEN` (403, missing `nodes:read`/`nodes:write` — includes a `missing` list), `ENRICHMENT_ANALYSIS_FAILED` / `ENRICHMENT_APPLY_FAILED` (500).

## Related

- [Solar Monitoring](./solar-monitoring) — configuration of the forecast.solar integration that powers the production curve and forecast factor
- [Map Analysis](./map-analysis) — cross-source map / coverage workspace at `/analysis`
- [Analytics](./analytics) — analytics dashboards in the per-source view
