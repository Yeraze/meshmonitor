/**
 * Test support for the backup → restore round trips: fill ANY table with rows
 * built from its live column list, on any backend.
 *
 * The round-trip suites seed every table in BACKUP_TABLES this way, so a table
 * added to the backup is exercised through export and restore with no test to
 * write. Values are derived from the column type and a row number, which keeps
 * rows distinct under unique indexes; foreign-key columns copy the parent row's
 * value. Columns whose meaning the type cannot express (a CHECK constraint, a
 * JSON document) get an explicit value in OVERRIDES.
 */

export type Dialect = 'sqlite' | 'postgres' | 'mysql';
export type SeedRow = Record<string, unknown>;

export interface SeedColumn {
  name: string;
  /** The backend's own type name, lower-cased (`integer`, `tinyint(1)`, `character varying`...). */
  type: string;
}

export interface SeedForeignKey {
  column: string;
  parentTable: string;
  parentColumn: string;
}

/** The handful of queries the seeder needs, per backend. */
export interface SeedAdapter {
  dialect: Dialect;
  columns(table: string): Promise<SeedColumn[]>;
  foreignKeys(table: string): Promise<SeedForeignKey[]>;
  insert(table: string, row: SeedRow): Promise<void>;
}

type Override = unknown | ((n: number) => unknown);

/**
 * Column values the type alone gets wrong. Keys are column names as each
 * backend spells them; a name that does not exist on a backend is ignored.
 */
const OVERRIDES: Record<string, Record<string, Override>> = {
  permissions: {
    // SQLite: CHECK (resource IN (...)) and CHECK (can_x IN (0, 1)).
    resource: (n: number) => ['nodes', 'messages', 'settings', 'configuration', 'info', 'dashboard'][n % 6],
    can_view_on_map: 1,
    can_read: 1,
    can_write: 0,
  },
  sources: {
    type: 'meshcore',
    config: '{}',
  },
};

function valueFor(dialect: Dialect, type: string, n: number): unknown {
  if (/bool/.test(type) || type === 'tinyint(1)') {
    return dialect === 'postgres' ? n % 2 === 0 : n % 2;
  }
  if (/int|serial/.test(type)) return 1000 + n;
  if (/real|double|float|numeric|decimal/.test(type)) return 1000.5 + n;
  // Short enough for the narrowest VARCHAR in the schema.
  return `t${n}`;
}

/** Build row `n` of `table`. `parents` holds the rows already seeded, by table. */
export async function buildSeedRow(
  adapter: SeedAdapter,
  table: string,
  n: number,
  parents: ReadonlyMap<string, SeedRow[]>,
  overrides: SeedRow = {},
): Promise<SeedRow> {
  const columns = await adapter.columns(table);
  const fks = await adapter.foreignKeys(table);
  const tableOverrides = OVERRIDES[table] ?? {};
  const row: SeedRow = {};

  for (const column of columns) {
    const fk = fks.find((f) => f.column === column.name);
    const parentRows = fk ? parents.get(fk.parentTable) : undefined;
    if (column.name in overrides) {
      row[column.name] = overrides[column.name];
    } else if (fk && parentRows && parentRows.length > 0) {
      row[column.name] = parentRows[n % parentRows.length][fk.parentColumn];
    } else if (column.name in tableOverrides) {
      const override = tableOverrides[column.name];
      row[column.name] = typeof override === 'function' ? (override as (n: number) => unknown)(n) : override;
    } else {
      row[column.name] = valueFor(adapter.dialect, column.type, n);
    }
  }
  return row;
}

/**
 * Insert `count` generated rows into each table, in the order given (parents
 * first). Returns what was inserted, by table.
 */
export async function seedTables(
  adapter: SeedAdapter,
  tables: readonly string[],
  count: number,
  firstN = 1,
): Promise<Map<string, SeedRow[]>> {
  const seeded = new Map<string, SeedRow[]>();
  for (const table of tables) {
    const rows: SeedRow[] = [];
    for (let i = 0; i < count; i++) {
      const row = await buildSeedRow(adapter, table, firstN + i, seeded);
      try {
        await adapter.insert(table, row);
      } catch (error) {
        throw new Error(`seeding ${table} row ${firstN + i} failed: ${(error as Error).message}`, { cause: error });
      }
      rows.push(row);
    }
    seeded.set(table, rows);
  }
  return seeded;
}
