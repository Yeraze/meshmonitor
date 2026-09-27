/**
 * Asset Tracking (#5354) — `purgeOldTelemetryAsync` end to end against the real
 * DatabaseService singleton (:memory: SQLite under vitest).
 *
 * Covers the facade's part of the contract: it loads the asset flags from the
 * database on every run (so a restart changes nothing), converts retention days
 * to cutoffs, and takes the asset-aware path even when the caller passes no
 * favorite retention at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import databaseService from './database.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SOURCE_ID = 'asset-ret-source';
const ASSET = { nodeId: '!0a0b0c0d', nodeNum: 0x0a0b0c0d };
const PLAIN = { nodeId: '!0d0c0b0a', nodeNum: 0x0d0c0b0a };

async function seed(node: { nodeId: string; nodeNum: number }, ageDays: number, type = 'position'): Promise<void> {
  const ts = Date.now() - ageDays * DAY;
  await databaseService.telemetry.insertTelemetry(
    { nodeId: node.nodeId, nodeNum: node.nodeNum, telemetryType: type, timestamp: ts, value: 1, unit: '', createdAt: ts },
    SOURCE_ID,
  );
}

async function agesFor(node: { nodeNum: number }): Promise<number[]> {
  const rows = await databaseService.telemetry.getTelemetryByNode(
    `!${node.nodeNum.toString(16).padStart(8, '0')}`, 1000, undefined, undefined, 0, undefined, SOURCE_ID,
  );
  return rows.map((r) => Math.round((Date.now() - Number(r.timestamp)) / DAY)).sort((a, b) => a - b);
}

describe('#5354 purgeOldTelemetryAsync keeps tracked assets for their own window', () => {
  beforeEach(async () => {
    await databaseService.waitForReady();
    await databaseService.purgeAllTelemetryAsync();
    await databaseService.clearAssetNodeAsync(ASSET.nodeNum);
    for (const d of [1, 10, 40]) {
      await seed(ASSET, d);
      await seed(PLAIN, d);
    }
  });

  afterEach(async () => {
    await databaseService.clearAssetNodeAsync(ASSET.nodeNum);
  });

  it('keeps an asset past 7 days and purges it past its own window', async () => {
    await databaseService.setAssetNodeAsync(ASSET.nodeNum, 30, null);
    await databaseService.purgeOldTelemetryAsync(168, 7);
    expect(await agesFor(ASSET)).toEqual([1, 10]);
    expect(await agesFor(PLAIN)).toEqual([1]);
  });

  it('takes the asset-aware path when no favorite retention is passed', async () => {
    await databaseService.setAssetNodeAsync(ASSET.nodeNum, 90, null);
    await databaseService.purgeOldTelemetryAsync(168);
    expect(await agesFor(ASSET)).toEqual([1, 10, 40]);
    expect(await agesFor(PLAIN)).toEqual([1]);
  });

  it('treats a cleared flag as a plain node again', async () => {
    await databaseService.setAssetNodeAsync(ASSET.nodeNum, 90, null);
    await databaseService.clearAssetNodeAsync(ASSET.nodeNum);
    await databaseService.purgeOldTelemetryAsync(168, 7);
    expect(await agesFor(ASSET)).toEqual([1]);
  });
});
