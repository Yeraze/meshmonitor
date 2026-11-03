/**
 * Route tests for the Meshtastic free-form remote-admin CLI console (#6154).
 *
 * Uses the real auth/permission middleware via createRouteTestApp, so
 * `remote_admin:write` is enforced by real SQL. The source manager resolution
 * and the CLI spawn are mocked — tests NEVER spawn the real `meshtastic`
 * binary.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import meshtasticAdminRoutes from './meshtasticAdminRoutes.js';

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn(),
  resolveOwnMeshtasticManager: vi.fn(),
}));
vi.mock('../services/meshtasticCliRunner.js', () => ({
  runMeshtasticCli: vi.fn(),
}));

import { resolveOwnMeshtasticManager } from '../utils/resolveSourceManager.js';
import { runMeshtasticCli } from '../services/meshtasticCliRunner.js';

const resolveMock = resolveOwnMeshtasticManager as unknown as Mock;
const runMock = runMeshtasticCli as unknown as Mock;

/** A fake Meshtastic manager whose VN target + TX capability are controllable. */
function fakeManager(target: { host: string; port: number } | null, canTransmit = true) {
  return {
    sourceType: 'meshtastic_tcp',
    getVirtualNodeTarget: () => target,
    canTransmit: () => canTransmit,
  };
}

function okRun(stdout = 'Connected to radio\nOK', stderr = '') {
  return { stdout, stderr, exitCode: 0, timedOut: false, outputTooLarge: false, elapsedMs: 42 };
}

describe('meshtastic remote-admin CLI route', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/api/sources/:id/meshtastic', meshtasticAdminRoutes),
    });
    resolveMock.mockReset();
    runMock.mockReset();
    // Default: VN enabled on sourceA.
    resolveMock.mockReturnValue(fakeManager({ host: '127.0.0.1', port: 4403 }));
    runMock.mockResolvedValue(okRun());
  });

  afterEach(() => harness.cleanup());

  const DEST = '!aabbccdd';
  const url = (id: string) => `/api/sources/${id}/meshtastic/admin/cli`;

  it('403s without remote_admin:write on the source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--set device.role CLIENT' });
    expect(res.status).toBe(403);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('happy path: builds argv with --dest, never a shell, returns output', async () => {
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--set device.role CLIENT' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.output).toContain('OK');

    expect(runMock).toHaveBeenCalledTimes(1);
    const [argv, opts] = runMock.mock.calls[0];
    expect(Array.isArray(argv)).toBe(true);
    // argv array handed to execFile — no shell string anywhere.
    expect(argv).toEqual([
      '--host', '127.0.0.1',
      '--port', '4403',
      '--dest', DEST,
      '--set', 'device.role', 'CLIENT',
    ]);
    expect(argv).toContain('--dest');
    expect(typeof opts.timeoutMs).toBe('number');
  });

  it('quote-aware splitting keeps a quoted value as one token (no shell)', async () => {
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--set-owner "My Node; rm -rf /"' });
    expect(res.status).toBe(200);
    const [argv] = runMock.mock.calls[0];
    expect(argv).toEqual([
      '--host', '127.0.0.1', '--port', '4403', '--dest', DEST,
      '--set-owner', 'My Node; rm -rf /',
    ]);
  });

  it('400s on a bad dest node id', async () => {
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: 'not-a-node', args: '--info' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_NODE_ID');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('blocks a destructive command without confirm:true', async () => {
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--reboot' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DANGER_CONFIRM_REQUIRED');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('allows a destructive command with confirm:true', async () => {
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--reboot', confirm: true });
    expect(res.status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);
    const [argv] = runMock.mock.calls[0];
    expect(argv).toContain('--reboot');
    expect(argv).toContain('--dest');
  });

  it('returns 409 VIRTUAL_NODE_DISABLED when the VN is off', async () => {
    resolveMock.mockReturnValue(fakeManager(null));
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--info' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VIRTUAL_NODE_DISABLED');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('returns 400 SOURCE_NOT_MESHTASTIC for a non-Meshtastic source', async () => {
    resolveMock.mockReturnValue(null);
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--info' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('maps a timeout to 504 CLI_TIMEOUT', async () => {
    runMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: null, timedOut: true, outputTooLarge: false, elapsedMs: 60000 });
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--info' });
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('CLI_TIMEOUT');
  });

  it('maps a non-zero exit to 422 CLI_NONZERO_EXIT with output', async () => {
    runMock.mockResolvedValue({ stdout: '', stderr: 'Error: Timed out waiting for connection', exitCode: 1, timedOut: false, outputTooLarge: false, elapsedMs: 10 });
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--info' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CLI_NONZERO_EXIT');
    expect(res.body.output).toContain('Timed out');
  });

  it('blocks an evasive-quoted destructive flag without confirm (danger on parsed argv)', async () => {
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    // `--rebo"o"t` parses to `--reboot`; the raw string does not match the
    // danger pattern, the parsed argv does.
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--rebo"o"t' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DANGER_CONFIRM_REQUIRED');
    expect(runMock).not.toHaveBeenCalled();

    // …and it runs once confirmed.
    const ok = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--rebo"o"t', confirm: true });
    expect(ok.status).toBe(200);
    const [argv] = runMock.mock.calls[0];
    expect(argv).toContain('--reboot');
  });

  it.each(['--reset-nodedb', '--remove-node !aabbccee', '--enter-dfu'])(
    'flags the Meshtastic-specific destructive flag %s without confirm',
    async (args) => {
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DANGER_CONFIRM_REQUIRED');
      expect(runMock).not.toHaveBeenCalled();
    },
  );

  it.each(['--host 10.0.0.1 --info', '--port 4404 --info', '--dest !deadbeef --info', '--host=1.2.3.4 --info'])(
    'rejects an attempt to re-specify a reserved transport/dest flag: %s',
    async (args) => {
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CLI_ARGS_INVALID');
      expect(runMock).not.toHaveBeenCalled();
    },
  );

  it('returns 403 TX_DISABLED when the source cannot transmit', async () => {
    resolveMock.mockReturnValue(fakeManager({ host: '127.0.0.1', port: 4403 }, false));
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--info' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TX_DISABLED');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('maps a maxBuffer overflow to 422 CLI_OUTPUT_TOO_LARGE (not a timeout)', async () => {
    runMock.mockResolvedValue({ stdout: 'x'.repeat(10), stderr: '', exitCode: null, timedOut: false, outputTooLarge: true, elapsedMs: 10 });
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--info' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CLI_OUTPUT_TOO_LARGE');
  });

  it('audits a blocked danger command with the quote-aware parsed+redacted argv (#7)', async () => {
    const auditSpy = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as never);
    try {
      await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      // Danger verb + a secret value with spaces: naive whitespace-splitting
      // would misalign the redaction and leak "e c"; parsed argv masks it whole.
      await agent.post(url(harness.sourceA)).send({ destNodeId: DEST, args: '--reboot --set security.admin_key "s e c"' });
      const blocked = auditSpy.mock.calls.find((c) => c[1] === 'meshtastic_remote_cli_blocked');
      expect(blocked).toBeTruthy();
      const details = JSON.parse(blocked![3] as string) as { args: string };
      expect(details.args).toContain('security.admin_key ********');
      expect(details.args).not.toContain('e c');
    } finally {
      auditSpy.mockRestore();
    }
  });

  it('enforces per-source scope (grant on A does not authorize B)', async () => {
    await harness.grant(harness.limited.id, 'remote_admin', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceB)).send({ destNodeId: DEST, args: '--info' });
    expect(res.status).toBe(403);
  });
});
