/**
 * Migration Registry
 *
 * Declarative registry for database migrations. Prevents:
 * - Missing migrations (all must be registered)
 * - Ordering bugs (enforces sequential numbering)
 * - Duplicate registrations (throws on duplicate number)
 * - Forgotten call sites (single loop replaces per-migration calls)
 */

export interface MigrationEntry {
  number: number;
  name: string;
  /** SQLite migration function */
  sqlite?: (db: any, getSetting: (key: string) => string | null, setSetting: (key: string, value: string) => void) => void;
  /** PostgreSQL migration function */
  postgres?: (client: any) => Promise<void>;
  /** MySQL migration function */
  mysql?: (pool: any) => Promise<void>;
  /** Settings key for SQLite idempotency tracking */
  settingsKey?: string;
  /**
   * If true, the SQLite migration handles its own idempotency internally
   * (old-style migrations that check sqlite_master or use CREATE TABLE IF NOT EXISTS).
   * The registry loop calls the function without checking/setting the settingsKey.
   */
  selfIdempotent?: boolean;
}

export class MigrationRegistry {
  private migrations: MigrationEntry[] = [];
  private registered = new Set<number>();

  register(entry: MigrationEntry): void {
    if (this.registered.has(entry.number)) {
      throw new Error(`Migration ${entry.number} already registered: ${entry.name}`);
    }
    if (this.migrations.length > 0) {
      const last = this.migrations[this.migrations.length - 1];
      if (entry.number !== last.number + 1) {
        throw new Error(
          `Migration ${entry.number} registered out of order (expected ${last.number + 1})`
        );
      }
    }
    this.registered.add(entry.number);
    this.migrations.push(entry);
  }

  getAll(): ReadonlyArray<MigrationEntry> {
    return this.migrations;
  }

  getFrom(startNumber: number): ReadonlyArray<MigrationEntry> {
    return this.migrations.filter(m => m.number >= startNumber);
  }

  count(): number {
    return this.migrations.length;
  }
}
