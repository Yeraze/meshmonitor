/**
 * ADMIN_PASSWORD seeds the first admin's password (#5874).
 *
 * Runs against the real singleton (:memory: SQLite under Vitest). Each case
 * demotes every admin so `createAdminIfNeeded` sees "no admin" and seeds a
 * fresh one under a unique ADMIN_USERNAME.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcrypt';
import databaseService from './database.js';
import { resetEnvironmentConfig } from '../server/config/environment.js';
import { waitForBackgroundTasks } from '../utils/backgroundTasks.js';
import { logger } from '../utils/logger.js';
import { systemRestoreService } from '../server/services/systemRestoreService.js';

const KEYS = ['ADMIN_PASSWORD', 'ADMIN_USERNAME'] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let n = 0;

async function demoteAllAdmins(): Promise<void> {
  const users = await databaseService.auth.getAllUsers();
  for (const u of users) {
    if (u.isAdmin) await databaseService.auth.updateUser(u.id, { isAdmin: false });
  }
}

async function seedWith(password: string | undefined): Promise<string> {
  const username = `fb-admin-${++n}`;
  process.env.ADMIN_USERNAME = username;
  if (password === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = password;
  resetEnvironmentConfig();
  await demoteAllAdmins();
  await (databaseService as any).createAdminIfNeeded();
  return username;
}

async function hashFor(username: string): Promise<string> {
  const user = await databaseService.auth.getUserByUsername(username);
  expect(user?.isAdmin).toBe(true);
  return user!.passwordHash!;
}

describe('first admin password from ADMIN_PASSWORD (#5874)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    await waitForBackgroundTasks();
    // Admin seeding waits for server.ts to mark the restore check done.
    // Release it, then let the boot-time seed finish before the cases run.
    systemRestoreService.markRestoreComplete();
    for (let i = 0; i < 100; i++) {
      const users = await databaseService.auth.getAllUsers();
      if (users.some((u) => u.isAdmin)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    resetEnvironmentConfig();
    vi.restoreAllMocks();
  });

  it('seeds the admin with ADMIN_PASSWORD and never logs it', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const info = vi.spyOn(logger, 'info');
    const debug = vi.spyOn(logger, 'debug');
    const username = await seedWith('headless-secret-1');
    const hash = await hashFor(username);
    expect(await bcrypt.compare('headless-secret-1', hash)).toBe(true);
    expect(await bcrypt.compare('changeme', hash)).toBe(false);

    const logged = [...warn.mock.calls, ...info.mock.calls, ...debug.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    expect(logged).not.toContain('headless-secret-1');
    expect(logged).toContain('ADMIN_PASSWORD');
  });

  it('falls back to changeme when ADMIN_PASSWORD is unset', async () => {
    const hash = await hashFor(await seedWith(undefined));
    expect(await bcrypt.compare('changeme', hash)).toBe(true);
  });

  it('falls back to changeme when ADMIN_PASSWORD is empty', async () => {
    const hash = await hashFor(await seedWith(''));
    expect(await bcrypt.compare('changeme', hash)).toBe(true);
  });

  it('falls back to changeme when ADMIN_PASSWORD is too short', async () => {
    const hash = await hashFor(await seedWith('short'));
    expect(await bcrypt.compare('changeme', hash)).toBe(true);
  });

  it('leaves an existing admin untouched', async () => {
    const username = await seedWith('first-boot-pass');
    const before = await hashFor(username);

    process.env.ADMIN_PASSWORD = 'second-boot-pass';
    resetEnvironmentConfig();
    await (databaseService as any).createAdminIfNeeded();

    expect(await hashFor(username)).toBe(before);
    expect(await bcrypt.compare('first-boot-pass', before)).toBe(true);
    const admins = (await databaseService.auth.getAllUsers()).filter((u) => u.isAdmin);
    expect(admins).toHaveLength(1);
  });
});
