/**
 * Walkabout session export (#6573). Read-only: no events, no timers, no writes.
 *
 * Builds the lossless `WalkaboutExportDoc` for one session, filtered for the
 * viewer with the same gate the hex map uses (`loadWalkaboutVisibility`):
 * a reception whose credited node the viewer may not see is dropped and
 * counted. The count covers the WHOLE session (every row is read, then
 * filtered), never a narrowed span. Samples are the walker's own track,
 * which any reader of the source may see (P1 Q6).
 *
 * Bounded: at most COVERAGE_IMPORT_MAX_ROWS rows leave the server (the import
 * cap, so every export can be imported again); a cut sets `truncated`.
 */
import databaseService from '../../services/database.js';
import type { DbWalkaboutReception } from '../../db/repositories/coverageWalkabout.js';
import type { WalkaboutExportDoc, WalkaboutExportReception, WalkaboutExportSample } from '../../types/walkabout.js';
import { COVERAGE_IMPORT_MAX_ROWS } from '../../utils/coverageImport.js';
import { WALKABOUT_EXPORT_FORMAT, WALKABOUT_EXPORT_VERSION, WALKABOUT_MAX_RX_ROWS } from '../../utils/walkabout.js';
import { loadWalkaboutVisibility } from './walkaboutCells.js';

/** Test seam: lets a test lower the row budget. */
export const walkaboutExportLimits = { maxRows: COVERAGE_IMPORT_MAX_ROWS, maxReadRx: WALKABOUT_MAX_RX_ROWS };

export async function exportWalkaboutSession(
  user: unknown,
  sourceId: string,
  sessionId: string,
  nowMs: number = Date.now(),
): Promise<WalkaboutExportDoc | null> {
  const repo = databaseService.coverageWalkabout;
  const session = await repo.getSession(sourceId, sessionId);
  if (!session) return null;
  const { maxRows, maxReadRx } = walkaboutExportLimits;

  const [samplesRaw, rxRaw] = await Promise.all([
    repo.listSamples(sourceId, session.id, maxRows + 1),
    repo.listReceptions(sourceId, session.id, maxReadRx + 1),
  ]);
  const rxCut = rxRaw.length > maxReadRx;
  const rxAll = rxCut ? rxRaw.slice(0, maxReadRx) : rxRaw;

  let shown: DbWalkaboutReception[] = rxAll;
  let names: (r: DbWalkaboutReception) => { longName: string | null; shortName: string | null } = () => ({
    longName: null,
    shortName: null,
  });
  if (rxAll.length > 0) {
    const imported = new Set(session.importId != null ? [session.id] : []);
    const vis = await loadWalkaboutVisibility(user, sourceId, imported);
    shown = rxAll.filter((r) => vis.visible(r));
    names = vis.names;
  }
  const hiddenReceptionCount = rxAll.length - shown.length;

  const samples = samplesRaw.slice(0, maxRows);
  const rxBudget = Math.max(0, maxRows - samples.length);
  const receptions = shown.slice(0, rxBudget);
  const truncated = samplesRaw.length > samples.length || shown.length > receptions.length || rxCut;
  const keptIds = new Set(samples.map((s) => s.id));

  return {
    meshmonitor: {
      format: WALKABOUT_EXPORT_FORMAT,
      version: WALKABOUT_EXPORT_VERSION,
      exportedAt: nowMs,
      hiddenReceptionCount,
      truncated,
    },
    sessions: [
      {
        name: session.name,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        endReason: session.endReason,
        samples: samples.map(
          (s): WalkaboutExportSample => ({
            id: s.id,
            latitude: s.latitude,
            longitude: s.longitude,
            accuracyM: s.accuracyM,
            deviceFixAt: s.deviceFixAt,
            fixAt: s.fixAt,
            receivedAt: s.receivedAt,
          }),
        ),
        receptions: receptions.map((r): WalkaboutExportReception => {
          const n = names(r);
          return {
            protocol: r.protocol,
            creditedKey: r.creditedKey,
            creditedNodeNum: r.creditedNodeNum,
            creditKind: r.creditKind,
            hopsAway: r.hopsAway,
            packetKey: r.packetKey,
            snr: r.snr,
            rssi: r.rssi,
            heardAt: r.heardAt,
            sampleId: r.sampleId != null && keptIds.has(r.sampleId) ? r.sampleId : null,
            latitude: r.latitude,
            longitude: r.longitude,
            accuracyM: r.accuracyM,
            sampleAgeMs: r.sampleAgeMs,
            longName: n.longName,
            shortName: n.shortName,
          };
        }),
      },
    ],
  };
}
