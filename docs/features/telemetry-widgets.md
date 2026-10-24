# Telemetry Widget Display Modes

MeshMonitor's telemetry widgets support three display modes for viewing node sensor data: **Chart**, **Gauge**, and **Numeric**. You can switch between modes on a per-widget basis, and your preference is saved automatically per node and metric type.

## Overview

Telemetry widgets appear in the Node Details view and display time-series data reported by Meshtastic nodes — including battery level, temperature, humidity, voltage, pressure, and others. Each widget has its own mode toggle, so you can show battery as a gauge while keeping temperature as a chart, for example.

## Switching Display Modes

Each widget header contains a three-button mode toggle group:

| Button | Label | Mode |
|--------|-------|------|
| `~` | Chart | Line/area chart of historical values |
| `⊙` | Gauge | Radial gauge showing the latest value |
| `#` | Numeric | Large numeric readout of the latest value |

Click any button to switch that widget to the corresponding mode. Your selection is saved to browser local storage and restored on your next visit.

## Chart Mode

The default mode. Displays a time-series line chart of all recorded values for the metric. Use this mode when you want to see trends and history over time.

- X-axis shows time; Y-axis shows the metric value
- Hover over the chart to see exact values at a point in time
- If [Solar Monitoring](solar-monitoring.md) is enabled and the metric is power-related, a translucent solar production overlay may appear
- **Export CSV** downloads the plotted series — in display units, with solar or Paxcounter columns included when present. Available on both node telemetry charts and Dashboard favorite charts.

## Gauge Mode

Displays the most recent value on a radial arc gauge. Use this mode when you want a at-a-glance status view, similar to a dashboard instrument.

### Reading the Gauge

- The colored arc fills from the left (minimum) to the right (maximum) proportional to the current value
- The current value is shown in large text at the center
- The unit label appears just below the value
- The timestamp of the last reading is shown at the bottom of the gauge
- Min and max labels appear at the ends of the arc

### Configuring the Range

Below the gauge, two editable number inputs let you set the minimum and maximum scale for that gauge:

```
[  min  ] ─── [  max  ]
```

Type a new value in either field and press Tab or click away to apply it. The range is saved to browser local storage per node and per metric type.

**Default ranges by metric type:**

| Metric | Default Min | Default Max |
|--------|-------------|-------------|
| Battery Level | 0 | 100 |
| Temperature | -20 | 50 |
| Humidity | 0 | 100 |
| Voltage | 0 | 5 |
| Pressure | 950 | 1050 |
| All others | 0 | 100 |

If the current value falls outside the configured range, the gauge arc will be fully empty (below min) or fully filled (above max) — the value is clamped visually but always displayed accurately in the center text.

## Numeric Mode

Displays only the latest value as a large number. Use this mode when you want maximum readability with minimal screen space, or when you are monitoring a single metric closely.

- The value is displayed in the widget's accent color
- Integer values are shown without decimal places; non-integer values are shown with two decimal places
- The unit label appears to the right of the value
- The timestamp of the last reading is shown below in a smaller font

## Persistence

All mode and range preferences are stored in your browser's local storage. They are:

- **Per node**: changing the gauge range for Battery Level on node A does not affect node B
- **Per metric type**: each metric (temperature, humidity, etc.) stores its mode and range independently
- **Per browser**: preferences are not synced across devices or users

To reset a widget's mode, click the `~` (Chart) button. To reset a gauge range, type in the desired values in the min/max inputs.

## Clean Telemetry Outliers

A faulty sensor can log a spike that flattens the rest of a chart. **Clean outliers** removes those readings and keeps the rest of the history. Only admins see it.

**Where to find it:**
- In a telemetry chart's menu, choose **Clean outliers…** to check one node and one metric.
- In **Settings → Danger Zone**, click **Clean outliers…** to check every node on one source for one metric.

**Criteria** (use either or both):
- **Auto-detect outliers**: removes a reading that sits more than *k* median absolute deviations (MAD) from the median of that node's series. A higher *k* removes less. *k* runs from 2 to 20 and defaults to 6. MeshMonitor skips a series with fewer than 10 readings, or one where most readings share a single value.
- **Remove values below / above**: optional bounds. They use stored values, so temperature is in °C.

**Steps:**
1. Set the criteria and click **Preview**. The preview lists the readings that would go, with the reason for each, and shows the series median.
2. Click **Delete N readings…** and confirm. Deletion is permanent.

If telemetry changed after the preview, MeshMonitor asks you to run the preview again. Each purge is written to the audit log.

## Unified Telemetry Dashboard

**Unified Telemetry** (in the dashboard sidebar) shows telemetry across every source you can read. It has two views: **Graphs** and **Latest**.

![Unified Telemetry](/images/features/unified-telemetry.png)

### Graphs

- The page draws a chart for each favorited reading. It takes the union of each source's favorites, and counts a favorite only on a source where you can see its node.
- Each chart covers one node and one telemetry type.
- Some types depend on who heard the packet: SNR, RSSI, channel utilization, air TX, LocalStats packet counters, MeshMonitor's per-source series and clock offset. These keep one line per source, each labelled **heard by <source>**.
- Every other type is a reading the node takes itself, such as battery, voltage or temperature. When more than one source holds it, the chart draws **one merged line**, so a reading one source missed fills the other's gap:
  - A reading that two sources both received plots once, not twice. Two sources' points in the same time bucket, or less than a minute apart for unaveraged types, count as one reading.
  - If those sources' values differ, the point shows their average. The tooltip names the sources behind each point.
  - **Split by source** on the chart brings back one line per source, so you can see where each one has gaps. The page does not remember this choice.
- Charts sit in the same category sections as a source's own Telemetry Dashboard.
- The **Time range** presets run from 15 minutes to 7 days, and the page remembers your pick. A source filter narrows the lines, and **Refresh** reloads. The page loads on open, on a range change and on refresh. It does not poll.
- **Export CSV** on each chart saves what the chart shows, with a `Source` column. A merged line lists every source behind a reading, separated by `; `.
- With no favorites yet, the page says so. Star a reading on the **Latest** view, or a graph on a source's Telemetry Dashboard.

### Latest

**Latest** shows the newest reading of each node for each source, as cards you can search, filter by source and type, and sort. The star on a reading adds it to, or removes it from, **that source's** favorites. The star shows only where you hold `settings:write` on that source. The view refreshes every 60 seconds.

Visibility follows the per-source rules for node telemetry: the source needs `nodes:read`, a Meshtastic node needs its channel's map visibility, and the position readings of a private node need the private-position permission.

## Limitations

- Gauge and Numeric modes only display the **most recent** data point. If no data has been received, the widget remains empty.
- Gauge and Numeric modes do not show historical data — switch to Chart mode to view trends.
- Range configuration is only available in Gauge mode. The inputs are not shown in Chart or Numeric mode.
