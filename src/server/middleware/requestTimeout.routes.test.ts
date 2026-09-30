/**
 * Pin test: asserts every route identified as a legitimate long-radio-wait
 * outlier (see CLAUDE.md / the #http-timeout-no-resend work) still carries
 * `extendRequestTimeout(...)` as route middleware, so a future refactor that
 * drops it is caught here instead of surfacing as a silent 504 in the field.
 *
 * Also pins the two explicit exclusions:
 *  - MeshCore `/contacts/:publicKey/trace-path` is handled by a separate PR
 *    (#5490) and must NOT be touched here.
 *  - `POST /api/automations/:id/run-now` has an unbounded worst case and
 *    intentionally relies on the global `respondOnSocketTimeout()` 504 safety
 *    net instead of a per-route extension.
 *
 * This is a source-text pin, not a functional test — `requestTimeout.test.ts`
 * covers `extendRequestTimeout`'s actual behavior (it sets `req.setTimeout`
 * and lets the route finish). Reading route source avoids standing up each
 * router's full dependency graph (managers, auth, rate limiters) just to
 * assert a timeout was extended.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.join(__dirname, '..', 'routes');

function readRoute(file: string): string {
  return fs.readFileSync(path.join(routesDir, file), 'utf8');
}

/**
 * True when `extendRequestTimeout(` appears immediately (allowing whitespace/
 * newlines, as in both single-line and multi-line `router.<verb>(...)` calls)
 * after the route's quoted path literal.
 */
function pathExtendsTimeout(content: string, routePath: string): boolean {
  const quoted = `'${routePath}'`;
  const idx = content.indexOf(quoted);
  if (idx === -1) {
    throw new Error(`route path ${quoted} not found in source — route renamed/removed?`);
  }
  const after = content.slice(idx + quoted.length, idx + quoted.length + 200);
  return /^\s*,\s*extendRequestTimeout\(/.test(after);
}

describe('extendRequestTimeout route coverage (pin test)', () => {
  const cases: Array<{ file: string; paths: string[] }> = [
    {
      file: 'meshcoreContactsRoutes.ts',
      paths: [
        '/contacts/:publicKey/ping',
        '/contacts/:publicKey/neighbours',
        '/nodes/:publicKey/neighbours/poll',
        '/nodes/:publicKey/time-sync',
        '/neighbors/request',
        '/nodes/:publicKey/telemetry/poll',
        '/discover',
        '/regions/discover',
      ],
    },
    {
      file: 'meshcoreAdminRoutes.ts',
      paths: ['/admin/login', '/admin/login-with-saved', '/admin/cli', '/cli'],
    },
    {
      file: 'meshcoreMessagingRoutes.ts',
      paths: ['/rooms/login', '/rooms/login-with-saved'],
    },
    {
      file: 'meshcoreAutomationRoutes.ts',
      paths: ['/automation/announce/send', '/automation/timers/:triggerId/run'],
    },
    {
      file: 'meshcoreDeviceRoutes.ts',
      paths: ['/connect'],
    },
    {
      file: 'adminRoutes.ts',
      paths: [
        '/ensure-session-passkey',
        '/load-config',
        '/get-channel',
        '/load-owner',
        '/get-device-metadata',
        '/export-config',
        '/reboot',
        '/set-time',
        '/auto-favorite-targets/:nodeNum/run',
      ],
    },
    {
      file: 'firmwareUpdateRoutes.ts',
      paths: ['/restore'],
    },
    {
      file: 'scriptRoutes.ts',
      paths: ['/scripts/dependencies/install', '/scripts/test'],
    },
    {
      file: 'backupRoutes.ts',
      paths: ['/restore/:filename'],
    },
  ];

  for (const { file, paths } of cases) {
    describe(file, () => {
      const content = readRoute(file);

      it('imports extendRequestTimeout', () => {
        expect(content).toMatch(/import\s*\{[^}]*extendRequestTimeout[^}]*\}\s*from\s*['"].*middleware\/requestTimeout\.js['"]/);
      });

      for (const routePath of paths) {
        it(`extends the socket timeout for ${routePath}`, () => {
          expect(pathExtendsTimeout(content, routePath)).toBe(true);
        });
      }
    });
  }

  it('does NOT extend the timeout on MeshCore trace-path (owned by #5490)', () => {
    const content = readRoute('meshcoreContactsRoutes.ts');
    expect(pathExtendsTimeout(content, '/contacts/:publicKey/trace-path')).toBe(false);
  });

  it('does NOT extend the timeout on automation run-now (unbounded; relies on the global 504 safety net)', () => {
    const content = readRoute('automationRoutes.ts');
    expect(pathExtendsTimeout(content, '/:id/run-now')).toBe(false);
    // The route must document why, so a future reader doesn't "fix" this as an oversight.
    const idx = content.indexOf("'/:id/run-now'");
    const before = content.slice(Math.max(0, idx - 600), idx);
    expect(before).toMatch(/respondOnSocketTimeout/);
  });
});
