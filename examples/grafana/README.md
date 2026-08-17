# Grafana dashboard for MeshMonitor

`meshmonitor-mesh-health.json` visualizes the Prometheus metrics exposed by
`GET /api/v1/metrics`: channel utilization (the airtime saturation headline),
TX air utilization, per-node battery/voltage/SNR, node liveness, message
volume, and source link state.

## Prerequisites

1. A Prometheus (or compatible) server scraping MeshMonitor. Example scrape
   config, using a MeshMonitor API token as the bearer credential:

   ```yaml
   scrape_configs:
     - job_name: meshmonitor
       metrics_path: /api/v1/metrics
       scrape_interval: 60s
       static_configs:
         - targets: ['meshmonitor.example.com:8080']
       authorization:
         credentials: mm_v1_YOUR_TOKEN
   ```

2. That Prometheus configured as a datasource in Grafana (10 or newer).

## Import

Dashboards → New → Import → upload `meshmonitor-mesh-health.json`, then pick
your Prometheus datasource. Or drop the file into a provisioning folder.

## Notes

- The **Source** variable lists every source the scraping token can read;
  panels aggregate or split by it.
- Per-node panels only show nodes heard in the **last 30 minutes**, so stale
  telemetry cannot masquerade as current. The scrape itself exports nodes
  heard within 24 hours (tunable with the endpoint's `?window=` parameter).
- **Estimated Battery Time Left** projects each discharging node's hours to
  0% from its last-2-hours trend (`battery / -deriv(battery[2h])`). Only
  nodes draining faster than ~1%/hour appear, so an empty panel means
  nothing is discharging. Pair it with a `predict_linear` alert to page
  before a node dies (example in the REST API docs).
- Channel-utilization marker lines sit at **20%** and **25%**. The firmware's
  polite threshold is 25% — above it nodes start suppressing position,
  telemetry, and nodeinfo broadcasts — so if that traffic matters to you,
  alert at 20% and treat 25% as "damage has started", not as the warning.
  TX air utilization marks 10% (typical regional duty-cycle limit). Adjust
  to your region and modem preset.
