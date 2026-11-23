/**
 * Drizzle schema for the `solar_irradiance` table (#6523).
 *
 * Hourly Open-Meteo sunlight (`shortwave_radiation`, W/m²) and cloud cover (%)
 * for one grid cell. A cell is a node's effective position snapped to the
 * configured grid (`solarMonitoringGridSize`, degrees); nearby nodes share one.
 *
 * GLOBAL by design — no `sourceId`. Weather at a place is the same whichever
 * source heard the node there, and sharing cells across sources is what keeps
 * the Open-Meteo call count down. Rows hold no node reference: a cell becomes
 * a node's curve only through `/api/solar/irradiance`, which resolves the node's
 * position server-side behind the per-source position visibility gate and
 * never returns the cell itself.
 *
 * `cellKey` is `"<grid>:<lat>:<lon>"` (cell centre), so a grid change starts new
 * keys and old ones age out with the retention sweep. `timestamp` and
 * `fetchedAt` are Unix seconds.
 */
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  bigint as pgBigint,
  doublePrecision as pgDoublePrecision,
  primaryKey as pgPrimaryKey,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  bigint as myBigint,
  double as myDouble,
  primaryKey as myPrimaryKey,
} from 'drizzle-orm/mysql-core';

export const solarIrradianceSqlite = sqliteTable('solar_irradiance', {
  cellKey: text('cellKey').notNull(),
  timestamp: integer('timestamp').notNull(),
  shortwaveRadiation: real('shortwaveRadiation'),
  cloudCover: real('cloudCover'),
  fetchedAt: integer('fetchedAt').notNull(),
}, (t) => [primaryKey({ columns: [t.cellKey, t.timestamp] })]);

export const solarIrradiancePostgres = pgTable('solar_irradiance', {
  cellKey: pgText('cellKey').notNull(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  shortwaveRadiation: pgDoublePrecision('shortwaveRadiation'),
  cloudCover: pgDoublePrecision('cloudCover'),
  fetchedAt: pgBigint('fetchedAt', { mode: 'number' }).notNull(),
}, (t) => [pgPrimaryKey({ columns: [t.cellKey, t.timestamp] })]);

export const solarIrradianceMysql = mysqlTable('solar_irradiance', {
  cellKey: myVarchar('cellKey', { length: 48 }).notNull(),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  shortwaveRadiation: myDouble('shortwaveRadiation'),
  cloudCover: myDouble('cloudCover'),
  fetchedAt: myBigint('fetchedAt', { mode: 'number' }).notNull(),
}, (t) => [myPrimaryKey({ columns: [t.cellKey, t.timestamp] })]);
