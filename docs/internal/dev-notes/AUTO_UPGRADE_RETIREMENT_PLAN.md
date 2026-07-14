# Auto-Upgrade Retirement Plan

**Status:** IMPLEMENTING — Phases 1+2 combined for 4.13
**Author:** drafted 2026-07-13

## Implementation notes (Phases 1+2 combined, 4.13)

Phases 1 and 2 were shipped together in 4.13 rather than across two minors —
the deprecation-overlap release was skipped, so unattended auto-apply, manual
one-click, and all execution machinery were removed in the same release while
the notification replacement landed alongside.

Backend deltas vs. the plan:

- **New `src/server/services/versionCheckService.ts`** — single server-side
  poller (6h; first check ~60s after `waitForReady()`; skipped when
  `versionCheckDisabled`). Caches the full status and fires
  `notifyUpgradeAvailable` headlessly. `getStatus()` does an on-demand refresh
  when the cache is older than ~5 min (preserves the old endpoint's freshness).
  A local `lastNotifiedVersion` guard complements the helper's dedupe so a
  repeated poll for the same version does not re-invoke the event.
- **`detectDeploymentMethod()`** extracted verbatim into
  `src/server/utils/deployment.ts` (module-level cache), typed
  `'docker' | 'lxc' | 'kubernetes' | 'manual'`.
- **`GET /api/system/version/check`** is now a cache read through
  versionCheckService. Removed the `autoUpgradeImmediate` trigger branch and the
  `autoUpgradeTriggered` field; **added** a `deploymentMethod` field. Response
  stays a bare JSON object (not wrapped in `ok()`), 404 when
  `versionCheckDisabled` preserved.
- **`src/server/routes/upgradeRoutes.ts`** replaced with `410` stubs
  (`FEATURE_RETIRED`, docs link `https://yeraze.github.io/meshmonitor/configuration/updating`)
  via the shared `fail()` envelope; router kept mounted at `/api/upgrade` so old
  frontends get clean 410s.
- **Migration 117** (`117_drop_upgrade_history.ts`) drops `upgrade_history`
  (all backends, idempotent) and deletes the `autoUpgradeImmediate` /
  `autoUpgradeBlocked` / `autoUpgradeBlockedReason` settings rows. (origin/main's
  latest was 116.)
- **Deleted:** `upgradeService.ts`(+test), `upgradeHistory.ts` repo(+test),
  `scripts/upgrade-watchdog.sh`, `scripts/test-docker-socket.sh`,
  `docker-compose.upgrade.yml`, `docker-compose.upgrade-test.yml`, the
  `upgrade_history` schema (misc.ts/activeSchema.ts) + facade wiring
  (database.ts), the server.ts auto-upgrade scheduler/boot-sync block, and the
  `scriptRoutes` watchdog special cases. Also scrubbed `upgrade_history` from
  `systemBackupService`, `cli/migrate-db.ts`, and `cli/migrationTables.ts`.
- **`docker/docker-entrypoint.sh`** no longer deploys the watchdog/socket-test
  scripts; it best-effort deletes stale `/data/.upgrade-*`,
  `/data/.docker-socket-test*`, and the retired internal scripts, and prints a
  single warning if `AUTO_UPGRADE_ENABLED` is still truthy.
- **Frontend (owned by a later agent):** `src/hooks/useAutoUpgrade.ts`,
  `src/components/configuration/AutoUpgradeTestSection.tsx`,
  `src/components/AppBanners/AppBanners.tsx`, and `src/App.tsx` still reference
  the removed `autoUpgradeTriggered` / `autoUpgradeBlock` response fields and the
  hidden settings toggle. These are intentionally untouched here.

---

## Original plan
**Decision:** Retire in-app upgrade *execution* (watchdog sidecar, trigger/status
file protocol, circuit breaker, unattended scheduler). Keep and strengthen
update *detection and notification*, with deployment-native upgrade
instructions surfaced in the UI.

## Why

The auto-upgrade subsystem has a >50% fix ratio (~50 commits to
`upgradeService.ts` / `upgrade-watchdog.sh` / `docker-compose.upgrade.yml`,
27 of them fixes). The failures are structural, not incidental:

1. **Distributed system on shared files with no handshake.** Backend, sidecar,
   and Docker daemon coordinate through `.upgrade-trigger` / `.upgrade-status`
   with no locking, no acks, and no upgrade-ID in the status file. Roughly half
   of `upgradeService.ts` is reconciliation code (sync-on-read, 30-min stale
   reaper, boot-time sync #3228, circuit breaker + auto-heal #2871) compensating
   for races the design guarantees.
2. **The process reporting status is killed mid-operation by design.** The
   backend can never directly observe its own upgrade completing — root cause
   of false circuit-breaker trips and spurious "failed" toasts.
3. **The sidecar must reverse-engineer the user's deployment.** Compose paths
   (three fallbacks), file extensions, project labels, lost `.env`
   interpolation, Portainer/Synology/Unraid stacks, podman. Every "specialized
   Docker environment" complaint is one of these unbounded assumptions breaking.
4. **Requires root-equivalent host access** (Docker socket) for a convenience
   feature; runs an unpinned `docker:latest` sidecar.
5. **Unattended mode multiplies blast radius** — a bad interaction breaks
   installs at 3am, not when a user clicks a button.
6. Rollback is an unimplemented comment; "backup" is `tar` of a live SQLite
   file (restore-time corruption risk).
7. Non-Docker deployments (LXC, k8s, bare metal, Windows/Mac) see the feature
   but get an error — a steady complaint source.

Mature self-hosted apps (Home Assistant, Grafana, Gitea) notify and refuse to
replace their own container. We adopt the same posture.

## Target end state

- MeshMonitor **detects** new releases server-side (no open browser required),
  shows a UI banner with **copy-pasteable, deployment-specific update
  instructions**, and fires the existing `upgrade-available` automation event
  so users can wire webhook/ntfy/Apprise notifications.
- Users who want unattended container updates are pointed at **Watchtower**
  (documented recipe), which owns the pull/recreate problem.
- All upgrade-execution machinery is deleted.

Desktop (Tauri) is out of scope — it has its own update channel.

---

## Inventory (what touches auto-upgrade today)

**Execution machinery (to be removed):**
- `src/server/services/upgradeService.ts` (~1,070 lines) + tests
- `scripts/upgrade-watchdog.sh` (~620 lines)
- `docker-compose.upgrade.yml`, `docker-compose.upgrade-test.yml`
- `docker/docker-entrypoint.sh` — deploys watchdog + `test-docker-socket.sh`
  into `/data/.meshmonitor-internal` on startup (~line 108)
- `src/server/routes/upgradeRoutes.ts` — `/trigger`, `/cancel/:id`,
  `/clear-block` (+ status/history GETs)
- `src/server/server.ts` — 4-hour `checkForAutoUpgrade()` scheduler (~line 610),
  boot-time `syncPendingUpgradeStatusOnBoot()` (~line 723)
- `src/server/routes/systemRoutes.ts` — `autoUpgradeImmediate` trigger branch
  inside the version-check handler (~line 163)
- `src/db/repositories/upgradeHistory.ts`, `upgrade_history` table
  (`src/db/schema/misc.ts`, `activeSchema.ts`, `database.ts` facade)
- Settings keys `autoUpgradeImmediate`, `autoUpgradeBlocked`,
  `autoUpgradeBlockedReason` (`src/server/constants/settings.ts:119-121`)
- Frontend: `src/hooks/useAutoUpgrade.ts`,
  `src/components/configuration/AutoUpgradeTestSection.tsx`, auto-upgrade
  toggle in `SettingsTab.tsx`, circuit-breaker/upgrade-progress banners in
  `src/components/AppBanners/AppBanners.tsx`, wiring in `App.tsx`
- `src/server/routes/scriptRoutes.ts` — special-casing of
  `upgrade-watchdog.sh` (lines 176, 777, 892)

**Detection machinery (to be kept / consolidated):**
- Version check against GitHub releases (`systemRoutes.ts` handler +
  `server.ts` scheduled copy — currently duplicated)
- `checkDockerImageExists()` ghcr manifest probe (`src/server/utils/systemInfo.ts`)
- Deployment-method detection (docker / lxc / kubernetes / manual) in
  `upgradeService.ts` — extract, don't delete
- `upgrade-available` automation system event
  (`triggerContext.ts`, `automationEngineSingleton.ts`) — **already exists**,
  currently only fired when a browser hits the version-check endpoint
- `env.versionCheckDisabled` opt-out — preserved throughout

---

## Phase 1 — Notify-first + deprecation (target: next minor, 4.12)

Ships the replacement before removing anything. Manual one-click upgrade keeps
working this release; **unattended auto-apply is disabled immediately** (it is
the dangerous half — see Decisions).

### 1.1 `versionCheckService` (new, consolidation)
- New `src/server/services/versionCheckService.ts`: single server-side poll
  (every 6h; respects `versionCheckDisabled`), caching
  `{ latestVersion, publishedAt, notesUrl, imageReady }`.
- Feeds three consumers: the `/api/system/version-check` endpoint (which
  becomes a cache read — no more browser-driven GitHub calls), the
  `upgrade-available` automation event (now fires headlessly — fixes the
  "no browser open, no notification" gap), and the update banner.
- Absorbs `compareVersions` + `checkDockerImageExists` usage; deletes the
  duplicated fetch logic in `server.ts`.
- Extract `detectDeploymentMethod()` from `upgradeService.ts` into
  `src/server/utils/deployment.ts`.

### 1.2 Update banner with deployment-native instructions
- Replace the "Upgrade now" action with an **"Update available: vX.Y.Z"**
  banner in `AppBanners`, expandable to show instructions keyed off detected
  deployment method:
  - **docker:** `docker compose pull && docker compose up -d` (+ Watchtower
    pointer for unattended)
  - **lxc:** `meshmonitor-update`
  - **kubernetes:** bump Helm chart / image tag (Renovate/Flux pointer)
  - **manual:** link to bare-metal update docs
- Link to the GitHub release notes. Dismissible per-version (localStorage).
- For docker, only show once `imageReady` is true (avoids "pull failed, tag
  not pushed yet" complaints).

### 1.3 Deprecation switches
- `autoUpgradeImmediate` becomes a **no-op**: scheduler branch and
  `systemRoutes` trigger branch removed. If the setting is `true`, log a
  startup warning and show a one-time banner: "Unattended auto-upgrade has
  been retired — see the update guide for Watchtower."
- Setting hidden from `SettingsTab` (key stays in `VALID_SETTINGS_KEYS` until
  Phase 2 so saves don't error).
- When `AUTO_UPGRADE_ENABLED=true`: startup log warning + banner noting the
  manual one-click path is deprecated and will be removed in the next minor,
  linking to migration docs. `/trigger` (manual, user-initiated) still works.
- Delete the 4h `checkForAutoUpgrade()` unattended scheduler from `server.ts`
  (replaced by `versionCheckService`, which never triggers anything).

### 1.4 Docs
- Rewrite `docs/configuration/auto-upgrade.md` → **"Updating MeshMonitor"**:
  per-platform sections (Docker, Watchtower recipe with labels + compose
  example, LXC, Helm, bare metal), plus an automation recipe
  (`upgrade-available` event → webhook/ntfy).
- Deprecation notice + timeline at the top; migration steps for existing
  sidecar users (remove overlay from compose command,
  `docker rm -f meshmonitor-upgrader`).
- GitHub: deprecation announcement (discussion or pinned issue) + release
  notes entry.

### 1.5 Tests
- New: `versionCheckService` unit tests (poll cadence, cache, dedupe of
  automation event by version, `versionCheckDisabled`).
- Update: banner rendering per deployment method; settings tests for hidden
  toggle; `systemRoutes` version-check now cache-backed.
- Keep existing upgradeService tests passing untouched where the code
  survives this phase.

---

## Phase 2 — Removal (target: following minor, 4.13)

### 2.1 Delete execution machinery
Everything in the "Execution machinery" inventory list above:
service, watchdog script, compose overlays, entrypoint deploy step,
`useAutoUpgrade`, `AutoUpgradeTestSection`, circuit-breaker banner,
`scriptRoutes` special cases, repo + facade methods.

### 2.2 API sunset
- `POST /api/upgrade/trigger`, `/cancel/:id`, `/clear-block` → `410 Gone`
  via `fail(res, 410, 'FEATURE_RETIRED', ...)` with a docs link, kept for one
  release, then the router is deleted entirely in the next.
- Status/history GETs return empty/410 consistently for any older frontend
  still polling.

### 2.3 Migration NNN (use `/migration` scaffold)
- Drop `upgrade_history` table (all three backends, idempotent).
- Delete `autoUpgrade*` rows from `settings`.
- Remove the three keys from `VALID_SETTINGS_KEYS`.
- Audit-log history of past upgrades is preserved (already written to
  `audit_log`), so dropping the table loses nothing users see.

### 2.4 Leftover cleanup (best-effort, boot-time)
- On startup, delete stale `/data/.upgrade-*` files and
  `/data/.meshmonitor-internal/upgrade-watchdog.sh` /
  `test-docker-socket.sh`.
- If `AUTO_UPGRADE_ENABLED=true` is still set: single startup log line
  "AUTO_UPGRADE_ENABLED is no longer supported; see <docs url>". No banner
  (Phase 1 already warned interactively).
- We cannot remove the orphaned `meshmonitor-upgrader` container ourselves
  (no socket — by design); docs cover it.

### 2.5 Tests
- Delete upgrade execution test suites (`upgradeService.test.ts`,
  `useAutoUpgrade.test.ts`, `upgradeHistory.test.ts`,
  `docker-compose.upgrade-test.yml` and any system-test hooks).
- Migration covered automatically by registry-derived `migrations.test.ts`.
- Route tests for the 410 stubs (harness pattern).

---

## Phase 3 — OPTIONAL: one-click via Watchtower HTTP API

**Do not build unless post-removal demand is real.** If users ask for
in-UI one-click after 4.13:

- Opt-in env config: `WATCHTOWER_API_URL` + `WATCHTOWER_API_TOKEN`.
- Backend `POST ${WATCHTOWER_API_URL}/v1/update` on user click; Watchtower
  recreates the container by cloning its live `docker inspect` config —
  no compose-file archaeology, no bespoke recreation logic, maintained
  upstream.
- MeshMonitor never touches the Docker socket; the only state is
  "request sent" + the normal version check confirming the new version after
  restart. No trigger files, no status files, no circuit breaker.
- Documented compose example with a pinned Watchtower image,
  `WATCHTOWER_HTTP_API_UPDATE=true`, and label-scoping to the meshmonitor
  container only.

---

## Decisions & rationale

| Decision | Rationale |
|----------|-----------|
| Kill unattended auto-apply in Phase 1, not Phase 2 | It is the half with 3am blast radius; the circuit breaker only exists because of it. Users who want unattended get a working Watchtower recipe the same day. |
| Keep manual one-click working through Phase 1 | Gives sidecar users one release of overlap with loud warnings before removal — no rug-pull. |
| Drop `upgrade_history` table | Reconciliation state for a feature that no longer exists; audit log keeps the human-readable history. |
| Server-side poll stays | The automation event must fire headlessly; also removes per-browser GitHub API traffic. `versionCheckDisabled` remains the global opt-out. |
| No bespoke sidecar rewrite | Any in-house recreation logic re-inherits the environment-assumption problem. If one-click returns, it rides Watchtower's API (Phase 3). |

## Risks & mitigations

- **Users on `autoUpgradeImmediate` silently stop getting updates.**
  Mitigation: Phase 1 one-time banner + startup warning + release notes +
  headless `upgrade-available` event; Watchtower recipe is a drop-in
  replacement for the unattended behavior.
- **Support shift from "upgrade failed" to "how do I update".**
  Mitigation: the banner shows the exact command for the detected deployment;
  docs page is the canonical answer. This trade is the point — instructions
  are debuggable by users; a broken sidecar is not.
- **Old frontends / scripts hitting `/api/upgrade/trigger`.**
  Mitigation: one release of `410` with docs link before router deletion.

## Issue breakdown

1. **Epic:** Retire auto-upgrade execution; replace with update notifications.
2. Phase 1a — `versionCheckService` consolidation + headless automation event.
3. Phase 1b — Update banner with per-deployment instructions + deprecation
   warnings + docs rewrite.
4. Phase 2 — Removal: machinery deletion, migration, API sunset, cleanup.
5. (Backlog, unscheduled) Phase 3 — Watchtower HTTP API one-click.
