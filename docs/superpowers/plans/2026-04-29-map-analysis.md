# Map Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `/analysis` workspace that renders a Leaflet map with eight togglable visualization layers (markers, traceroutes, neighbors, heatmap, trails, range rings, hop shading, SNR overlay), a source multi-select, a time-window slider, and an inspector panel — driven by new `/api/analysis/*` endpoints with cursor pagination.

**Architecture:** New page `MapAnalysisPage` mounts at the existing `/analysis` route. A new `analysisRoutes.ts` adds five cross-source endpoints; permissions inherit from the existing `checkPermissionAsync(user.id, resource, 'read', sourceId)` pattern used by `unifiedRoutes.ts`. Layer config lives in `localStorage` (key `mapAnalysis.config.v1`). Each layer has a dedicated React Query hook gated by its `enabled` flag. Lookback (per layer) controls how much history to fetch; the time slider applies a pure client-side window over already-loaded data. Map stack (`react-leaflet`, `MapStyleManager`, custom tilesets) reuses existing components.

**Tech Stack:** TypeScript, React 18, react-leaflet, leaflet.heat, @tanstack/react-query, Express, Drizzle ORM, Vitest, Testing Library, supertest. Backend SQLite/PostgreSQL/MySQL via existing `databaseService` facade.

**Reference spec:** `docs/superpowers/specs/2026-04-29-map-analysis-design.md`

**Testing rules (from CLAUDE.md):**
- Mock `databaseService` with all `Async` methods used by `authMiddleware`
- Coerce `nodeNum` values to `Number()` when comparing across sources (BIGINT in PG/MySQL)
- All new repo methods are async; expose via `DatabaseService` facade with `Async` suffix when touched there
- Run full suite (`npm test`) before commit, not just targeted tests

---

## Phase 1 — Sidebar entry & page shell

### Task 1: Add Map Analysis nav entry to DashboardSidebar

**Files:**
- Modify: `src/components/Dashboard/DashboardSidebar.tsx` (the `dashboard-sidebar-links` block, ~line 340–352)
- Modify: `src/i18n/locales/en/translation.json` (add `source.sidebar.map_analysis` key)

- [ ] **Step 1: Write the failing test**

Append to existing `src/components/Dashboard/DashboardSidebar.test.tsx`:

```tsx
it('renders Map Analysis link below the unified links and navigates to /analysis on click', async () => {
  const navigate = vi.fn();
  vi.mocked(useNavigate).mockReturnValue(navigate);

  renderSidebar(); // existing helper from this file

  const link = await screen.findByRole('button', { name: /map analysis/i });
  expect(link).toBeInTheDocument();

  fireEvent.click(link);
  expect(navigate).toHaveBeenCalledWith('/analysis');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/Dashboard/DashboardSidebar.test.tsx -t "Map Analysis"`
Expected: FAIL — no element matching `/map analysis/i`.

- [ ] **Step 3: Add translation key**

Append to `src/i18n/locales/en/translation.json` inside `source.sidebar`:

```json
"map_analysis": "Map Analysis"
```

- [ ] **Step 4: Add the link in DashboardSidebar.tsx**

Locate the `dashboard-sidebar-links` block (right after the two unified buttons). Add a third button:

```tsx
<button
  className="dashboard-sidebar-link dashboard-sidebar-link--active"
  onClick={() => navigate('/analysis')}
>
  {t('source.sidebar.map_analysis')}
</button>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/components/Dashboard/DashboardSidebar.test.tsx -t "Map Analysis"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/Dashboard/DashboardSidebar.tsx src/components/Dashboard/DashboardSidebar.test.tsx src/i18n/locales/en/translation.json
git commit -m "feat(dashboard): add Map Analysis link to dashboard sidebar"
```

---

### Task 2: Create MapAnalysisPage shell replacing the AnalysisPage placeholder

**Files:**
- Create: `src/pages/MapAnalysisPage.tsx`
- Create: `src/pages/MapAnalysisPage.test.tsx`
- Modify: `src/main.tsx` (replace `<AnalysisPage />` with `<MapAnalysisPage />`)
- Delete (or leave dormant): `src/pages/AnalysisPage.tsx` — kept as a re-export from `MapAnalysisPage` to avoid breaking other imports if any

- [ ] **Step 1: Write the failing test**

Create `src/pages/MapAnalysisPage.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MapAnalysisPage from './MapAnalysisPage';

vi.mock('../components/MapAnalysis/MapAnalysisCanvas', () => ({
  default: () => <div data-testid="map-analysis-canvas" />,
}));
vi.mock('../components/MapAnalysis/MapAnalysisToolbar', () => ({
  default: () => <div data-testid="map-analysis-toolbar" />,
}));
vi.mock('../components/MapAnalysis/AnalysisInspectorPanel', () => ({
  default: () => <div data-testid="analysis-inspector" />,
}));

function renderPage() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/analysis']}>
        <MapAnalysisPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MapAnalysisPage', () => {
  it('renders toolbar, canvas, and inspector', () => {
    renderPage();
    expect(screen.getByTestId('map-analysis-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('map-analysis-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-inspector')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/MapAnalysisPage.test.tsx`
Expected: FAIL — `Cannot find module './MapAnalysisPage'`.

- [ ] **Step 3: Create the page shell**

Create `src/pages/MapAnalysisPage.tsx`:

```tsx
/**
 * MapAnalysisPage — cross-source map workspace with togglable visualization
 * layers, time slider, and node inspector. Public route; data still gated by
 * existing per-source permissions on each /api/analysis/* endpoint.
 */
import { SettingsProvider } from '../contexts/SettingsContext';
import { ToastProvider } from '../components/ToastContainer';
import MapAnalysisToolbar from '../components/MapAnalysis/MapAnalysisToolbar';
import MapAnalysisCanvas from '../components/MapAnalysis/MapAnalysisCanvas';
import AnalysisInspectorPanel from '../components/MapAnalysis/AnalysisInspectorPanel';
import '../styles/map-analysis.css';

export default function MapAnalysisPage() {
  return (
    <ToastProvider>
      <SettingsProvider>
        <div className="map-analysis-page">
          <MapAnalysisToolbar />
          <div className="map-analysis-body">
            <MapAnalysisCanvas />
            <AnalysisInspectorPanel />
          </div>
        </div>
      </SettingsProvider>
    </ToastProvider>
  );
}
```

Create stub components so the import resolves:

`src/components/MapAnalysis/MapAnalysisToolbar.tsx`:
```tsx
export default function MapAnalysisToolbar() {
  return <div className="map-analysis-toolbar">Toolbar</div>;
}
```

`src/components/MapAnalysis/MapAnalysisCanvas.tsx`:
```tsx
export default function MapAnalysisCanvas() {
  return <div className="map-analysis-canvas">Canvas</div>;
}
```

`src/components/MapAnalysis/AnalysisInspectorPanel.tsx`:
```tsx
export default function AnalysisInspectorPanel() {
  return <aside className="map-analysis-inspector">Inspector</aside>;
}
```

Create `src/styles/map-analysis.css`:
```css
.map-analysis-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #111;
  color: #eee;
}
.map-analysis-toolbar {
  flex: 0 0 auto;
  border-bottom: 1px solid #333;
  padding: 8px 12px;
}
.map-analysis-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}
.map-analysis-canvas {
  flex: 1 1 auto;
  position: relative;
}
.map-analysis-inspector {
  flex: 0 0 320px;
  border-left: 1px solid #333;
  overflow: auto;
}
```

- [ ] **Step 4: Wire the route**

In `src/main.tsx`, replace the `AnalysisPage` import + route element:

```tsx
import MapAnalysisPage from './pages/MapAnalysisPage.tsx';
// (remove `import AnalysisPage from './pages/AnalysisPage.tsx';`)
```

```tsx
<Route
  path="analysis"
  element={sharedProviders(<MapAnalysisPage />)}
/>
```

Delete `src/pages/AnalysisPage.tsx`. If grep finds no other importers, the deletion is safe.

```bash
grep -rn "AnalysisPage\|from.*AnalysisPage" src/ --include='*.ts' --include='*.tsx'
```

If grep returns only the now-removed line in `main.tsx`, run `git rm src/pages/AnalysisPage.tsx`. Otherwise, replace its body with `export { default } from './MapAnalysisPage';`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/pages/MapAnalysisPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/MapAnalysisPage.tsx src/pages/MapAnalysisPage.test.tsx \
  src/components/MapAnalysis/ src/styles/map-analysis.css src/main.tsx
git rm src/pages/AnalysisPage.tsx 2>/dev/null || true
git commit -m "feat(analysis): page shell mounted at /analysis"
```

---

## Phase 2 — Backend: analysis repository & first endpoint

### Task 3: Create analysisRepository with getPositionsAcrossSources

**Files:**
- Create: `src/db/repositories/analysis.ts`
- Create: `src/db/repositories/analysis.test.ts`
- Modify: `src/db/repositories/index.ts` (export new repo)

- [ ] **Step 1: Write the failing test**

Create `src/db/repositories/analysis.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { positions, nodes } from '../schema/index.js';
import { AnalysisRepository } from './analysis.js';

describe('AnalysisRepository.getPositions', () => {
  let repo: AnalysisRepository;
  let sqlite: Database.Database;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    // Apply minimal schema (positions + nodes) — replicate columns used here
    sqlite.exec(`
      CREATE TABLE nodes (
        node_num INTEGER NOT NULL,
        node_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        long_name TEXT,
        short_name TEXT,
        PRIMARY KEY (source_id, node_num)
      );
      CREATE TABLE positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_num INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude INTEGER,
        timestamp INTEGER NOT NULL,
        snr REAL,
        rssi INTEGER
      );
    `);

    // Seed
    const now = Date.now();
    sqlite.prepare(
      'INSERT INTO nodes (node_num, node_id, source_id, long_name, short_name) VALUES (?, ?, ?, ?, ?)'
    ).run(1, '!00000001', 'src-a', 'Alpha', 'A');
    sqlite.prepare(
      'INSERT INTO positions (node_num, source_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(1, 'src-a', 30.0, -90.0, now - 1000);
    sqlite.prepare(
      'INSERT INTO positions (node_num, source_id, latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(1, 'src-a', 30.1, -90.1, now);

    repo = new AnalysisRepository(db, 'sqlite');
  });

  it('returns positions across given sources, newest first, paginated', async () => {
    const result = await repo.getPositions({
      sourceIds: ['src-a'],
      sinceMs: Date.now() - 60_000,
      pageSize: 10,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].timestamp).toBeGreaterThan(result.items[1].timestamp);
    expect(result.items[0]).toMatchObject({ sourceId: 'src-a', nodeNum: 1, latitude: 30.1 });
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('honors pageSize and emits a cursor when more rows remain', async () => {
    const result = await repo.getPositions({
      sourceIds: ['src-a'],
      sinceMs: Date.now() - 60_000,
      pageSize: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it('returns no rows when sourceIds is empty', async () => {
    const result = await repo.getPositions({ sourceIds: [], sinceMs: 0, pageSize: 10 });
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/analysis.test.ts`
Expected: FAIL — `Cannot find module './analysis.js'`.

- [ ] **Step 3: Implement AnalysisRepository**

Create `src/db/repositories/analysis.ts`:

```ts
/**
 * Cross-source analysis queries. Each method takes an explicit allow-list of
 * source IDs (already filtered for the user's permissions in the route layer)
 * and a `sinceMs` lower bound. All paginated methods use cursor pagination
 * keyed on (timestamp, id) so concurrent inserts don't shift offsets.
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { and, desc, gte, inArray, lt, or, eq, sql } from 'drizzle-orm';
import { positions } from '../schema/positions.js';

export type DrizzleDb =
  | BetterSQLite3Database
  | NodePgDatabase
  | MySql2Database;

export interface PositionRow {
  id: number;
  nodeNum: number;
  sourceId: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  timestamp: number;
  snr: number | null;
  rssi: number | null;
}

export interface PaginatedPositions {
  items: PositionRow[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface GetPositionsArgs {
  sourceIds: string[];
  sinceMs: number;
  pageSize: number;
  cursor?: string | null;
}

interface Cursor {
  ts: number;
  id: number;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}:${c.id}`, 'utf8').toString('base64url');
}

function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf8');
    const [tsStr, idStr] = decoded.split(':');
    const ts = Number(tsStr);
    const id = Number(idStr);
    if (!Number.isFinite(ts) || !Number.isFinite(id)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

export class AnalysisRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly dbType: 'sqlite' | 'postgres' | 'mysql',
  ) {}

  async getPositions(args: GetPositionsArgs): Promise<PaginatedPositions> {
    const pageSize = Math.max(1, Math.min(args.pageSize, 2000));
    if (args.sourceIds.length === 0) {
      return { items: [], pageSize, hasMore: false, nextCursor: null };
    }

    const cursor = decodeCursor(args.cursor ?? null);
    const conditions = [
      inArray(positions.sourceId, args.sourceIds),
      gte(positions.timestamp, args.sinceMs),
    ];
    if (cursor) {
      // (timestamp DESC, id DESC) → next page starts strictly before the cursor
      conditions.push(
        or(
          lt(positions.timestamp, cursor.ts),
          and(eq(positions.timestamp, cursor.ts), lt(positions.id, cursor.id)),
        )!,
      );
    }

    const rows = await (this.db as any)
      .select({
        id: positions.id,
        nodeNum: positions.nodeNum,
        sourceId: positions.sourceId,
        latitude: positions.latitude,
        longitude: positions.longitude,
        altitude: positions.altitude,
        timestamp: positions.timestamp,
        snr: positions.snr,
        rssi: positions.rssi,
      })
      .from(positions)
      .where(and(...conditions))
      .orderBy(desc(positions.timestamp), desc(positions.id))
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const items: PositionRow[] = rows.slice(0, pageSize).map((r: any) => ({
      ...r,
      nodeNum: Number(r.nodeNum), // BIGINT → number
    }));

    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ ts: last.timestamp, id: last.id })
      : null;

    return { items, pageSize, hasMore, nextCursor };
  }
}
```

- [ ] **Step 4: Export from index**

Append to `src/db/repositories/index.ts`:
```ts
export { AnalysisRepository } from './analysis.js';
export type { PositionRow, PaginatedPositions, GetPositionsArgs } from './analysis.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/db/repositories/analysis.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/analysis.ts src/db/repositories/analysis.test.ts src/db/repositories/index.ts
git commit -m "feat(db): AnalysisRepository.getPositions with cursor pagination"
```

---

### Task 4: Expose AnalysisRepository on DatabaseService facade

**Files:**
- Modify: `src/services/database.ts` (add `analysis` accessor + `getPositionsAcrossSourcesAsync`)

- [ ] **Step 1: Write the failing test**

Create `src/services/database.analysis.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/repositories/analysis.js', () => ({
  AnalysisRepository: vi.fn().mockImplementation(() => ({
    getPositions: vi.fn().mockResolvedValue({
      items: [{ id: 1, nodeNum: 1, sourceId: 's', latitude: 0, longitude: 0, altitude: null, timestamp: 0, snr: null, rssi: null }],
      pageSize: 10,
      hasMore: false,
      nextCursor: null,
    }),
  })),
}));

import databaseService from './database.js';

describe('databaseService.analysis facade', () => {
  it('exposes analysis.getPositions through the facade', async () => {
    expect(databaseService.analysis).toBeDefined();
    const r = await databaseService.analysis.getPositions({ sourceIds: ['s'], sinceMs: 0, pageSize: 10 });
    expect(r.items).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/database.analysis.test.ts`
Expected: FAIL — `databaseService.analysis is undefined`.

- [ ] **Step 3: Wire the repository into DatabaseService**

In `src/services/database.ts`, find the existing repository accessor block (other repos exposed similarly: `messages`, `telemetry`, `sources`, `nodes`). Add:

```ts
import { AnalysisRepository } from '../db/repositories/analysis.js';
```

In the constructor / initializer block where other repos are constructed, add:

```ts
this.analysis = new AnalysisRepository(this.drizzleDb as any, this.drizzleDbType);
```

Add public field declaration:

```ts
public analysis!: AnalysisRepository;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/database.analysis.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/database.ts src/services/database.analysis.test.ts
git commit -m "feat(db): expose AnalysisRepository on DatabaseService facade"
```

---

### Task 5: Create /api/analysis/positions route

**Files:**
- Create: `src/server/routes/analysisRoutes.ts`
- Create: `src/server/routes/analysisRoutes.test.ts`
- Modify: `src/server/server.ts` (mount router)

- [ ] **Step 1: Write the failing test**

Create `src/server/routes/analysisRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { Express } from 'express';
import session from 'express-session';
import request from 'supertest';

vi.mock('../../services/database.js', () => ({
  default: {
    sources: { getAllSources: vi.fn() },
    analysis: { getPositions: vi.fn() },
    checkPermissionAsync: vi.fn(),
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    getUserPermissionSetAsync: vi.fn(),
  },
}));

import analysisRoutes from './analysisRoutes.js';
import databaseService from '../../services/database.js';

const mockDb = databaseService as any;

const adminUser = { id: 1, username: 'admin', isActive: true, isAdmin: true };
const regularUser = { id: 2, username: 'user', isActive: true, isAdmin: false };

const SOURCE_A = { id: 'src-a', name: 'Source A', enabled: true };
const SOURCE_B = { id: 'src-b', name: 'Source B', enabled: true };

function createApp(user: any = null): Express {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false, cookie: { secure: false } }));
  app.use((req: any, _res, next) => {
    if (user) {
      req.session.userId = user.id;
      mockDb.findUserByIdAsync.mockResolvedValue(user);
    }
    next();
  });
  app.use('/', analysisRoutes);
  return app;
}

describe('GET /positions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getPositions.mockResolvedValue({
      items: [], pageSize: 500, hasMore: false, nextCursor: null,
    });
  });

  it('admin: queries all enabled sources', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'] }),
    );
  });

  it('regular user: queries only sources they have nodes:read on', async () => {
    mockDb.checkPermissionAsync.mockImplementation((_uid: number, _r: string, _a: string, sid: string) =>
      Promise.resolve(sid === 'src-a'),
    );
    const app = createApp(regularUser);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a'] }),
    );
  });

  it('intersects requested sources with permitted sources', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(true);
    const app = createApp(regularUser);
    await request(app).get('/positions?sources=src-b&since=0');
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-b'] }),
    );
  });

  it('anonymous: returns empty when no sources are publicly readable', async () => {
    mockDb.checkPermissionAsync.mockResolvedValue(false);
    const app = createApp(null);
    const res = await request(app).get('/positions?since=0');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('clamps pageSize at 2000', async () => {
    const app = createApp(adminUser);
    await request(app).get('/positions?since=0&pageSize=999999');
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 2000 }),
    );
  });

  it('passes through cursor', async () => {
    const app = createApp(adminUser);
    await request(app).get('/positions?since=0&cursor=abc');
    expect(mockDb.analysis.getPositions).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'abc' }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/routes/analysisRoutes.test.ts`
Expected: FAIL — `Cannot find module './analysisRoutes.js'`.

- [ ] **Step 3: Implement the route**

Create `src/server/routes/analysisRoutes.ts`:

```ts
/**
 * Analysis Routes
 *
 * Cross-source endpoints for the /analysis workspace. Each handler:
 *  1. Resolves the requesting user's permitted source IDs (admin = all, else
 *     filtered via checkPermissionAsync(uid, 'nodes', 'read', sourceId)).
 *  2. Intersects with the optional `sources` query param.
 *  3. Delegates to AnalysisRepository which performs the cross-source query
 *     using the resulting allow-list.
 *
 * The page itself is public; data filtering happens here, exactly like
 * unifiedRoutes.ts.
 */
import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';

const router = Router();
router.use(optionalAuth());

async function resolvePermittedSourceIds(req: Request): Promise<string[]> {
  const user = (req as any).user;
  const isAdmin = user?.isAdmin ?? false;
  const allSources = await databaseService.sources.getAllSources();
  const enabled = allSources.filter((s: any) => s.enabled !== false);

  if (isAdmin) return enabled.map((s: any) => s.id);

  const checks = await Promise.all(
    enabled.map(async (s: any) => {
      const ok = user
        ? await databaseService.checkPermissionAsync(user.id, 'nodes', 'read', s.id)
        : await databaseService.checkPermissionAsync(0, 'nodes', 'read', s.id); // anonymous
      return ok ? s.id : null;
    }),
  );
  return checks.filter((id): id is string => id !== null);
}

function parseSourcesParam(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function clampPageSize(raw: unknown): number {
  const n = parseInt(String(raw ?? '500'), 10);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, 2000);
}

function parseSinceMs(raw: unknown): number {
  const n = parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

router.get('/positions', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested
      ? permitted.filter((id) => requested.includes(id))
      : permitted;

    const result = await databaseService.analysis.getPositions({
      sourceIds,
      sinceMs: parseSinceMs(req.query.since),
      pageSize: clampPageSize(req.query.pageSize),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
    });
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/positions:', error);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

export default router;
```

- [ ] **Step 4: Mount the router**

In `src/server/server.ts`, find the block where other route modules are imported (`unifiedRoutes`, `sourceRoutes`, etc.) and add:

```ts
import analysisRoutes from './routes/analysisRoutes.js';
```

Find where other routers are mounted on `apiRouter` (look for `apiRouter.use('/unified', unifiedRoutes)`) and add:

```ts
apiRouter.use('/analysis', analysisRoutes);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/server/routes/analysisRoutes.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/routes/analysisRoutes.ts src/server/routes/analysisRoutes.test.ts src/server/server.ts
git commit -m "feat(api): GET /api/analysis/positions with permission filter + pagination"
```

---

## Phase 3 — Backend: remaining endpoints

### Task 6: Add getTraceroutes to AnalysisRepository + /traceroutes route

**Files:**
- Modify: `src/db/repositories/analysis.ts`, `src/db/repositories/analysis.test.ts`
- Modify: `src/server/routes/analysisRoutes.ts`, `src/server/routes/analysisRoutes.test.ts`

- [ ] **Step 1: Write the failing repository test**

Append to `src/db/repositories/analysis.test.ts`:

```ts
describe('AnalysisRepository.getTraceroutes', () => {
  let repo: AnalysisRepository;
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE traceroutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_node_num INTEGER NOT NULL,
        to_node_num INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        route TEXT,
        route_back TEXT,
        snr_towards TEXT,
        snr_back TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    sqlite.prepare(
      'INSERT INTO traceroutes (from_node_num, to_node_num, source_id, route, route_back, snr_towards, snr_back, timestamp, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(1, 2, 'src-a', '[]', '[]', '[10]', '[12]', now, now);
    repo = new AnalysisRepository(db, 'sqlite');
  });

  it('returns traceroutes for given sources, newest first', async () => {
    const r = await repo.getTraceroutes({ sourceIds: ['src-a'], sinceMs: 0, pageSize: 10 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ fromNodeNum: 1, toNodeNum: 2, sourceId: 'src-a' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/db/repositories/analysis.test.ts -t "getTraceroutes"`
Expected: FAIL — `getTraceroutes is not a function`.

- [ ] **Step 3: Implement getTraceroutes**

Append to `src/db/repositories/analysis.ts`:

```ts
import { traceroutes } from '../schema/traceroutes.js';

export interface TracerouteRow {
  id: number;
  fromNodeNum: number;
  toNodeNum: number;
  sourceId: string;
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  timestamp: number;
  createdAt: number;
}

export interface PaginatedTraceroutes {
  items: TracerouteRow[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}
```

Add method on the class:

```ts
async getTraceroutes(args: GetPositionsArgs): Promise<PaginatedTraceroutes> {
  const pageSize = Math.max(1, Math.min(args.pageSize, 2000));
  if (args.sourceIds.length === 0) {
    return { items: [], pageSize, hasMore: false, nextCursor: null };
  }
  const cursor = decodeCursor(args.cursor ?? null);
  const conditions = [
    inArray(traceroutes.sourceId, args.sourceIds),
    gte(traceroutes.timestamp, args.sinceMs),
  ];
  if (cursor) {
    conditions.push(
      or(
        lt(traceroutes.timestamp, cursor.ts),
        and(eq(traceroutes.timestamp, cursor.ts), lt(traceroutes.id, cursor.id)),
      )!,
    );
  }
  const rows = await (this.db as any)
    .select({
      id: traceroutes.id,
      fromNodeNum: traceroutes.fromNodeNum,
      toNodeNum: traceroutes.toNodeNum,
      sourceId: traceroutes.sourceId,
      route: traceroutes.route,
      routeBack: traceroutes.routeBack,
      snrTowards: traceroutes.snrTowards,
      snrBack: traceroutes.snrBack,
      timestamp: traceroutes.timestamp,
      createdAt: traceroutes.createdAt,
    })
    .from(traceroutes)
    .where(and(...conditions))
    .orderBy(desc(traceroutes.timestamp), desc(traceroutes.id))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const items: TracerouteRow[] = rows.slice(0, pageSize).map((r: any) => ({
    ...r,
    fromNodeNum: Number(r.fromNodeNum),
    toNodeNum: Number(r.toNodeNum),
  }));
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ ts: last.timestamp, id: last.id }) : null;
  return { items, pageSize, hasMore, nextCursor };
}
```

- [ ] **Step 4: Add the /traceroutes route + route test**

Append to `src/server/routes/analysisRoutes.test.ts`:

```ts
describe('GET /traceroutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getTraceroutes = vi.fn().mockResolvedValue({
      items: [], pageSize: 500, hasMore: false, nextCursor: null,
    });
  });

  it('admin queries all enabled sources', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/traceroutes?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getTraceroutes).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'] }),
    );
  });
});
```

Append to `src/server/routes/analysisRoutes.ts`:

```ts
router.get('/traceroutes', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested ? permitted.filter((id) => requested.includes(id)) : permitted;
    const result = await databaseService.analysis.getTraceroutes({
      sourceIds,
      sinceMs: parseSinceMs(req.query.since),
      pageSize: clampPageSize(req.query.pageSize),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : null,
    });
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/traceroutes:', error);
    res.status(500).json({ error: 'Failed to fetch traceroutes' });
  }
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/db/repositories/analysis.test.ts src/server/routes/analysisRoutes.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/repositories/analysis.ts src/db/repositories/analysis.test.ts \
  src/server/routes/analysisRoutes.ts src/server/routes/analysisRoutes.test.ts
git commit -m "feat(api): GET /api/analysis/traceroutes"
```

---

### Task 7: Add /neighbors endpoint

**Files:** Same as Task 6, plus repo + route additions.

- [ ] **Step 1: Repo test**

Append to `src/db/repositories/analysis.test.ts`:

```ts
describe('AnalysisRepository.getNeighbors', () => {
  it('returns neighbor edges for given sources within sinceMs', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE neighbor_info (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_num INTEGER NOT NULL,
        neighbor_num INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        snr REAL,
        timestamp INTEGER NOT NULL
      );
    `);
    sqlite.prepare(
      'INSERT INTO neighbor_info (node_num, neighbor_num, source_id, snr, timestamp) VALUES (?,?,?,?,?)'
    ).run(1, 2, 'src-a', 5.5, Date.now());
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getNeighbors({ sourceIds: ['src-a'], sinceMs: 0 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ nodeNum: 1, neighborNum: 2, snr: 5.5 });
  });
});
```

- [ ] **Step 2: Run, fail, implement**

Run: `npx vitest run src/db/repositories/analysis.test.ts -t getNeighbors` → expect FAIL.

Append to `src/db/repositories/analysis.ts`:

```ts
import { neighborInfo } from '../schema/neighborInfo.js';

export interface NeighborRow {
  id: number;
  nodeNum: number;
  neighborNum: number;
  sourceId: string;
  snr: number | null;
  timestamp: number;
}
export interface NeighborsResult { items: NeighborRow[]; }
export interface GetNeighborsArgs { sourceIds: string[]; sinceMs: number; }
```

Method:
```ts
async getNeighbors(args: GetNeighborsArgs): Promise<NeighborsResult> {
  if (args.sourceIds.length === 0) return { items: [] };
  const rows = await (this.db as any)
    .select({
      id: neighborInfo.id,
      nodeNum: neighborInfo.nodeNum,
      neighborNum: neighborInfo.neighborNum,
      sourceId: neighborInfo.sourceId,
      snr: neighborInfo.snr,
      timestamp: neighborInfo.timestamp,
    })
    .from(neighborInfo)
    .where(and(
      inArray(neighborInfo.sourceId, args.sourceIds),
      gte(neighborInfo.timestamp, args.sinceMs),
    ));
  return {
    items: rows.map((r: any) => ({
      ...r,
      nodeNum: Number(r.nodeNum),
      neighborNum: Number(r.neighborNum),
    })),
  };
}
```

- [ ] **Step 3: Add route + test**

Append to `analysisRoutes.test.ts`:
```ts
describe('GET /neighbors', () => {
  it('admin: returns merged neighbors across all sources', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getNeighbors = vi.fn().mockResolvedValue({ items: [] });
    const app = createApp(adminUser);
    const res = await request(app).get('/neighbors?since=0');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getNeighbors).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'] }),
    );
  });
});
```

Append to `analysisRoutes.ts`:
```ts
router.get('/neighbors', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested ? permitted.filter((id) => requested.includes(id)) : permitted;
    const result = await databaseService.analysis.getNeighbors({
      sourceIds,
      sinceMs: parseSinceMs(req.query.since),
    });
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/neighbors:', error);
    res.status(500).json({ error: 'Failed to fetch neighbors' });
  }
});
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src/db/repositories/analysis.test.ts src/server/routes/analysisRoutes.test.ts
git add -u src/db/repositories/analysis.ts src/db/repositories/analysis.test.ts \
  src/server/routes/analysisRoutes.ts src/server/routes/analysisRoutes.test.ts
git commit -m "feat(api): GET /api/analysis/neighbors"
```

---

### Task 8: Add /coverage-grid endpoint

The coverage-grid endpoint server-side bins position fixes into `(zoom, latBin, lonBin)` cells with a 5-minute in-memory cache. Reuses `getPositions` then groups in-process; no database-specific binning required for v1.

**Files:** Same as Task 7.

- [ ] **Step 1: Repo test**

Append to `src/db/repositories/analysis.test.ts`:

```ts
describe('AnalysisRepository.getCoverageGrid', () => {
  it('bins positions into lat/lon cells with intensity', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_num INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude INTEGER,
        timestamp INTEGER NOT NULL,
        snr REAL,
        rssi INTEGER
      );
    `);
    const insert = sqlite.prepare(
      'INSERT INTO positions (node_num, source_id, latitude, longitude, timestamp) VALUES (?,?,?,?,?)'
    );
    // 3 fixes in same cell at (30.001..30.002, -90.001..-90.002), 1 fix far away
    insert.run(1, 'src-a', 30.001, -90.001, Date.now());
    insert.run(1, 'src-a', 30.002, -90.002, Date.now());
    insert.run(2, 'src-a', 30.0015, -90.0015, Date.now());
    insert.run(3, 'src-a', 31.5, -89.0, Date.now());
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getCoverageGrid({ sourceIds: ['src-a'], sinceMs: 0, zoom: 12 });
    expect(r.cells.length).toBeGreaterThanOrEqual(2);
    const hot = r.cells.find((c) => c.count >= 3);
    expect(hot).toBeDefined();
  });
});
```

- [ ] **Step 2: Implement getCoverageGrid**

Append to `src/db/repositories/analysis.ts`:

```ts
export interface GridCell {
  latBin: number;
  lonBin: number;
  centerLat: number;
  centerLon: number;
  count: number;
}
export interface CoverageGridResult { cells: GridCell[]; binSizeDeg: number; }
export interface GetCoverageGridArgs { sourceIds: string[]; sinceMs: number; zoom: number; }

function binSizeForZoom(zoom: number): number {
  // Lower zoom → larger bins. Roughly 0.5° at z=8 → 0.001° at z=18.
  const z = Math.max(1, Math.min(20, zoom));
  return Math.pow(2, 8 - z) * 0.01;
}
```

Method:
```ts
async getCoverageGrid(args: GetCoverageGridArgs): Promise<CoverageGridResult> {
  if (args.sourceIds.length === 0) return { cells: [], binSizeDeg: binSizeForZoom(args.zoom) };
  const binSize = binSizeForZoom(args.zoom);
  const rows = await (this.db as any)
    .select({
      latitude: positions.latitude,
      longitude: positions.longitude,
    })
    .from(positions)
    .where(and(
      inArray(positions.sourceId, args.sourceIds),
      gte(positions.timestamp, args.sinceMs),
    ));

  const cellMap = new Map<string, GridCell>();
  for (const r of rows as Array<{ latitude: number; longitude: number }>) {
    const latBin = Math.floor(r.latitude / binSize);
    const lonBin = Math.floor(r.longitude / binSize);
    const key = `${latBin}:${lonBin}`;
    let cell = cellMap.get(key);
    if (!cell) {
      cell = {
        latBin, lonBin,
        centerLat: latBin * binSize + binSize / 2,
        centerLon: lonBin * binSize + binSize / 2,
        count: 0,
      };
      cellMap.set(key, cell);
    }
    cell.count++;
  }
  return { cells: Array.from(cellMap.values()), binSizeDeg: binSize };
}
```

- [ ] **Step 3: Add cached route + test**

Append to `src/server/routes/analysisRoutes.ts`:

```ts
const coverageCache = new Map<string, { at: number; data: any }>();
const COVERAGE_TTL_MS = 5 * 60_000;

router.get('/coverage-grid', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested ? permitted.filter((id) => requested.includes(id)) : permitted;
    const sinceMs = parseSinceMs(req.query.since);
    const zoom = parseInt(String(req.query.zoom ?? '12'), 10) || 12;

    const key = `${sourceIds.sort().join(',')}|${sinceMs}|${zoom}`;
    const cached = coverageCache.get(key);
    if (cached && Date.now() - cached.at < COVERAGE_TTL_MS) {
      return res.json(cached.data);
    }
    const result = await databaseService.analysis.getCoverageGrid({ sourceIds, sinceMs, zoom });
    coverageCache.set(key, { at: Date.now(), data: result });
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/coverage-grid:', error);
    res.status(500).json({ error: 'Failed to fetch coverage grid' });
  }
});
```

Append to `analysisRoutes.test.ts`:

```ts
describe('GET /coverage-grid', () => {
  it('returns cached result on second hit within TTL', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A]);
    mockDb.analysis.getCoverageGrid = vi.fn().mockResolvedValue({ cells: [], binSizeDeg: 0.01 });
    const app = createApp(adminUser);
    await request(app).get('/coverage-grid?since=0&zoom=12');
    await request(app).get('/coverage-grid?since=0&zoom=12');
    expect(mockDb.analysis.getCoverageGrid).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src/db/repositories/analysis.test.ts src/server/routes/analysisRoutes.test.ts
git add -u
git commit -m "feat(api): GET /api/analysis/coverage-grid with 5-min cache"
```

---

### Task 9: Add /hop-counts endpoint

Hop count = path length from each source's local node to a given node, computed from the most recent traceroute reaching that node. If no traceroute reaches it, hop count is `null`.

**Files:** Same as Task 8.

- [ ] **Step 1: Repo test**

Append to `analysis.test.ts`:

```ts
describe('AnalysisRepository.getHopCounts', () => {
  it('returns hop count per (sourceId, nodeNum) from latest traceroute', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE traceroutes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_node_num INTEGER NOT NULL,
        to_node_num INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        route TEXT,
        timestamp INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    sqlite.prepare(
      'INSERT INTO traceroutes (from_node_num, to_node_num, source_id, route, timestamp) VALUES (?,?,?,?,?)'
    ).run(1, 99, 'src-a', '[10,20]', now);
    const repo = new AnalysisRepository(db, 'sqlite');
    const r = await repo.getHopCounts({ sourceIds: ['src-a'] });
    const hop = r.entries.find((e) => e.nodeNum === 99 && e.sourceId === 'src-a');
    expect(hop?.hops).toBe(2);
  });
});
```

- [ ] **Step 2: Implement getHopCounts**

Append to `analysis.ts`:

```ts
export interface HopEntry { sourceId: string; nodeNum: number; hops: number; }
export interface HopCountsResult { entries: HopEntry[]; }
```

Method:
```ts
async getHopCounts(args: { sourceIds: string[] }): Promise<HopCountsResult> {
  if (args.sourceIds.length === 0) return { entries: [] };
  const rows = await (this.db as any)
    .select({
      sourceId: traceroutes.sourceId,
      toNodeNum: traceroutes.toNodeNum,
      route: traceroutes.route,
      timestamp: traceroutes.timestamp,
    })
    .from(traceroutes)
    .where(inArray(traceroutes.sourceId, args.sourceIds))
    .orderBy(desc(traceroutes.timestamp));

  const seen = new Map<string, HopEntry>();
  for (const r of rows as Array<{ sourceId: string; toNodeNum: number | bigint; route: string | null }>) {
    const nodeNum = Number(r.toNodeNum);
    const key = `${r.sourceId}:${nodeNum}`;
    if (seen.has(key)) continue;
    let hops = 0;
    try {
      const arr = JSON.parse(r.route ?? '[]');
      hops = Array.isArray(arr) ? arr.length : 0;
    } catch {
      hops = 0;
    }
    seen.set(key, { sourceId: r.sourceId, nodeNum, hops });
  }
  return { entries: Array.from(seen.values()) };
}
```

- [ ] **Step 3: Add route + test**

Append to `analysisRoutes.ts`:

```ts
router.get('/hop-counts', async (req: Request, res: Response) => {
  try {
    const permitted = await resolvePermittedSourceIds(req);
    const requested = parseSourcesParam(req.query.sources);
    const sourceIds = requested ? permitted.filter((id) => requested.includes(id)) : permitted;
    const result = await databaseService.analysis.getHopCounts({ sourceIds });
    res.json(result);
  } catch (error) {
    logger.error('Error in GET /api/analysis/hop-counts:', error);
    res.status(500).json({ error: 'Failed to fetch hop counts' });
  }
});
```

Append to `analysisRoutes.test.ts`:
```ts
describe('GET /hop-counts', () => {
  it('admin: queries all enabled sources', async () => {
    mockDb.sources.getAllSources.mockResolvedValue([SOURCE_A, SOURCE_B]);
    mockDb.analysis.getHopCounts = vi.fn().mockResolvedValue({ entries: [] });
    const app = createApp(adminUser);
    const res = await request(app).get('/hop-counts');
    expect(res.status).toBe(200);
    expect(mockDb.analysis.getHopCounts).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: ['src-a', 'src-b'] }),
    );
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src/db/repositories/analysis.test.ts src/server/routes/analysisRoutes.test.ts
git add -u
git commit -m "feat(api): GET /api/analysis/hop-counts"
```

---

## Phase 4 — Frontend: config + data hooks

### Task 10: useMapAnalysisConfig — localStorage-backed layer config

**Files:**
- Create: `src/hooks/useMapAnalysisConfig.ts`
- Create: `src/hooks/useMapAnalysisConfig.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useMapAnalysisConfig.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMapAnalysisConfig, DEFAULT_CONFIG } from './useMapAnalysisConfig';

const KEY = 'mapAnalysis.config.v1';

describe('useMapAnalysisConfig', () => {
  beforeEach(() => localStorage.clear());

  it('returns DEFAULT_CONFIG when no stored value', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config).toEqual(DEFAULT_CONFIG);
  });

  it('toggles a layer and persists to localStorage', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setLayerEnabled('markers', false));
    expect(result.current.config.layers.markers.enabled).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY)!).layers.markers.enabled).toBe(false);
  });

  it('updates layer lookback and persists', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setLayerLookback('trails', 168));
    expect(result.current.config.layers.trails.lookbackHours).toBe(168);
  });

  it('updates selected sources', () => {
    const { result } = renderHook(() => useMapAnalysisConfig());
    act(() => result.current.setSources(['src-a', 'src-b']));
    expect(result.current.config.sources).toEqual(['src-a', 'src-b']);
  });

  it('survives malformed localStorage by falling back to defaults', () => {
    localStorage.setItem(KEY, '{not json');
    const { result } = renderHook(() => useMapAnalysisConfig());
    expect(result.current.config).toEqual(DEFAULT_CONFIG);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useMapAnalysisConfig.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useMapAnalysisConfig.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';

export type LayerKey =
  | 'markers'
  | 'traceroutes'
  | 'neighbors'
  | 'heatmap'
  | 'trails'
  | 'rangeRings'
  | 'hopShading'
  | 'snrOverlay';

export interface LayerConfig {
  enabled: boolean;
  lookbackHours: number | null; // null = current state, no time window
  /** Layer-specific options stashed under `options`. */
  options?: Record<string, unknown>;
}

export interface MapAnalysisConfig {
  version: 1;
  layers: Record<LayerKey, LayerConfig>;
  sources: string[]; // empty array = "all"
  timeSlider: {
    enabled: boolean;
    windowStartMs?: number;
    windowEndMs?: number;
  };
  inspectorOpen: boolean;
}

export const DEFAULT_CONFIG: MapAnalysisConfig = {
  version: 1,
  layers: {
    markers:    { enabled: true,  lookbackHours: null },
    traceroutes:{ enabled: false, lookbackHours: 24 },
    neighbors:  { enabled: false, lookbackHours: 24 },
    heatmap:    { enabled: false, lookbackHours: 24 },
    trails:     { enabled: false, lookbackHours: 24 },
    rangeRings: { enabled: false, lookbackHours: null, options: { radiusKm: 5 } },
    hopShading: { enabled: false, lookbackHours: null },
    snrOverlay: { enabled: false, lookbackHours: 24 },
  },
  sources: [],
  timeSlider: { enabled: false },
  inspectorOpen: true,
};

const STORAGE_KEY = 'mapAnalysis.config.v1';

function load(): MapAnalysisConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1) return DEFAULT_CONFIG;
    // Shallow-merge layers so a newly-added LayerKey gets its default
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      layers: { ...DEFAULT_CONFIG.layers, ...(parsed.layers ?? {}) },
      timeSlider: { ...DEFAULT_CONFIG.timeSlider, ...(parsed.timeSlider ?? {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function save(config: MapAnalysisConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* quota */ }
}

export function useMapAnalysisConfig() {
  const [config, setConfig] = useState<MapAnalysisConfig>(load);

  useEffect(() => { save(config); }, [config]);

  const setLayerEnabled = useCallback((layer: LayerKey, enabled: boolean) => {
    setConfig((prev) => ({
      ...prev,
      layers: { ...prev.layers, [layer]: { ...prev.layers[layer], enabled } },
    }));
  }, []);

  const setLayerLookback = useCallback((layer: LayerKey, hours: number | null) => {
    setConfig((prev) => ({
      ...prev,
      layers: { ...prev.layers, [layer]: { ...prev.layers[layer], lookbackHours: hours } },
    }));
  }, []);

  const setLayerOptions = useCallback((layer: LayerKey, options: Record<string, unknown>) => {
    setConfig((prev) => ({
      ...prev,
      layers: {
        ...prev.layers,
        [layer]: { ...prev.layers[layer], options: { ...prev.layers[layer].options, ...options } },
      },
    }));
  }, []);

  const setSources = useCallback((sources: string[]) => {
    setConfig((prev) => ({ ...prev, sources }));
  }, []);

  const setTimeSlider = useCallback((ts: Partial<MapAnalysisConfig['timeSlider']>) => {
    setConfig((prev) => ({ ...prev, timeSlider: { ...prev.timeSlider, ...ts } }));
  }, []);

  const setInspectorOpen = useCallback((open: boolean) => {
    setConfig((prev) => ({ ...prev, inspectorOpen: open }));
  }, []);

  const reset = useCallback(() => setConfig(DEFAULT_CONFIG), []);

  return {
    config,
    setLayerEnabled,
    setLayerLookback,
    setLayerOptions,
    setSources,
    setTimeSlider,
    setInspectorOpen,
    reset,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useMapAnalysisConfig.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMapAnalysisConfig.ts src/hooks/useMapAnalysisConfig.test.ts
git commit -m "feat(analysis): localStorage-backed layer config hook"
```

---

### Task 11: useMapAnalysisData — paginated React Query hooks per layer

**Files:**
- Create: `src/hooks/useMapAnalysisData.ts`
- Create: `src/hooks/useMapAnalysisData.test.ts`
- Create: `src/services/analysisApi.ts` (thin fetch wrappers)

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useMapAnalysisData.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { usePositions } from './useMapAnalysisData';
import * as api from '../services/analysisApi';

vi.mock('../services/analysisApi');

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('usePositions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT fetch when disabled', () => {
    vi.mocked(api.fetchPositionsPage).mockResolvedValue({ items: [], pageSize: 500, hasMore: false, nextCursor: null });
    renderHook(() => usePositions({ enabled: false, sources: [], lookbackHours: 24 }), { wrapper });
    expect(api.fetchPositionsPage).not.toHaveBeenCalled();
  });

  it('aggregates pages across multiple fetches', async () => {
    vi.mocked(api.fetchPositionsPage)
      .mockResolvedValueOnce({ items: [{ id: 1 } as any], pageSize: 1, hasMore: true, nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [{ id: 2 } as any], pageSize: 1, hasMore: false, nextCursor: null });
    const { result } = renderHook(
      () => usePositions({ enabled: true, sources: ['s'], lookbackHours: 24 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.progress.percent).toBe(100);
    expect(result.current.isLoading).toBe(false);
  });

  it('reports progress percent during pagination', async () => {
    vi.mocked(api.fetchPositionsPage).mockResolvedValueOnce({
      items: [{ id: 1 } as any], pageSize: 1, hasMore: true, nextCursor: 'c1',
    });
    const { result } = renderHook(
      () => usePositions({ enabled: true, sources: ['s'], lookbackHours: 24 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBeGreaterThan(0));
    expect(result.current.progress.percent).toBeLessThan(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useMapAnalysisData.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the API client**

Create `src/services/analysisApi.ts`:

```ts
import { api } from './api';

export interface Paginated<T> {
  items: T[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

interface FetchArgs {
  sources: string[];
  sinceMs: number;
  pageSize?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

function buildQuery({ sources, sinceMs, pageSize, cursor }: FetchArgs): string {
  const p = new URLSearchParams();
  if (sources.length) p.set('sources', sources.join(','));
  p.set('since', String(sinceMs));
  if (pageSize) p.set('pageSize', String(pageSize));
  if (cursor) p.set('cursor', cursor);
  return p.toString();
}

export async function fetchPositionsPage(args: FetchArgs): Promise<Paginated<any>> {
  return api.get(`/api/analysis/positions?${buildQuery(args)}`, { signal: args.signal });
}
export async function fetchTraceroutesPage(args: FetchArgs): Promise<Paginated<any>> {
  return api.get(`/api/analysis/traceroutes?${buildQuery(args)}`, { signal: args.signal });
}
export async function fetchNeighbors(args: Omit<FetchArgs, 'pageSize' | 'cursor'>): Promise<{ items: any[] }> {
  return api.get(`/api/analysis/neighbors?${buildQuery({ ...args, pageSize: undefined, cursor: null })}`, { signal: args.signal });
}
export async function fetchCoverageGrid(args: Omit<FetchArgs, 'pageSize' | 'cursor'> & { zoom: number }): Promise<{ cells: any[]; binSizeDeg: number }> {
  const p = new URLSearchParams();
  if (args.sources.length) p.set('sources', args.sources.join(','));
  p.set('since', String(args.sinceMs));
  p.set('zoom', String(args.zoom));
  return api.get(`/api/analysis/coverage-grid?${p.toString()}`, { signal: args.signal });
}
export async function fetchHopCounts(args: { sources: string[]; signal?: AbortSignal }): Promise<{ entries: any[] }> {
  const p = new URLSearchParams();
  if (args.sources.length) p.set('sources', args.sources.join(','));
  return api.get(`/api/analysis/hop-counts?${p.toString()}`, { signal: args.signal });
}
```

> Note: confirm the existing `services/api.ts` exports a `get(path, opts)` helper. If it exposes a different shape (e.g. `authFetch`), swap to that. The test mocks the module so the production API surface is the only place the choice matters.

- [ ] **Step 4: Implement the hooks**

Create `src/hooks/useMapAnalysisData.ts`:

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchPositionsPage,
  fetchTraceroutesPage,
  fetchNeighbors,
  fetchCoverageGrid,
  fetchHopCounts,
} from '../services/analysisApi';

interface PaginatedHookArgs {
  enabled: boolean;
  sources: string[];
  lookbackHours: number;
}

export interface PaginatedHookResult<T> {
  items: T[];
  isLoading: boolean;
  isError: boolean;
  progress: { loaded: number; estimatedTotal: number | null; percent: number };
  error: Error | null;
}

const PAGE_SIZE = 500;

function lookbackToSinceMs(hours: number): number {
  return hours <= 0 ? 0 : Date.now() - hours * 3_600_000;
}

/**
 * Aggregates all pages of a paginated /analysis/* endpoint into a single
 * flat array. Re-runs from scratch on `enabled`/`sources`/`lookbackHours`
 * change. Internal cursor state is held outside React Query because each
 * page's cursor is an input to the next.
 */
function useAggregatedPaginated<T>(
  key: readonly unknown[],
  fetchPage: (args: { sources: string[]; sinceMs: number; pageSize: number; cursor: string | null }) => Promise<{ items: T[]; hasMore: boolean; nextCursor: string | null }>,
  args: PaginatedHookArgs,
): PaginatedHookResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  const sinceMs = useMemo(() => lookbackToSinceMs(args.lookbackHours), [args.lookbackHours]);
  // Stable string for the dependency array
  const argsKey = useMemo(
    () => JSON.stringify([args.enabled, args.sources, args.lookbackHours, ...key]),
    [args.enabled, args.sources, args.lookbackHours, key],
  );

  useEffect(() => {
    if (!args.enabled || args.sources.length === 0) {
      setItems([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    cancelRef.current?.abort();
    const ctrl = new AbortController();
    cancelRef.current = ctrl;

    setItems([]);
    setIsLoading(true);
    setError(null);
    let cursor: string | null = null;
    let acc: T[] = [];

    (async () => {
      try {
        do {
          const res = await fetchPage({ sources: args.sources, sinceMs, pageSize: PAGE_SIZE, cursor });
          if (ctrl.signal.aborted) return;
          acc = acc.concat(res.items);
          setItems([...acc]);
          cursor = res.hasMore ? res.nextCursor : null;
        } while (cursor && !ctrl.signal.aborted);
        if (!ctrl.signal.aborted) setIsLoading(false);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setError(e as Error);
        setIsLoading(false);
      }
    })();

    return () => ctrl.abort();
  }, [argsKey, sinceMs]);

  // We don't know the true total without an extra count query; estimate as
  // (loaded + 1 page) while still paginating. Once `isLoading` flips false we
  // know we've exhausted pages and can report 100%.
  const progress = useMemo(() => {
    if (!isLoading) return { loaded: items.length, estimatedTotal: items.length, percent: 100 };
    const estimatedTotal = items.length + PAGE_SIZE;
    return {
      loaded: items.length,
      estimatedTotal,
      percent: Math.min(99, Math.round((items.length / estimatedTotal) * 100)),
    };
  }, [items, isLoading]);

  return { items, isLoading, isError: error !== null, error, progress };
}

export function usePositions(args: PaginatedHookArgs) {
  return useAggregatedPaginated(['positions'], fetchPositionsPage, args);
}
export function useTraceroutes(args: PaginatedHookArgs) {
  return useAggregatedPaginated(['traceroutes'], fetchTraceroutesPage, args);
}

export function useNeighbors(args: PaginatedHookArgs) {
  return useQuery({
    queryKey: ['analysis', 'neighbors', args.sources, args.lookbackHours],
    enabled: args.enabled && args.sources.length > 0,
    queryFn: ({ signal }) => fetchNeighbors({
      sources: args.sources,
      sinceMs: lookbackToSinceMs(args.lookbackHours),
      signal,
    }),
    keepPreviousData: true,
  });
}

export function useCoverageGrid(args: PaginatedHookArgs & { zoom: number }) {
  return useQuery({
    queryKey: ['analysis', 'coverage', args.sources, args.lookbackHours, args.zoom],
    enabled: args.enabled && args.sources.length > 0,
    queryFn: ({ signal }) => fetchCoverageGrid({
      sources: args.sources,
      sinceMs: lookbackToSinceMs(args.lookbackHours),
      zoom: args.zoom,
      signal,
    }),
    keepPreviousData: true,
  });
}

export function useHopCounts(args: { enabled: boolean; sources: string[] }) {
  return useQuery({
    queryKey: ['analysis', 'hopCounts', args.sources],
    enabled: args.enabled && args.sources.length > 0,
    queryFn: ({ signal }) => fetchHopCounts({ sources: args.sources, signal }),
    keepPreviousData: true,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/hooks/useMapAnalysisData.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useMapAnalysisData.ts src/hooks/useMapAnalysisData.test.ts src/services/analysisApi.ts
git commit -m "feat(analysis): React Query hooks for paginated analysis endpoints"
```

---

## Phase 5 — Frontend: toolbar, source filter, map canvas

### Task 12: SourceMultiSelect

**Files:**
- Create: `src/components/MapAnalysis/SourceMultiSelect.tsx`
- Create: `src/components/MapAnalysis/SourceMultiSelect.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SourceMultiSelect from './SourceMultiSelect';

const sources = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
];

describe('SourceMultiSelect', () => {
  it('shows "All sources (N)" when value is empty', () => {
    render(<SourceMultiSelect sources={sources} value={[]} onChange={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent(/all sources \(3\)/i);
  });

  it('shows count when sources are selected', () => {
    render(<SourceMultiSelect sources={sources} value={['a', 'b']} onChange={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent(/2 sources/i);
  });

  it('toggles a source on checkbox click', () => {
    const onChange = vi.fn();
    render(<SourceMultiSelect sources={sources} value={['a']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByLabelText('B'));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/MapAnalysis/SourceMultiSelect.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/components/MapAnalysis/SourceMultiSelect.tsx`:

```tsx
import { useState } from 'react';

export interface SourceMultiSelectProps {
  sources: Array<{ id: string; name: string }>;
  value: string[];
  onChange: (next: string[]) => void;
}

export default function SourceMultiSelect({ sources, value, onChange }: SourceMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const label = value.length === 0
    ? `All sources (${sources.length})`
    : `${value.length} sources`;

  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div className="map-analysis-source-select">
      <button type="button" onClick={() => setOpen((o) => !o)} className="map-analysis-pill">
        {label}
      </button>
      {open && (
        <div className="map-analysis-source-popover" role="dialog">
          {sources.map((s) => (
            <label key={s.id} className="map-analysis-source-row">
              <input
                type="checkbox"
                checked={value.includes(s.id)}
                onChange={() => toggle(s.id)}
              />
              {s.name}
            </label>
          ))}
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])}>Clear</button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/MapAnalysis/SourceMultiSelect.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/MapAnalysis/SourceMultiSelect.tsx src/components/MapAnalysis/SourceMultiSelect.test.tsx
git commit -m "feat(analysis): SourceMultiSelect component"
```

---

### Task 13: LayerToggleButton

**Files:**
- Create: `src/components/MapAnalysis/LayerToggleButton.tsx`
- Create: `src/components/MapAnalysis/LayerToggleButton.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LayerToggleButton from './LayerToggleButton';

describe('LayerToggleButton', () => {
  it('renders label and active class when enabled', () => {
    render(
      <LayerToggleButton
        label="Markers"
        enabled={true}
        onToggle={() => {}}
        lookbackHours={24}
        lookbackOptions={[1, 24, 168]}
        onLookbackChange={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /markers/i });
    expect(btn.className).toMatch(/active/);
  });

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(
      <LayerToggleButton label="X" enabled={false} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /x/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('opens popover with lookback options when chevron clicked', () => {
    render(
      <LayerToggleButton
        label="Trails"
        enabled={true}
        onToggle={() => {}}
        lookbackHours={24}
        lookbackOptions={[1, 24, 168]}
        onLookbackChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText(/configure trails/i));
    expect(screen.getByText('1h')).toBeInTheDocument();
    expect(screen.getByText('168h')).toBeInTheDocument();
  });

  it('shows spinner badge when loading', () => {
    render(
      <LayerToggleButton label="X" enabled={true} onToggle={() => {}} loading={true} />,
    );
    expect(screen.getByTestId('layer-spinner')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/MapAnalysis/LayerToggleButton.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/components/MapAnalysis/LayerToggleButton.tsx`:

```tsx
import { useState } from 'react';

export interface LayerToggleButtonProps {
  label: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  lookbackHours?: number | null;
  lookbackOptions?: number[];
  onLookbackChange?: (h: number | null) => void;
  loading?: boolean;
  errored?: boolean;
}

export default function LayerToggleButton({
  label,
  enabled,
  onToggle,
  lookbackHours,
  lookbackOptions,
  onLookbackChange,
  loading,
  errored,
}: LayerToggleButtonProps) {
  const [popOpen, setPopOpen] = useState(false);
  const showChevron = !!lookbackOptions && !!onLookbackChange;

  return (
    <div className={`map-analysis-layer-btn-wrap ${errored ? 'errored' : ''}`}>
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        className={`map-analysis-layer-btn ${enabled ? 'active' : ''}`}
      >
        {label}
        {loading && <span className="map-analysis-layer-spinner" data-testid="layer-spinner" />}
      </button>
      {showChevron && (
        <button
          type="button"
          aria-label={`Configure ${label}`}
          className="map-analysis-layer-chevron"
          onClick={() => setPopOpen((o) => !o)}
        >
          ▾
        </button>
      )}
      {popOpen && lookbackOptions && onLookbackChange && (
        <div className="map-analysis-layer-popover" role="dialog">
          <div className="map-analysis-popover-label">Lookback</div>
          {lookbackOptions.map((h) => (
            <button
              key={h}
              type="button"
              className={lookbackHours === h ? 'selected' : ''}
              onClick={() => { onLookbackChange(h); setPopOpen(false); }}
            >
              {h}h
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src/components/MapAnalysis/LayerToggleButton.test.tsx
git add src/components/MapAnalysis/LayerToggleButton.tsx src/components/MapAnalysis/LayerToggleButton.test.tsx
git commit -m "feat(analysis): LayerToggleButton with config popover"
```

---

### Task 14: MapAnalysisToolbar — wire config + buttons

**Files:**
- Modify: `src/components/MapAnalysis/MapAnalysisToolbar.tsx`
- Create: `src/components/MapAnalysis/MapAnalysisToolbar.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MapAnalysisToolbar from './MapAnalysisToolbar';
import { MapAnalysisProvider } from './MapAnalysisContext';

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>{children}</MapAnalysisProvider>
    </QueryClientProvider>
  );
};

describe('MapAnalysisToolbar', () => {
  beforeEach(() => localStorage.clear());

  it('renders all 8 layer toggles + source select', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    expect(screen.getByRole('button', { name: /markers/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /traceroutes/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /neighbors/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /heatmap/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /trails/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /range rings/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hop shading/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /snr overlay/i })).toBeInTheDocument();
  });

  it('toggles a layer and persists to localStorage', () => {
    render(<MapAnalysisToolbar />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /traceroutes/i }));
    const stored = JSON.parse(localStorage.getItem('mapAnalysis.config.v1')!);
    expect(stored.layers.traceroutes.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Create context to share config + selected node + sources**

Create `src/components/MapAnalysis/MapAnalysisContext.tsx`:

```tsx
import { createContext, useContext, useState, ReactNode } from 'react';
import { useMapAnalysisConfig } from '../../hooks/useMapAnalysisConfig';

export interface SelectedTarget {
  type: 'node' | 'segment';
  // node
  nodeNum?: number;
  sourceId?: string;
  // segment
  fromNodeNum?: number;
  toNodeNum?: number;
}

type CtxShape = ReturnType<typeof useMapAnalysisConfig> & {
  selected: SelectedTarget | null;
  setSelected: (s: SelectedTarget | null) => void;
};

const Ctx = createContext<CtxShape | null>(null);

export function MapAnalysisProvider({ children }: { children: ReactNode }) {
  const config = useMapAnalysisConfig();
  const [selected, setSelected] = useState<SelectedTarget | null>(null);
  return <Ctx.Provider value={{ ...config, selected, setSelected }}>{children}</Ctx.Provider>;
}

export function useMapAnalysisCtx() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMapAnalysisCtx must be used inside MapAnalysisProvider');
  return v;
}
```

- [ ] **Step 3: Implement the toolbar**

Replace `src/components/MapAnalysis/MapAnalysisToolbar.tsx`:

```tsx
import { useDashboardSources } from '../../hooks/useDashboardData';
import LayerToggleButton from './LayerToggleButton';
import SourceMultiSelect from './SourceMultiSelect';
import { useMapAnalysisCtx, MapAnalysisProvider } from './MapAnalysisContext';
import { LayerKey } from '../../hooks/useMapAnalysisConfig';

const LOOKBACK_OPTIONS = [1, 6, 24, 72, 168, 720];

const TIMED_LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'traceroutes', label: 'Traceroutes' },
  { key: 'neighbors',   label: 'Neighbors' },
  { key: 'heatmap',     label: 'Heatmap' },
  { key: 'trails',      label: 'Trails' },
  { key: 'snrOverlay',  label: 'SNR Overlay' },
];
const UNTIMED_LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'markers',     label: 'Markers' },
  { key: 'rangeRings',  label: 'Range Rings' },
  { key: 'hopShading',  label: 'Hop Shading' },
];

function ToolbarInner() {
  const { config, setLayerEnabled, setLayerLookback, setSources, setTimeSlider, reset } = useMapAnalysisCtx();
  const { data: sources = [] } = useDashboardSources();

  return (
    <div className="map-analysis-toolbar-row">
      <SourceMultiSelect
        sources={sources.map((s: any) => ({ id: s.id, name: s.name }))}
        value={config.sources}
        onChange={setSources}
      />
      <button
        type="button"
        className={`map-analysis-layer-btn ${config.timeSlider.enabled ? 'active' : ''}`}
        onClick={() => setTimeSlider({ enabled: !config.timeSlider.enabled })}
      >
        Time Slider
      </button>
      {UNTIMED_LAYERS.map(({ key, label }) => (
        <LayerToggleButton
          key={key}
          label={label}
          enabled={config.layers[key].enabled}
          onToggle={(next) => setLayerEnabled(key, next)}
        />
      ))}
      {TIMED_LAYERS.map(({ key, label }) => (
        <LayerToggleButton
          key={key}
          label={label}
          enabled={config.layers[key].enabled}
          onToggle={(next) => setLayerEnabled(key, next)}
          lookbackHours={config.layers[key].lookbackHours}
          lookbackOptions={LOOKBACK_OPTIONS}
          onLookbackChange={(h) => setLayerLookback(key, h)}
        />
      ))}
      <button
        type="button"
        className="map-analysis-reset"
        onClick={reset}
        style={{ marginLeft: 'auto' }}
      >
        Reset
      </button>
    </div>
  );
}

export default function MapAnalysisToolbar() {
  // If a parent already wrapped in MapAnalysisProvider, consume it; otherwise
  // we render bare to support testing in isolation. The page wraps the whole
  // tree in MapAnalysisProvider inside MapAnalysisPage.
  return <ToolbarInner />;
}

export { MapAnalysisProvider };
```

- [ ] **Step 4: Wrap MapAnalysisPage in MapAnalysisProvider**

Update `src/pages/MapAnalysisPage.tsx` to wrap the body in `<MapAnalysisProvider>`:

```tsx
import { MapAnalysisProvider } from '../components/MapAnalysis/MapAnalysisContext';
// ...
<MapAnalysisProvider>
  <div className="map-analysis-page">
    <MapAnalysisToolbar />
    <div className="map-analysis-body">
      <MapAnalysisCanvas />
      <AnalysisInspectorPanel />
    </div>
  </div>
</MapAnalysisProvider>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/MapAnalysis/MapAnalysisToolbar.test.tsx src/pages/MapAnalysisPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/MapAnalysis/MapAnalysisToolbar.tsx \
        src/components/MapAnalysis/MapAnalysisToolbar.test.tsx \
        src/components/MapAnalysis/MapAnalysisContext.tsx \
        src/pages/MapAnalysisPage.tsx
git commit -m "feat(analysis): toolbar with all 8 layer toggles + source select + reset"
```

---

### Task 15: MapAnalysisCanvas with Leaflet base + NodeMarkersLayer

**Files:**
- Modify: `src/components/MapAnalysis/MapAnalysisCanvas.tsx`
- Create: `src/components/MapAnalysis/MapAnalysisCanvas.test.tsx`
- Create: `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MapAnalysisCanvas from './MapAnalysisCanvas';
import { MapAnalysisProvider } from './MapAnalysisContext';

// react-leaflet uses real DOM APIs Vitest doesn't supply by default; stub it.
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: ({ children, position }: any) => (
    <div data-testid="marker" data-pos={position.join(',')}>{children}</div>
  ),
  Popup: ({ children }: any) => <div data-testid="popup">{children}</div>,
  useMap: () => ({}),
  useMapEvents: () => ({}),
  Pane: ({ children }: any) => <>{children}</>,
}));

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [{ id: 'a', name: 'A' }] }),
  useDashboardUnifiedData: () => ({
    nodes: [
      { nodeNum: 1, sourceId: 'a', longName: 'Alpha', shortName: 'A', position: { latitude: 30, longitude: -90 } },
    ],
  }),
  UNIFIED_SOURCE_ID: '__unified__',
}));

const wrapper = ({ children }: any) => {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>{children}</MapAnalysisProvider>
    </QueryClientProvider>
  );
};

describe('MapAnalysisCanvas', () => {
  beforeEach(() => localStorage.clear());

  it('renders the map container and tile layer', () => {
    render(<MapAnalysisCanvas />, { wrapper });
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
    expect(screen.getByTestId('tile-layer')).toBeInTheDocument();
  });

  it('renders a marker per node when markers layer is enabled', () => {
    render(<MapAnalysisCanvas />, { wrapper });
    expect(screen.getAllByTestId('marker').length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement NodeMarkersLayer**

Create `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx`:

```tsx
import { Marker, Popup } from 'react-leaflet';
import { useDashboardUnifiedData } from '../../../hooks/useDashboardData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

export default function NodeMarkersLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const { nodes } = useDashboardUnifiedData();

  const filteredNodes = (nodes ?? []).filter((n: any) => {
    if (!n.position?.latitude || !n.position?.longitude) return false;
    if (config.sources.length === 0) return true;
    return config.sources.includes(n.sourceId);
  });

  return (
    <>
      {filteredNodes.map((n: any) => (
        <Marker
          key={`${n.sourceId}:${n.nodeNum}`}
          position={[n.position.latitude, n.position.longitude]}
          eventHandlers={{
            click: () => setSelected({ type: 'node', nodeNum: Number(n.nodeNum), sourceId: n.sourceId }),
          }}
        >
          <Popup>
            <strong>{n.longName ?? n.shortName ?? `!${Number(n.nodeNum).toString(16)}`}</strong>
            <div>Source: {n.sourceId}</div>
          </Popup>
        </Marker>
      ))}
    </>
  );
}
```

- [ ] **Step 3: Implement MapAnalysisCanvas**

Replace `src/components/MapAnalysis/MapAnalysisCanvas.tsx`:

```tsx
import { MapContainer, TileLayer, Pane } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { useSettings } from '../../contexts/SettingsContext';
import { useMapAnalysisCtx } from './MapAnalysisContext';
import NodeMarkersLayer from './layers/NodeMarkersLayer';

export default function MapAnalysisCanvas() {
  const { defaultMapCenterLat, defaultMapCenterLon } = useSettings();
  const { config } = useMapAnalysisCtx();
  const center: [number, number] = [defaultMapCenterLat ?? 30, defaultMapCenterLon ?? -90];

  return (
    <div className="map-analysis-canvas">
      <MapContainer center={center} zoom={10} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap"
        />
        <Pane name="markers" style={{ zIndex: 600 }}>
          {config.layers.markers.enabled && <NodeMarkersLayer />}
        </Pane>
      </MapContainer>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/MapAnalysis/MapAnalysisCanvas.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Manual deploy + verify**

Per CLAUDE.md, build/deploy locally and verify before pushing:

```bash
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up -d
```

Open http://localhost:8080/meshmonitor/analysis. Confirm:
- Toolbar visible at top with all 8 buttons + source select
- Map renders with markers from connected source
- Toggle Markers off → markers disappear; toggle on → return
- Toggle persists across page reload

- [ ] **Step 6: Commit**

```bash
git add src/components/MapAnalysis/MapAnalysisCanvas.tsx \
        src/components/MapAnalysis/MapAnalysisCanvas.test.tsx \
        src/components/MapAnalysis/layers/NodeMarkersLayer.tsx
git commit -m "feat(analysis): map canvas with NodeMarkersLayer reading unified nodes"
```

---

## Phase 6 — Layers backed by /api/analysis endpoints

### Task 16: TraceroutePathsLayer

**Files:**
- Create: `src/components/MapAnalysis/layers/TraceroutePathsLayer.tsx`
- Create: `src/components/MapAnalysis/layers/TraceroutePathsLayer.test.tsx`
- Modify: `src/components/MapAnalysis/MapAnalysisCanvas.tsx` (add Pane + conditional render)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import TraceroutePathsLayer from './TraceroutePathsLayer';

vi.mock('react-leaflet', () => ({
  Polyline: ({ positions }: any) => (
    <div data-testid="polyline" data-pts={JSON.stringify(positions)} />
  ),
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useTraceroutes: () => ({
    items: [
      {
        fromNodeNum: 1, toNodeNum: 2, sourceId: 'a',
        route: '[]', routeBack: '[]',
        snrTowards: '[10]', snrBack: '[12]',
        timestamp: 0, createdAt: 0, id: 1,
      },
    ],
    isLoading: false, isError: false, error: null,
    progress: { loaded: 1, estimatedTotal: 1, percent: 100 },
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardUnifiedData: () => ({
    nodes: [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
    ],
  }),
  UNIFIED_SOURCE_ID: '__unified__',
}));

const wrapper = ({ children }: any) => {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>{children}</MapAnalysisProvider>
    </QueryClientProvider>
  );
};

describe('TraceroutePathsLayer', () => {
  it('renders one polyline per traceroute segment with positions resolved from nodes', () => {
    render(<TraceroutePathsLayer />, { wrapper });
    const lines = screen.getAllByTestId('polyline');
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Implement the layer**

Create `src/components/MapAnalysis/layers/TraceroutePathsLayer.tsx`:

```tsx
import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import { useDashboardUnifiedData } from '../../../hooks/useDashboardData';
import { useTraceroutes } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

function snrToColor(snr: number): string {
  if (snr >= 5) return '#22c55e';
  if (snr >= 0) return '#eab308';
  if (snr >= -5) return '#f97316';
  return '#ef4444';
}

export default function TraceroutePathsLayer() {
  const { config, setSelected } = useMapAnalysisCtx();
  const layer = config.layers.traceroutes;
  const { items } = useTraceroutes({
    enabled: layer.enabled,
    sources: config.sources,
    lookbackHours: layer.lookbackHours ?? 24,
  });
  const { nodes } = useDashboardUnifiedData();

  const positionByKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const n of (nodes ?? []) as any[]) {
      if (n.position?.latitude && n.position?.longitude) {
        map.set(`${n.sourceId}:${Number(n.nodeNum)}`, [n.position.latitude, n.position.longitude]);
      }
    }
    return map;
  }, [nodes]);

  const segments = useMemo(() => {
    const out: Array<{ key: string; positions: [number, number][]; color: string; from: number; to: number }> = [];
    for (const tr of items as any[]) {
      const route: number[] = (() => {
        try { return JSON.parse(tr.route ?? '[]'); } catch { return []; }
      })();
      const snrTowards: number[] = (() => {
        try { return JSON.parse(tr.snrTowards ?? '[]'); } catch { return []; }
      })();
      const path = [Number(tr.fromNodeNum), ...route, Number(tr.toNodeNum)];
      for (let i = 0; i < path.length - 1; i++) {
        const a = positionByKey.get(`${tr.sourceId}:${path[i]}`);
        const b = positionByKey.get(`${tr.sourceId}:${path[i + 1]}`);
        if (!a || !b) continue;
        const snr = snrTowards[i] ?? 0;
        out.push({
          key: `${tr.id}:${i}`,
          positions: [a, b],
          color: snrToColor(snr),
          from: path[i],
          to: path[i + 1],
        });
      }
    }
    return out;
  }, [items, positionByKey]);

  return (
    <>
      {segments.map((s) => (
        <Polyline
          key={s.key}
          positions={s.positions}
          pathOptions={{ color: s.color, weight: 2 }}
          eventHandlers={{
            click: () => setSelected({ type: 'segment', fromNodeNum: s.from, toNodeNum: s.to }),
          }}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 3: Wire into canvas**

In `MapAnalysisCanvas.tsx`, add inside the `MapContainer` (above the markers Pane so traceroutes render below):

```tsx
import TraceroutePathsLayer from './layers/TraceroutePathsLayer';
// ...
<Pane name="paths" style={{ zIndex: 500 }}>
  {config.layers.traceroutes.enabled && <TraceroutePathsLayer />}
</Pane>
```

- [ ] **Step 4: Run tests + commit**

```bash
npx vitest run src/components/MapAnalysis/layers/TraceroutePathsLayer.test.tsx
git add -u
git commit -m "feat(analysis): TraceroutePathsLayer with SNR-colored segments"
```

---

### Task 17: NeighborLinksLayer

**Files:** Same pattern as Task 16 — new layer file + canvas wire-in.

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import NeighborLinksLayer from './NeighborLinksLayer';

vi.mock('react-leaflet', () => ({
  Polyline: (p: any) => <div data-testid="poly" data-color={p.pathOptions?.color} />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useNeighbors: () => ({
    data: { items: [{ nodeNum: 1, neighborNum: 2, sourceId: 'a', snr: 5, timestamp: 0 }] },
    isLoading: false,
  }),
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardUnifiedData: () => ({
    nodes: [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
    ],
  }),
}));

describe('NeighborLinksLayer', () => {
  it('renders one polyline per edge', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider><NeighborLinksLayer /></MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('poly')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/components/MapAnalysis/layers/NeighborLinksLayer.tsx`:

```tsx
import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import { useDashboardUnifiedData } from '../../../hooks/useDashboardData';
import { useNeighbors } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

function snrToOpacity(snr: number | null): number {
  if (snr === null) return 0.4;
  return Math.max(0.2, Math.min(1, (snr + 10) / 20));
}

export default function NeighborLinksLayer() {
  const { config } = useMapAnalysisCtx();
  const layer = config.layers.neighbors;
  const { data } = useNeighbors({
    enabled: layer.enabled,
    sources: config.sources,
    lookbackHours: layer.lookbackHours ?? 24,
  });
  const { nodes } = useDashboardUnifiedData();

  const positionByKey = useMemo(() => {
    const map = new Map<string, [number, number]>();
    for (const n of (nodes ?? []) as any[]) {
      if (n.position?.latitude && n.position?.longitude) {
        map.set(`${n.sourceId}:${Number(n.nodeNum)}`, [n.position.latitude, n.position.longitude]);
      }
    }
    return map;
  }, [nodes]);

  const edges = useMemo(() => {
    const out: Array<{ key: string; positions: [number, number][]; opacity: number }> = [];
    for (const e of (data?.items ?? []) as any[]) {
      const a = positionByKey.get(`${e.sourceId}:${Number(e.nodeNum)}`);
      const b = positionByKey.get(`${e.sourceId}:${Number(e.neighborNum)}`);
      if (!a || !b) continue;
      out.push({ key: String(e.id), positions: [a, b], opacity: snrToOpacity(e.snr) });
    }
    return out;
  }, [data, positionByKey]);

  return (
    <>
      {edges.map((e) => (
        <Polyline
          key={e.key}
          positions={e.positions}
          pathOptions={{ color: '#06b6d4', weight: 1, opacity: e.opacity, dashArray: '4 4' }}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 3: Wire into canvas**

In `MapAnalysisCanvas.tsx`:
```tsx
import NeighborLinksLayer from './layers/NeighborLinksLayer';
// ...
<Pane name="neighbors" style={{ zIndex: 450 }}>
  {config.layers.neighbors.enabled && <NeighborLinksLayer />}
</Pane>
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src/components/MapAnalysis/layers/NeighborLinksLayer.test.tsx
git add -u
git commit -m "feat(analysis): NeighborLinksLayer with SNR opacity"
```

---

### Task 18: PositionTrailsLayer

**Files:** Same pattern.

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import PositionTrailsLayer from './PositionTrailsLayer';

vi.mock('react-leaflet', () => ({
  Polyline: () => <div data-testid="poly" />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      { id: 1, nodeNum: 1, sourceId: 'a', latitude: 30, longitude: -90, timestamp: 1 },
      { id: 2, nodeNum: 1, sourceId: 'a', latitude: 30.1, longitude: -90.1, timestamp: 2 },
      { id: 3, nodeNum: 2, sourceId: 'a', latitude: 31, longitude: -91, timestamp: 1 },
      { id: 4, nodeNum: 2, sourceId: 'a', latitude: 31.1, longitude: -91.1, timestamp: 2 },
    ],
    isLoading: false,
    progress: { loaded: 4, estimatedTotal: 4, percent: 100 },
  }),
}));

describe('PositionTrailsLayer', () => {
  it('renders one polyline per node with 2+ position fixes', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider><PositionTrailsLayer /></MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('poly')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/components/MapAnalysis/layers/PositionTrailsLayer.tsx`:

```tsx
import { Polyline } from 'react-leaflet';
import { useMemo } from 'react';
import { usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

function colorForKey(key: string): string {
  // Stable hash → HSL hue
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 70%, 55%)`;
}

export default function PositionTrailsLayer() {
  const { config } = useMapAnalysisCtx();
  const layer = config.layers.trails;
  const { items } = usePositions({
    enabled: layer.enabled,
    sources: config.sources,
    lookbackHours: layer.lookbackHours ?? 24,
  });

  const trails = useMemo(() => {
    const grouped = new Map<string, Array<{ ts: number; pos: [number, number] }>>();
    for (const p of items as any[]) {
      const key = `${p.sourceId}:${Number(p.nodeNum)}`;
      const arr = grouped.get(key) ?? [];
      arr.push({ ts: p.timestamp, pos: [p.latitude, p.longitude] });
      grouped.set(key, arr);
    }
    const out: Array<{ key: string; positions: [number, number][]; color: string }> = [];
    for (const [key, arr] of grouped) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.ts - b.ts);
      out.push({ key, positions: arr.map((x) => x.pos), color: colorForKey(key) });
    }
    return out;
  }, [items]);

  return (
    <>
      {trails.map((t) => (
        <Polyline key={t.key} positions={t.positions} pathOptions={{ color: t.color, weight: 2, opacity: 0.7 }} />
      ))}
    </>
  );
}
```

- [ ] **Step 3: Wire into canvas**

```tsx
<Pane name="trails" style={{ zIndex: 400 }}>
  {config.layers.trails.enabled && <PositionTrailsLayer />}
</Pane>
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src/components/MapAnalysis/layers/PositionTrailsLayer.test.tsx
git add -u
git commit -m "feat(analysis): PositionTrailsLayer per-node breadcrumbs"
```

---

### Task 19: CoverageHeatmapLayer

**Files:** Same pattern.
- New dependency: `leaflet.heat` (already in `package.json` if used elsewhere; otherwise install).

- [ ] **Step 1: Verify / install dependency**

Run: `npm ls leaflet.heat`
If absent: `npm install --save leaflet.heat @types/leaflet.heat --legacy-peer-deps`

- [ ] **Step 2: Test**

```tsx
import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import CoverageHeatmapLayer from './CoverageHeatmapLayer';

const mockMap = { addLayer: vi.fn(), removeLayer: vi.fn() };
vi.mock('react-leaflet', () => ({ useMap: () => mockMap }));
vi.mock('leaflet.heat', () => ({}));
vi.mock('leaflet', () => ({
  default: { heatLayer: vi.fn(() => ({ addTo: vi.fn() })) },
  heatLayer: vi.fn(() => ({ addTo: vi.fn() })),
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  useCoverageGrid: () => ({
    data: { cells: [{ centerLat: 30, centerLon: -90, count: 5 }], binSizeDeg: 0.01 },
    isLoading: false,
  }),
  usePositions: () => ({ items: [], isLoading: false, progress: { percent: 100, loaded: 0, estimatedTotal: 0 } }),
}));

describe('CoverageHeatmapLayer', () => {
  it('attaches a heat layer to the map when enabled', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider><CoverageHeatmapLayer /></MapAnalysisProvider>
      </QueryClientProvider>,
    );
    // L.heatLayer should have been called with at least one point
    const L = require('leaflet');
    expect(L.heatLayer).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Implement**

Create `src/components/MapAnalysis/layers/CoverageHeatmapLayer.tsx`:

```tsx
import { useEffect } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.heat';
import { useCoverageGrid, usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

const ZOOM_THRESHOLD = 13;

export default function CoverageHeatmapLayer() {
  const map = useMap();
  const { config } = useMapAnalysisCtx();
  const layer = config.layers.heatmap;
  const zoom = (map as any).getZoom?.() ?? 12;

  const grid = useCoverageGrid({
    enabled: layer.enabled && zoom < ZOOM_THRESHOLD,
    sources: config.sources,
    lookbackHours: layer.lookbackHours ?? 24,
    zoom,
  });
  const positions = usePositions({
    enabled: layer.enabled && zoom >= ZOOM_THRESHOLD,
    sources: config.sources,
    lookbackHours: layer.lookbackHours ?? 24,
  });

  useEffect(() => {
    if (!layer.enabled) return;
    const points: Array<[number, number, number]> =
      zoom < ZOOM_THRESHOLD
        ? (grid.data?.cells ?? []).map((c: any) => [c.centerLat, c.centerLon, Math.min(1, c.count / 50)])
        : (positions.items as any[]).map((p) => [p.latitude, p.longitude, 0.4]);
    if (points.length === 0) return;
    const heat = (L as any).heatLayer(points, { radius: 25, blur: 15, maxZoom: 17 });
    heat.addTo(map);
    return () => { map.removeLayer(heat); };
  }, [map, layer.enabled, zoom, grid.data, positions.items]);

  return null;
}
```

- [ ] **Step 4: Wire into canvas + commit**

```tsx
<Pane name="heatmap" style={{ zIndex: 350 }}>
  {config.layers.heatmap.enabled && <CoverageHeatmapLayer />}
</Pane>
```

```bash
npx vitest run src/components/MapAnalysis/layers/CoverageHeatmapLayer.test.tsx
git add -u
git commit -m "feat(analysis): CoverageHeatmapLayer with zoom-aware grid/raw fallback"
```

---

### Task 20: RangeRingsLayer + HopShadingDecorator + SnrOverlayLayer

Three smaller layers grouped — each tested + committed individually.

#### 20a — RangeRingsLayer

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import RangeRingsLayer from './RangeRingsLayer';

vi.mock('react-leaflet', () => ({
  Circle: (p: any) => <div data-testid="ring" data-radius={p.radius} />,
}));
vi.mock('../../../hooks/useDashboardData', () => ({
  useDashboardUnifiedData: () => ({
    nodes: [
      { nodeNum: 1, sourceId: 'a', position: { latitude: 30, longitude: -90 } },
      { nodeNum: 2, sourceId: 'a', position: { latitude: 31, longitude: -91 } },
    ],
  }),
}));

describe('RangeRingsLayer', () => {
  it('renders one circle per node at configured radius (km → meters)', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider><RangeRingsLayer /></MapAnalysisProvider>
      </QueryClientProvider>,
    );
    const rings = screen.getAllByTestId('ring');
    expect(rings).toHaveLength(2);
    expect(rings[0].getAttribute('data-radius')).toBe('5000'); // default 5 km
  });
});
```

- [ ] **Step 2: Implement**

Create `src/components/MapAnalysis/layers/RangeRingsLayer.tsx`:

```tsx
import { Circle } from 'react-leaflet';
import { useDashboardUnifiedData } from '../../../hooks/useDashboardData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

export default function RangeRingsLayer() {
  const { config } = useMapAnalysisCtx();
  const radiusKm = (config.layers.rangeRings.options?.radiusKm as number) ?? 5;
  const { nodes } = useDashboardUnifiedData();

  const filtered = (nodes ?? []).filter((n: any) =>
    n.position?.latitude && n.position?.longitude &&
    (config.sources.length === 0 || config.sources.includes(n.sourceId)),
  );

  return (
    <>
      {filtered.map((n: any) => (
        <Circle
          key={`${n.sourceId}:${n.nodeNum}`}
          center={[n.position.latitude, n.position.longitude]}
          radius={radiusKm * 1000}
          pathOptions={{ color: '#a855f7', fillOpacity: 0.05, weight: 1 }}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 3: Wire + commit**

```tsx
<Pane name="rangeRings" style={{ zIndex: 480 }}>
  {config.layers.rangeRings.enabled && <RangeRingsLayer />}
</Pane>
```

```bash
npx vitest run src/components/MapAnalysis/layers/RangeRingsLayer.test.tsx
git add -u
git commit -m "feat(analysis): RangeRingsLayer with configurable radius"
```

#### 20b — HopShadingDecorator

The hop-shading layer doesn't render its own markers — it modifies `NodeMarkersLayer`. We expose a `useHopColors()` helper and have NodeMarkersLayer consume it.

- [ ] **Step 1: Implement helper**

Append to `src/components/MapAnalysis/layers/NodeMarkersLayer.tsx`:

```tsx
import { useHopCounts } from '../../../hooks/useMapAnalysisData';
// ... inside the component:
const { config } = useMapAnalysisCtx();
const hop = useHopCounts({
  enabled: config.layers.hopShading.enabled,
  sources: config.sources,
});
const hopByKey = useMemo(() => {
  const m = new Map<string, number>();
  for (const e of (hop.data?.entries ?? []) as any[]) {
    m.set(`${e.sourceId}:${Number(e.nodeNum)}`, e.hops);
  }
  return m;
}, [hop.data]);

function hopColor(h: number | undefined): string | undefined {
  if (!config.layers.hopShading.enabled || h === undefined) return undefined;
  if (h === 0) return '#22c55e';
  if (h === 1) return '#84cc16';
  if (h === 2) return '#eab308';
  if (h === 3) return '#f97316';
  return '#ef4444';
}
```

Use the color when constructing markers (apply via `divIcon` or marker `pathOptions`; minimum viable: wrap the marker label with the color in the popup. For first delivery, attach as a CSS class on the container).

- [ ] **Step 2: Test**

Append a test to `NodeMarkersLayer.test.tsx`:

```tsx
it('applies hop color when hop shading is enabled', () => {
  // Detail mock + render...
  // Assert at least one marker carries the expected hop class
});
```

(Concrete assertion depends on the rendering technique chosen above. If using `divIcon`, assert via `data-hop` attribute on the marker testid.)

- [ ] **Step 3: Run + commit**

```bash
npx vitest run src/components/MapAnalysis/layers/NodeMarkersLayer.test.tsx
git add -u
git commit -m "feat(analysis): HopShadingDecorator tints node markers by hop count"
```

#### 20c — SnrOverlayLayer

- [ ] **Step 1: Test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapAnalysisProvider } from '../MapAnalysisContext';
import SnrOverlayLayer from './SnrOverlayLayer';

vi.mock('react-leaflet', () => ({
  CircleMarker: (p: any) => <div data-testid="snr-dot" data-color={p.pathOptions?.color} />,
}));
vi.mock('../../../hooks/useMapAnalysisData', () => ({
  usePositions: () => ({
    items: [
      { latitude: 30, longitude: -90, snr: 7, timestamp: 0 },
      { latitude: 31, longitude: -91, snr: -3, timestamp: 0 },
    ],
    isLoading: false, progress: { percent: 100, loaded: 2, estimatedTotal: 2 },
  }),
}));

describe('SnrOverlayLayer', () => {
  it('renders one CircleMarker per position with SNR-based color', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MapAnalysisProvider><SnrOverlayLayer /></MapAnalysisProvider>
      </QueryClientProvider>,
    );
    expect(screen.getAllByTestId('snr-dot')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/components/MapAnalysis/layers/SnrOverlayLayer.tsx`:

```tsx
import { CircleMarker } from 'react-leaflet';
import { usePositions } from '../../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from '../MapAnalysisContext';

function snrColor(snr: number | null): string {
  if (snr === null) return '#888';
  if (snr >= 5) return '#22c55e';
  if (snr >= 0) return '#eab308';
  if (snr >= -5) return '#f97316';
  return '#ef4444';
}

export default function SnrOverlayLayer() {
  const { config } = useMapAnalysisCtx();
  const layer = config.layers.snrOverlay;
  const { items } = usePositions({
    enabled: layer.enabled,
    sources: config.sources,
    lookbackHours: layer.lookbackHours ?? 24,
  });
  return (
    <>
      {(items as any[]).map((p, i) => (
        <CircleMarker
          key={`${p.id ?? i}`}
          center={[p.latitude, p.longitude]}
          radius={4}
          pathOptions={{ color: snrColor(p.snr ?? null), fillOpacity: 0.7, weight: 1 }}
        />
      ))}
    </>
  );
}
```

- [ ] **Step 3: Wire + commit**

```tsx
<Pane name="snrOverlay" style={{ zIndex: 420 }}>
  {config.layers.snrOverlay.enabled && <SnrOverlayLayer />}
</Pane>
```

```bash
npx vitest run src/components/MapAnalysis/layers/SnrOverlayLayer.test.tsx
git add -u
git commit -m "feat(analysis): SnrOverlayLayer with per-fix SNR coloring"
```

---

## Phase 7 — Time slider, inspector, progress bar

### Task 21: TimeSliderControl with client-side filtering

**Files:**
- Create: `src/components/MapAnalysis/TimeSliderControl.tsx`
- Create: `src/components/MapAnalysis/TimeSliderControl.test.tsx`
- Modify: each timed layer (Trails, Heatmap, SNR Overlay, Traceroutes, Neighbors) to filter `items` by `(timeSlider.windowStartMs, windowEndMs)` when slider is enabled

- [ ] **Step 1: Test the control**

```tsx
import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MapAnalysisProvider } from './MapAnalysisContext';
import TimeSliderControl from './TimeSliderControl';

describe('TimeSliderControl', () => {
  beforeEach(() => localStorage.clear());

  it('hides itself when timeSlider.enabled is false', () => {
    render(<MapAnalysisProvider><TimeSliderControl /></MapAnalysisProvider>);
    expect(screen.queryByTestId('time-slider')).not.toBeInTheDocument();
  });
});
```

(Full slider interaction tests are skipped here — coverage of the filter math lives on the layers in step 3.)

- [ ] **Step 2: Implement**

Create `src/components/MapAnalysis/TimeSliderControl.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useMapAnalysisCtx } from './MapAnalysisContext';

export default function TimeSliderControl() {
  const { config, setTimeSlider } = useMapAnalysisCtx();
  const [start, setStart] = useState(config.timeSlider.windowStartMs ?? Date.now() - 86_400_000);
  const [end, setEnd] = useState(config.timeSlider.windowEndMs ?? Date.now());

  useEffect(() => {
    setTimeSlider({ windowStartMs: start, windowEndMs: end });
  }, [start, end]);

  if (!config.timeSlider.enabled) return null;

  const min = Date.now() - 30 * 86_400_000;
  const max = Date.now();

  return (
    <div className="map-analysis-time-slider" data-testid="time-slider">
      <div>
        Window: {new Date(start).toLocaleString()} → {new Date(end).toLocaleString()}
      </div>
      <input
        type="range" min={min} max={max} value={start}
        onChange={(e) => setStart(Math.min(end, Number(e.target.value)))}
      />
      <input
        type="range" min={min} max={max} value={end}
        onChange={(e) => setEnd(Math.max(start, Number(e.target.value)))}
      />
    </div>
  );
}
```

Mount in `MapAnalysisCanvas.tsx` outside the `MapContainer` (overlay):

```tsx
<TimeSliderControl />
```

- [ ] **Step 3: Filter timed layers**

In each of `TraceroutePathsLayer`, `NeighborLinksLayer`, `PositionTrailsLayer`, `CoverageHeatmapLayer`, `SnrOverlayLayer`, after fetching `items`/`data`, apply:

```ts
const ts = config.timeSlider;
const windowed = ts.enabled && ts.windowStartMs !== undefined && ts.windowEndMs !== undefined
  ? items.filter((p: any) => p.timestamp >= ts.windowStartMs! && p.timestamp <= ts.windowEndMs!)
  : items;
```

Use `windowed` in the downstream `useMemo` instead of `items`.

For each layer, append a unit test asserting the filter excludes points outside the window. Example for `PositionTrailsLayer.test.tsx`:

```tsx
it('drops points outside time slider window', () => {
  // Configure localStorage with timeSlider.enabled + window covering only ts=2..3
  localStorage.setItem('mapAnalysis.config.v1', JSON.stringify({
    version: 1,
    layers: { ...DEFAULT_CONFIG.layers, trails: { enabled: true, lookbackHours: 24 } },
    sources: [],
    timeSlider: { enabled: true, windowStartMs: 2, windowEndMs: 3 },
    inspectorOpen: true,
  }));
  // ... render, assert only one polyline (the segment at ts=2..3)
});
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src/components/MapAnalysis/
git add -u
git commit -m "feat(analysis): TimeSliderControl with client-side window filter on timed layers"
```

---

### Task 22: AnalysisInspectorPanel

**Files:**
- Modify: `src/components/MapAnalysis/AnalysisInspectorPanel.tsx`
- Create: `src/components/MapAnalysis/AnalysisInspectorPanel.test.tsx`

- [ ] **Step 1: Test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AnalysisInspectorPanel from './AnalysisInspectorPanel';
import { MapAnalysisProvider, useMapAnalysisCtx } from './MapAnalysisContext';

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardUnifiedData: () => ({
    nodes: [{ nodeNum: 1, sourceId: 'a', longName: 'Alpha', shortName: 'A', position: { latitude: 30, longitude: -90 } }],
  }),
}));
vi.mock('../../hooks/useMapAnalysisData', () => ({
  useHopCounts: () => ({ data: { entries: [{ sourceId: 'a', nodeNum: 1, hops: 2 }] } }),
}));

function Wrapper({ children }: any) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <MapAnalysisProvider>{children}</MapAnalysisProvider>
    </QueryClientProvider>
  );
}

function SelectAlpha() {
  const ctx = useMapAnalysisCtx();
  return <button onClick={() => ctx.setSelected({ type: 'node', nodeNum: 1, sourceId: 'a' })}>select</button>;
}

describe('AnalysisInspectorPanel', () => {
  it('shows empty state when nothing selected', () => {
    render(<Wrapper><AnalysisInspectorPanel /></Wrapper>);
    expect(screen.getByText(/click a node or route segment/i)).toBeInTheDocument();
  });

  it('renders node detail when a node is selected', () => {
    render(<Wrapper><SelectAlpha /><AnalysisInspectorPanel /></Wrapper>);
    fireEvent.click(screen.getByText('select'));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText(/hops: 2/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement**

Replace `src/components/MapAnalysis/AnalysisInspectorPanel.tsx`:

```tsx
import { useDashboardUnifiedData } from '../../hooks/useDashboardData';
import { useHopCounts } from '../../hooks/useMapAnalysisData';
import { useMapAnalysisCtx } from './MapAnalysisContext';

export default function AnalysisInspectorPanel() {
  const { config, selected } = useMapAnalysisCtx();
  const { nodes } = useDashboardUnifiedData();
  const hop = useHopCounts({ enabled: true, sources: config.sources });

  if (!config.inspectorOpen) return null;
  if (!selected) {
    return <aside className="map-analysis-inspector"><em>Click a node or route segment</em></aside>;
  }

  if (selected.type === 'node') {
    const node = (nodes ?? []).find((n: any) =>
      Number(n.nodeNum) === selected.nodeNum && n.sourceId === selected.sourceId,
    );
    if (!node) {
      return <aside className="map-analysis-inspector">Node not found</aside>;
    }
    const hops = (hop.data?.entries ?? []).find(
      (e: any) => e.sourceId === selected.sourceId && Number(e.nodeNum) === selected.nodeNum,
    )?.hops;
    return (
      <aside className="map-analysis-inspector">
        <h3>{node.longName ?? node.shortName ?? `!${selected.nodeNum.toString(16)}`}</h3>
        <dl>
          <dt>Node</dt><dd>{selected.nodeNum} (!{selected.nodeNum.toString(16)})</dd>
          <dt>Source</dt><dd>{node.sourceId}</dd>
          <dt>Hops</dt><dd>Hops: {hops ?? '—'}</dd>
          <dt>Last position</dt>
          <dd>{node.position?.latitude?.toFixed(5)}, {node.position?.longitude?.toFixed(5)}</dd>
        </dl>
      </aside>
    );
  }

  // segment
  return (
    <aside className="map-analysis-inspector">
      <h3>Route segment</h3>
      <div>{selected.fromNodeNum} → {selected.toNodeNum}</div>
    </aside>
  );
}
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run src/components/MapAnalysis/AnalysisInspectorPanel.test.tsx
git add -u
git commit -m "feat(analysis): inspector panel with node/segment detail"
```

---

### Task 23: Toolbar progress bar + per-button loading state

**Files:**
- Modify: `src/components/MapAnalysis/MapAnalysisToolbar.tsx` (read each hook's `isLoading`/`progress`, pass to `LayerToggleButton`, render aggregate progress bar)

- [ ] **Step 1: Add an aggregate progress hook**

Append to `src/hooks/useMapAnalysisData.ts`:

```ts
export function useAggregateProgress(states: Array<{ isLoading: boolean; progress?: { percent: number } }>): number | null {
  const loading = states.filter((s) => s.isLoading);
  if (loading.length === 0) return null;
  const sum = loading.reduce((acc, s) => acc + (s.progress?.percent ?? 0), 0);
  return Math.round(sum / loading.length);
}
```

- [ ] **Step 2: Refactor toolbar to consume hook states**

Add `loading` prop to each `LayerToggleButton` based on its hook's `isLoading`. For paginated hooks (`usePositions`, `useTraceroutes`) call them at the toolbar level so they can also drive the `useAggregateProgress` and the global progress bar:

```tsx
import { usePositions, useTraceroutes, useNeighbors, useCoverageGrid, useHopCounts, useAggregateProgress } from '../../hooks/useMapAnalysisData';

// inside ToolbarInner:
const positions = usePositions({ enabled: config.layers.trails.enabled || config.layers.heatmap.enabled || config.layers.snrOverlay.enabled, sources: config.sources, lookbackHours: 24 });
const traceroutes = useTraceroutes({ enabled: config.layers.traceroutes.enabled, sources: config.sources, lookbackHours: config.layers.traceroutes.lookbackHours ?? 24 });
const neighbors = useNeighbors({ enabled: config.layers.neighbors.enabled, sources: config.sources, lookbackHours: config.layers.neighbors.lookbackHours ?? 24 });
const aggregate = useAggregateProgress([positions, traceroutes, { isLoading: neighbors.isLoading } as any]);
```

> **Note:** the layer components already call these same hooks. With React Query the duplicate calls share a cache key and only one network request is made — but only if the *args* are identical. Be sure each hook is called with the same `sources` + `lookbackHours` everywhere it appears. If divergence is needed (e.g. SNR overlay uses a different lookback than Trails), give them distinct hook calls.

Render the global bar:
```tsx
{aggregate !== null && (
  <div className="map-analysis-progress" role="progressbar" aria-valuenow={aggregate}>
    <div style={{ width: `${aggregate}%` }} />
  </div>
)}
```

- [ ] **Step 3: Add loading state to button props**

Pass `loading={traceroutes.isLoading}` etc. to each `LayerToggleButton`.

- [ ] **Step 4: Test**

Append to `MapAnalysisToolbar.test.tsx`:

```tsx
it('renders an aggregate progress bar while a paginated hook is loading', async () => {
  // Mock usePositions to return isLoading=true with percent=42
  // Render and assert role=progressbar with aria-valuenow=42
});
```

- [ ] **Step 5: Run + commit**

```bash
npx vitest run src/components/MapAnalysis/MapAnalysisToolbar.test.tsx
git add -u
git commit -m "feat(analysis): aggregate progress bar + per-layer loading spinners"
```

---

## Phase 8 — System tests + final verification

### Task 24: Add system test for /api/analysis/positions

**Files:**
- Modify: `tests/system-tests.sh`

- [ ] **Step 1: Append the test**

In `tests/system-tests.sh`, near the existing `unified` checks, add:

```bash
echo "Test: /api/analysis/positions returns paginated shape"
RESP=$(./scripts/api-test.sh get '/api/analysis/positions?since=0&pageSize=10')
echo "$RESP" | jq -e '.items | type == "array"' > /dev/null \
  || { echo "FAIL: positions.items not an array"; exit 1; }
echo "$RESP" | jq -e 'has("hasMore") and has("nextCursor")' > /dev/null \
  || { echo "FAIL: missing hasMore/nextCursor"; exit 1; }
echo "  ✓ positions endpoint returns paginated shape"
```

Run the script once locally to confirm it doesn't blow up:

```bash
./tests/system-tests.sh
```

- [ ] **Step 2: Commit**

```bash
git add tests/system-tests.sh
git commit -m "test(analysis): smoke-test /api/analysis/positions paginated response"
```

---

### Task 25: Build, deploy, manual verify, then push

- [ ] **Step 1: Stop tileserver if running** (per CLAUDE.md)
- [ ] **Step 2: Build dev container**

```bash
docker compose -f docker-compose.dev.yml build
docker compose -f docker-compose.dev.yml up -d
```

- [ ] **Step 3: Verify deployed code**

Watch the container logs for the new mount line and confirm `/api/analysis/*` is registered. Hit:

```bash
curl -s 'http://localhost:8080/meshmonitor/api/analysis/positions?since=0&pageSize=5' | jq .
```

Expect `{ items: [...], pageSize: 5, hasMore: bool, nextCursor: ... }`.

- [ ] **Step 4: Manual UI exercise**

Login (admin/changeme1). Navigate to `/meshmonitor/analysis`. Confirm:
- Sidebar entry exists on the dashboard at `/`
- Page renders toolbar + map + inspector
- Markers visible by default
- Toggle each layer in turn — confirm visual change
- Source multi-select hides/shows nodes appropriately
- Time slider toggle reveals slider; moving handles changes visible trails/SNR
- Inspector populates when clicking a node
- Reload page — config persists

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass (0 failures).

- [ ] **Step 6: Push to a feature branch and open PR**

(Per CLAUDE.md, never push to main directly. Use `/create-pr` workflow.)

```bash
git checkout -b feature/map-analysis
git push -u origin feature/map-analysis
```

Then run `/create-pr` to fill the PR template + body.

---

## Self-review notes

**Spec coverage check (against `2026-04-29-map-analysis-design.md`):**
- ✅ Sidebar entry — Task 1
- ✅ Page route + shell — Task 2
- ✅ All 5 backend endpoints — Tasks 5–9
- ✅ Permission filtering inheritance — Task 5 (and reused by 6–9)
- ✅ localStorage config — Task 10
- ✅ Per-layer paginated hooks with progress — Task 11
- ✅ Source multi-select — Task 12
- ✅ All 8 layers — Tasks 15 (markers), 16 (traceroutes), 17 (neighbors), 18 (trails), 19 (heatmap), 20a (range rings), 20b (hop shading), 20c (SNR overlay)
- ✅ Time slider — Task 21
- ✅ Inspector panel — Task 22
- ✅ Aggregate progress bar — Task 23
- ✅ System test + manual verify — Tasks 24–25

**Type consistency check:**
- `LayerKey` defined in `useMapAnalysisConfig.ts`, consumed by toolbar + every layer component
- `PaginatedPositions` / `PaginatedTraceroutes` returned from repo, mirrored in `analysisApi.ts` `Paginated<T>`, consumed by hooks
- `SelectedTarget` from `MapAnalysisContext`, consumed by markers (sets) + inspector (reads)
- All `nodeNum` values coerced to `Number()` at repo boundary (BIGINT compatibility)

**Known caveats:**
- Step 6 of Task 14 wraps the `<MapAnalysisProvider>` inside `MapAnalysisPage`. The toolbar test mounts its own provider so it can stand alone.
- Coverage heatmap test in Task 19 mocks `leaflet` heavily because `leaflet.heat` is a side-effect import; if the existing project already exposes a different heatmap API, swap to that helper.
- Hop shading sub-task 20b is partly schematic — the exact rendering technique (DivIcon vs styled marker) depends on how `NodeMarkersLayer` is currently structured by the time you reach it. Pick the smallest delta.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-29-map-analysis.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
