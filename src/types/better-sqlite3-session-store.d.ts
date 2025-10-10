/**
 * Type definitions for better-sqlite3-session-store
 */

declare module 'better-sqlite3-session-store' {
  import { Store } from 'express-session';
  import Database from 'better-sqlite3';

  interface BetterSqlite3SessionStoreOptions {
    client: Database.Database;
    expired?: {
      clear?: boolean;
      intervalMs?: number;
    };
  }

  interface BetterSqlite3SessionStoreConstructor {
    new (options: BetterSqlite3SessionStoreOptions): Store;
  }

  function BetterSqlite3SessionStore(
    session: any
  ): BetterSqlite3SessionStoreConstructor;

  export default BetterSqlite3SessionStore;
}
