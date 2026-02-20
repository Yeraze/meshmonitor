/**
 * Type definitions for express-mysql-session
 */

declare module 'express-mysql-session' {
  import { Store } from 'express-session';

  interface MySQLSessionStoreOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    clearExpired?: boolean;
    checkExpirationInterval?: number;
    expiration?: number;
    createDatabaseTable?: boolean;
    schema?: {
      tableName?: string;
      columnNames?: {
        session_id?: string;
        expires?: string;
        data?: string;
      };
    };
  }

  interface MySQLSessionStoreConstructor {
    new (options: MySQLSessionStoreOptions): Store;
  }

  function MySQLSessionStore(session: any): MySQLSessionStoreConstructor;

  export default MySQLSessionStore;
}
