/**
 * Tests for MeshCoreManager.requestNeighbors login behavior.
 *
 * A neighbor request to a remote repeater logs in with the SAVED password for
 * that node (repeaters gate `neighbors` behind a guest/admin password). It
 * must NEVER fall back to an empty-password ("anonymous") login — that silently
 * downgrades below the guest level and the command returns nothing. It retries
 * the saved password because the login round-trip is easily dropped on a lossy
 * link. Regression guard for the "neighbor request ignores the saved password /
 * downgrades to anonymous" bug.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocked credential store — same specifier the manager imports dynamically.
const mockLoad = vi.fn();
vi.mock('./services/meshcoreCredentialStore.js', () => ({
  getMeshCoreCredentialStore: () => ({ load: mockLoad }),
}));

import { MeshCoreManager, MeshCoreDeviceType } from './meshcoreManager.js';

const KEY = 'a'.repeat(64);

interface LoginCall { pk: string; pw: string }

function makeManager(loginImpl?: (pk: string, pw: string, attempt: number) => boolean) {
  const m = new MeshCoreManager('test-source') as any;
  m.deviceType = MeshCoreDeviceType.COMPANION;
  m.connected = true;
  m.localNode = { publicKey: 'local', name: 'local', advType: MeshCoreDeviceType.COMPANION };
  const loginCalls: LoginCall[] = [];
  m.loginToNode = vi.fn(async (pk: string, pw: string) => {
    loginCalls.push({ pk, pw });
    return loginImpl ? loginImpl(pk, pw, loginCalls.length) : true;
  });
  // Stub the CLI transport: reply "not supported" so requestNeighbors returns
  // early (null) right after login — we only assert on the login that happened.
  m.sendCliCommand = vi.fn(async () => ({ reply: 'not supported', elapsedMs: 0 }));
  return { m, loginCalls };
}

describe('MeshCoreManager.requestNeighbors — saved-password login (no anonymous fallback)', () => {
  beforeEach(() => {
    mockLoad.mockReset();
  });

  it('logs in with the SAVED password when one exists', async () => {
    mockLoad.mockResolvedValue({ kind: 'ok', password: 's3cret' });
    const { m, loginCalls } = makeManager();

    await m.requestNeighbors(KEY);

    expect(mockLoad).toHaveBeenCalledWith('test-source', KEY);
    expect(loginCalls).toEqual([{ pk: KEY, pw: 's3cret' }]);
  });

  it('NEVER falls back to an empty-password (anonymous) login when no credential is saved', async () => {
    mockLoad.mockResolvedValue({ kind: 'none' });
    const { m, loginCalls } = makeManager();

    await m.requestNeighbors(KEY);

    expect(loginCalls).toEqual([]); // no login attempted at all
    expect(loginCalls.some((c) => c.pw === '')).toBe(false);
  });

  it('NEVER anonymous-logs-in when the stored credential key was rotated', async () => {
    mockLoad.mockResolvedValue({ kind: 'key_rotated', storedKid: 'old' });
    const { m, loginCalls } = makeManager();

    await m.requestNeighbors(KEY);

    expect(loginCalls).toEqual([]);
  });

  it('retries the saved password (lossy link) and does NOT downgrade to empty', async () => {
    mockLoad.mockResolvedValue({ kind: 'ok', password: 's3cret' });
    // First attempt dropped (no reply → false), second succeeds.
    const { m, loginCalls } = makeManager((_pk, _pw, attempt) => attempt >= 2);

    await m.requestNeighbors(KEY);

    expect(loginCalls).toEqual([
      { pk: KEY, pw: 's3cret' },
      { pk: KEY, pw: 's3cret' },
    ]);
    expect(loginCalls.some((c) => c.pw === '')).toBe(false);
  });

  it('gives up after 3 saved-password attempts without ever sending an empty password', async () => {
    mockLoad.mockResolvedValue({ kind: 'ok', password: 's3cret' });
    const { m, loginCalls } = makeManager(() => false); // every attempt dropped

    await m.requestNeighbors(KEY);

    expect(loginCalls).toEqual([
      { pk: KEY, pw: 's3cret' },
      { pk: KEY, pw: 's3cret' },
      { pk: KEY, pw: 's3cret' },
    ]);
    expect(loginCalls.some((c) => c.pw === '')).toBe(false);
  });
});

describe('MeshCoreManager.getNeighbours — saved-password login (binary path)', () => {
  beforeEach(() => {
    mockLoad.mockReset();
  });

  it('logs in with the saved password before the binary get_neighbours query', async () => {
    mockLoad.mockResolvedValue({ kind: 'ok', password: 's3cret' });
    const { m, loginCalls } = makeManager();
    const bridgeCalls: string[] = [];
    m.sendBridgeCommand = vi.fn(async (cmd: string) => {
      bridgeCalls.push(cmd);
      return { id: '1', success: true, data: { total: 0, neighbours: [] } };
    });

    await m.getNeighbours(KEY, { count: 20 });

    expect(loginCalls).toEqual([{ pk: KEY, pw: 's3cret' }]);
    expect(bridgeCalls).toContain('get_neighbours');
  });

  it('does NOT anonymous-login when no credential is saved (binary path)', async () => {
    mockLoad.mockResolvedValue({ kind: 'none' });
    const { m, loginCalls } = makeManager();
    m.sendBridgeCommand = vi.fn(async () => ({ id: '1', success: true, data: { total: 0, neighbours: [] } }));

    await m.getNeighbours(KEY, { count: 20 });

    expect(loginCalls).toEqual([]); // no empty-password login
  });
});
