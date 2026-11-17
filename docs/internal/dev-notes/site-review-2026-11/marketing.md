# MeshMonitor marketing-claims audit (v4.18.0, 2026-11-17)

Read-only review. No repo file changed. Evidence comes from `src/`, `.github/`, `Dockerfile`, git history,
and live HTTP checks of meshmonitor.org. "Unverified" is a tag beside a verdict, not a verdict.

Verdicts: PROMOTE / DEMOTE / REVISE / CUT / KEEP.

---

## A. False or stale claims (fix first)

### A1. "Retrieve history from S&F peers" -- CUT the clause
- Claim: `docs/index.md:57` "Retrieve history from S&F peers, flag S&F servers on the map, and keep messages flowing across offline gaps."
- Evidence: no code sends a Store & Forward request. `/usr/bin/grep -rn "STORE_FORWARD_APP|StoreAndForward" src/server` finds only the enum comment at `src/server/constants/meshtastic.ts:371`; `CLIENT_HISTORY: 65` (`:386`) is defined and never used. MeshMonitor only ingests replays a server chooses to push and tags `via_store_forward` (migrations 034, 035). The feature page agrees: `docs/features/store-forward.md:18` "does not actively request history ... on the roadmap", which also contradicts its own line 4 ("can request history from them").
- Rewrite: "Spot Store & Forward servers on the map and tag messages they replay."
- Also fix `docs/features/store-forward.md:4`.

### A2. README "One-click Self-Upgrade" and "auto-upgrade support" -- CUT
- Claims: `README.md:296` "One-click Self-Upgrade - Automatic upgrades from the UI with backup and rollback"; `README.md:252` "Pre-built multi-architecture images with auto-upgrade support".
- Evidence: commit `f78336f38` (2026-07-14) "feat!: retire in-app auto-upgrade, replace with update notifications (#4108)". `src/server/routes/systemRoutes.ts:157-158`: "This route no longer triggers any upgrade -- detection/notification only." `docs/getting-started.md:38` says "It never modifies its own deployment."
- Rewrite: "Update alerts - MeshMonitor tells you when a new release is out and shows the update steps for your platform."

### A3. MQTT is a "read-only source" -- REVISE
- Claim: `docs/index.md:134` "connect to an external MQTT broker as a read-only source".
- Evidence: `src/server/routes/mqttNativeRoutes.ts` (#4305, commit `24eca2b58`) adds `POST /api/sources/:id/mqtt/native/send` for channel and PKI DMs through a broker with no radio; migration `236_create_mqtt_native_identities.ts`. 4.18.0 blog lists it ("Meshtastic over MQTT with no radio").
- Rewrite: "MQTT: read a broker, and (opt-in) send Meshtastic messages through it with no radio. Or run the embedded broker with two-way bridges to public upstreams."

### A4. "nodes colored by signal strength" / "signal-strength indicators" -- REVISE
- Claims: `docs/index.md:141` "nodes colored by signal strength and connectivity status"; `docs/index.md:41` "signal-strength indicators".
- Evidence: map markers use `getHopColor()` (`src/utils/roleGlyphSvg.ts:261`) with `hopColors` from `src/config/overlayColors.ts`; the map legend reads "Hops". Other modes are colour by source (`src/components/Dashboard/nodeSourceRing.ts`, #6125) and by gateway (`DashboardMap.tsx:1244`, #6175). SNR colouring appears only in Coverage and Traceroute Explorer maps.
- Rewrite: "Nodes are coloured by hop count, by source, or by MQTT gateway, with role badges."

### A5. Quick Start "That's it! No ... complex configuration" -- REVISE
- Claims: `docs/index.md:112` `ALLOWED_ORIGINS=http://localhost:8080  # Required for CORS`; `docs/index.md:124` "That's it! No SESSION_SECRET or complex configuration needed".
- Evidence: `src/server/config/environment.ts:436-441` already defaults `ALLOWED_ORIGINS` to `http://localhost:8080,http://localhost:3001`, so the line in the example does nothing. The CORS check in `src/server/server.ts:200-217` rejects any other browser origin, so a user who opens `http://<server-ip>:8080` from another machine hits the problem that is FAQ item #1 (`docs/faq.md:9-43`). The README Quick Start (`README.md:62-78`) leaves the variable out. Runtime behaviour on a LAN IP not reproduced here: unverified, but the code path is clear.
- Rewrite the comment: `- ALLOWED_ORIGINS=http://192.168.1.50:8080  # The URL you type in the browser. Needed unless you use localhost.` Add the same line to README.

### A6. OTA "through a connected gateway ... no SSH or CLI" -- REVISE
- Claim: `docs/index.md:69` "push OTA firmware updates through a connected gateway -- all from the web UI".
- Evidence: `src/server/routes/firmwareUpdateRoutes.ts:32` `router.use(requireAdmin())`; `refuseNonMeshtasticSource` (Meshtastic only); `src/server/services/firmwareUpdateService.ts:980` "Every OTA-capable board is ESP32"; hardware refusal codes at `:40`. The prereq page needs firmware >= 2.7.18 and a one-time USB flash of the OTA bootloader.
- Rewrite: "Update ESP32 node firmware over Wi-Fi from the web UI (after a one-time USB bootloader flash)."
- Side note: `docs/firmware-ota-prerequisites.md:15-16` has two "ESP32 hardware" rows that disagree (ESP32-family vs ESP32/ESP32-S3).

### A7. "new in 4.11.0" -- REVISE
- Claim: `docs/index.md:37` "and, new in 4.11.0, connect the MeshCore app...". Current version is 4.18.0 (`package.json:3`). Seven minors old.
- Rewrite: "Each source has its own Virtual Node. Point several Meshtastic apps, or the MeshCore app, at one radio through MeshMonitor."

### A8. 4.17.2 blog still says "What's Coming" and "release candidates" -- REVISE
- Claim: `docs/blog/2026-10-31-v4.17.2-security-reliability.md:3` title "What's Coming in v4.17.2"; `:47` "These are release candidates ... don't point a production deployment at an RC."
- Evidence: `git tag` shows `v4.17.2`, `v4.17.3`, `v4.18.0` all final. No separate 4.17.2 release post exists.
- Rewrite title: "MeshMonitor v4.17.2: Security Hardening and Fewer False Alarms". Replace the RC bullet with "Shipped in v4.17.2."
- Message clash: `:51` "don't put it on the open internet" vs `site-gallery.md` inviting public instances and the 4.18 Public-Instance Mode. Rewrite: "Before you expose an instance, change the admin password and turn on Public-Instance Mode."

### A9. README stale tech facts -- REVISE
- `README.md:349` "Vite 7" -- `package.json:165` has `"vite": "^8.3.8"`.
- `README.md:281` "Analysis & Reports (4.2) ... first report is Solar Monitoring" -- the README itself (`:47`) lists six reports (NodeInfo Enrichment, ok_to_mqtt Violations, Mesh Issues, Coverage Report, Traceroute Explorer). Drop "(4.2)" and "first report".
- `README.md:9` "featuring a beautiful Catppuccin Mocha dark theme" -- undersells 15 built-in themes plus an editor. Rewrite: "15 built-in themes, including colour-blind and high-contrast sets."

### A10. getting-started Helm row -- REVISE
- `docs/getting-started.md:56` "Kubernetes/Helm - Available in our GitHub repository"; `:20` links Helm to `/deployment/DEPLOYMENT_GUIDE`.
- Evidence: `https://meshmonitor.org/charts/index.yaml` returns 200 (live Helm repo); README shows `helm repo add meshmonitor https://meshmonitor.org/charts`.
- Rewrite: "Kubernetes/Helm - `helm repo add meshmonitor https://meshmonitor.org/charts`. See the Helm guide." Link to `/deployment/HELM_GUIDE`.

---

## B. Broken or stale assets (site-wide impact)

### B1. Navbar logo 404 on every page -- REVISE (high impact, small fix)
- `docs/.vitepress/config.mts:205` `logo: '/images/logo.svg'`. File does not exist in `docs/public/images/` and never did (`git log --all -- docs/public/images/logo.svg` empty).
- Live: `curl https://meshmonitor.org/images/logo.svg` returns 404; homepage HTML has `<img class="VPImage logo" src="/images/logo.svg">`.
- Fix: copy `public/logo.png` (repo root) to `docs/public/images/` and point config at it, or add an SVG.

### B2. No favicon, no Open Graph / Twitter tags -- REVISE
- `config.mts` has no `head:` entry and no `transformHead` (grep count 0). `https://meshmonitor.org/favicon.ico` returns 404. Links shared on Discord, Reddit, or Mastodon show no image.
- Fix: add `head` with a favicon and `og:image` (use the new `docs/images/main.png`), `og:title`, `og:description`.

### B3. Homepage hero shows Feb-2026 single-source screenshots -- REVISE (high impact)
- `docs/.vitepress/theme/index.ts` fills the `home-hero-image` slot with `HeroCarousel.vue`, so the frontmatter `hero.image` (`docs/index.md:8-10`, dashboard-multi-source.png, alt "Meshtastic, MeshCore, and MQTT sources side by side") never renders.
- The carousel (`HeroCarousel.vue:5-11`) loads seven shots, all last changed 2026-02-26. `docs/public/images/main.png` shows the old single-radio UI: one Meshtastic node header, a "Disconnect" button, Leaflet map. That sits under the headline "One dashboard. Every mesh."
- The README got fresh shots on 2026-11-06 in `docs/images/` (main, source-nodes, channels, dashboard, telemetry, reports), taken from the public demo signed out. They differ from the public copies (`cmp` reports differ).
- Fix: copy the November shots into `docs/public/images/` and use them in the carousel and in the Screenshots section (`docs/index.md:203` also uses the old `main.png`). Drop the dead `hero.image` block or keep it as the no-JS fallback.
- Other homepage screenshots (`docs/public/images/features/*.png`) date from 2026-04-21: before MeshCore parity, Reticulum, and Public-Instance Mode. Unverified whether they still match the UI.

### B4. config.mts `description` is 193 characters -- REVISE
- `docs/.vitepress/config.mts:200`. Search engines cut near 155-160.
- Rewrite (about 150): "Self-hosted dashboard for Meshtastic, MeshCore, Reticulum and MQTT meshes. Maps, messages, telemetry, alerts and automation in one place."

---

## C. Over-stated or muddled (REVISE)

### C1. "Connect Meshtastic (TCP, Serial, BLE)" -- REVISE
- `docs/index.md:21`. Native Meshtastic link is TCP only; `src/server/transports/` has no serial or BLE for Meshtastic, and `serialport` is used only by `meshcoreManager.ts`. Serial and BLE go through the bridge sidecars, which `docs/index.md:132` says correctly.
- Rewrite: "Meshtastic over TCP (or USB and Bluetooth through a small bridge container)".

### C2. "Desktop & Mobile ... PWA for iOS and Android with a collapsible sidebar and system-tray integration" -- REVISE
- `docs/index.md:85`. The tray belongs to the desktop app, not the PWA. Desktop builds: Windows x64 (`desktop-release.yml:131` `...-x64-setup.exe`) and macOS arm64 and x64 DMGs (`:502`, `:869`). No Linux desktop build.
- Rewrite: "Desktop app for Windows and macOS that runs from the system tray. Install the web app on iOS or Android from the browser."

### C3. "Push Notifications ... even when the app is closed" -- REVISE
- `docs/index.md:65`. Web Push exists (`web-push` used in 15 src files). iOS needs the PWA installed (16.4+) and HTTPS, which clashes with "works over HTTP out of the box" (`docs/index.md:124`). Source of the HTTPS/iOS rule is the notifications doc; not proven from src (unverified).
- Rewrite: "Push alerts on desktop, Android and iOS (iOS needs HTTPS and the installed web app). Apprise for email, Slack, Discord, Telegram and more."

### C4. "Extend with custom Python or Bash scripts" -- REVISE (small)
- `docs/index.md:53`. `src/server/routes/scriptRoutes.ts:217` accepts `.js`, `.mjs`, `.py`, `.sh`. Rewrite: "Python, JavaScript or shell scripts".

### C5. "Color-blind friendly and WCAG AAA high-contrast variants" -- KEEP (unverified)
- `docs/index.md:77`. The themes exist (`protanopia`, `deuteranopia`, `tritanopia`, `high-contrast-dark/light` in `src/contexts/SettingsContext.tsx:98-104`). `src/utils/accessibilityChecker.ts` checks AA/AAA ratios for the editor, but nothing proves the built-in high-contrast themes meet AAA. Either test them or soften to "high-contrast themes".

### C6. "Each source exposes its own Virtual Node" vs "Each TCP source gets its own Virtual Node" -- REVISE
- `docs/index.md:37` vs `:176`. Virtual Node exists for Meshtastic TCP and MeshCore (`MeshCoreVirtualNodeServer`, `meshcoreManager.ts:131`); none found for MQTT or Reticulum managers. Use one phrase: "Meshtastic and MeshCore sources".

### C7. Homepage "Deployment Options" lists three -- REVISE
- `docs/index.md:157-161` names Docker Compose, Kubernetes, Bare Metal. The feature card (`:89`) and getting-started table list Desktop, Proxmox LXC, Portainer and NixOS too. Also "Docker Compose: Quick local deployment for testing and development" sells the recommended production path as a test tool.
- Rewrite: Docker Compose (recommended), Portainer, Kubernetes/Helm, Proxmox LXC, Desktop app, bare metal.

### C8. Automation card omits the Automation Engine -- REVISE
- `docs/index.md:53` lists Auto-Responders, Scheduled Messages, Auto-Traceroute, Geofence Triggers. The Automation Engine (`src/server/services/automation/`, `automationEngineService.ts`, sidebar entry, #3653) is the bigger story, plus the 4.18 `is_automation` loop guard and airtime cutoff.
- Rewrite: "Build rules with the visual Automation Engine, or use ready-made auto-reply, timers, auto-traceroute and geofences. Bots tag their own packets (is_automation) so two bots never trade replies, and an airtime cutoff pauses them when the channel is busy."

### C9. Site gallery -- REVISE
- `docs/site-gallery.md:3` "monitoring real-world Meshtastic networks" -- say "Meshtastic and MeshCore".
- Privacy section (`~:150`) should link `/features/public-instance-mode`.
- `docs/site-gallery.md:26` lists a raw IP over plain HTTP (`http://192.81.132.42:8080/`); it did not answer in 8 s. Consider dropping it.
- Five of 16 URLs did not answer from this host at check time (8 s timeout, 2026-11-17): `192.81.132.42:8080` (000), `meshmonitor.meshcn.net` (000), `meshmap.tranziq.net` (000), `meshmonitor.mesh.ec` (000), `meshmon.canadaverse.org` (503). Recheck from another network before removing.

---

## D. DEMOTE (niche or low-value on the homepage)

- **Custom Map Tiles** (`docs/index.md:71-73`) -- real (`src/server/routes/mapStyleRoutes.ts`, tile-server test route) but niche. Fold into the Map card as one clause.
- **Customizable Themes** (`:75-77`) -- verified (15 themes) but low buyer value. Merge with the Mobile/Desktop card or drop to the Key Features list.
- **Solar Monitoring** (`:79-81`) -- real (`forecast.solar` in 8 src files) but one report among six. Fold into an "Analysis & Reports" card. "Predicted at risk" unverified.
- **Store & Forward** (`:55-57`) -- after A1, too thin to hold its own card. Merge into Messages.
- **Security Monitoring** appears twice (`:59-61` card and `:152-153` section). Keep one.

---

## E. KEEP (verified)

| Claim | File:line | Evidence |
|---|---|---|
| "No restart to add or remove a source" | index.md:21, :171 | `sourceRoutes.ts` POST/PUT/DELETE call `sourceManagerRegistry.addManager/removeManager` (lines 1137-1660) |
| SQLite, PostgreSQL, MySQL | index.md:89, README:287 | `src/db/drivers/{sqlite,postgres,mysql}.ts` |
| Docker arches amd64, arm64, armv7 | README:254 | `.github/workflows/docker-publish.yml:68,139` |
| Helm chart | index.md:89 | `helm/meshmonitor/Chart.yaml` version 4.18.0; `meshmonitor.org/charts/index.yaml` 200 |
| Proxmox LXC | index.md:89 | `.github/workflows/lxc-template-build.yml`, `lxc/` |
| Desktop Windows and macOS | index.md:85 | `desktop-release.yml` (NSIS exe; arm64 and x64 DMG) |
| 15 built-in themes | index.md:77 | `SettingsContext.tsx:98-104` (15 ids) |
| OIDC, MFA, local accounts | index.md:33 | `src/server/auth/oidcAuth.ts`, `src/server/routes/mfaRoutes.ts` |
| Admin audit log | index.md:33, :61 | 61 src files reference `auditLog` |
| Weak and duplicate key detection | index.md:61, :153 | `lowEntropy` 35 files, `duplicateKey` 41 files |
| Real-time | hero | `socket.io` 4.8 + `src/server/services/webSocketService.ts` |
| Embedded MQTT broker + bridges + geo filter | index.md:29 | `aedes` dep, `src/server/transports/mqttBroker.ts`, `POST /:id/prune-outside-roi` |
| MeshCore over USB or TCP | index.md:133 | `meshcoreConfig.ts:20` `transport?: 'usb' \| 'serial' \| 'tcp'` |
| GeoJSON / KML / KMZ, polar grid | index.md:41 | `kmz` 5, `kml` 3, `polarGrid` 12 src files |
| Apprise | index.md:65 | `Dockerfile:103-104` installs apprise in a venv |
| 4.18 `is_automation` bit 0x04, migrations 233-239 | blog 4.18.0:21, :81 | `constants/meshtastic.ts:571`; `src/server/migrations/233_...` to `239_add_is_automation_flag.ts` |
| 4.17.0 non-root image, `RUN_AS_ROOT` escape | docker-hardening blog :34, :69 | `docker/docker-entrypoint.sh` |
| 4.17.2 per-request CSP nonce | 4.17.2 blog :29 | `src/server/middleware/dynamicCsp.ts` |
| README third-party links, docs paths | README:253-267 | all target files exist |
| All internal links and anchors in the reviewed pages | -- | script check over index, getting-started, site-gallery and six blog posts: no dead link or anchor |

Unverified blog figures (not checked against src): 38/34 pentest findings, image size 1.44 GB to 964 MB, "more than 60 features and 60 fixes", CVE-2026-114613, firmware#12128 status, "Apprise 100+ services".

---

## F. Missing from the homepage (PROMOTE)

Ranked by how much they set MeshMonitor apart. Each has shipped code.

1. **Reticulum** -- "Watch a Reticulum network too: LXMF messages, Sideband telemetry and positions, and a topology view, through a small bridge container." (`src/server/reticulumManager.ts`, source type `reticulum`, shipped 4.15.0, bridge image `meshmonitor-rns-bridge`; no "experimental" label found.) The hero says "Every mesh" yet names three; the 4.17.0 and 4.18.0 posts already treat Reticulum as a peer.
2. **Public-Instance Mode** (4.18) -- "Share a public map that hides positions, names, keys and message text from anyone not signed in." (`src/server/utils/publicInstanceRedactor.ts`, `middleware/publicInstanceRedaction.ts`.) Pairs with the Site Gallery.
3. **Automation Engine + is_automation** -- see C8.
4. **Analysis & Reports / Diagnostics** -- "Coverage Report, Traceroute Explorer, Mesh Issues, Packet Monitor, link quality and solar analysis in one Reports workspace." (coverageReport 19, TracerouteExplorer 6, PacketMonitor 50 src files.)
5. **Cross-source correlation** (4.17.0) -- "When two of your radios hear the same packet, MeshMonitor draws the link, merges the message and sends one alert, not two." (`src/server/services/crossSourceCorrelation.ts`, `cross_source_links`.)
6. **MeshCore parity** (4.17.3) -- "MeshCore gets the same tools as Meshtastic: remote repeater settings, alerts, traces, security checks, map analysis and automations." Plus MeshCore MQTT ingest, embedded MeshCore broker (#6197) and Analyzer Observer.
7. **Map Analysis: terrain link profile, 3D terrain, RF coverage, ducting overlay** -- "Check line of sight and Fresnel clearance between two nodes, view 3D terrain, and see NOAA ducting forecasts." (linkProfile 13, ducting 20, terrain 9 src files.)
8. **REST API v1 + Prometheus metrics** -- "Bearer-token REST API with OpenAPI docs and a Prometheus `/api/v1/metrics` endpoint." (`src/server/routes/v1/`, `metrics.ts`, `openapi.yaml`.) Third-party iOS and Emacs clients already use it (README:393-394).
9. **13 languages** -- "Translated into 13 languages through Weblate, with inline message translation." (`public/locales/*.json`: de, en, es, fr, id, it, nb_NO, pl, pt_BR, ru, sv, zh_Hans, zh_Hant; `services/translation/`.)
10. **Passkeys and reverse-proxy SSO** -- "Sign in with a passkey, OIDC, or your reverse proxy (Cloudflare Access, oauth2-proxy, Authelia)." (`passkeyRoutes.ts`, `auth/proxyAuth.ts`.) The homepage names OIDC and MFA only.
11. **Security extras** -- impersonation detection (19 files), XEdDSA signed-packet badge (29 files), security digest preview (11 files), node-name anti-spam.
12. **ATAK / CoT and ADS-B aircraft matching** -- "Feed nodes to ATAK, and flag nodes riding in aircraft by matching ADS-B or OpenSky flights." (`atakRoutes.ts`, `adsbMatchService.ts`.)
13. **Embed maps** -- "Put a live mesh map on your own site." (`embedProfileRoutes.ts`, `embedPublicRoutes.ts`.)
14. **System backup and restore** -- "Full backup and restore across SQLite, PostgreSQL and MySQL." (`systemBackupService.ts`.) In README but not homepage.
15. **Live packet traffic on the map** (#5971) and **Direct RF Contacts** (#6388) -- visual, demo-friendly.

---

## G. Suggested homepage card set (12, down from 18)

Multi-Protocol Sources (Meshtastic, MeshCore, Reticulum, MQTT) / MeshCore parity / Unified map and Map Analysis / Messages (with S&F tags, translation) / Analysis & Reports / Automation Engine / Alerts and push / Security monitoring / Per-source permissions and Public-Instance Mode / Remote admin and ESP32 OTA / Embedded MQTT broker / Deploy anywhere (Docker, Helm, LXC, desktop; SQLite/Postgres/MySQL).
