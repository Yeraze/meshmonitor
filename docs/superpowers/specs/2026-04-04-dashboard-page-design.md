# MeshMonitor Dashboard Page Design

**Goal:** Replace the SourceListPage with a map-centric dashboard that lists sources in a left sidebar and shows node positions for the selected source on the map, respecting per-user and per-channel permissions.

**Architecture:** Two-panel layout — collapsible left sidebar with source cards and a full-screen react-leaflet map. `DashboardPage` owns selected-source state and fetches data; `SourceMap` is extracted from `NodesTab` as a reusable map component.

**Tech Stack:** React, react-leaflet, TypeScript, `--ctp-*` CSS variables, existing MeshMonitor API endpoints.

---

## Layout

`DashboardPage` lives at `/` and replaces `SourceListPage`. It renders:

- **Top bar**: MeshMonitor logo on the left; "Add Source" button (admin only) and Sign In / user menu on the right.
- **Left sidebar** (~200px, `--ctp-mantle` background): source cards stacked vertically, cross-source links pinned at the bottom.
- **Right panel**: full-screen map (flex-1), showing nodes for the currently selected source.

The existing per-source App at `/source/:sourceId/*` is **not changed**. The "Open →" button on each source card navigates there.

---

## Source Cards (Sidebar)

Each card displays:

| Element | Visibility |
|---|---|
| Source name + type badge (`tcp` / `mqtt`) | All users |
| Status dot + label (Connected / Connecting / Disabled) | All users |
| Node count | Authenticated users with `sources:read` |
| 🔒 lock icon (in place of node count) | When user lacks `sources:read` |
| **Open →** button | All users (disabled if source is disabled) |
| **⋮ kebab menu** | Admin users only |

**Kebab menu actions** (admin only): Edit (opens add/edit modal), Enable/Disable toggle, Delete (with confirmation).

**"Add Source"** button in the top bar opens the add modal (admin only).

At the bottom of the sidebar, always visible regardless of auth state:

- 💬 Unified Messages — **Coming soon** (link disabled, greyed out)
- 📡 Unified Telemetry — **Coming soon** (link disabled, greyed out)

---

## Map Behavior

The map renders the **selected source's** data using the same full feature set as the existing per-source map:

- Node markers (existing icon logic: color by battery level, role, etc.)
- Neighbor link lines between nodes
- Traceroute path overlays
- Click a marker → full node popup (name, short name, last heard, battery, position, hops away)

**Default selection:** The first enabled source in the list. If no sources exist, the map shows an empty state; admins see an "Add Source" prompt.

**Polling:** Every 15 seconds — `GET /api/sources/:id/nodes`, `GET /api/sources/:id/status`, `GET /api/sources/:id/traceroutes`.

---

## Map Visibility Rules

A node's position is rendered on the map only when **both** conditions are met:

1. The current user (including anonymous) has `sources:read` permission for that source.
2. The channel the node was heard on has **"View on Map"** enabled for that user.

These are the same rules already applied in the per-source map view — the dashboard applies them identically across the source switcher.

**For anonymous users:** Nodes are visible only if the source grants anonymous `sources:read` AND the relevant channels have map visibility open. If neither condition is met, the map renders empty with a "Sign in to view nodes" hint overlay.

**Source cards** are always shown in the sidebar (name + lock icon) even when the user cannot see that source's nodes, so they know the source exists and can choose to sign in.

---

## Authentication & Login

- A **Sign In** button sits in the top-right of the top bar for unauthenticated users.
- Clicking it opens the existing `LoginModal`.
- After login the page re-fetches sources and refreshes map data without a full reload.
- No bottom banner or interstitial — the page is usable (read-only for public sources) without logging in.

---

## Components & File Changes

### New files

| File | Purpose |
|---|---|
| `src/pages/DashboardPage.tsx` | Top-level page; owns selected-source state, fetches and polls data |
| `src/components/Dashboard/DashboardSidebar.tsx` | Source card list, kebab menu, cross-source links |
| `src/components/Dashboard/SourceMap.tsx` | Reusable map component extracted from `NodesTab`; accepts `nodes`, `neighborInfo`, `traceroutes` as props |
| `src/styles/dashboard.css` | Layout and sidebar styles using `--ctp-*` variables |

### Modified files

| File | Change |
|---|---|
| `src/main.tsx` | Route `/` → `DashboardPage` (replaces `SourceListPage`) |
| `src/components/NodesTab.tsx` | Refactored to use `SourceMap` internally; no behavior change to per-source view |

### Removed files

| File | Reason |
|---|---|
| `src/pages/SourceListPage.tsx` | Replaced by `DashboardPage` |
| `src/styles/sources.css` | No longer needed |

### Unchanged

- All existing API endpoints — no new backend required.
- The per-source App at `/source/:sourceId/*`.
- `UnifiedMessagesPage`, `UnifiedTelemetryPage`, `AnalysisPage`.

---

## API Endpoints Used

| Endpoint | Auth required | Purpose |
|---|---|---|
| `GET /api/sources` | None (optionalAuth) | Source list for sidebar |
| `GET /api/sources/:id/status` | `sources:read` | Connection status per card |
| `GET /api/sources/:id/nodes` | `sources:read` | Node positions for map |
| `GET /api/sources/:id/traceroutes` | `sources:read` | Traceroute overlays |
| `GET /api/neighbor-info` (scoped) | `sources:read` | Neighbor link lines |

Status, nodes, and traceroute requests fail gracefully for users without `sources:read` — the map renders empty for that source.
