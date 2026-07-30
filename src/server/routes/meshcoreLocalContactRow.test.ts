/**
 * Tests for the shared MeshCore local-contact-row construction site (#4438)
 * and the #4449 GET/POST-refresh parity fix that fell out of enumerating
 * its producers.
 *
 * Three layers:
 *  - Pure unit tests for `buildLocalContactRow` / `withoutLocalFlag`.
 *  - T-C1: a structural (source-read) test asserting the advName `(local)`
 *    marker is constructed in exactly one `src/server` module. A future
 *    fourth route that hand-rolls a local row fails this immediately.
 *  - T-C2 + the #4449 parity test: table-driven behavioural coverage over
 *    the three contact-returning endpoints, using the real
 *    `createRouteTestApp()` harness (real session + real permission checks)
 *    per CLAUDE.md.
 */
import { readFileSync, readdirSync } from 'fs';
import { resolve, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { buildLocalContactRow, withoutLocalFlag } from './meshcoreLocalContactRow.js';
import type { MeshCoreContact, MeshCoreNode } from '../meshcoreManager.js';

// ─── Pure unit tests ────────────────────────────────────────────────────────

describe('buildLocalContactRow', () => {
  const localNode: MeshCoreNode = {
    publicKey: 'a'.repeat(64),
    name: 'MyNode',
    advType: 1,
    latitude: 10,
    longitude: 20,
  };

  it('sets isLocal: true', () => {
    expect(buildLocalContactRow(localNode).isLocal).toBe(true);
  });

  it('keeps the "(local)" suffix on advName as user-visible display text (#4438) — do NOT remove it', () => {
    // MeshCoreNodesView.test.tsx asserts the rendered row name is literally
    // "MyNode (local)". Only the reader-side substring MATCH was the bug;
    // the string itself stays.
    expect(buildLocalContactRow(localNode).advName).toBe('MyNode (local)');
  });

  it('carries the local node identity through to the row', () => {
    const row = buildLocalContactRow(localNode);
    expect(row.publicKey).toBe(localNode.publicKey);
    expect(row.name).toBe('MyNode');
    expect(row.latitude).toBe(10);
    expect(row.longitude).toBe(20);
    expect(row.advType).toBe(1);
  });
});

describe('withoutLocalFlag', () => {
  it('stamps isLocal: false on every contact, preserving the rest of the shape', () => {
    const contacts: MeshCoreContact[] = [
      { publicKey: 'b'.repeat(64), advName: 'Remote1', advType: 2 },
      { publicKey: 'c'.repeat(64), advName: 'Remote2', advType: 3 },
    ];
    const result = withoutLocalFlag(contacts);
    expect(result).toHaveLength(2);
    expect(result.every((c) => c.isLocal === false)).toBe(true);
    expect(result[0].advName).toBe('Remote1');
    expect(result[1].advName).toBe('Remote2');
  });

  it('does not mutate the input array elements', () => {
    const original: MeshCoreContact = { publicKey: 'd'.repeat(64) };
    const contacts = [original];
    withoutLocalFlag(contacts);
    expect((original as MeshCoreContact & { isLocal?: boolean }).isLocal).toBeUndefined();
  });
});

// ─── T-C1: structural — the advName marker exists in exactly one module ───

const __filename = fileURLToPath(import.meta.url);
const SERVER_ROOT = resolve(__filename, '..', '..'); // src/server

/**
 * Find every `src/server/**\/*.ts` file (excluding test files) that
 * constructs the advName `(local)` marker — i.e. contains the literal
 * template-literal tail `` (local)` ``. This deliberately does NOT match
 * the unrelated `publicKey ?? '(local)'` sentinel in
 * `meshcoreContactsRoutes.ts` (a quoted string, not a template-literal
 * suffix) — see the note in the epic follow-up spec §4 P6/T-C1 caveat.
 */
function findAdvNameMarkerFiles(): string[] {
  const matches: string[] = [];
  const MARKER = /\(local\)`/;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const content = readFileSync(full, 'utf-8');
      if (MARKER.test(content)) matches.push(relative(SERVER_ROOT, full));
    }
  }

  walk(SERVER_ROOT);
  return matches;
}

describe('T-C1 — the advName "(local)" marker has exactly one construction site', () => {
  it('is constructed only in meshcoreLocalContactRow.ts', () => {
    expect(findAdvNameMarkerFiles()).toEqual(['routes/meshcoreLocalContactRow.ts']);
  });

  it('the unrelated publicKey sentinel in meshcoreContactsRoutes.ts is untouched (out of scope for this guard)', () => {
    // `neighbors/request` uses '(local)' as a publicKey placeholder in the
    // audit log when no explicit target was requested — a different thing
    // entirely from the advName marker. Confirmed still present, unchanged,
    // and NOT counted by findAdvNameMarkerFiles() above (it's a quoted
    // string literal, not a template-literal suffix).
    const source = readFileSync(join(SERVER_ROOT, 'routes/meshcoreContactsRoutes.ts'), 'utf-8');
    expect(source).toContain("publicKey: publicKey ?? '(local)'");
  });
});

// ─── T-C2 + #4449 parity: behavioural, table-driven over the real routes ──

vi.mock('../sourceManagerRegistry.js', () => {
  const LOCAL_PK = 'l'.repeat(64);
  const REMOTE_PK = 'r'.repeat(64);
  const remoteContacts = [
    { publicKey: REMOTE_PK, advName: 'Remote1', name: 'Remote1', advType: 2, latitude: 11, longitude: 21 },
  ];
  const localNode = { publicKey: LOCAL_PK, name: 'MyNode', advType: 1, latitude: 10, longitude: 20 };

  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
    getLocalNode: () => localNode,
    getContacts: () => remoteContacts,
    getAllNodes: async () => [],
    getRecentMessages: (_limit?: number) => [],
    refreshContacts: async () => new Map(remoteContacts.map((c) => [c.publicKey, c])),
  });
  const managers = new Map([['rt-source-a', stubFor('rt-source-a')]]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
    __LOCAL_PK: LOCAL_PK,
    __REMOTE_PK: REMOTE_PK,
  };
});

const LOCAL_PK = 'l'.repeat(64);
const REMOTE_PK = 'r'.repeat(64);

import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('MeshCore contact-returning endpoints — isLocal shape parity (#4438 T-C2, #4449)', () => {
  let harness: RouteTestHarness;

  const setup = async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
    // One row per (user, resource, sourceId) — `harness.grant()` only sets a
    // single action flag per call, so both `nodes:read` (GET routes) and
    // `nodes:write` (POST /contacts/refresh) must land in ONE insert here
    // rather than two `grant()` calls, which would violate the unique
    // constraint on a second insert for the same (user, 'nodes', sourceId).
    await harness.db.auth.createPermission({
      userId: harness.limited.id,
      resource: 'nodes',
      canRead: true,
      canWrite: true,
      canViewOnMap: false,
      sourceId: harness.sourceA,
      grantedAt: Date.now(),
      grantedBy: null,
    });
    await harness.grant(harness.limited.id, 'connection', 'read', harness.sourceA);
  };

  afterEach(async () => {
    await harness?.cleanup();
  });

  const url = (path: string) => `/sources/rt-source-a/meshcore${path}`;

  const endpoints: Array<{
    name: string;
    extract: (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>) => Promise<Array<Record<string, unknown>>>;
  }> = [
    {
      name: 'GET /contacts',
      extract: async (agent) => (await agent.get(url('/contacts'))).body.data,
    },
    {
      name: 'GET /snapshot',
      extract: async (agent) => (await agent.get(url('/snapshot'))).body.data.contacts,
    },
    {
      name: 'POST /contacts/refresh',
      extract: async (agent) => (await agent.post(url('/contacts/refresh'))).body.data,
    },
  ];

  it.each(endpoints)('T-C2: $name returns exactly one isLocal:true row, matching the local node', async ({ extract }) => {
    await setup();
    const agent = await harness.loginAs(harness.limited);
    const contacts = await extract(agent);

    const localRows = contacts.filter((c) => c.isLocal === true);
    expect(localRows).toHaveLength(1);
    expect(localRows[0].publicKey).toBe(LOCAL_PK);

    // Every OTHER row must explicitly carry isLocal: false (wire type is
    // required, not merely absent) — this is what makes the "required"
    // typing meaningful rather than decorative.
    const remoteRows = contacts.filter((c) => c.publicKey !== LOCAL_PK);
    expect(remoteRows.length).toBeGreaterThan(0);
    expect(remoteRows.every((c) => c.isLocal === false)).toBe(true);
  });

  it('#4449: GET /contacts and POST /contacts/refresh return the same set of public keys', async () => {
    await setup();
    const agent = await harness.loginAs(harness.limited);

    const getRes = await agent.get(url('/contacts'));
    const refreshRes = await agent.post(url('/contacts/refresh'));

    const getKeys = new Set((getRes.body.data as Array<{ publicKey: string }>).map((c) => c.publicKey));
    const refreshKeys = new Set((refreshRes.body.data as Array<{ publicKey: string }>).map((c) => c.publicKey));

    expect(refreshKeys).toEqual(getKeys);
    // The load-bearing half of the assertion: the operator's own node must
    // survive a "Refresh Contacts" click, not just an initial GET.
    expect(refreshKeys.has(LOCAL_PK)).toBe(true);
    expect(refreshKeys.has(REMOTE_PK)).toBe(true);
  });
});
