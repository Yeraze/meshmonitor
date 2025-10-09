/**
 * Type definitions for connect-sqlite3
 */

declare module 'connect-sqlite3' {
  import session from 'express-session';

  interface SqliteStoreOptions {
    db?: string;
    dir?: string;
    table?: string;
    concurrentDB?: boolean;
  }

  interface SqliteStore extends session.Store {
    new (options?: SqliteStoreOptions): SqliteStore;
  }

  function connectSqlite3(session: typeof import('express-session')): {
    new (options?: SqliteStoreOptions): session.Store;
  };

  export = connectSqlite3;
}
