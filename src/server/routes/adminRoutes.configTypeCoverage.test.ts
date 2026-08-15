/**
 * Config-type registry vs. adminRoutes dispatch coverage (#4739).
 *
 * `CONFIG_TYPE_MAP` decides whether a config type is *recognised*; two separate
 * `switch` statements in `adminRoutes.ts` — one for the local node, one for
 * remote admin — decide whether it is *formatted into a response*. A type in
 * the registry but missing from a switch passes the lookup, falls through with
 * `config` unset, and reaches the user as "Unknown config type: <id>", which
 * reads like an unsupported feature rather than the dispatch gap it is.
 *
 * That has happened twice: #1852 (`telemetry`) and #4739 (`meshbeacon`). Both
 * were one-line fixes, and both were found by a user rather than by CI. This
 * test closes the class — adding a config type to the registry without wiring
 * both switches now fails here instead of shipping.
 *
 * Source extraction rather than an HTTP exercise, deliberately: the switches
 * sit deep inside a large handler behind device/session mocking, and what needs
 * guarding is a *list*, not behaviour. The repo uses this pattern elsewhere
 * (see `server.settings-persistence.test.ts`).
 *
 * Regions are used rather than "the case labels above the generic body",
 * because several types (`mqtt`, `device`, `lora`, `position`, `security`)
 * carry bespoke cases outside the generic fallthrough group. Anchoring on the
 * group alone reported those as missing when they are handled perfectly well.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_TYPES } from '../constants/configTypes.js';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'adminRoutes.ts'),
  'utf8',
);

/** Boundaries of the two dispatch switches inside the config-load handler. */
const REMOTE_MARKER = '// Remote node - request config with session passkey';
const AFTER_MARKER = '// Handle channel config (works for both local and remote)';

function regions(): { local: string; remote: string } {
  const r = source.indexOf(REMOTE_MARKER);
  const c = source.indexOf(AFTER_MARKER);
  expect(r, `marker missing — retarget this test: ${REMOTE_MARKER}`).toBeGreaterThan(-1);
  expect(c, `marker missing — retarget this test: ${AFTER_MARKER}`).toBeGreaterThan(r);
  return { local: source.slice(0, r), remote: source.slice(r, c) };
}

function caseLabels(region: string): Set<string> {
  return new Set(Array.from(region.matchAll(/^\s*case '([a-z0-9_]+)':/gm), (m) => m[1]));
}

const ALL_IDS = CONFIG_TYPES.map((e) => e.id);
const MODULE_IDS = CONFIG_TYPES.filter((e) => e.kind === 'module').map((e) => e.id);

describe('adminRoutes config dispatch covers the registry', () => {
  // Guards the guard: an extraction bug returning nothing would make every
  // coverage assertion below vacuously pass.
  it('extracts a plausible case list from both regions', () => {
    const { local, remote } = regions();
    expect(caseLabels(local).size).toBeGreaterThan(20);
    expect(caseLabels(remote).size).toBeGreaterThan(20);
  });

  it('registry includes the two types that previously drifted', () => {
    expect(MODULE_IDS).toContain('telemetry');   // #1852
    expect(MODULE_IDS).toContain('meshbeacon');  // #4739
  });

  it('handles every registered config type on the local-node path', () => {
    const handled = caseLabels(regions().local);
    expect(ALL_IDS.filter((id) => !handled.has(id))).toEqual([]);
  });

  it('handles every registered config type on the remote-node path', () => {
    // The reported #4739 failure came through remote admin's "Load All Config".
    const handled = caseLabels(regions().remote);
    expect(ALL_IDS.filter((id) => !handled.has(id))).toEqual([]);
  });
});
