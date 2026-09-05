/**
 * Regression tests for issue #5080 — "Telemetry Dashboard shows only ~7 days of
 * history for favorited nodes despite favoriteTelemetryStorageDays=90".
 *
 * The Dashboard is always rendered inside a `<SourceProvider>`, so every write it
 * makes to `/api/settings` carries `?sourceId=<id>` and therefore lands in the
 * per-source settings namespace (`source:<id>:telemetryFavorites`,
 * `source:<id>:favoriteTelemetryStorageDays`). The hourly retention purge, however,
 * read only the un-namespaced GLOBAL keys — so it saw zero favorites, fell through
 * to `deleteOldTelemetry(now - 168h)`, and deleted every favorited chart's history
 * older than 7 days. The chart then rendered a ~7-day X-axis no matter what
 * "Days to view" was set to, because the older rows had already been destroyed.
 *
 * These tests run against the real DatabaseService singleton (:memory: SQLite under
 * vitest) so the whole settings-read → purge path is exercised, not a mock of it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import databaseService from './database.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const NODE = '!a1b2c3d4';
const NODE_NUM = 0xa1b2c3d4;
const SOURCE_ID = 'ret-source-a';

/** Retention window the hourly purge job uses for non-favorited telemetry. */
const TELEMETRY_RETENTION_HOURS = 168; // 7 days

async function seedTelemetry(ageDays: number, type: string, value: number) {
  const ts = Date.now() - ageDays * DAY;
  await databaseService.telemetry.insertTelemetry(
    {
      nodeId: NODE,
      nodeNum: NODE_NUM,
      telemetryType: type,
      timestamp: ts,
      value,
      unit: '%',
      createdAt: ts,
    },
    SOURCE_ID
  );
}

async function remainingTimestampsFor(type: string): Promise<number[]> {
  const rows = await databaseService.getTelemetryByNodeAveragedAsync(
    NODE,
    Date.now() - 90 * DAY,
    1,
    undefined,
    SOURCE_ID
  );
  return rows.filter((r) => r.telemetryType === type).map((r) => r.timestamp).sort((a, b) => a - b);
}

describe('#5080 favorite telemetry retention reads per-source settings', () => {
  beforeEach(async () => {
    await databaseService.waitForReady();
    await databaseService.purgeAllTelemetryAsync();
    await databaseService.settings.setSetting('telemetryFavorites', '');
    await databaseService.settings.setSetting('favoriteTelemetryStorageDays', '');
    await databaseService.settings.setSetting(`source:${SOURCE_ID}:telemetryFavorites`, '');
    await databaseService.settings.setSetting(`source:${SOURCE_ID}:favoriteTelemetryStorageDays`, '');

    // 30 days of daily battery + voltage samples for one node on one source.
    for (let d = 0; d <= 30; d++) {
      await seedTelemetry(d, 'batteryLevel', 100 - d);
      await seedTelemetry(d, 'voltage', 4.0);
    }
  });

  it('keeps favorited history for the per-source favoriteTelemetryStorageDays window', async () => {
    // Exactly what the Dashboard writes when the user favorites a chart and sets
    // "Favorite telemetry storage" to 30 days: both land in the SOURCE namespace.
    await databaseService.settings.setSetting(
      `source:${SOURCE_ID}:telemetryFavorites`,
      JSON.stringify([{ nodeId: NODE, telemetryType: 'batteryLevel' }])
    );
    await databaseService.settings.setSetting(
      `source:${SOURCE_ID}:favoriteTelemetryStorageDays`,
      '30'
    );

    await databaseService.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, 7);

    const battery = await remainingTimestampsFor('batteryLevel');
    const sevenDaysAgo = Date.now() - 7 * DAY;

    // The whole point of the setting: rows older than the 7-day non-favorite
    // window must survive out to 30 days.
    expect(battery.filter((t) => t < sevenDaysAgo).length).toBeGreaterThan(20);
    expect(Math.min(...battery)).toBeLessThan(Date.now() - 29 * DAY);

    // Non-favorited series is still trimmed to the 7-day regular window.
    const voltage = await remainingTimestampsFor('voltage');
    expect(voltage.every((t) => t >= sevenDaysAgo)).toBe(true);
  });

  it('still honours a legacy global favorites list (pre-4.x installs)', async () => {
    await databaseService.settings.setSetting(
      'telemetryFavorites',
      JSON.stringify([{ nodeId: NODE, telemetryType: 'batteryLevel' }])
    );
    await databaseService.settings.setSetting('favoriteTelemetryStorageDays', '30');

    await databaseService.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, 7);

    const battery = await remainingTimestampsFor('batteryLevel');
    expect(Math.min(...battery)).toBeLessThan(Date.now() - 29 * DAY);
  });

  it('purges favorited telemetry older than the per-source window', async () => {
    await databaseService.settings.setSetting(
      `source:${SOURCE_ID}:telemetryFavorites`,
      JSON.stringify([{ nodeId: NODE, telemetryType: 'batteryLevel' }])
    );
    await databaseService.settings.setSetting(
      `source:${SOURCE_ID}:favoriteTelemetryStorageDays`,
      '14'
    );

    await databaseService.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, 7);

    const battery = await remainingTimestampsFor('batteryLevel');
    expect(battery.every((t) => t >= Date.now() - 15 * DAY)).toBe(true);
    expect(battery.some((t) => t < Date.now() - 7 * DAY)).toBe(true);
  });

  it('serves the full 720h window the Dashboard asks for once the data survives', async () => {
    // The chart's X-axis is the min/max of the rows it receives, so the exact
    // symptom in #5080 ("more points, same ~7-day span") is a data question, not
    // a rendering one. This asserts the averaged query itself is not truncating
    // to the newest N rows: it must return the far edge of a 30-day window.
    await databaseService.settings.setSetting(
      `source:${SOURCE_ID}:telemetryFavorites`,
      JSON.stringify([{ nodeId: NODE, telemetryType: 'batteryLevel' }])
    );
    await databaseService.settings.setSetting(
      `source:${SOURCE_ID}:favoriteTelemetryStorageDays`,
      '30'
    );
    await databaseService.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, 7);

    // Exactly what GET /api/telemetry/:nodeId?hours=720 issues.
    const hours = 720;
    const rows = await databaseService.getTelemetryByNodeAveragedAsync(
      NODE,
      Date.now() - hours * HOUR,
      undefined,
      hours,
      SOURCE_ID
    );
    const battery = rows.filter((r) => r.telemetryType === 'batteryLevel');
    expect(battery.length).toBeGreaterThan(0);

    const span = Math.max(...battery.map((r) => r.timestamp)) - Math.min(...battery.map((r) => r.timestamp));
    expect(span).toBeGreaterThan(28 * DAY);
  });

  it('does not let one source\'s favorite protect another source\'s telemetry', async () => {
    const OTHER = 'ret-source-b';
    const ts = Date.now() - 20 * DAY;
    await databaseService.telemetry.insertTelemetry(
      {
        nodeId: NODE,
        nodeNum: NODE_NUM,
        telemetryType: 'batteryLevel',
        timestamp: ts,
        value: 42,
        unit: '%',
        createdAt: ts,
      },
      OTHER
    );

    await databaseService.settings.setSetting(
      `source:${SOURCE_ID}:telemetryFavorites`,
      JSON.stringify([{ nodeId: NODE, telemetryType: 'batteryLevel' }])
    );
    await databaseService.settings.setSetting(
      `source:${SOURCE_ID}:favoriteTelemetryStorageDays`,
      '30'
    );

    await databaseService.purgeOldTelemetryAsync(TELEMETRY_RETENTION_HOURS, 7);

    const otherRows = await databaseService.getTelemetryByNodeAveragedAsync(
      NODE,
      Date.now() - 90 * DAY,
      1,
      undefined,
      OTHER
    );
    expect(otherRows).toHaveLength(0);
  });
});
