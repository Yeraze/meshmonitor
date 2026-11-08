import { describe, it, expect } from 'vitest';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { likeContains, escapeLike } from './likeSearch.js';

describe('likeSearch', () => {
  it('escapes ~ % _ with the ~ escape char', () => {
    expect(escapeLike('a%b_c~d')).toBe('a~%b~_c~~d');
  });

  it('builds LIKE ... ESCAPE for sqlite/mysql and ILIKE for postgres', () => {
    const cols = [sql`a`, sql`b`];
    const lite = new SQLiteSyncDialect().sqlToQuery(likeContains(cols, '50%_', false));
    expect(lite.sql).toBe("(a LIKE ? ESCAPE '~' OR b LIKE ? ESCAPE '~')");
    expect(lite.params).toEqual(['%50~%~_%', '%50~%~_%']);
    const pg = new PgDialect().sqlToQuery(likeContains(cols, 'x', true));
    expect(pg.sql).toContain('ILIKE');
  });

  it('supports prefix mode', () => {
    const q = new SQLiteSyncDialect().sqlToQuery(likeContains([sql`a`], 'ab', false, 'prefix'));
    expect(q.params).toEqual(['ab%']);
  });
});
