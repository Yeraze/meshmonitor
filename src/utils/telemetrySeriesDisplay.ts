/**
 * Display and export helpers shared by every telemetry chart surface: the
 * per-node graphs (`TelemetryGraphs`) and the cross-source dashboard
 * (`CombinedTelemetryChart`, #5896). Lifted out of `TelemetryGraphWidget` so
 * the two surfaces convert units and write CSV the same way.
 */
import { type TemperatureUnit, formatTemperature, getTemperatureUnit, isTemperatureType } from './temperature.js';
import { telemetryDisplayScale, type TelemetryDisplay } from './telemetryFormat.js';
import { buildTelemetryFilename, telemetrySeriesToCsv, type TelemetryCsvMeta, type TelemetryCsvRow } from './telemetryChartCsv.js';
import { downloadTextFile } from './nodeExport.js';

/** How to show one telemetry series: unit, scale and C/F conversion. */
export interface SeriesDisplay extends TelemetryDisplay {
  isTemperature: boolean;
  /** A stored value (Celsius for temperature) as the displayed number. */
  toDisplay(value: number): number;
  /** A displayed number back to the stored unit. */
  toStored(value: number): number;
}

/**
 * Resolve the display of a whole series from its stored values. Temperature
 * converts to the viewer's unit; everything else uses the shared SI prefix /
 * duration scaling of `telemetryDisplayScale` (#3261), one factor for the
 * whole series so every line, the axis and the tooltip agree.
 */
export function resolveSeriesDisplay(
  type: string,
  storedValues: Array<number | null | undefined>,
  storedUnit: string,
  temperatureUnit: TemperatureUnit,
): SeriesDisplay {
  if (isTemperatureType(type)) {
    return {
      isTemperature: true,
      isUptime: false,
      factor: 1,
      unit: getTemperatureUnit(temperatureUnit),
      toDisplay: (v) => formatTemperature(v, 'C', temperatureUnit),
      toStored: (v) => formatTemperature(v, temperatureUnit, 'C'),
    };
  }
  const scale = telemetryDisplayScale(type, storedValues, storedUnit);
  return {
    ...scale,
    isTemperature: false,
    toDisplay: (v) => v * scale.factor,
    toStored: (v) => v / scale.factor,
  };
}

/** Write a plotted series to a CSV file and hand it to the browser (UTF-8 BOM for Excel). */
export function downloadTelemetryCsv(rows: TelemetryCsvRow[], meta: TelemetryCsvMeta): void {
  if (rows.length === 0) return;
  downloadTextFile(
    buildTelemetryFilename(meta.nodeId, meta.telemetryType, meta.hours),
    `\uFEFF${telemetrySeriesToCsv(rows, meta)}`,
    'text/csv;charset=utf-8',
  );
}
