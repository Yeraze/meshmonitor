/**
 * Regression test for issue #2713.
 *
 * The SQLite baseline (migration 001) creates `user_map_preferences` with
 * `user_id` (snake_case), matching every other SQLite table's FK convention.
 * Drizzle's SQLite schema for this table must therefore map the JS `userId`
 * property to the physical column `user_id` — otherwise every page load that
 * fetches map preferences logs:
 *   SqliteError: no such column: userId
 *
 * (The repo's getMapPreferences catches and swallows the error, so we can't
 * observe it by call result. Pin the schema mapping instead.)
 */
import { describe, it, expect } from 'vitest';
import * as schema from '../schema/index.js';

describe('userMapPreferencesSqlite — SQL column alignment (#2713)', () => {
  it('maps JS `userId` → SQL column `user_id` to match v3.7 baseline DDL', () => {
    const col = (schema.userMapPreferencesSqlite as unknown as {
      userId: { name: string };
    }).userId;
    expect(col.name).toBe('user_id');
  });
});
