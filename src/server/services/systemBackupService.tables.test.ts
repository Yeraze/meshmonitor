/**
 * Regression test for the system-backup `BACKUP_TABLES` allowlist.
 *
 * Footnote 1 of the MM-SEC-1 advisory established that the realistic
 * exploitability of a leaked VAPID private key depends on the attacker
 * also obtaining each subscriber's `endpoint`/`p256dh`/`auth` from the
 * `push_subscriptions` table. That table is intentionally excluded from
 * the system-backup tarball so a stolen backup file cannot be used as a
 * second-stage exploit.
 *
 * If a future change adds `push_subscriptions` (or any of the other
 * sensitive tables) to BACKUP_TABLES, this test fails. The fix is
 * almost always "remove it from the allowlist" — backup of these
 * tables changes the threat model and needs an explicit security
 * review.
 */

import { describe, it, expect } from 'vitest';
import { BACKUP_TABLES } from './systemBackupService.js';

const FORBIDDEN_TABLES = [
  // Holds per-subscriber push endpoint URLs + p256dh/auth secrets.
  // Combined with a leaked VAPID private key, leaking these enables
  // arbitrary push notifications to the subscriber's browser.
  'push_subscriptions',
  // Active session tokens. Including them in a backup means stealing
  // a backup tarball = stealing every active session.
  'sessions',
  // Backup metadata is per-installation; including it in a backup
  // confuses the restore flow and is its own infinite-recursion problem.
  'backup_history',
];

describe('BACKUP_TABLES allowlist', () => {
  for (const table of FORBIDDEN_TABLES) {
    it(`MUST NOT include "${table}" (sensitive — see MM-SEC-1 footnote 1 / ARCHITECTURE_LESSONS.md)`, () => {
      expect(BACKUP_TABLES).not.toContain(table);
    });
  }

  it('is a non-empty allowlist of distinct table names', () => {
    expect(BACKUP_TABLES.length).toBeGreaterThan(0);
    expect(new Set(BACKUP_TABLES).size).toBe(BACKUP_TABLES.length);
  });
});
