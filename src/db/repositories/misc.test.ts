/**
 * End-state assertion: misc.ts teardown complete (Task 3.1 PR3).
 *
 * Asserts that MiscRepository no longer exists as an export from the barrel
 * and that src/db/repositories/misc.ts has been deleted.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as barrel from './index.js';

describe('misc.ts teardown — end-state assertions (Task 3.1 PR3)', () => {
  it('misc.ts no longer exists in src/db/repositories/', () => {
    const miscPath = path.resolve(
      import.meta.dirname ?? __dirname,
      'misc.ts'
    );
    expect(fs.existsSync(miscPath)).toBe(false);
  });

  it('MiscRepository is not exported from the barrel (index.ts)', () => {
    expect((barrel as any).MiscRepository).toBeUndefined();
  });

  it('PacketLogRepository is exported from the barrel', () => {
    expect(typeof (barrel as any).PacketLogRepository).toBe('function');
  });

  it('KeyRepairRepository is exported from the barrel', () => {
    expect(typeof (barrel as any).KeyRepairRepository).toBe('function');
  });
});
