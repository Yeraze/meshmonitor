# meshmonitor.org — structure and hygiene review

Scope: `docs/` (VitePress), config `docs/.vitepress/config.mts`. Read-only review, 2026-11-17.
Method: read config; walked all `.md` under `docs/` and applied `srcExclude` (190 published pages);
link/anchor scan with VitePress's slug rules; checked a Sept build in `docs/.vitepress/dist` and the
live site with `curl`. No fresh build run (live site already proves what publishes).

Paths below are relative to `docs/` unless they start with `src/`.

---

## P0 — publishes but should not / visibly broken

### 1. Internal design specs and old release notes are public
- `srcExclude` (`.vitepress/config.mts:399-412`) covers `internal/ architecture/ database/ api/ planning/ plans/ operations/` and the dated security review. It does **not** cover `superpowers/` or `releases/`.
- Live proof (HTTP 200 with real titles):
  - `https://meshmonitor.org/superpowers/specs/2026-04-03-multi-source-architecture-design` → "MeshMonitor 4.0: Multi-Source Architecture"
  - `https://meshmonitor.org/superpowers/reviews/2026-03-18-database-architecture-audit` → "Database Architecture Audit Report"
  - `https://meshmonitor.org/releases/RELEASE_NOTES_v1.16.0` → "Release Notes - v1.16.0"
- Count: 21 specs + 4 reviews in `superpowers/`, 3 files in `releases/` (v1.16.0, v2.13.3, v2.16.1). None is in any sidebar; local search indexes them, so they show in site search.
- They hold no secrets (grep for IPs/hosts/passwords found only an example `192.168.1.100` in `releases/RELEASE_NOTES_v2.13.3.md:65`), so this is noise, not a leak.
- The superpowers plugin writes new specs to `docs/superpowers/specs/` by default, so this set will keep growing.
- Fix: add `'**/superpowers/**'` and `'**/releases/**'` to `srcExclude`, or `git mv` both into `docs/internal/`. GitHub Releases already holds release notes (nav links there, `config.mts:222`).
- Correction to the lead: `security/2026-05-05-mm-sec-1-2-3-review.md` is **not** public (excluded at `config.mts:411`; live 404; `dist/security/` holds only `SECURITY_ADVISORY.html`).

### 2. Site logo is a 404
- `config.mts:205` sets `logo: '/images/logo.svg'`. No `logo.svg` exists anywhere under `docs/` (outside `dist`), and `https://meshmonitor.org/images/logo.svg` returns 404. The live home page renders `<img class="VPImage logo" src="/images/logo.svg">`, so every page shows a broken logo.
- Fix: add `docs/public/images/logo.svg` (copy from the app's `public/`), or point `logo` at a file that exists.

### 3. In-app "docs" links that land on the wrong spot
App code links into the docs; these anchors do not exist:
- `src/components/AutoDeleteByDistanceSection.tsx:250` and `src/components/MeshCore/MeshCoreAutoDeleteByDistanceSection.tsx:166` → `/features/automation#auto-delete-by-distance`. No docs page has an Auto Delete by Distance section at all (only blog `blog/2026-03-15-distance-delete-traceroute.md` and a table row in `features/multi-source.md:194`). The feature is undocumented.
- `src/components/AutoLocalStatsSection.tsx:434` → `/features/automation#auto-localstats`; the heading is `{#auto-remote-localstats}` (`features/automation.md:379`).
- 59 distinct doc URLs appear in `src/`, `README.md`, `helm/`, `desktop/`. All 57 page paths resolve; only the 2 anchors above fail. These URLs (e.g. `features/device#...`, `features/meshcore#...`, `faq.html#...`, `deployment/HELM_GUIDE.html`, `site-gallery.html`, `user-scripts.html`) pin the current layout: **any page move must keep these paths.**

---

## P1 — dead internal links (published pages)

Scanner: markdown, `href=`/`src=`, ref-defs; code fences skipped; anchors checked against VitePress slugify. 0 missing pages, 0 missing images, 0 links into excluded dirs. 10 dead anchors, all confirmed against ids in the built HTML (`dist/`) except where noted.

Cause in every case: VitePress keeps `—` and `→` in slugs and prefixes a leading digit with `_`, or the heading changed.

| Source | Link | Real id |
|---|---|---|
| `configuration/custom-tile-servers.md:611` | `#nginx-caching-tile-proxy-easiest-for-offline` | `#nginx-caching-tile-proxy-gradual-offline-coverage` (heading renamed, line 199) |
| `configuration/sso.md:47` | `#group-role-mapping` | `#group-→-role-mapping` (line 79) |
| `features/map-analysis.md:58` | `#3d-terrain-view` | `#_3d-terrain-view` (line 295) |
| `features/maps.md:571` | `/features/map-analysis#3d-terrain-view` | same |
| `features/settings.md:687` | `/features/map-analysis#3d-terrain-view` | same |
| `features/meshcore-analyzer-observer.md:33` | `#step-2-provide-broker-credentials` | `#step-2-—-provide-broker-credentials` (line 126) |
| `features/meshcore-analyzer-observer.md:42` | same | same |
| `features/meshcore-analyzer-observer.md:101` | `#step-3-verify` | `#step-3-—-verify` (line 188; source-grep only, not in Sept build) |
| `features/public-instance-mode.md:67` | `./atak#phase-3-cot-feed-atak-wintak-network-input` | `#phase-3-—-cot-feed-atak-wintak-network-input` |
| `features/solar-monitoring.md:288` | `/features/device#telemetry-graphs` | no such heading in `features/device.md` (source-grep only) |

Best fix: give headings with `—`/`→`/leading digits explicit ids (`## Step 2 — Provide broker credentials {#step-2-provide-broker-credentials}`), which repairs the links and makes ids readable. Also consider `markdown.anchor.slugify` in config to strip non-ASCII punctuation site-wide (would change existing ids; check the in-app anchors first).

Absolute self-links: 33 `https://meshmonitor.org/...` links in published docs; all resolve. `/charts` (`configuration/production.md:80`, `deployment/HELM_GUIDE.md:17`) is not a VitePress page but `charts/index.yaml` returns 200 (Helm repo), so fine.

---

## P2 — navigation and IA

### Top nav (`config.mts:207-223`)
- "Features" → `/features/settings` (`:213`). No `features/index.md` exists (`https://meshmonitor.org/features/` → 404). Readers land on a 40 KB+ settings reference. Add a `features/index.md` overview (cards per group) and point nav there.
- "Documents" dropdown mixes sections with two single pages (Site Gallery, User Scripts, `:218-219`) that already sit in the Features sidebar.
- Emoji only on some items: `🌐 Site Gallery`, `📜 User Scripts`, `📦 Releases` (`:218-222`).

### Pages with no sidebar at all
Sidebar keys are prefixes (`config.mts:225-355`). Nothing covers `/deployment/`, `/developers/`, `/configurator`, `/getting-started`, `/blog/`. Live check: 0 `VPSidebarItem` on `/deployment/HELM_GUIDE`, `/configurator`, `/developers/auto-responder-scripting`, `/getting-started` (vs 77 on `/features/maps`).
- Effect: the Configuration sidebar links to `/configurator` (`:252`) and four `/deployment/*` guides (`:301-304`); clicking them drops the reader onto a bare page. Development sidebar links `/developers/auto-responder-scripting` (`:350`), same result.
- Fix (free, no URL change): add keys `'/configurator': configSidebar`, `'/deployment/': configSidebar`, `'/getting-started': configSidebar`, `'/developers/': devSidebar`.

### Sidebar swaps
- `Passkeys` is in Features→Security (`:137`) and Configuration→Auth (`:281`); `Push Notifications` in Features→Automation (`:128`) and Configuration→Production (`:293`). Both link to `/features/*`, so a reader clicking them from Configuration is switched into the Features sidebar. Keep one home each.
- `/faq` borrows the Features sidebar (`:244`); FAQ spans install and config too. Fine as a stopgap; a "Help" group would fit better.

### Duplicate / confusing labels
- Two entries labelled exactly "Receive-Only Mode" in the same sidebar (`:65` Meshtastic, `:170` MeshCore). Rename to "Receive-Only Mode (Meshtastic)" / "(MeshCore)", or merge into one page with two sections (5 KB + 7 KB).
- "Analytics" (`features/analytics.md`) is web-analytics injection (Google Analytics etc.), yet sits under "Monitoring & Telemetry" (`:97`) beside "Analysis & Reports". Move to Administration and rename "Site Analytics (tracking scripts)".
- `config.mts:34` comment says no group runs past six rows; Maps has 7 (`:84-90`) and Security has 8 (`:136-143`).

### Emoji in labels — inconsistent
Features sidebar uses emoji only in the collapsed last group (`:181-185`). Configuration uses them on 6 of 22 items (`:252-253, 264, 290, 294`) and Deployment on 3 of 4 (`:302-304`). Pick one rule: none in sidebar (recommended; matches the app's no-emoji UiIcon rule), or one per group header.

### URL / filename hygiene
- Upper-case URLs: `/THEME_GALLERY`, `/development/FRONTEND_STRUCTURE`, `/development/TEST_SUITE`, `/development/BLE_BRIDGE_MIGRATION`, `/deployment/*_GUIDE`. `HELM_GUIDE.html` is linked from the app, so leave it; the rest are low-traffic but cannot move without redirects.
- `developers/` (1 page) vs `development/` (10 pages): two folders for one audience.
- Root-level odd locations (`security-duplicate-keys.md`, `security-low-entropy-keys.md`, `firmware-ota-prerequisites.md`, `THEME_GALLERY.md`) are **intentional**: `config.mts:39-43, 228-236` says the URLs are shared with users and the site has no redirects. Do not move; they are already wired into the Features sidebar.

### Development section
- Stubs: `development/architecture.md` (164 B, "This page is under construction… Coming Soon", line 3-5) and `development/authentication.md` (372 B, links to a GitHub file under `docs/internal/` and "Coming Soon", line 3-5). Both in sidebar (`:332, :335`). Either fill from `docs/internal/dev-notes/ARCHITECTURE_LESSONS.md` / `AUTHENTICATION.md` or drop from the sidebar.
- API: only one published API page, `development/api-reference.md` (Swagger UI over `public/openapi.yaml`, 18 paths, updated 2026-11-08). The 4 files in `api/` (`API.md`, `API_REFERENCE.md`, `API_TOKEN_IMPLEMENTATION.md`, `REST_API.md` 65 KB) are excluded, so they are not public. Move them to `internal/` so nobody edits them thinking they ship. The page should say the spec covers the token API (v1) only, not the full internal API (unverified that this is the intent).

---

## P3 — features regrouping and merges

58 feature pages (not 70), all in the sidebar. Sizes span 1.5 KB (`spip-images`) to 129 KB (`automation.md`), 122 KB (`meshcore.md`), 103 KB (`automation-engine.md`).

Small pages (<4 KB), inbound links from other published pages (sidebar excluded) / from app code:

| Page | Size | Docs links | App links | Suggestion |
|---|---|---|---|---|
| `spip-images` | 1.5 KB | 0 | 0 | Keep page, move under Messaging; or section in message docs |
| `store-forward` | 2.5 KB | 1 | 0 | Keep; **fix contradiction**: tip at line 4 says it "can request history", line 19 says it "does not actively request history" |
| `transport-breakdown` | 2.5 KB | 1 | 0 | Merge into `packet-monitor` or `analysis-reports` |
| `meshwars` | 2.6 KB | 0 | 0 | Keep (community game); move to Community group |
| `privacy-disclosures` | 2.7 KB | 2 | 0 | Merge with `public-instance-mode` into one "Running a public instance" section |
| `local-markers` | 2.9 KB | 2 | 0 | Merge into `waypoints` ("Waypoints & local markers") |
| `geofence-triggers` | 3.1 KB | 1 | 0 | Merge into `automation-engine` (geofence is a trigger type) |
| `analytics` | 3.2 KB | 1 | 0 | Keep, move to Administration (see above) |
| `configuration-search` | 3.5 KB | 1 | 0 | Merge into `settings` |
| `impersonation-detection` | 3.9 KB | 1 | 0 | Keep under Security |
| `estimated-accuracy` | 13 KB (not small) | 1 | 0 | Optional: merge into `position-estimation` |

Every merge breaks one URL (no redirects). Cheap guard: leave a 3-line stub page at the old path that links to the new anchor, and drop it from the sidebar.

Huge pages to split (no URL loss if the parent keeps its anchors used by the app): `features/automation.md` (129 KB; app links `#auto-welcome`, `#auto-ping`, `#auto-acknowledge`, …) and `features/meshcore.md` (122 KB; app links `#timer-triggers`, `#forwarding`, `#auto-responder`, `#auto-announce`). Splitting would break those in-app anchors unless the app links change in the same PR.

Overlap to resolve: `features/automation.md` (Automatic Responses), `features/automation-engine.md`, `developers/auto-responder-scripting.md` (35 KB), `user-scripts.md`. Four entry points for "make MeshMonitor reply to things".

---

## P4 — blog

- 57 posts. `blog/index.md` is a live index: `blog/posts.data.ts` loads `blog/*.md`, drops the index, sorts by `date` desc (line ~76). Top 3 featured, rest listed. Every post filename date matches its `date:` front matter. No issues.
- Blog has no sidebar (normal) but also no category filter; 57 posts in one list is long. Optional: tag/category filter.
- Stale promises:
  - `blog/2026-04-21-v4.0-coming-soon.md` ("Heads-up: MeshMonitor 4.0 is coming soon", priority `important`). 4.0 shipped; fine as history, but a one-line "Shipped in 4.0 — see …" note at top would help readers who arrive from search.
  - `blog/2026-06-09-v4.9.4-impersonation-detection.md:35` lists roadmap follow-ups (PKI DM verification, other-node impersonation, Security dashboard/notification alerts). `features/impersonation-detection.md:37` still says "Phase 1 covers self-node spoofing". Whether the follow-ups shipped (e.g. via `reliable-pki.md`) is **unverified**.
  - `features/map-analysis.md:337` "candidates for a follow-up phase of the 3D map work" — unverified.
- `public/news.json` (180 KB) is regenerated from the blog at build (`config.mts:10-28`); not a page, fine.

---

## P5 — add-ons

All linked repos are active, none archived (`gh repo view`, last push):
- `LN4CY/mqtt-proxy` 2026-08-31 (16★), `LN4CY/ai-responder` 2026-10-31 (5★)
- `maxhayim/CardMesh` 2026-11-17, `screensaver-mesh` 2026-10-20, `ShackScreen` 2026-10-21, `widgets-pack` 2026-10-06
No action. Only two add-ons have their own pages; the other four live only in `add-ons/index.md` — consistent enough.

---

## P6 — images

- 0 broken image refs in published pages.
- `public/images` is 95 MB and ships on every deploy. 293 files (57 MB) are not referenced by name from `docs/` or `README.md`: 261 in `public/images/features/` (names like `5156-20-embed-mode-off.png`, i.e. PR screenshots) and 30 in `public/images/themes/` (e.g. `*-unified-messages-desktop.png`, not used by `THEME_GALLERY.md`). PR bodies on GitHub may hot-link the PR screenshots — **unverified**, so do not delete blind. Option: move PR-only screenshots to a separate folder or GitHub attachments going forward.

---

## Proposed sidebar outline

### A. Sidebar-only changes (no URL breaks — do first)

```
Features (/features/)                         ← new features/index.md overview
  Start Here
    Overview (new index) · Settings · Global Settings · Multi-Source
  Your Nodes
    Device Configuration · Admin Commands · Node Number Changes (2.8)
    Traffic Management · Receive-Only (Meshtastic) · Firmware OTA Updates
  Messaging
    Message Search · Delivery Details · Channel Database · Store & Forward
    Message Translation · SPIP Pixel Images
  Maps
    Interactive Maps · Map Analysis · Waypoints · Local Markers
    Position Estimation · Estimated Accuracy · Embed Maps
  Monitor & Diagnose
    Analysis & Reports · Telemetry Widgets · Solar Monitoring
    Mesh Issues (+Test Reference) · Coverage Report · Traceroute Explorer
    Link Quality · Transport Breakdown · Packet Monitor
  Automate & Alert
    Automatic Responses · Automation Engine · Geofence Triggers
    Push Notifications · Auto Heap Management · User Scripts
  MeshCore
    Overview · Receive-Only (MeshCore) · Analyzer Observer
    MQTT Ingest · MQTT Broker
  MQTT & Integrations
    MQTT Setup Guide · Embedded MQTT Broker · ATAK / CoT
  Security
    Overview · Passkeys · Duplicate Keys · Low-Entropy Keys
    Impersonation Detection · PKI DM Decryption · Reliable PKI · Advisories
  Run an Instance
    Per-Source Permissions · System Backup · Public-Instance Mode
    Privacy Disclosures · Configuration Search · Site Analytics
  Community (collapsed)
    Custom Themes · Theme Gallery · Translations · Site Gallery · MeshWars

Setup (/configuration/, /deployment/, /configurator, /getting-started)
  Get Started:  Getting Started · Overview · Compose Configurator · Desktop App
  Install:      Deployment Guide · Kubernetes/Helm · Proxmox LXC · Production
  Connect:      BLE · Serial · Virtual Node · meshtasticd · Reticulum · Tested Hardware
  Network:      HTTP vs HTTPS · Reverse Proxy · DuckDNS · Custom Tile Servers
  Sign-in:      SSO · Fail2ban            (Passkeys link removed; lives in Security)
  Operate:      Updating · Unattended Upgrades · Reducing Node Load
                (Push Notifications link removed; lives in Automate)

Development (/development/, /developers/)
  Setup · Claude Code Quickstart · Frontend Structure · Database · Test Suite
  API Reference · Auto Responder Scripting · BLE Bridge Migration
  (Architecture + Authentication stubs hidden until written)
```

Top nav: `Getting Started · Features (→ /features/) · Setup (→ /configuration/) · Develop · Blog · FAQ · Releases ↗`; drop Site Gallery / User Scripts from the dropdown; no emoji.

### B. Changes that break URLs (need stub pages; do later, one PR each)
1. Merge `geofence-triggers` → `automation-engine#geofence` (1 inbound).
2. Merge `local-markers` → `waypoints#local-markers` (2 inbound).
3. Merge `estimated-accuracy` → `position-estimation#accuracy` (1 inbound).
4. Merge `configuration-search` → `settings#search` (1 inbound).
5. Merge `privacy-disclosures` + `public-instance-mode` (2 inbound; keep `public-instance-mode` URL).
6. Merge the two Receive-Only pages (optional).
7. Move `developers/auto-responder-scripting` → `development/` (app does not link it; 1 sidebar link).
Never move: `security-*`, `firmware-ota-prerequisites`, `faq`, `site-gallery`, `user-scripts`, `getting-started`, `deployment/HELM_GUIDE`, and any `features/*` page or anchor the app links (list in §3).

### C. Exclude / remove
- `srcExclude += '**/superpowers/**', '**/releases/**'` (or move into `internal/`).
- Move `api/*.md` into `internal/` (already hidden; avoids confusion).
