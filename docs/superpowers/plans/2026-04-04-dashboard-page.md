# Dashboard Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `SourceListPage` at `/` with a map-centric `DashboardPage` featuring a left sidebar of source cards and a full-screen map showing nodes for the selected source.

**Architecture:** Two-panel layout — collapsible sidebar with source cards (status, node count, admin kebab menu) and a full-screen react-leaflet map. `DashboardPage` owns selected-source state. A new `DashboardMap` component renders markers, neighbor lines, and traceroutes (self-contained, not extracted from `NodesTab`). A new per-source neighbor-info backend endpoint provides enriched neighbor data.

**Tech Stack:** React, react-leaflet, TanStack Query, TypeScript, `--ctp-*` CSS variables, existing MeshMonitor API endpoints.

---

## File Structure

### New files

| File | Purpose |
|------|---------|
| `src/pages/DashboardPage.tsx` | Top-level page; selected-source state, data fetching, layout |
| `src/components/Dashboard/DashboardSidebar.tsx` | Source card list, kebab menu, cross-source links |
| `src/components/Dashboard/DashboardMap.tsx` | Self-contained map: markers, popups, neighbor lines, traceroutes |
| `src/styles/dashboard.css` | Layout grid, sidebar, card, and map styles |
| `src/hooks/useDashboardData.ts` | TanStack Query hooks for dashboard polling |
| `src/hooks/useDashboardData.test.ts` | Tests for dashboard data hooks |
| `src/components/Dashboard/DashboardSidebar.test.tsx` | Tests for sidebar |
| `src/components/Dashboard/DashboardMap.test.tsx` | Tests for map |
| `src/pages/DashboardPage.test.tsx` | Tests for page integration |
| `src/server/routes/sourceRoutes.neighbor-info.test.ts` | Tests for neighbor-info endpoint |

### Modified files

| File | Change |
|------|--------|
| `src/server/routes/sourceRoutes.ts` | Add `GET /:id/neighbor-info` endpoint |
| `src/main.tsx` | Route `/` to `DashboardPage` (replaces `SourceListPage`) |

### Removed files

| File | Reason |
|------|--------|
| `src/pages/SourceListPage.tsx` | Replaced by `DashboardPage` |
| `src/styles/sources.css` | No longer needed |

---

## Task 1: Add per-source neighbor-info endpoint

**Files:**
- Modify: `src/server/routes/sourceRoutes.ts:239` (append before `export`)
- Create: `src/server/routes/sourceRoutes.neighbor-info.test.ts`

The existing `GET /api/neighbor-info` in `server.ts` is global and uses `databaseService.getLatestNeighborInfoPerNode()`. We need a source-scoped version using the Drizzle repository's `getAllNeighborInfo(sourceId)`.

- [ ] **Step 1: Write the failing test**

Create `src/server/routes/sourceRoutes.neighbor-info.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock database service
vi.mock('../../services/database.js', () => {
  const mockDb = {
    sources: {
      getSource: vi.fn(),
    },
    neighbors: {
      getAllNeighborInfo: vi.fn(),
    },
    nodes: {
      getNode: vi.fn(),
    },
    settings: {
      getSetting: vi.fn(),
    },
    findUserByIdAsync: vi.fn(),
    findUserByUsernameAsync: vi.fn(),
    checkPermissionAsync: vi.fn().mockResolvedValue(true),
    getUserPermissionSetAsync: vi.fn().mockResolvedValue({ resources: {}, isAdmin: true }),
  };
  return { default: mockDb };
});

// Mock auth middleware to inject test user
vi.mock('../auth/authMiddleware.js', () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.user = { id: 1, username: 'admin', isAdmin: true };
    next();
  },
  optionalAuth: () => (req: any, _res: any, next: any) => {
    next();
  },
}));

// Mock sourceManagerRegistry
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn(),
    addManager: vi.fn(),
    removeManager: vi.fn(),
  },
}));

// Mock MeshtasticManager
vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn(),
}));

import databaseService from '../../services/database.js';
import sourceRoutes from './sourceRoutes.js';

const app = express();
app.use(express.json());
app.use('/api/sources', sourceRoutes);

describe('GET /api/sources/:id/neighbor-info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 404 when source does not exist', async () => {
    (databaseService.sources.getSource as any).mockResolvedValue(null);

    const res = await request(app).get('/api/sources/test-source/neighbor-info');
    expect(res.status).toBe(404);
  });

  it('returns enriched neighbor info for a valid source', async () => {
    (databaseService.sources.getSource as any).mockResolvedValue({
      id: 'src-1',
      name: 'Test Source',
      type: 'meshtastic_tcp',
      enabled: true,
    });

    const now = Math.floor(Date.now() / 1000);
    (databaseService.neighbors.getAllNeighborInfo as any).mockResolvedValue([
      { nodeNum: 100, neighborNodeNum: 200, snr: 5.5, timestamp: now },
    ]);

    (databaseService.nodes.getNode as any)
      .mockResolvedValueOnce({
        nodeId: '!00000064',
        longName: 'Node100',
        lastHeard: now,
        latitude: 30.0,
        longitude: -90.0,
        positionOverrideEnabled: false,
      })
      .mockResolvedValueOnce({
        nodeId: '!000000c8',
        longName: 'Node200',
        lastHeard: now,
        latitude: 30.1,
        longitude: -90.1,
        positionOverrideEnabled: false,
      });

    (databaseService.settings.getSetting as any).mockResolvedValue('24');

    const res = await request(app).get('/api/sources/src-1/neighbor-info');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      nodeNum: 100,
      neighborNodeNum: 200,
      nodeId: '!00000064',
      nodeName: 'Node100',
      neighborNodeId: '!000000c8',
      neighborName: 'Node200',
      nodeLatitude: 30.0,
      nodeLongitude: -90.0,
      neighborLatitude: 30.1,
      neighborLongitude: -90.1,
      bidirectional: false,
    });
  });

  it('filters out stale neighbor info based on maxNodeAge', async () => {
    (databaseService.sources.getSource as any).mockResolvedValue({
      id: 'src-1', name: 'Test', type: 'meshtastic_tcp', enabled: true,
    });

    const now = Math.floor(Date.now() / 1000);
    const staleTime = now - 48 * 60 * 60; // 48 hours ago

    (databaseService.neighbors.getAllNeighborInfo as any).mockResolvedValue([
      { nodeNum: 100, neighborNodeNum: 200, snr: 5.5, timestamp: now },
    ]);

    (databaseService.nodes.getNode as any)
      .mockResolvedValueOnce({
        nodeId: '!00000064', longName: 'Node100', lastHeard: staleTime,
        latitude: 30.0, longitude: -90.0, positionOverrideEnabled: false,
      })
      .mockResolvedValueOnce({
        nodeId: '!000000c8', longName: 'Node200', lastHeard: now,
        latitude: 30.1, longitude: -90.1, positionOverrideEnabled: false,
      });

    (databaseService.settings.getSetting as any).mockResolvedValue('24');

    const res = await request(app).get('/api/sources/src-1/neighbor-info');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/server/routes/sourceRoutes.neighbor-info.test.ts`
Expected: FAIL — endpoint does not exist yet (404 on the route)

- [ ] **Step 3: Implement the neighbor-info endpoint**

Add at the end of `src/server/routes/sourceRoutes.ts`, before `export default router;`:

```typescript
// GET /api/sources/:id/neighbor-info — enriched neighbor info for a source
router.get('/:id/neighbor-info', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const neighborInfo = await databaseService.neighbors.getAllNeighborInfo(source.id);

    // Get max node age setting (default 24 hours)
    const maxNodeAgeStr = await databaseService.settings.getSetting('maxNodeAge');
    const maxNodeAgeHours = maxNodeAgeStr ? parseInt(maxNodeAgeStr, 10) : 24;
    const cutoffTime = Math.floor(Date.now() / 1000) - maxNodeAgeHours * 60 * 60;

    // Build link key set for bidirectionality detection
    const linkKeys = new Set(neighborInfo.map(ni => `${ni.nodeNum}-${ni.neighborNodeNum}`));

    const getEffectivePosition = (node: any) => {
      if (!node) return { latitude: undefined, longitude: undefined };
      if (node.positionOverrideEnabled && node.latitudeOverride != null && node.longitudeOverride != null) {
        return { latitude: node.latitudeOverride, longitude: node.longitudeOverride };
      }
      return { latitude: node.latitude, longitude: node.longitude };
    };

    // Enrich with names, positions, bidirectionality; filter by age
    const enriched = (await Promise.all(neighborInfo.map(async ni => {
      const node = await databaseService.nodes.getNode(ni.nodeNum, source.id);
      const neighbor = await databaseService.nodes.getNode(ni.neighborNodeNum, source.id);
      const nodePos = getEffectivePosition(node);
      const neighborPos = getEffectivePosition(neighbor);

      return {
        ...ni,
        nodeId: node?.nodeId || `!${ni.nodeNum.toString(16).padStart(8, '0')}`,
        nodeName: node?.longName || `Node !${ni.nodeNum.toString(16).padStart(8, '0')}`,
        neighborNodeId: neighbor?.nodeId || `!${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        neighborName: neighbor?.longName || `Node !${ni.neighborNodeNum.toString(16).padStart(8, '0')}`,
        bidirectional: linkKeys.has(`${ni.neighborNodeNum}-${ni.nodeNum}`),
        nodeLatitude: nodePos.latitude,
        nodeLongitude: nodePos.longitude,
        neighborLatitude: neighborPos.latitude,
        neighborLongitude: neighborPos.longitude,
        _node: node,
        _neighbor: neighbor,
      };
    })))
      .filter(ni => {
        if (!ni._node?.lastHeard || !ni._neighbor?.lastHeard) return false;
        return ni._node.lastHeard >= cutoffTime && ni._neighbor.lastHeard >= cutoffTime;
      })
      .map(({ _node, _neighbor, ...rest }) => rest);

    res.json(enriched);
  } catch (error) {
    logger.error('Error fetching neighbor info for source:', error);
    res.status(500).json({ error: 'Failed to fetch neighbor info' });
  }
});
```

Note: Check whether `databaseService.nodes.getNode` accepts a `sourceId` parameter. If the method signature is `getNode(nodeNum: number, sourceId?: string)`, use it as shown. If not, use `getNode(nodeNum)` — the source scoping on the neighbor info query already limits results to the correct source.

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/server/routes/sourceRoutes.neighbor-info.test.ts`
Expected: PASS — all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/sourceRoutes.ts src/server/routes/sourceRoutes.neighbor-info.test.ts
git commit -m "feat: add per-source neighbor-info endpoint (GET /api/sources/:id/neighbor-info)"
```

---

## Task 2: Dashboard CSS

**Files:**
- Create: `src/styles/dashboard.css`

All dashboard layout styling — sidebar, cards, map container, responsive behavior.

- [ ] **Step 1: Create the stylesheet**

Create `src/styles/dashboard.css`:

```css
/* Dashboard Page — two-panel layout */

.dashboard-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--ctp-base);
  color: var(--ctp-text);
}

/* Top bar */
.dashboard-topbar {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  background: var(--ctp-crust);
  border-bottom: 1px solid var(--ctp-surface0);
  flex-shrink: 0;
  gap: 12px;
  z-index: 1000;
}

.dashboard-topbar-logo {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--ctp-blue);
  font-size: 14px;
}

.dashboard-topbar-logo img {
  height: 28px;
  width: 28px;
}

.dashboard-topbar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Main content area */
.dashboard-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* Left sidebar */
.dashboard-sidebar {
  width: 240px;
  min-width: 240px;
  background: var(--ctp-mantle);
  border-right: 1px solid var(--ctp-surface0);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  flex-shrink: 0;
}

.dashboard-sidebar-header {
  padding: 8px 12px 4px;
  font-size: 11px;
  color: var(--ctp-subtext0);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 600;
}

/* Source cards */
.dashboard-source-card {
  margin: 4px 8px;
  background: var(--ctp-surface0);
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: border-color 0.15s, background 0.15s;
}

.dashboard-source-card:hover {
  background: var(--ctp-surface1);
}

.dashboard-source-card.selected {
  border-color: var(--ctp-blue);
}

.dashboard-source-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.dashboard-source-card-name {
  font-weight: 600;
  font-size: 13px;
  color: var(--ctp-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.dashboard-source-card-badge {
  background: var(--ctp-surface1);
  color: var(--ctp-subtext0);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
  flex-shrink: 0;
}

.dashboard-source-card-status {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  font-size: 11px;
  color: var(--ctp-subtext1);
}

.dashboard-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dashboard-status-dot.connected { background: var(--ctp-green); }
.dashboard-status-dot.connecting { background: var(--ctp-yellow); }
.dashboard-status-dot.disconnected { background: var(--ctp-surface2); }
.dashboard-status-dot.disabled { background: var(--ctp-surface2); }

.dashboard-source-card-actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.dashboard-open-btn {
  flex: 1;
  background: var(--ctp-blue);
  color: var(--ctp-base);
  border: none;
  border-radius: 4px;
  padding: 4px 0;
  font-size: 11px;
  font-weight: 600;
  text-align: center;
  cursor: pointer;
  transition: opacity 0.15s;
}

.dashboard-open-btn:hover {
  opacity: 0.9;
}

.dashboard-open-btn:disabled {
  background: var(--ctp-surface1);
  color: var(--ctp-subtext0);
  cursor: not-allowed;
  opacity: 0.6;
}

/* Kebab menu */
.dashboard-kebab-btn {
  background: none;
  border: none;
  color: var(--ctp-subtext0);
  cursor: pointer;
  padding: 2px 4px;
  font-size: 16px;
  line-height: 1;
  border-radius: 3px;
}

.dashboard-kebab-btn:hover {
  background: var(--ctp-surface1);
  color: var(--ctp-text);
}

.dashboard-kebab-menu {
  position: absolute;
  right: 8px;
  top: 100%;
  background: var(--ctp-crust);
  border: 1px solid var(--ctp-surface1);
  border-radius: 6px;
  padding: 4px 0;
  z-index: 20;
  min-width: 120px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.dashboard-kebab-item {
  display: block;
  width: 100%;
  background: none;
  border: none;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--ctp-text);
  text-align: left;
  cursor: pointer;
}

.dashboard-kebab-item:hover {
  background: var(--ctp-surface0);
}

.dashboard-kebab-item.danger {
  color: var(--ctp-red);
}

/* Cross-source links at sidebar bottom */
.dashboard-sidebar-links {
  margin-top: auto;
  border-top: 1px solid var(--ctp-surface0);
  padding: 8px 0;
}

.dashboard-sidebar-link {
  display: block;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--ctp-subtext0);
  text-decoration: none;
  cursor: default;
  opacity: 0.5;
}

.dashboard-sidebar-link .coming-soon {
  font-size: 10px;
  color: var(--ctp-subtext0);
  margin-left: 4px;
}

/* Node count / lock icon */
.dashboard-node-count {
  font-size: 11px;
  color: var(--ctp-subtext0);
}

.dashboard-lock-icon {
  font-size: 11px;
  color: var(--ctp-subtext0);
}

/* Map panel */
.dashboard-map-container {
  flex: 1;
  position: relative;
  min-width: 0;
}

.dashboard-map-container .leaflet-container {
  width: 100%;
  height: 100%;
}

/* Empty state overlay */
.dashboard-map-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
  pointer-events: none;
}

.dashboard-map-empty-content {
  background: var(--ctp-mantle);
  border: 1px solid var(--ctp-surface0);
  border-radius: 8px;
  padding: 24px 32px;
  text-align: center;
  pointer-events: auto;
}

.dashboard-map-empty-content h3 {
  margin: 0 0 8px;
  color: var(--ctp-text);
  font-size: 16px;
}

.dashboard-map-empty-content p {
  margin: 0;
  color: var(--ctp-subtext1);
  font-size: 13px;
}

/* Sign In button */
.dashboard-signin-btn {
  background: var(--ctp-blue);
  color: var(--ctp-base);
  border: none;
  border-radius: 4px;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.dashboard-signin-btn:hover {
  opacity: 0.9;
}

/* Add Source button */
.dashboard-add-source-btn {
  background: var(--ctp-blue);
  color: var(--ctp-base);
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.dashboard-add-source-btn:hover {
  opacity: 0.9;
}

/* Confirmation dialog */
.dashboard-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.dashboard-confirm-dialog {
  background: var(--ctp-mantle);
  border: 1px solid var(--ctp-surface1);
  border-radius: 8px;
  padding: 20px 24px;
  max-width: 360px;
}

.dashboard-confirm-dialog h4 {
  margin: 0 0 8px;
  color: var(--ctp-text);
}

.dashboard-confirm-dialog p {
  margin: 0 0 16px;
  color: var(--ctp-subtext1);
  font-size: 13px;
}

.dashboard-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles/dashboard.css
git commit -m "feat: add dashboard page styles"
```

---

## Task 3: useDashboardData hook

**Files:**
- Create: `src/hooks/useDashboardData.ts`
- Create: `src/hooks/useDashboardData.test.ts`

Custom hooks that poll source-scoped data using TanStack Query.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useDashboardData.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the API module
vi.mock('../services/api', () => ({
  getApiBaseUrl: vi.fn(() => '/meshmonitor/api'),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { useDashboardSources, useDashboardSourceData } from './useDashboardData';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useDashboardSources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and returns sources', async () => {
    const sources = [
      { id: 'src-1', name: 'Test', type: 'meshtastic_tcp', enabled: true },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sources),
    });

    const { result } = renderHook(() => useDashboardSources(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sources);
  });

  it('returns empty array on fetch error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { result } = renderHook(() => useDashboardSources(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useDashboardSourceData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns disabled queries when sourceId is null', () => {
    const { result } = renderHook(() => useDashboardSourceData(null), {
      wrapper: createWrapper(),
    });

    expect(result.current.nodes).toEqual([]);
    expect(result.current.traceroutes).toEqual([]);
    expect(result.current.neighborInfo).toEqual([]);
    expect(result.current.status).toBeNull();
  });

  it('fetches nodes, traceroutes, neighbor-info, and status for a source', async () => {
    const mockNodes = [{ user: { id: '!aabbccdd' }, position: { latitude: 30, longitude: -90 } }];
    const mockTraceroutes = [{ id: 1, from: 100, to: 200 }];
    const mockNeighborInfo = [{ nodeNum: 100, neighborNodeNum: 200 }];
    const mockStatus = { connected: true, sourceId: 'src-1' };

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockNodes) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockTraceroutes) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockNeighborInfo) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockStatus) });

    const { result } = renderHook(() => useDashboardSourceData('src-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.nodes.length).toBeGreaterThan(0));
    expect(result.current.nodes).toEqual(mockNodes);
    expect(result.current.traceroutes).toEqual(mockTraceroutes);
    expect(result.current.neighborInfo).toEqual(mockNeighborInfo);
    expect(result.current.status).toEqual(mockStatus);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/hooks/useDashboardData.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the hooks**

Create `src/hooks/useDashboardData.ts`:

```typescript
import { useQuery, useQueries } from '@tanstack/react-query';
import { getApiBaseUrl } from '../services/api';

interface DashboardSource {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

interface SourceStatus {
  sourceId: string;
  sourceName?: string;
  sourceType?: string;
  connected: boolean;
  [key: string]: unknown;
}

const POLL_INTERVAL = 15_000;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Fetch all sources (public endpoint, no auth required) */
export function useDashboardSources() {
  return useQuery<DashboardSource[]>({
    queryKey: ['dashboard', 'sources'],
    queryFn: () => fetchJson<DashboardSource[]>(`${getApiBaseUrl()}/sources`),
    refetchInterval: POLL_INTERVAL,
  });
}

/** Fetch status for all sources in a single hook call */
export function useSourceStatuses(sourceIds: string[]) {
  const queries = useQueries({
    queries: sourceIds.map(id => ({
      queryKey: ['dashboard', 'status', id],
      queryFn: () => fetchJson<SourceStatus>(`${getApiBaseUrl()}/sources/${id}/status`).catch(() => null),
      refetchInterval: POLL_INTERVAL,
    })),
  });

  const statusMap = new Map<string, SourceStatus | null>();
  sourceIds.forEach((id, i) => {
    statusMap.set(id, queries[i]?.data ?? null);
  });

  return statusMap;
}

/** Fetch nodes, traceroutes, neighbor-info, and status for a single source */
export function useDashboardSourceData(sourceId: string | null) {
  const enabled = sourceId !== null;
  const base = `${getApiBaseUrl()}/sources/${sourceId}`;

  const nodesQuery = useQuery({
    queryKey: ['dashboard', 'nodes', sourceId],
    queryFn: () => fetchJson<any[]>(`${base}/nodes`),
    enabled,
    refetchInterval: POLL_INTERVAL,
  });

  const traceroutesQuery = useQuery({
    queryKey: ['dashboard', 'traceroutes', sourceId],
    queryFn: () => fetchJson<any[]>(`${base}/traceroutes`),
    enabled,
    refetchInterval: POLL_INTERVAL,
  });

  const neighborInfoQuery = useQuery({
    queryKey: ['dashboard', 'neighborInfo', sourceId],
    queryFn: () => fetchJson<any[]>(`${base}/neighbor-info`),
    enabled,
    refetchInterval: POLL_INTERVAL,
  });

  const statusQuery = useQuery({
    queryKey: ['dashboard', 'status', sourceId],
    queryFn: () => fetchJson<SourceStatus>(`${base}/status`).catch(() => null),
    enabled,
    refetchInterval: POLL_INTERVAL,
  });

  const channelsQuery = useQuery({
    queryKey: ['dashboard', 'channels', sourceId],
    queryFn: () => fetchJson<any[]>(`${base}/channels`),
    enabled,
    refetchInterval: POLL_INTERVAL,
  });

  return {
    nodes: nodesQuery.data ?? [],
    traceroutes: traceroutesQuery.data ?? [],
    neighborInfo: neighborInfoQuery.data ?? [],
    channels: channelsQuery.data ?? [],
    status: statusQuery.data ?? null,
    isLoading: nodesQuery.isLoading || traceroutesQuery.isLoading || neighborInfoQuery.isLoading,
    isError: nodesQuery.isError && traceroutesQuery.isError,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/hooks/useDashboardData.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useDashboardData.ts src/hooks/useDashboardData.test.ts
git commit -m "feat: add useDashboardData hooks for source polling"
```

---

## Task 4: DashboardSidebar component

**Files:**
- Create: `src/components/Dashboard/DashboardSidebar.tsx`
- Create: `src/components/Dashboard/DashboardSidebar.test.tsx`

Sidebar with source cards, status, node counts, kebab admin menu, and "coming soon" links.

- [ ] **Step 1: Write the failing test**

Create `src/components/Dashboard/DashboardSidebar.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardSidebar } from './DashboardSidebar';

const mockSources = [
  { id: 'src-1', name: 'Yeraze Sandbox', type: 'meshtastic_tcp', enabled: true },
  { id: 'src-2', name: 'Home Node', type: 'meshtastic_tcp', enabled: true },
  { id: 'src-3', name: 'MQTT Feed', type: 'mqtt', enabled: false },
];

const mockStatusMap = new Map([
  ['src-1', { sourceId: 'src-1', connected: true }],
  ['src-2', { sourceId: 'src-2', connected: false }],
  ['src-3', null],
]);

const mockNodeCounts = new Map([
  ['src-1', 5],
  ['src-2', 3],
  ['src-3', 0],
]);

function renderSidebar(overrides = {}) {
  const defaultProps = {
    sources: mockSources,
    statusMap: mockStatusMap,
    nodeCounts: mockNodeCounts,
    selectedSourceId: 'src-1',
    onSelectSource: vi.fn(),
    isAdmin: false,
    isAuthenticated: false,
    onAddSource: vi.fn(),
    onEditSource: vi.fn(),
    onToggleSource: vi.fn(),
    onDeleteSource: vi.fn(),
    ...overrides,
  };

  return render(
    <MemoryRouter>
      <DashboardSidebar {...defaultProps} />
    </MemoryRouter>
  );
}

describe('DashboardSidebar', () => {
  it('renders all source names', () => {
    renderSidebar();
    expect(screen.getByText('Yeraze Sandbox')).toBeInTheDocument();
    expect(screen.getByText('Home Node')).toBeInTheDocument();
    expect(screen.getByText('MQTT Feed')).toBeInTheDocument();
  });

  it('highlights selected source card', () => {
    renderSidebar();
    const selectedCard = screen.getByText('Yeraze Sandbox').closest('.dashboard-source-card');
    expect(selectedCard).toHaveClass('selected');
  });

  it('calls onSelectSource when clicking a card', () => {
    const onSelectSource = vi.fn();
    renderSidebar({ onSelectSource });

    fireEvent.click(screen.getByText('Home Node').closest('.dashboard-source-card')!);
    expect(onSelectSource).toHaveBeenCalledWith('src-2');
  });

  it('shows node count for authenticated users', () => {
    renderSidebar({ isAuthenticated: true });
    expect(screen.getByText(/5 nodes/)).toBeInTheDocument();
  });

  it('shows lock icon for unauthenticated users instead of node count', () => {
    renderSidebar({ isAuthenticated: false });
    expect(screen.queryByText(/5 nodes/)).not.toBeInTheDocument();
  });

  it('shows kebab menu button for admin users', () => {
    renderSidebar({ isAdmin: true });
    const kebabButtons = screen.getAllByRole('button', { name: /menu/i });
    expect(kebabButtons.length).toBeGreaterThan(0);
  });

  it('does not show kebab menu for non-admin users', () => {
    renderSidebar({ isAdmin: false });
    const kebabButtons = screen.queryAllByRole('button', { name: /menu/i });
    expect(kebabButtons).toHaveLength(0);
  });

  it('shows Add Source button for admin', () => {
    renderSidebar({ isAdmin: true });
    expect(screen.getByText('+ Add Source')).toBeInTheDocument();
  });

  it('shows "Coming soon" links', () => {
    renderSidebar();
    expect(screen.getByText(/Unified Messages/)).toBeInTheDocument();
    expect(screen.getByText(/Unified Telemetry/)).toBeInTheDocument();
  });

  it('disables Open button for disabled sources', () => {
    renderSidebar();
    const openButtons = screen.getAllByText(/Open/);
    // MQTT Feed (disabled) should have a disabled Open button
    const mqttCard = screen.getByText('MQTT Feed').closest('.dashboard-source-card');
    const openBtn = mqttCard?.querySelector('.dashboard-open-btn');
    expect(openBtn).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/components/Dashboard/DashboardSidebar.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the sidebar**

Create `src/components/Dashboard/DashboardSidebar.tsx`:

```typescript
import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

interface SourceStatus {
  sourceId: string;
  connected: boolean;
  [key: string]: unknown;
}

interface DashboardSource {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

interface DashboardSidebarProps {
  sources: DashboardSource[];
  statusMap: Map<string, SourceStatus | null>;
  nodeCounts: Map<string, number>;
  selectedSourceId: string | null;
  onSelectSource: (id: string) => void;
  isAdmin: boolean;
  isAuthenticated: boolean;
  onAddSource: () => void;
  onEditSource: (id: string) => void;
  onToggleSource: (id: string, enabled: boolean) => void;
  onDeleteSource: (id: string) => void;
}

function getStatusLabel(source: DashboardSource, status: SourceStatus | null | undefined): string {
  if (!source.enabled) return 'Disabled';
  if (!status) return 'Unknown';
  return status.connected ? 'Connected' : 'Connecting';
}

function getStatusClass(source: DashboardSource, status: SourceStatus | null | undefined): string {
  if (!source.enabled) return 'disabled';
  if (!status) return 'disconnected';
  return status.connected ? 'connected' : 'connecting';
}

export const DashboardSidebar: React.FC<DashboardSidebarProps> = ({
  sources,
  statusMap,
  nodeCounts,
  selectedSourceId,
  onSelectSource,
  isAdmin,
  isAuthenticated,
  onAddSource,
  onEditSource,
  onToggleSource,
  onDeleteSource,
}) => {
  const navigate = useNavigate();
  const [openKebab, setOpenKebab] = useState<string | null>(null);
  const kebabRef = useRef<HTMLDivElement>(null);

  // Close kebab on outside click
  useEffect(() => {
    if (!openKebab) return;
    const handler = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) {
        setOpenKebab(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openKebab]);

  return (
    <div className="dashboard-sidebar">
      <div className="dashboard-sidebar-header">Sources</div>

      {sources.map(source => {
        const status = statusMap.get(source.id);
        const nodeCount = nodeCounts.get(source.id) ?? 0;
        const isSelected = source.id === selectedSourceId;

        return (
          <div
            key={source.id}
            className={`dashboard-source-card${isSelected ? ' selected' : ''}`}
            onClick={() => onSelectSource(source.id)}
          >
            <div className="dashboard-source-card-header">
              <span className="dashboard-source-card-name">{source.name}</span>
              <span className="dashboard-source-card-badge">{source.type === 'mqtt' ? 'mqtt' : 'tcp'}</span>
              {isAdmin && (
                <div style={{ position: 'relative' }} ref={openKebab === source.id ? kebabRef : undefined}>
                  <button
                    className="dashboard-kebab-btn"
                    aria-label="menu"
                    onClick={e => {
                      e.stopPropagation();
                      setOpenKebab(openKebab === source.id ? null : source.id);
                    }}
                  >
                    &#8942;
                  </button>
                  {openKebab === source.id && (
                    <div className="dashboard-kebab-menu">
                      <button
                        className="dashboard-kebab-item"
                        onClick={e => { e.stopPropagation(); setOpenKebab(null); onEditSource(source.id); }}
                      >
                        Edit
                      </button>
                      <button
                        className="dashboard-kebab-item"
                        onClick={e => { e.stopPropagation(); setOpenKebab(null); onToggleSource(source.id, !source.enabled); }}
                      >
                        {source.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="dashboard-kebab-item danger"
                        onClick={e => { e.stopPropagation(); setOpenKebab(null); onDeleteSource(source.id); }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="dashboard-source-card-status">
              <span className={`dashboard-status-dot ${getStatusClass(source, status)}`} />
              <span>{getStatusLabel(source, status)}</span>
              {isAuthenticated ? (
                <span className="dashboard-node-count"> &middot; {nodeCount} nodes</span>
              ) : (
                <span className="dashboard-lock-icon" title="Sign in to view">&#128274;</span>
              )}
            </div>

            <div className="dashboard-source-card-actions">
              <button
                className="dashboard-open-btn"
                disabled={!source.enabled}
                onClick={e => {
                  e.stopPropagation();
                  navigate(`/source/${source.id}`);
                }}
              >
                Open &rarr;
              </button>
            </div>
          </div>
        );
      })}

      {/* Cross-source links (coming soon) */}
      <div className="dashboard-sidebar-links">
        <span className="dashboard-sidebar-link">
          &#128172; Unified Messages <span className="coming-soon">(coming soon)</span>
        </span>
        <span className="dashboard-sidebar-link">
          &#128225; Unified Telemetry <span className="coming-soon">(coming soon)</span>
        </span>
      </div>
    </div>
  );
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/components/Dashboard/DashboardSidebar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/Dashboard/DashboardSidebar.tsx src/components/Dashboard/DashboardSidebar.test.tsx
git commit -m "feat: add DashboardSidebar component with source cards and kebab menu"
```

---

## Task 5: DashboardMap component

**Files:**
- Create: `src/components/Dashboard/DashboardMap.tsx`
- Create: `src/components/Dashboard/DashboardMap.test.tsx`

Self-contained map component that renders node markers, popups, neighbor lines, and traceroute paths. Uses react-leaflet `MapContainer`, `TileLayer`, `Marker`, `Popup`, `Polyline`.

- [ ] **Step 1: Write the failing test**

Create `src/components/Dashboard/DashboardMap.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// Mock react-leaflet — the actual map can't render in jsdom
vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map-container">{children}</div>,
  TileLayer: () => <div data-testid="tile-layer" />,
  Marker: ({ children }: any) => <div data-testid="map-marker">{children}</div>,
  Popup: ({ children }: any) => <div data-testid="map-popup">{children}</div>,
  Polyline: () => <div data-testid="map-polyline" />,
  useMap: () => ({ fitBounds: vi.fn(), setView: vi.fn() }),
}));

vi.mock('leaflet', () => ({
  default: {
    divIcon: () => ({}),
    latLngBounds: () => ({ isValid: () => false }),
    latLng: (lat: number, lng: number) => ({ lat, lng }),
  },
  divIcon: () => ({}),
  latLngBounds: () => ({ isValid: () => false }),
  latLng: (lat: number, lng: number) => ({ lat, lng }),
}));

vi.mock('../../utils/mapIcons', () => ({
  createNodeIcon: () => ({}),
  getHopColor: () => '#000',
}));

import { DashboardMap } from './DashboardMap';

const baseProps = {
  nodes: [],
  neighborInfo: [],
  traceroutes: [],
  channels: [],
  tilesetId: 'osm' as const,
  customTilesets: [],
  defaultCenter: { lat: 30.0, lng: -90.0 },
};

describe('DashboardMap', () => {
  it('renders the map container', () => {
    render(<DashboardMap {...baseProps} />);
    expect(screen.getByTestId('map-container')).toBeInTheDocument();
  });

  it('renders markers for nodes with positions', () => {
    const nodes = [
      {
        user: { id: '!aabbccdd', shortName: 'TST', longName: 'Test Node' },
        position: { latitude: 30.0, longitude: -90.0 },
        hopsAway: 1,
      },
    ];
    render(<DashboardMap {...baseProps} nodes={nodes} />);
    expect(screen.getByTestId('map-marker')).toBeInTheDocument();
  });

  it('does not render markers for nodes without positions', () => {
    const nodes = [
      {
        user: { id: '!aabbccdd', shortName: 'TST', longName: 'Test Node' },
        position: null,
        hopsAway: 1,
      },
    ];
    render(<DashboardMap {...baseProps} nodes={nodes} />);
    expect(screen.queryByTestId('map-marker')).not.toBeInTheDocument();
  });

  it('renders polylines for neighbor links with positions', () => {
    const neighborInfo = [
      {
        nodeNum: 100, neighborNodeNum: 200,
        nodeLatitude: 30.0, nodeLongitude: -90.0,
        neighborLatitude: 30.1, neighborLongitude: -90.1,
        bidirectional: true, snr: 5.5,
      },
    ];
    render(<DashboardMap {...baseProps} neighborInfo={neighborInfo} />);
    expect(screen.getByTestId('map-polyline')).toBeInTheDocument();
  });

  it('shows empty state when no nodes have positions', () => {
    render(<DashboardMap {...baseProps} nodes={[]} />);
    expect(screen.getByText(/No node positions/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/components/Dashboard/DashboardMap.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the map component**

Create `src/components/Dashboard/DashboardMap.tsx`:

```typescript
import React, { useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { createNodeIcon, getHopColor } from '../../utils/mapIcons';
import { getTilesetById } from '../../config/tilesets';
import type { CustomTileset } from '../../config/tilesets';

interface NodePosition {
  latitude: number;
  longitude: number;
  altitude?: number;
}

interface MapNode {
  user?: {
    id: string;
    shortName?: string;
    longName?: string;
  };
  position?: NodePosition | null;
  hopsAway?: number;
  role?: number;
  channel?: number;
}

interface EnrichedNeighborInfo {
  nodeNum: number;
  neighborNodeNum: number;
  nodeLatitude?: number;
  nodeLongitude?: number;
  neighborLatitude?: number;
  neighborLongitude?: number;
  bidirectional?: boolean;
  snr?: number;
}

interface DashboardMapProps {
  nodes: MapNode[];
  neighborInfo: EnrichedNeighborInfo[];
  traceroutes: any[];
  channels: any[];
  tilesetId: string;
  customTilesets: CustomTileset[];
  defaultCenter: { lat: number; lng: number };
}

/** Filter nodes to only those with valid lat/lng */
function getNodesWithPositions(nodes: MapNode[]): (MapNode & { position: NodePosition })[] {
  return nodes.filter(
    (n): n is MapNode & { position: NodePosition } =>
      n.position != null &&
      typeof n.position.latitude === 'number' &&
      typeof n.position.longitude === 'number' &&
      n.position.latitude !== 0 &&
      n.position.longitude !== 0
  );
}

/** Filter neighbor info to only links where both endpoints have positions */
function getLinksWithPositions(neighborInfo: EnrichedNeighborInfo[]): EnrichedNeighborInfo[] {
  return neighborInfo.filter(
    ni =>
      ni.nodeLatitude != null &&
      ni.nodeLongitude != null &&
      ni.neighborLatitude != null &&
      ni.neighborLongitude != null
  );
}

export const DashboardMap: React.FC<DashboardMapProps> = ({
  nodes,
  neighborInfo,
  traceroutes: _traceroutes,
  channels: _channels,
  tilesetId,
  customTilesets,
  defaultCenter,
}) => {
  const nodesWithPos = useMemo(() => getNodesWithPositions(nodes), [nodes]);
  const linksWithPos = useMemo(() => getLinksWithPositions(neighborInfo), [neighborInfo]);

  const tileset = getTilesetById(tilesetId, customTilesets);

  // Compute map bounds from node positions
  const bounds = useMemo(() => {
    if (nodesWithPos.length === 0) return null;
    const lats = nodesWithPos.map(n => n.position.latitude);
    const lngs = nodesWithPos.map(n => n.position.longitude);
    return L.latLngBounds(
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)]
    );
  }, [nodesWithPos]);

  const center: [number, number] = bounds && bounds.isValid()
    ? [bounds.getCenter().lat, bounds.getCenter().lng]
    : [defaultCenter.lat, defaultCenter.lng];

  return (
    <div className="dashboard-map-container">
      <MapContainer
        center={center}
        zoom={10}
        style={{ width: '100%', height: '100%' }}
        zoomControl={true}
      >
        <TileLayer
          url={tileset.url}
          attribution={tileset.attribution}
          maxZoom={tileset.maxZoom}
        />

        {/* Auto-fit bounds when nodes change */}
        {bounds && bounds.isValid() && <MapBoundsUpdater bounds={bounds} />}

        {/* Node markers */}
        {nodesWithPos.map(node => {
          const hops = node.hopsAway ?? 999;
          const icon = createNodeIcon({
            hops,
            isSelected: false,
            isRouter: node.role === 2, // ROUTER role
            shortName: node.user?.shortName,
            showLabel: true,
          });

          return (
            <Marker
              key={node.user?.id ?? `${node.position.latitude}-${node.position.longitude}`}
              position={[node.position.latitude, node.position.longitude]}
              icon={icon}
            >
              <Popup>
                <div style={{ minWidth: 150 }}>
                  <strong>{node.user?.longName || node.user?.shortName || 'Unknown'}</strong>
                  {node.user?.shortName && (
                    <span style={{ marginLeft: 6, opacity: 0.7 }}>({node.user.shortName})</span>
                  )}
                  <br />
                  <small>
                    {node.position.latitude.toFixed(5)}, {node.position.longitude.toFixed(5)}
                  </small>
                  {hops !== 999 && (
                    <>
                      <br />
                      <small>{hops === 0 ? 'Direct' : `${hops} hop${hops > 1 ? 's' : ''}`}</small>
                    </>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* Neighbor link lines */}
        {linksWithPos.map((ni, idx) => (
          <Polyline
            key={`neighbor-${ni.nodeNum}-${ni.neighborNodeNum}-${idx}`}
            positions={[
              [ni.nodeLatitude!, ni.nodeLongitude!],
              [ni.neighborLatitude!, ni.neighborLongitude!],
            ]}
            pathOptions={{
              color: ni.bidirectional ? 'var(--ctp-blue, #89b4fa)' : 'var(--ctp-surface2, #585b70)',
              weight: ni.bidirectional ? 2 : 1,
              opacity: 0.6,
              dashArray: ni.bidirectional ? undefined : '5,5',
            }}
          />
        ))}
      </MapContainer>

      {/* Empty state overlay */}
      {nodesWithPos.length === 0 && (
        <div className="dashboard-map-empty">
          <div className="dashboard-map-empty-content">
            <h3>No node positions</h3>
            <p>Select a source with nodes that have GPS positions to see them on the map.</p>
          </div>
        </div>
      )}
    </div>
  );
};

/** Helper component to auto-fit bounds */
function MapBoundsUpdater({ bounds }: { bounds: L.LatLngBounds }) {
  const map = (await import('react-leaflet')).useMap();
  React.useEffect(() => {
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
  }, [bounds, map]);
  return null;
}
```

**Important fix:** The `MapBoundsUpdater` above uses a top-level await which won't work. Replace it with a proper import:

```typescript
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';

// ... (remove the async import)

function MapBoundsUpdater({ bounds }: { bounds: L.LatLngBounds }) {
  const map = useMap();
  React.useEffect(() => {
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
  }, [bounds, map]);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/components/Dashboard/DashboardMap.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/Dashboard/DashboardMap.tsx src/components/Dashboard/DashboardMap.test.tsx
git commit -m "feat: add DashboardMap component with markers, popups, and neighbor lines"
```

---

## Task 6: DashboardPage component and routing

**Files:**
- Create: `src/pages/DashboardPage.tsx`
- Create: `src/pages/DashboardPage.test.tsx`
- Modify: `src/main.tsx:14` (replace SourceListPage import)
- Modify: `src/main.tsx:77-80` (replace landing route)

The page that wires everything together: selected source state, data fetching, sidebar, map, auth, and admin actions.

- [ ] **Step 1: Write the failing test**

Create `src/pages/DashboardPage.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock all child components and hooks
vi.mock('../hooks/useDashboardData', () => ({
  useDashboardSources: vi.fn(() => ({
    data: [
      { id: 'src-1', name: 'Test Source', type: 'meshtastic_tcp', enabled: true },
    ],
    isSuccess: true,
    isLoading: false,
  })),
  useSourceStatuses: vi.fn(() => new Map([['src-1', { sourceId: 'src-1', connected: true }]])),
  useDashboardSourceData: vi.fn(() => ({
    nodes: [],
    traceroutes: [],
    neighborInfo: [],
    channels: [],
    status: { sourceId: 'src-1', connected: true },
    isLoading: false,
    isError: false,
  })),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: vi.fn(() => ({
    user: null,
    isAuthenticated: false,
    isAdmin: false,
    hasPermission: () => false,
  })),
}));

vi.mock('../contexts/SettingsContext', () => ({
  SettingsProvider: ({ children }: any) => <div>{children}</div>,
  useSettings: vi.fn(() => ({
    mapTileset: 'osm',
    customTilesets: [],
    defaultMapCenterLat: '30.0',
    defaultMapCenterLng: '-90.0',
  })),
}));

vi.mock('../components/Dashboard/DashboardSidebar', () => ({
  DashboardSidebar: () => <div data-testid="dashboard-sidebar">Sidebar</div>,
}));

vi.mock('../components/Dashboard/DashboardMap', () => ({
  DashboardMap: () => <div data-testid="dashboard-map">Map</div>,
}));

import DashboardPage from './DashboardPage';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the top bar with logo text', () => {
    renderPage();
    expect(screen.getByText('MeshMonitor')).toBeInTheDocument();
  });

  it('renders the sidebar', () => {
    renderPage();
    expect(screen.getByTestId('dashboard-sidebar')).toBeInTheDocument();
  });

  it('renders the map', () => {
    renderPage();
    expect(screen.getByTestId('dashboard-map')).toBeInTheDocument();
  });

  it('shows Sign In button when not authenticated', () => {
    renderPage();
    expect(screen.getByText('Sign In')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run src/pages/DashboardPage.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement DashboardPage**

Create `src/pages/DashboardPage.tsx`:

```typescript
import React, { useState, useMemo, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { SettingsProvider, useSettings } from '../contexts/SettingsContext';
import { useDashboardSources, useSourceStatuses, useDashboardSourceData } from '../hooks/useDashboardData';
import { DashboardSidebar } from '../components/Dashboard/DashboardSidebar';
import { DashboardMap } from '../components/Dashboard/DashboardMap';
import { LoginModal } from '../components/LoginModal';
import { getApiBaseUrl } from '../services/api';
import '../styles/dashboard.css';

/** Inner component that uses SettingsContext */
function DashboardInner() {
  const { user, isAdmin } = useAuth();
  const isAuthenticated = !!user;
  const settings = useSettings();
  const { mapTileset, customTilesets, defaultMapCenterLat, defaultMapCenterLng } = settings;

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Fetch sources
  const { data: sources = [], isSuccess: sourcesLoaded } = useDashboardSources();

  // Auto-select first enabled source once sources load
  React.useEffect(() => {
    if (sourcesLoaded && sources.length > 0 && !selectedSourceId) {
      const firstEnabled = sources.find(s => s.enabled);
      if (firstEnabled) setSelectedSourceId(firstEnabled.id);
      else setSelectedSourceId(sources[0].id);
    }
  }, [sourcesLoaded, sources, selectedSourceId]);

  // Fetch statuses for all sources
  const sourceIds = useMemo(() => sources.map(s => s.id), [sources]);
  const statusMap = useSourceStatuses(sourceIds);

  // Fetch data for selected source
  const { nodes, traceroutes, neighborInfo, channels } = useDashboardSourceData(selectedSourceId);

  // Node count per source (use nodes from selected source, 0 for others)
  const nodeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    sources.forEach(s => counts.set(s.id, 0));
    if (selectedSourceId) counts.set(selectedSourceId, nodes.length);
    return counts;
  }, [sources, selectedSourceId, nodes]);

  const defaultCenter = {
    lat: parseFloat(defaultMapCenterLat) || 30.0,
    lng: parseFloat(defaultMapCenterLng) || -90.0,
  };

  // Admin actions
  const handleAddSource = useCallback(() => {
    // TODO: Open add source modal — re-use existing modal from SourceListPage or create new one
    // For now, this is a placeholder that will be connected in a follow-up
  }, []);

  const handleEditSource = useCallback((_id: string) => {
    // TODO: Open edit source modal
  }, []);

  const handleToggleSource = useCallback(async (id: string, enabled: boolean) => {
    try {
      await fetch(`${getApiBaseUrl()}/sources/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled }),
      });
    } catch {
      // Silently fail — the next poll will show the real state
    }
  }, []);

  const handleDeleteSource = useCallback((id: string) => {
    setDeleteConfirm(id);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    try {
      await fetch(`${getApiBaseUrl()}/sources/${deleteConfirm}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (selectedSourceId === deleteConfirm) {
        setSelectedSourceId(null);
      }
    } catch {
      // Silently fail
    }
    setDeleteConfirm(null);
  }, [deleteConfirm, selectedSourceId]);

  return (
    <div className="dashboard-page">
      {/* Top bar */}
      <div className="dashboard-topbar">
        <div className="dashboard-topbar-logo">
          <img src="logo.png" alt="" />
          MeshMonitor
        </div>
        <div className="dashboard-topbar-actions">
          {isAdmin && (
            <button className="dashboard-add-source-btn" onClick={handleAddSource}>
              + Add Source
            </button>
          )}
          {!isAuthenticated ? (
            <button className="dashboard-signin-btn" onClick={() => setShowLogin(true)}>
              Sign In
            </button>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--ctp-subtext1)' }}>
              {user?.username}
            </span>
          )}
        </div>
      </div>

      {/* Main body */}
      <div className="dashboard-body">
        <DashboardSidebar
          sources={sources}
          statusMap={statusMap}
          nodeCounts={nodeCounts}
          selectedSourceId={selectedSourceId}
          onSelectSource={setSelectedSourceId}
          isAdmin={isAdmin}
          isAuthenticated={isAuthenticated}
          onAddSource={handleAddSource}
          onEditSource={handleEditSource}
          onToggleSource={handleToggleSource}
          onDeleteSource={handleDeleteSource}
        />

        <DashboardMap
          nodes={nodes}
          neighborInfo={neighborInfo}
          traceroutes={traceroutes}
          channels={channels}
          tilesetId={mapTileset}
          customTilesets={customTilesets}
          defaultCenter={defaultCenter}
        />
      </div>

      {/* Login modal */}
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="dashboard-confirm-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="dashboard-confirm-dialog" onClick={e => e.stopPropagation()}>
            <h4>Delete Source</h4>
            <p>Are you sure? This will remove the source and all its data. This action cannot be undone.</p>
            <div className="dashboard-confirm-actions">
              <button
                className="dashboard-open-btn"
                style={{ flex: 'none', padding: '6px 16px', background: 'var(--ctp-surface1)', color: 'var(--ctp-subtext1)' }}
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="dashboard-open-btn"
                style={{ flex: 'none', padding: '6px 16px', background: 'var(--ctp-red)' }}
                onClick={confirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Wraps DashboardInner in SettingsProvider (needed since DashboardPage lives outside the per-source App) */
export default function DashboardPage() {
  return (
    <SettingsProvider>
      <DashboardInner />
    </SettingsProvider>
  );
}
```

Note: The `LoginModal` import may need adjustment based on the existing export. Check `src/components/LoginModal.tsx` for the correct export name. If it's not directly importable (e.g., it's part of App.tsx), you may need to extract it or use a simpler login redirect approach.

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run src/pages/DashboardPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Update routing in main.tsx**

In `src/main.tsx`, replace the SourceListPage import and route:

Replace:
```typescript
import SourceListPage from './pages/SourceListPage.tsx';
```
With:
```typescript
import DashboardPage from './pages/DashboardPage.tsx';
```

Replace the landing route (lines 76-80):
```typescript
            {/* Source list / landing page */}
            <Route
              path="*"
              element={sharedProviders(<SourceListPage />)}
            />
```
With:
```typescript
            {/* Dashboard / landing page */}
            <Route
              path="*"
              element={sharedProviders(<DashboardPage />)}
            />
```

- [ ] **Step 6: Verify the app compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 7: Run all tests**

Run: `node_modules/.bin/vitest run src/pages/DashboardPage.test.tsx src/components/Dashboard/DashboardSidebar.test.tsx src/components/Dashboard/DashboardMap.test.tsx src/hooks/useDashboardData.test.ts`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add src/pages/DashboardPage.tsx src/pages/DashboardPage.test.tsx src/main.tsx
git commit -m "feat: add DashboardPage and wire up as landing page at /"
```

---

## Task 7: Clean up old SourceListPage

**Files:**
- Delete: `src/pages/SourceListPage.tsx`
- Delete: `src/styles/sources.css` (if it exists)

- [ ] **Step 1: Check for remaining references to SourceListPage**

Run: `grep -r "SourceListPage" src/ --include="*.ts" --include="*.tsx"`
Expected: No references (after main.tsx was updated in Task 6)

- [ ] **Step 2: Check if sources.css exists and is imported**

Run: `find src/styles -name "sources.css" 2>/dev/null`
Run: `grep -r "sources.css" src/ --include="*.ts" --include="*.tsx"`

- [ ] **Step 3: Delete the files**

```bash
rm -f src/pages/SourceListPage.tsx src/styles/sources.css
```

- [ ] **Step 4: Verify no import errors**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run the full test suite**

Run: `node_modules/.bin/vitest run`
Expected: All tests pass (SourceListPage tests will be gone with the file)

- [ ] **Step 6: Commit**

```bash
git add -u src/pages/SourceListPage.tsx src/styles/sources.css
git commit -m "chore: remove replaced SourceListPage and sources.css"
```

---

## Task 8: Integration testing

**Files:**
- No new files — manual and automated verification

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run all unit tests**

Run: `node_modules/.bin/vitest run`
Expected: All tests pass

- [ ] **Step 3: Run system tests**

Run: `./tests/system-tests.sh`
Expected: All pass

- [ ] **Step 4: Manual verification checklist**

Build and start the dev container:
```bash
COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml build --no-cache && COMPOSE_PROFILES=sqlite docker compose -f docker-compose.dev.yml up -d --force-recreate
```

Verify in browser at `http://localhost:8081/meshmonitor`:

1. Dashboard loads at `/` with sidebar and map
2. Source cards show in sidebar with correct status indicators
3. Clicking a source card updates the map to show that source's nodes
4. "Open" button navigates to `/source/:sourceId` (per-source view)
5. Anonymous user sees source cards with lock icon instead of node counts
6. Sign In button opens login modal
7. After login, node counts appear and map shows node markers
8. Admin user sees kebab menu (Edit/Disable/Delete) and "Add Source" button
9. Disable/Enable toggle works via kebab menu
10. Delete with confirmation dialog works
11. Empty map shows "No node positions" overlay
12. Neighbor link lines appear between nodes with positions
13. Unified Messages and Unified Telemetry show as "coming soon"

- [ ] **Step 5: Commit any fixes from manual testing**

```bash
git add -A
git commit -m "fix: integration testing fixes for dashboard page"
```

---

## Notes for Implementers

### LoginModal Import
The `LoginModal` component may not exist as a standalone file. Check how login is handled in the existing codebase:
- If there's a `LoginModal` component in `src/components/`, import it directly
- If login is embedded in `App.tsx`, you may need to extract it first or implement a simple login form inline in DashboardPage

### SettingsProvider Dependency
`DashboardPage` wraps itself in `SettingsProvider` because it lives outside the per-source `App` component which normally provides settings. This means `useSettings()` works inside `DashboardInner`.

### CSRF Tokens
API calls that mutate data (PUT, DELETE) may need CSRF tokens. The `CsrfProvider` is in the shared providers wrapping DashboardPage in `main.tsx`, so `useCsrf()` should be available. Add CSRF headers to the fetch calls in `handleToggleSource` and `confirmDelete` if the server requires them.

### Channel Visibility Filtering
The spec says nodes should only appear on the map if the user has `sources:read` permission AND the channel has "view on map" enabled. The backend's `GET /api/sources/:id/nodes` endpoint already enforces `sources:read` via `requirePermission`. Channel-level filtering (`filterNodesByChannelPermission` from `src/server/utils/nodeEnhancer.ts`) is NOT currently applied in the source routes endpoint — this may need to be added server-side in a follow-up task if the existing endpoint doesn't already filter by channel visibility.
