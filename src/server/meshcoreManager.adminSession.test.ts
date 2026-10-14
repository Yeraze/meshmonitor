/**
 * Remembered remote-admin sessions (#5785).
 *
 * A repeater keeps a logged-in client in its ACL with no idle timeout, so
 * `ensureSavedLogin` resumes a remembered session instead of paying a fresh
 * login exchange. These tests drive the real repository on an in-memory
 * SQLite database built by the migration registry, so "survives a restart"
 * is a real row read by a NEW manager instance.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockLoad = vi.fn();
vi.mock('./services/meshcoreCredentialStore.js', () => ({
  getMeshCoreCredentialStore: () => ({ load: mockLoad }),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';
import databaseService from '../services/database.js';
import { MeshCoreAdminSessionsRepository } from '../db/repositories/meshcoreAdminSessions.js';
import { createTestDb } from './test-helpers/testDb.js';

const SOURCE = 'src-a';
const TARGET = 'a'.repeat(64);
const SELF = 'b'.repeat(64);
const OTHER_SELF = 'c'.repeat(64);

type LoginOutcome = 'ok' | 'no_reply' | 'rejected';

function makeManager(opts: { self?: string; sourceId?: string; login?: () => LoginOutcome } = {}) {
  const m = new MeshCoreManager(opts.sourceId ?? SOURCE) as any;
  m.deviceType = MeshCoreDeviceType.COMPANION;
  m.connected = true;
  m.localNode = { publicKey: opts.self ?? SELF, name: 'local', advType: MeshCoreDeviceType.COMPANION };
  const loginSpy = vi.fn(async () => {
    const outcome = opts.login ? opts.login() : 'ok';
    return { result: outcome === 'ok' ? { isAdmin: true } : null, outcome, attempts: 1 };
  });
  m.loginToNodeWithRetry = loginSpy;
  return { m, loginSpy };
}

let t: ReturnType<typeof createTestDb>;
let repo: MeshCoreAdminSessionsRepository;
let savedRepo: unknown;

beforeEach(() => {
  t = createTestDb();
  repo = new MeshCoreAdminSessionsRepository(t.db, 'sqlite');
  savedRepo = (databaseService as any).meshcoreAdminSessionsRepo;
  (databaseService as any).meshcoreAdminSessionsRepo = repo;
  mockLoad.mockReset();
  mockLoad.mockResolvedValue({ kind: 'ok', password: 's3cret' });
});

afterEach(() => {
  (databaseService as any).meshcoreAdminSessionsRepo = savedRepo;
  t.sqlite.close();
});

describe('ensureSavedLogin — remembered sessions', () => {
  it('records the session on a successful saved-password login', async () => {
    const { m, loginSpy } = makeManager();
    expect(await m.ensureSavedLoginDetailed(TARGET)).toBe('logged_in');
    expect(loginSpy).toHaveBeenCalledTimes(1);
    const row = await repo.get(SOURCE, TARGET);
    expect(row).toMatchObject({ selfPublicKey: SELF, isAdmin: true });
  });

  it('resumes a remembered session with no login exchange', async () => {
    await repo.record({ sourceId: SOURCE, targetPublicKey: TARGET, selfPublicKey: SELF, loggedInAt: 1, isAdmin: true });
    const { m, loginSpy } = makeManager();
    expect(await m.ensureSavedLogin(TARGET)).toBe(true);
    expect(await m.ensureSavedLoginDetailed(TARGET)).toBe('resumed');
    expect(loginSpy).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('survives a manager re-instantiation (it lives in the database)', async () => {
    const first = makeManager();
    await first.m.ensureSavedLogin(TARGET);
    expect(first.loginSpy).toHaveBeenCalledTimes(1);

    const second = makeManager();
    expect(await second.m.ensureSavedLoginDetailed(TARGET)).toBe('resumed');
    expect(second.loginSpy).not.toHaveBeenCalled();
  });

  it('ignores a session recorded by a different companion key', async () => {
    await repo.record({ sourceId: SOURCE, targetPublicKey: TARGET, selfPublicKey: OTHER_SELF, loggedInAt: 1, isAdmin: true });
    const { m, loginSpy } = makeManager();
    expect((await m.getAdminSession(TARGET)).reason).toBe('other_radio');
    expect(await m.ensureSavedLoginDetailed(TARGET)).toBe('logged_in');
    expect(loginSpy).toHaveBeenCalledTimes(1);
    // The fresh login re-records it under the current key.
    expect((await repo.get(SOURCE, TARGET))?.selfPublicKey).toBe(SELF);
  });

  it('does not honour a session while disconnected, and does not clear it either', async () => {
    await repo.record({ sourceId: SOURCE, targetPublicKey: TARGET, selfPublicKey: SELF, loggedInAt: 1, isAdmin: true });
    const { m } = makeManager();
    m.connected = false;
    expect(await m.getAdminSession(TARGET)).toMatchObject({ active: false, reason: 'not_connected' });
    expect(await repo.get(SOURCE, TARGET)).not.toBeNull();
  });

  it('does not see another source’s session', async () => {
    await repo.record({ sourceId: 'src-b', targetPublicKey: TARGET, selfPublicKey: SELF, loggedInAt: 1, isAdmin: true });
    const { m, loginSpy } = makeManager();
    expect(await m.ensureSavedLoginDetailed(TARGET)).toBe('logged_in');
    expect(loginSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the session when the saved password is rejected', async () => {
    await repo.record({ sourceId: SOURCE, targetPublicKey: TARGET, selfPublicKey: OTHER_SELF, loggedInAt: 1, isAdmin: true });
    const { m } = makeManager({ login: () => 'rejected' });
    expect(await m.ensureSavedLoginDetailed(TARGET)).toBe('failed');
    expect(await repo.get(SOURCE, TARGET)).toBeNull();
  });

  it('keeps the session when a fresh login only got no reply', async () => {
    await repo.record({ sourceId: SOURCE, targetPublicKey: TARGET, selfPublicKey: SELF, loggedInAt: 1, isAdmin: true });
    const { m } = makeManager({ login: () => 'no_reply' });
    expect(await m.ensureSavedLoginDetailed(TARGET, { fresh: true })).toBe('failed');
    expect(await repo.get(SOURCE, TARGET)).not.toBeNull();
  });
});

describe('recordAdminSession — admin logins only', () => {
  it('records an admin login', async () => {
    const { m } = makeManager();
    await m.recordAdminSession(TARGET, { isAdmin: true });
    expect(await repo.get(SOURCE, TARGET)).toMatchObject({ isAdmin: true });
  });

  it('does not record a login the repeater says is a guest, and forgets an older admin one', async () => {
    await repo.record({ sourceId: SOURCE, targetPublicKey: TARGET, selfPublicKey: SELF, loggedInAt: 1, isAdmin: true });
    const { m } = makeManager();
    await m.recordAdminSession(TARGET, { isAdmin: false });
    expect(await repo.get(SOURCE, TARGET)).toBeFalsy();
  });

  it('treats an empty-password login as a guest when the reply does not say', async () => {
    const { m } = makeManager();
    await m.recordAdminSession(TARGET, {}, { guest: true });
    expect(await repo.get(SOURCE, TARGET)).toBeFalsy();
  });

  it('records a password login whose reply does not say', async () => {
    const { m } = makeManager();
    await m.recordAdminSession(TARGET, {}, { guest: false });
    expect(await repo.get(SOURCE, TARGET)).toBeTruthy();
  });
});

describe('syncNodeTime — stale-session fallback', () => {
  const resumed = async () => {
    await repo.record({ sourceId: SOURCE, targetPublicKey: TARGET, selfPublicKey: SELF, loggedInAt: 1, isAdmin: true });
  };

  it('a live session costs no login: just the time command', async () => {
    await resumed();
    const { m, loginSpy } = makeManager();
    m.sendCliCommand = vi.fn(async () => ({ reply: 'OK', elapsedMs: 5 }));
    expect(await m.syncNodeTime(TARGET)).toMatchObject({ status: 'ok' });
    expect(loginSpy).not.toHaveBeenCalled();
    expect(m.sendCliCommand).toHaveBeenCalledTimes(1);
  });

  it('a stale session: clears it, logs in ONCE, retries ONCE', async () => {
    await resumed();
    const { m, loginSpy } = makeManager();
    m.sendCliCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('CLI command timed out after 15000ms'))
      .mockResolvedValueOnce({ reply: 'OK', elapsedMs: 5 });
    expect(await m.syncNodeTime(TARGET)).toMatchObject({ status: 'ok' });
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(m.sendCliCommand).toHaveBeenCalledTimes(2);
    // The fresh login re-recorded the session.
    expect(await repo.get(SOURCE, TARGET)).not.toBeNull();
  });

  it('never loops: a retry that also times out is the final answer', async () => {
    await resumed();
    const { m, loginSpy } = makeManager();
    m.sendCliCommand = vi.fn().mockRejectedValue(new Error('CLI command timed out after 15000ms'));
    expect(await m.syncNodeTime(TARGET)).toMatchObject({ status: 'failed' });
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(m.sendCliCommand).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the fallback login fails, and leaves no session behind', async () => {
    await resumed();
    const { m, loginSpy } = makeManager({ login: () => 'no_reply' });
    m.sendCliCommand = vi.fn().mockRejectedValue(new Error('CLI command timed out after 15000ms'));
    expect(await m.syncNodeTime(TARGET)).toMatchObject({ status: 'failed' });
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(m.sendCliCommand).toHaveBeenCalledTimes(1);
    expect(await repo.get(SOURCE, TARGET)).toBeNull();
  });

  it('no fallback after a FRESH login: a timeout there is not a stale session', async () => {
    const { m, loginSpy } = makeManager();
    m.sendCliCommand = vi.fn().mockRejectedValue(new Error('CLI command timed out after 15000ms'));
    expect(await m.syncNodeTime(TARGET)).toMatchObject({ status: 'failed' });
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(m.sendCliCommand).toHaveBeenCalledTimes(1);
  });
});

describe('getNeighbours / requestNeighbors — stale-session fallback', () => {
  beforeEach(async () => {
    await repo.record({ sourceId: SOURCE, targetPublicKey: TARGET, selfPublicKey: SELF, loggedInAt: 1, isAdmin: true });
  });

  it('getNeighbours: resumes, then relogs once and retries once on no reply', async () => {
    const { m, loginSpy } = makeManager();
    m.sendBridgeCommand = vi
      .fn()
      .mockResolvedValueOnce({ id: '1', success: false, error: 'timeout' })
      .mockResolvedValueOnce({ id: '2', success: true, data: { total: 0, neighbours: [] } });
    expect(await m.getNeighbours(TARGET)).toEqual({ total: 0, neighbours: [] });
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(m.sendBridgeCommand).toHaveBeenCalledTimes(2);
  });

  it('getNeighbours: a resumed session that answers costs no login', async () => {
    const { m, loginSpy } = makeManager();
    m.sendBridgeCommand = vi.fn(async () => ({ id: '1', success: true, data: { total: 0, neighbours: [] } }));
    await m.getNeighbours(TARGET);
    expect(loginSpy).not.toHaveBeenCalled();
    expect(m.sendBridgeCommand).toHaveBeenCalledTimes(1);
  });

  it('requestNeighbors: relogs once and retries once on a CLI timeout', async () => {
    const { m, loginSpy } = makeManager();
    m.sendCliCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('CLI command timed out after 15000ms'))
      .mockResolvedValueOnce({ reply: 'not supported', elapsedMs: 0 });
    await m.requestNeighbors(TARGET);
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(m.sendCliCommand).toHaveBeenCalledTimes(2);
  });

  it('requestNeighbors: a second timeout is thrown, not retried again', async () => {
    const { m, loginSpy } = makeManager();
    m.sendCliCommand = vi.fn().mockRejectedValue(new Error('CLI command timed out after 15000ms'));
    await expect(m.requestNeighbors(TARGET)).rejects.toThrow(/timed out/);
    expect(loginSpy).toHaveBeenCalledTimes(1);
    expect(m.sendCliCommand).toHaveBeenCalledTimes(2);
  });
});
