/**
 * Multi-Database Mesh Issues Repository Tests (epic #4964, Phase 1 WP1).
 *
 * Validates MeshIssuesRepository against SQLite, PostgreSQL, and MySQL
 * backends using the shared test factory from test-utils.ts.
 *
 * SQLite: always runs (in-memory, schema from the migration registry via
 * createTestDb() — migration 154 creates mesh_issues).
 * PostgreSQL: requires test container on port 5433 (skipped if unavailable)
 * MySQL: requires test container on port 3307 (skipped if unavailable)
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import { MeshIssuesRepository } from './meshIssues.js';
import type { MeshIssueFinding } from '../../server/services/meshIssues/types.js';
import {
  TestBackend,
  createPostgresBackend,
  createMysqlBackend,
  clearTable,
  postgresAvailable,
  mysqlAvailable,
} from './test-utils.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

// Note: SQLite DDL comes from createTestDb() via the migration registry.

const POSTGRES_CREATE = `
  DROP TABLE IF EXISTS mesh_issues CASCADE;
  CREATE TABLE mesh_issues (
    id SERIAL PRIMARY KEY,
    "issueType" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "nodeNum" BIGINT,
    severity TEXT NOT NULL,
    confidence TEXT NOT NULL,
    evidence TEXT NOT NULL,
    "sourceIds" TEXT NOT NULL,
    "firstDetected" BIGINT NOT NULL,
    "lastDetected" BIGINT NOT NULL,
    "cleanRuns" INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    "closedAt" BIGINT,
    dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    "dismissedAt" BIGINT,
    "dismissedBy" INTEGER,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    UNIQUE ("issueType", "subjectKey")
  )
`;

const MYSQL_CREATE = `
  DROP TABLE IF EXISTS mesh_issues;
  CREATE TABLE mesh_issues (
    id INT AUTO_INCREMENT PRIMARY KEY,
    issueType VARCHAR(64) NOT NULL,
    subjectKey VARCHAR(128) NOT NULL,
    nodeNum BIGINT,
    severity VARCHAR(16) NOT NULL,
    confidence VARCHAR(16) NOT NULL,
    evidence TEXT NOT NULL,
    sourceIds TEXT NOT NULL,
    firstDetected BIGINT NOT NULL,
    lastDetected BIGINT NOT NULL,
    cleanRuns INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    closedAt BIGINT,
    dismissed BOOLEAN NOT NULL DEFAULT FALSE,
    dismissedAt BIGINT,
    dismissedBy INT,
    createdAt BIGINT NOT NULL,
    updatedAt BIGINT NOT NULL,
    UNIQUE KEY mesh_issues_type_subject_uniq (issueType, subjectKey)
  )
`;

function makeFinding(overrides: Partial<MeshIssueFinding> = {}): MeshIssueFinding {
  return {
    issueType: 'A1_deprecated_role',
    subjectKey: 'node:123',
    nodeNum: 123,
    severity: 'warning',
    confidence: 'high',
    evidence: { role: 4, roleName: 'REPEATER' },
    sourceIds: ['src-a'],
    recommendation: 'Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE.',
    ...overrides,
  };
}

/**
 * Shared test suite that runs against any backend.
 */
function runMeshIssuesTests(getBackend: () => TestBackend) {
  let repo: MeshIssuesRepository;

  beforeEach(() => {
    const backend = getBackend();
    if (!backend.available) return;
    repo = new MeshIssuesRepository(backend.drizzleDb, backend.dbType);
  });

  it('upsertFinding — inserts a new row with outcome "created"', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const now = Date.now();
    const { issue, outcome } = await repo.upsertFinding(makeFinding(), now);
    expect(outcome).toBe('created');
    expect(issue.issueType).toBe('A1_deprecated_role');
    expect(issue.subjectKey).toBe('node:123');
    expect(issue.status).toBe('open');
    expect(issue.cleanRuns).toBe(0);
    expect(issue.dismissed).toBe(false);
    expect(issue.firstDetected).toBe(now);
    expect(issue.lastDetected).toBe(now);
    expect(JSON.parse(issue.evidence)).toMatchObject({
      role: 4,
      roleName: 'REPEATER',
      recommendation: 'Consider CLIENT_BASE (fixed, powered) or ROUTER_LATE.',
    });
    expect(JSON.parse(issue.sourceIds)).toEqual(['src-a']);
  });

  it('upsertFinding — nodeNum round-trips as a number (BIGINT coercion)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const { issue } = await repo.upsertFinding(makeFinding({ nodeNum: 3735928559 }), Date.now());
    expect(issue.nodeNum).toBe(3735928559);
    expect(typeof issue.nodeNum).toBe('number');
  });

  it('upsertFinding — area finding with nodeNum: null round-trips', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const { issue } = await repo.upsertFinding(
      makeFinding({ issueType: 'A2b_congested_area', subjectKey: 'area:700:-1220', nodeNum: null }),
      Date.now(),
    );
    expect(issue.nodeNum).toBeNull();
  });

  it('upsertFinding — second call on the same key updates in place: firstDetected unchanged, cleanRuns reset to 0', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const t1 = Date.now() - 60_000;
    const first = await repo.upsertFinding(makeFinding({ confidence: 'medium' }), t1);
    expect(first.outcome).toBe('created');

    // Simulate clean runs having accrued before re-detection.
    await repo.bumpCleanRun(first.issue.id, 5, t1 + 10_000);

    const t2 = Date.now();
    const second = await repo.upsertFinding(makeFinding({ confidence: 'high' }), t2);
    expect(second.outcome).toBe('updated');
    expect(second.issue.firstDetected).toBe(t1);
    expect(second.issue.lastDetected).toBe(t2);
    expect(second.issue.cleanRuns).toBe(0);
    expect(second.issue.confidence).toBe('high');
  });

  it('upsertFinding — UNIQUE (issueType, subjectKey) prevents a distinct row for the same key', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertFinding(makeFinding(), Date.now());
    await repo.upsertFinding(makeFinding(), Date.now());
    const all = await repo.getIssues({ includeClosed: true, includeDismissed: true });
    expect(all.filter((i) => i.subjectKey === 'node:123')).toHaveLength(1);
  });

  it('bumpCleanRun x3 (autoCloseAfter=3) closes the issue on the third call', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const { issue } = await repo.upsertFinding(makeFinding(), Date.now());

    const r1 = await repo.bumpCleanRun(issue.id, 3, Date.now());
    expect(r1).toEqual({ cleanRuns: 1, closed: false });
    const r2 = await repo.bumpCleanRun(issue.id, 3, Date.now());
    expect(r2).toEqual({ cleanRuns: 2, closed: false });
    const r3 = await repo.bumpCleanRun(issue.id, 3, Date.now());
    expect(r3).toEqual({ cleanRuns: 3, closed: true });

    const closed = await repo.getIssueById(issue.id);
    expect(closed?.status).toBe('closed');
    expect(closed?.closedAt).not.toBeNull();
  });

  it('upsertFinding after close — reopens: outcome "reopened", closedAt null, firstDetected preserved', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const t1 = Date.now() - 100_000;
    const { issue } = await repo.upsertFinding(makeFinding(), t1);
    await repo.bumpCleanRun(issue.id, 1, Date.now());
    const closed = await repo.getIssueById(issue.id);
    expect(closed?.status).toBe('closed');

    const t2 = Date.now();
    const { issue: reopened, outcome } = await repo.upsertFinding(makeFinding(), t2);
    expect(outcome).toBe('reopened');
    expect(reopened.status).toBe('open');
    expect(reopened.closedAt).toBeNull();
    expect(reopened.firstDetected).toBe(t1);
    expect(reopened.lastDetected).toBe(t2);
  });

  it('setDismissed then upsertFinding — dismissed stays true (never cleared by a re-detection)', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const { issue } = await repo.upsertFinding(makeFinding(), Date.now());
    await repo.setDismissed(issue.id, true, 7, Date.now());

    const dismissedRow = await repo.getIssueById(issue.id);
    expect(dismissedRow?.dismissed).toBe(true);
    expect(dismissedRow?.dismissedBy).toBe(7);
    expect(dismissedRow?.dismissedAt).not.toBeNull();

    await repo.upsertFinding(makeFinding({ confidence: 'medium' }), Date.now());
    const stillDismissed = await repo.getIssueById(issue.id);
    expect(stillDismissed?.dismissed).toBe(true);
  });

  it('setDismissed(false) clears dismissedAt/dismissedBy', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const { issue } = await repo.upsertFinding(makeFinding(), Date.now());
    await repo.setDismissed(issue.id, true, 7, Date.now());
    await repo.setDismissed(issue.id, false, null, Date.now());

    const row = await repo.getIssueById(issue.id);
    expect(row?.dismissed).toBe(false);
    expect(row?.dismissedAt).toBeNull();
    expect(row?.dismissedBy).toBeNull();
  });

  it('getIssues — default excludes closed and dismissed findings', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const open = await repo.upsertFinding(makeFinding({ subjectKey: 'node:1' }), Date.now());
    const toClose = await repo.upsertFinding(makeFinding({ subjectKey: 'node:2' }), Date.now());
    const toDismiss = await repo.upsertFinding(makeFinding({ subjectKey: 'node:3' }), Date.now());

    await repo.bumpCleanRun(toClose.issue.id, 1, Date.now());
    await repo.setDismissed(toDismiss.issue.id, true, 1, Date.now());

    const defaultIssues = await repo.getIssues();
    const subjectKeys = defaultIssues.map((i) => i.subjectKey);
    expect(subjectKeys).toContain('node:1');
    expect(subjectKeys).not.toContain('node:2');
    expect(subjectKeys).not.toContain('node:3');
    void open;
  });

  it('getIssues — includeClosed and includeDismissed are honored', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    const toClose = await repo.upsertFinding(makeFinding({ subjectKey: 'node:2' }), Date.now());
    const toDismiss = await repo.upsertFinding(makeFinding({ subjectKey: 'node:3' }), Date.now());
    await repo.bumpCleanRun(toClose.issue.id, 1, Date.now());
    await repo.setDismissed(toDismiss.issue.id, true, 1, Date.now());

    const withClosed = await repo.getIssues({ includeClosed: true });
    expect(withClosed.map((i) => i.subjectKey)).toContain('node:2');

    const withDismissed = await repo.getIssues({ includeDismissed: true });
    expect(withDismissed.map((i) => i.subjectKey)).toContain('node:3');

    const withBoth = await repo.getIssues({ includeClosed: true, includeDismissed: true });
    expect(withBoth.map((i) => i.subjectKey)).toEqual(expect.arrayContaining(['node:2', 'node:3']));
  });

  it('deleteAll — removes every row', async () => {
    const backend = getBackend();
    if (!backend.available) {
      console.log(`⚠ Skipped: ${backend.skipReason}`);
      return;
    }

    await repo.upsertFinding(makeFinding({ subjectKey: 'node:1' }), Date.now());
    await repo.upsertFinding(makeFinding({ subjectKey: 'node:2' }), Date.now());
    const deleted = await repo.deleteAll();
    expect(deleted).toBe(2);
    expect(await repo.getIssues({ includeClosed: true, includeDismissed: true })).toHaveLength(0);
  });
}

// --- SQLite Backend ---
describe('MeshIssuesRepository - SQLite Backend', () => {
  let backend: TestBackend;

  beforeEach(() => {
    const t = createTestDb();
    backend = {
      dbType: 'sqlite',
      drizzleDb: t.db,
      exec: async (sql: string) => { t.sqlite.exec(sql); },
      close: async () => { t.close(); },
      available: true,
    };
  });

  afterEach(async () => {
    await backend.close();
  });

  runMeshIssuesTests(() => backend);
});

// --- PostgreSQL Backend ---
describe.skipIf(!postgresAvailable)('MeshIssuesRepository - PostgreSQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createPostgresBackend(POSTGRES_CREATE);
    if (backend.available) {
      console.log('✓ PostgreSQL connection established for mesh issues tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'mesh_issues');
  });

  runMeshIssuesTests(() => backend);
});

// --- MySQL Backend ---
describe.skipIf(!mysqlAvailable)('MeshIssuesRepository - MySQL Backend', () => {
  let backend: TestBackend;

  beforeAll(async () => {
    backend = await createMysqlBackend(MYSQL_CREATE);
    if (backend.available) {
      console.log('✓ MySQL connection established for mesh issues tests');
    } else {
      console.log(`⚠ ${backend.skipReason}`);
    }
  });

  afterAll(async () => {
    if (backend) {
      await backend.close();
    }
  });

  beforeEach(async () => {
    if (!backend.available) return;
    await clearTable(backend, 'mesh_issues');
  });

  runMeshIssuesTests(() => backend);
});
