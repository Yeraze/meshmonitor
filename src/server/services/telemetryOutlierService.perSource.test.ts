/**
 * Source isolation for the telemetry outlier purge (#5333): a preview or
 * purge on source A must never see or touch source B, even for the same
 * nodeId, nodeNum and telemetryType.
 *
 * Runs against the live DatabaseService singleton (:memory: SQLite under
 * vitest), so the real repository SQL does the scoping.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import databaseService from '../../services/database.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';
import { previewTelemetryOutliers, purgeTelemetryOutliers } from './telemetryOutlierService.js';
import { OUTLIER_K_DEFAULT, type OutlierCriteria } from '../../utils/telemetryOutliers.js';

const NODE = { nodeId: '!12345678', nodeNum: 0x12345678 };
const TYPE = 'voltage';
const SRC_A = 'outlier-src-a';
const SRC_B = 'outlier-src-b';
const AUTO: OutlierCriteria = { auto: true, k: OUTLIER_K_DEFAULT, min: null, max: null };
const NORMAL = Array.from({ length: 20 }, (_, i) => 3.7 + (i % 3) * 0.05);

async function seed(sourceId: string, values: number[]) {
  for (let i = 0; i < values.length; i++) {
    const ts = 1_760_000_000_000 + i * 1000;
    await databaseService.telemetry.insertTelemetry(
      { ...NODE, telemetryType: TYPE, timestamp: ts, value: values[i], createdAt: ts },
      sourceId,
    );
  }
}

async function count(sourceId: string) {
  const rows = await databaseService.telemetry.getTelemetrySeriesForOutlierScan(
    sourceId, TYPE, NODE.nodeId, Number.MAX_SAFE_INTEGER,
  );
  return rows.length;
}

describe('telemetry outlier purge — per-source isolation', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
  });

  afterEach(async () => {
    await databaseService.telemetry.deleteTelemetryByNode(NODE.nodeNum, ALL_SOURCES);
  });

  it('preview on A ignores B\'s rows entirely', async () => {
    await seed(SRC_A, NORMAL);
    await seed(SRC_B, [...NORMAL, 0, 99]);
    const preview = await previewTelemetryOutliers({ sourceId: SRC_A, telemetryType: TYPE, nodeId: NODE.nodeId }, AUTO);
    expect(preview.rowsScanned).toBe(20);
    expect(preview.affectedCount).toBe(0);
  });

  it('a node-scoped purge on A leaves B untouched', async () => {
    await seed(SRC_A, [...NORMAL, 99]);
    await seed(SRC_B, [...NORMAL, 99]);
    const scope = { sourceId: SRC_A, telemetryType: TYPE, nodeId: NODE.nodeId };
    const preview = await previewTelemetryOutliers(scope, AUTO);
    const result = await purgeTelemetryOutliers(scope, AUTO, preview.cutoffId as number, preview.fingerprint);
    expect(result.deletedCount).toBe(1);
    expect(await count(SRC_A)).toBe(20);
    expect(await count(SRC_B)).toBe(21);
  });

  it('a source-wide sweep on A leaves B untouched, even with bounds that match B', async () => {
    await seed(SRC_A, [...NORMAL, 99]);
    await seed(SRC_B, [...NORMAL, 99]);
    const bounds: OutlierCriteria = { auto: false, k: OUTLIER_K_DEFAULT, min: null, max: 4 };
    const scope = { sourceId: SRC_A, telemetryType: TYPE };
    const preview = await previewTelemetryOutliers(scope, bounds);
    expect(preview.affectedCount).toBe(1);
    await purgeTelemetryOutliers(scope, bounds, preview.cutoffId as number, preview.fingerprint);
    expect(await count(SRC_A)).toBe(20);
    expect(await count(SRC_B)).toBe(21);
  });
});
