/**
 * Generate `CREATE TABLE` DDL for PostgreSQL / MySQL straight from the Drizzle
 * schema definitions.
 *
 * The alternative — hand-writing the DDL in each `.pgmysql.test.ts` — is what
 * cost ~92 CI failures in #4250: only the SQLite suites build from the
 * migration registry, so the literal `CREATE TABLE` blocks drift silently until
 * a `select()` enumerating a missing column fails every query in the file. A
 * merge test needs sixteen tables including `nodes` (70-odd columns), so
 * hand-writing them would be that failure mode with a much bigger surface.
 *
 * This reads the same table objects the repositories query, so the fixture
 * cannot drift from the schema by construction.
 *
 * Test-only. Production DDL still lives in `src/server/migrations/`, which owns
 * ordering, backfills and idempotency — none of which belong here.
 */
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as mysqlTableConfig } from 'drizzle-orm/mysql-core';

/* eslint-disable @typescript-eslint/no-explicit-any -- Drizzle's column/table metadata is untyped at this level of reflection */

function quotePg(name: string): string {
  return `"${name}"`;
}

function columnDdl(column: any, quote: (n: string) => string, dialect: 'postgres' | 'mysql'): string {
  const parts = [quote(column.name), column.getSQLType()];
  if (column.primary) parts.push('PRIMARY KEY');
  if (column.notNull && !column.primary) parts.push('NOT NULL');
  // Defaults matter: a NOT NULL column with a schema default is routinely
  // omitted from inserts in production code.
  if (column.hasDefault && column.default !== undefined) {
    const value = column.default;
    if (typeof value === 'string') parts.push(`DEFAULT '${value.replace(/'/g, "''")}'`);
    else if (typeof value === 'boolean') {
      parts.push(`DEFAULT ${dialect === 'postgres' ? String(value).toUpperCase() : value ? '1' : '0'}`);
    } else if (typeof value === 'number') parts.push(`DEFAULT ${value}`);
  }
  return parts.join(' ');
}

/** `CREATE TABLE` for one PostgreSQL Drizzle table, plus its unique indexes. */
export function postgresCreateTable(table: any): string {
  const config = pgTableConfig(table);
  const columns = Object.values(getTableColumns(table)) as any[];
  const lines = columns.map((c) => columnDdl(c, quotePg, 'postgres'));
  for (const pk of config.primaryKeys) {
    lines.push(`PRIMARY KEY (${pk.columns.map((c: any) => quotePg(c.name)).join(', ')})`);
  }
  const statements = [`CREATE TABLE ${quotePg(config.name)} (\n  ${lines.join(',\n  ')}\n)`];
  for (const index of config.indexes) {
    if (!index.config.unique) continue;
    const cols = index.config.columns.map((c: any) => quotePg(c.name)).join(', ');
    statements.push(
      `CREATE UNIQUE INDEX ${quotePg(String(index.config.name))} ON ${quotePg(config.name)} (${cols})`,
    );
  }
  return statements.join(';\n');
}

/** `CREATE TABLE` for one MySQL Drizzle table, with unique indexes inline. */
export function mysqlCreateTable(table: any): string {
  const config = mysqlTableConfig(table);
  const columns = Object.values(getTableColumns(table)) as any[];
  const lines = columns.map((c) => columnDdl(c, (n) => `\`${n}\``, 'mysql'));
  for (const pk of config.primaryKeys) {
    lines.push(`PRIMARY KEY (${pk.columns.map((c: any) => `\`${c.name}\``).join(', ')})`);
  }
  for (const index of config.indexes) {
    if (!index.config.unique) continue;
    const cols = index.config.columns.map((c: any) => `\`${c.name}\``).join(', ');
    lines.push(`UNIQUE KEY \`${index.config.name}\` (${cols})`);
  }
  return `CREATE TABLE \`${config.name}\` (\n  ${lines.join(',\n  ')}\n)`;
}

export function postgresTableName(table: any): string {
  return pgTableConfig(table).name;
}

export function mysqlTableName(table: any): string {
  return mysqlTableConfig(table).name;
}
