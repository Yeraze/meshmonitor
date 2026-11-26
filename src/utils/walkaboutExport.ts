/**
 * Walkabout session export builders (#6573). Client-side, over the
 * `WalkaboutExportDoc` the server already filtered for the viewer (hidden
 * credited nodes dropped, counted in `meshmonitor.hiddenReceptionCount`).
 *
 * - JSON: the doc itself. Lossless, and the only walkabout import format.
 * - CSV / GeoJSON: one row / Point per sample with what was heard there, plus
 *   a track LineString per session in GeoJSON. Export-only, for other tools.
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596).
 */
import type { WalkaboutExportDoc, WalkaboutExportReception, WalkaboutExportSession } from '../types/walkabout.js';
import { escapeCsv } from './nodeExport.js';
import { guardFormulaInjection } from './coverageExport.js';

export const WALKABOUT_SAMPLE_COLUMNS = [
  'sessionName',
  'sessionStartedAt',
  'fixAt',
  'fixAtMs',
  'latitude',
  'longitude',
  'accuracyM',
  'receptionCount',
  'nodeCount',
  'bestSnr',
  'bestRssi',
  'heardNodes',
] as const;

type SampleRow = Record<(typeof WALKABOUT_SAMPLE_COLUMNS)[number], string | number | null>;

const iso = (ms: number): string => new Date(ms).toISOString();

function nodeLabel(r: WalkaboutExportReception): string {
  return r.longName || r.shortName || r.creditedKey;
}

/** One row per sample: receptions credited to it are summarised on the row. */
function sampleRows(s: WalkaboutExportSession): SampleRow[] {
  const bySample = new Map<number, WalkaboutExportReception[]>();
  for (const r of s.receptions) {
    if (r.sampleId == null) continue;
    const list = bySample.get(r.sampleId);
    if (list) list.push(r);
    else bySample.set(r.sampleId, [r]);
  }
  return [...s.samples]
    .sort((a, b) => a.fixAt - b.fixAt || a.id - b.id)
    .map((smp) => {
      const rx = bySample.get(smp.id) ?? [];
      let bestSnr: number | null = null;
      let bestRssi: number | null = null;
      const labels = new Map<string, string>();
      for (const r of rx) {
        if (r.snr != null && (bestSnr == null || r.snr > bestSnr)) bestSnr = r.snr;
        if (r.rssi != null && (bestRssi == null || r.rssi > bestRssi)) bestRssi = r.rssi;
        labels.set(r.creditedKey, nodeLabel(r));
      }
      return {
        sessionName: s.name,
        sessionStartedAt: iso(s.startedAt),
        fixAt: iso(smp.fixAt),
        fixAtMs: smp.fixAt,
        latitude: smp.latitude,
        longitude: smp.longitude,
        accuracyM: smp.accuracyM,
        receptionCount: rx.length,
        nodeCount: labels.size,
        bestSnr,
        bestRssi,
        heardNodes: [...labels.values()].join('; '),
      };
    });
}

export function buildWalkaboutJson(doc: WalkaboutExportDoc): string {
  return JSON.stringify(doc, null, 2);
}

export function buildWalkaboutCsv(doc: WalkaboutExportDoc): string {
  const lines = [WALKABOUT_SAMPLE_COLUMNS.join(',')];
  for (const s of doc.sessions) {
    for (const row of sampleRows(s)) {
      lines.push(
        WALKABOUT_SAMPLE_COLUMNS.map((c) => {
          const v = row[c];
          if (v == null) return '';
          return typeof v === 'number' ? String(v) : escapeCsv(guardFormulaInjection(v));
        }).join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}

export function buildWalkaboutGeoJson(doc: WalkaboutExportDoc): string {
  const features: unknown[] = [];
  for (const s of doc.sessions) {
    const rows = sampleRows(s);
    for (const row of rows) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] },
        properties: { kind: 'sample', ...row },
      });
    }
    if (rows.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: rows.map((r) => [r.longitude, r.latitude]) },
        properties: { kind: 'track', sessionName: s.name, sessionStartedAt: iso(s.startedAt) },
      });
    }
  }
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      meshmonitor: {
        format: 'meshmonitor-walkabout-samples',
        version: 1,
        exportedAt: doc.meshmonitor.exportedAt,
        hiddenReceptionCount: doc.meshmonitor.hiddenReceptionCount,
        truncated: doc.meshmonitor.truncated,
      },
      features,
    },
    null,
    2,
  );
}

/** `walkabout_<startedAt>.<ext>`, filesystem-safe. */
export function walkaboutExportFilename(ext: 'json' | 'csv' | 'geojson', startedAt: number): string {
  const ts = iso(startedAt).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `walkabout_${ts}.${ext}`;
}
