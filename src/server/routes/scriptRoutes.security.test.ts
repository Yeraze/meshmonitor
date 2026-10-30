import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import scriptRoutes, { getScriptsDirectory } from './scriptRoutes.js';

// Integration regression coverage for cluster C1 (script-engine RCE), driven
// through the real auth middleware + real permission SQL via the route harness.
//
//   AUTHZ-01 (#6051) — a single-source settings grant must NOT reach the
//                      script endpoints. They are admin-only now.
//   INJ-01   (#6052) — execute requires the same privilege as upload (admin),
//                      and server secrets are stripped from the child env.
//   MISC-06  (#6076) — a whitespace/flag-laden mock node token must not split
//                      into extra argv elements.

let harness: RouteTestHarness;

beforeEach(async () => {
  harness = await createRouteTestApp({ mount: (app) => app.use('/', scriptRoutes) });
});
afterEach(() => harness.cleanup());

describe('script engine permission gating (AUTHZ-01 / INJ-01)', () => {
  it('denies the import endpoint to a user holding settings:write on a single source', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent
      .post('/scripts/import')
      .set('x-filename', 'evil.py')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('print(1)'));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ADMIN');
  });

  it('denies the test (execute) endpoint to a settings:write user', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent
      .post('/scripts/test')
      .send({ triggerType: 'timer', script: '/data/scripts/x.py', timerName: 't' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ADMIN');
  });

  it('denies the dependency install endpoint to a settings:write user', async () => {
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.post('/scripts/dependencies/install').send({});

    expect(res.status).toBe(403);
  });

  it('lets an admin past the gate (handler validation is reached)', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent
      .post('/scripts/import')
      .set('x-filename', 'evil.exe')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));

    // Past requireAdmin → the handler's own extension validation rejects it.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid file extension');
  });
});

// Executing a real script needs a POSIX `sh`; skip on Windows runners.
describe.skipIf(process.platform === 'win32')('script execution hardening (INJ-01 env / MISC-06 argv)', () => {
  const scriptName = 'mm_sec_argtest.sh';
  let scriptAbsPath: string;

  beforeEach(() => {
    scriptAbsPath = path.join(getScriptsDirectory(), scriptName);
    // Report the secret the child can see and its positional-arg count as JSON.
    fs.writeFileSync(
      scriptAbsPath,
      '#!/bin/sh\nprintf \'{"secret":"%s","argc":%s}\' "$SESSION_SECRET" "$#"\n',
      { mode: 0o755 }
    );
  });

  afterEach(() => {
    try {
      fs.unlinkSync(scriptAbsPath);
    } catch {
      /* already gone */
    }
  });

  it('withholds SESSION_SECRET and keeps a whitespace token as a single argv element', async () => {
    const prev = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'super-secret-value';
    try {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/scripts/test').send({
        triggerType: 'timer',
        script: `/data/scripts/${scriptName}`,
        timerName: 't',
        timerId: 't',
        scriptArgs: '{SHORT_NAME}',
        mockNode: { shortName: 'legit --injected-arg 42', longName: 'Test', nodeNum: 12345 },
      });

      expect(res.status).toBe(200);
      const out = JSON.parse(res.body.stdout);
      // INJ-01: the server secret must not leak into the script's environment.
      expect(out.secret).toBe('');
      // MISC-06: the flag-laden shortName stays one argument, not three.
      expect(out.argc).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prev;
    }
  });
});
