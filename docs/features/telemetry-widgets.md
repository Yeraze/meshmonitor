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

## Limitations

- Gauge and Numeric modes only display the **most recent** data point. If no data has been received, the widget remains empty.
- Gauge and Numeric modes do not show historical data — switch to Chart mode to view trends.
- Range configuration is only available in Gauge mode. The inputs are not shown in Chart or Numeric mode.
