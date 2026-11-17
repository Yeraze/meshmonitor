# MeshMonitor onboarding docs review (v4.18.0)

Scope: the new-user path through getting-started, configurator, configuration/*, deployment/*, and features/multi-source. Read-only. No repo files changed.

Every finding cites the doc line and the code or config line that proves it. Items marked **unverified** rest on reasoning or partial search, not proof.

Code facts used throughout:

| Fact | Evidence |
|---|---|
| App listens on 3001 | `Dockerfile:165` `ENV PORT=3001`; `src/server/config/environment.ts:389` default 3001 |
| Image runs in production mode | `Dockerfile:164` `ENV NODE_ENV=production` |
| Data root is `/data`; DB is `/data/meshmonitor.db` | `src/server/config/dataDir.ts` (`DEFAULT_DATA_DIR = '/data'`, `getDefaultDatabasePath`) |
| No `/app/data` anywhere in the image | `grep app/data Dockerfile docker/docker-entrypoint.sh` returns nothing; no `VOLUME` line in Dockerfile |
| `MESHTASTIC_NODE_IP` is optional | `environment.ts:565-569`; `defaultSourceConfig.ts:235-260`; `server.ts:356-364` (#5237: nothing dials unless a source row says so) |
| Unset IP gives a disabled "Default" at `meshtastic.local` | `defaultSourceConfig.ts:73`, `:254-260` |
| `ALLOWED_ORIGINS` default is `http://localhost:8080,http://localhost:3001` | `environment.ts:436-442` |
| `TRUST_PROXY` default false | `environment.ts:450` |
| `COOKIE_SECURE` default false; `COOKIE_SAMESITE` default `lax` | `environment.ts:487-488` |
| `TZ` default `UTC` | `environment.ts:604` |
| Auto session secret is not saved | `environment.ts:461-476` ("Sessions will be reset on each container restart"); `auth/sessionConfig.ts:145` |
| Rate limits: 1000/15 min prod, 10000 dev | `environment.ts:747` |
| Meshtastic sources are TCP only | source types in code: `meshtastic_tcp`, `meshcore`, `meshcore_mqtt`, `meshcore_mqtt_broker`, `mqtt_broker`, `mqtt_bridge`, `reticulum` |
| A node serves one TCP client | `docs/faq.md:643` |
| Image tags published: `:latest`, `:dev`, `:X.Y.Z`, `:X.Y`, `:X` | `.github/workflows/docker-publish.yml:297-330` |

---

## 1. Factual errors (ranked by harm)

### 1.1 Volume mounted at `/app/data` loses all data on update (critical)
- `docs/configuration/production.md:53`, `:187`, `:198` mount the named volume at `/app/data`.
- `docs/configuration/index.md:305`, `:350`, `:359` say the Docker DB lives at `/app/data/meshmonitor.db` and back it up from there.
- `docs/configuration/production.md:444`, `:756` back up and restore from `/app/data`.
- Code: the app writes to `/data` (`dataDir.ts`). The image has no `/app/data` and no `VOLUME` line. Anyone who copies the "production" compose keeps the DB in the container's writable layer. The next `docker compose pull && up -d` deletes it. The backup script copies a file that does not exist.

### 1.2 Example compose files that cannot connect
- `docs/configuration/index.md:294-306`: `image: meshmonitor:latest` (no such image, the real one is `ghcr.io/yeraze/meshmonitor`), `PORT=3000` with `ports: "8080:8080"` (the app listens on 3000, nothing listens on 8080), and the `/app/data` volume. Every line is wrong.
- `docs/configuration/http-vs-https.md:34-42`: `image: meshmonitor:latest` and `"8080:8080"`. The container listens on 3001, so the browser gets connection refused.
- `docs/configuration/production.md:183`, `:194`: `image: meshmonitor:latest`; `expose: "8080"`; nginx upstream `meshmonitor-1:8080` (`:229-230`). Both should be 3001.
- `docs/configuration/reverse-proxy.md:277`: Traefik label `loadbalancer.server.port=8080`. The container listens on 3001, so Traefik returns 502.
- `docs/configuration/reverse-proxy.md:403`: Kubernetes Ingress backend `number: 8080`. The Helm Service port is 80 (`helm/meshmonitor/values.yaml:15`).
- `docs/configuration/reverse-proxy.md:146-147` with `:81`: the nginx-in-compose example uses `expose: "8080"`, and its nginx.conf proxies to `localhost:8080`. Inside the nginx container, `localhost` is nginx itself. **Unverified**: it is not certain the reader pairs these two snippets.
- `docs/configuration/duckdns-https.md:198`: `image: yeraze/meshmonitor:latest` (Docker Hub). Every other page uses ghcr. **Unverified** whether a Docker Hub image exists. `:140` tells Docker users to `reverse_proxy meshmonitor:8080`, but a standard install listens on 3001 inside the network.
- `docs/configuration/duckdns-https.md:194-238`: the "complete" HTTPS example sets none of `ALLOWED_ORIGINS`, `TRUST_PROXY`, `COOKIE_SECURE` or `SESSION_SECRET`. `reverse-proxy.md:20-43` says that combination gives blank pages.

### 1.3 High Availability section is unsafe
- `docs/configuration/production.md:170-260` tells readers to run two replicas sharing one SQLite volume, each with `MESHTASTIC_NODE_IP=192.168.1.100`. `production.md:112` also suggests `replicas: 2`.
- Code and docs disagree: `docs/faq.md:643` says a node serves one TCP client and two clients knock each other off. Sources live in an in-process registry (`sourceManagerRegistry`). Two instances on one SQLite file is not supported. **Unverified**: no explicit single-writer guard was found. Even so, the guide leads straight to the dual-client failure the FAQ describes.
- `production.md:22` checklist item "High availability is configured" and `configurator.md:76` link to this section.

### 1.4 Shell `export` instructions do nothing
- `docs/getting-started.md:229-232` ("Change the Bootstrap Source Address") and `:319-321` (meshtasticd) tell the user to `export MESHTASTIC_NODE_IP=...` and then `docker compose up -d`.
- The Quick Start compose at `getting-started.md:147` hard-codes `MESHTASTIC_NODE_IP=192.168.1.100`. Compose only reads shell variables through `${VAR}` substitution, so the export changes nothing. (This is standard Docker Compose behaviour, not tested here.)
- `:320` and `docs/configuration/meshtasticd.md:103`, `:109` use `localhost`. Inside the MeshMonitor container, `localhost` is the container, not the host running meshtasticd. It works only with `network_mode: host`, which `meshtasticd.md:250-257` covers later.

### 1.5 Wrong defaults in the env-var reference (`configuration/index.md`)
| Line | Doc says | Code says |
|---|---|---|
| 75 | `NODE_ENV` default `development` | Docker image sets `production` (`Dockerfile:164`). The code default is development only on bare metal. The doc never says which. |
| 79 | `TZ` default `America/New_York` | `UTC` (`environment.ts:604`) |
| 112 | `MESHTASTIC_CONNECT_TIMEOUT_MS` `10000` | `60000` (`environment.ts:585`) |
| 113 | `MESHTASTIC_RECONNECT_INITIAL_DELAY_MS` `1000` | `60000` (`environment.ts:590`) |
| 115 | `MESHTASTIC_MODULE_CONFIG_DELAY_MS` `100` | `1000` (`environment.ts:600`) |
| 165 | `TRUST_PROXY` `1` in production | `false` (`environment.ts:450`); `reverse-proxy.md:16-18` says the default changed to false in 4.13 |
| 166 | `COOKIE_SECURE` `true` in production | `false` (`environment.ts:487`, with a warning at `:491-494`) |
| 167 | `COOKIE_SAMESITE` `strict` in production | `lax` (`environment.ts:488`) |
| 346, 351 | bare-metal DB at `./data/meshmonitor.db` | `/data/meshmonitor.db` unless `DATA_DIR`/`DATABASE_PATH` is set (`dataDir.ts`) |
| 373 | `openssl rand -base64 32` | the startup log tells users `openssl rand -hex 32` (`environment.ts:473`). Both work, but pick one. |
| 308-323 | Helm `ingress.host`, `ingress.tls.enabled` | values use `ingress.hosts[]` and `ingress.tls[]` (`values.yaml:73-87`) |

The missing `MESHTASTIC_NODE_PORT` synonym (`environment.ts:570-575`) matters too: the configurator emits it (`DockerComposeConfigurator.vue:890`), but `index.md` does not list it.

### 1.6 Helm instructions and chart defaults
- `docs/configuration/production.md:84-93`, `:98-137`: `--set meshmonitor.nodeIp`, `ingress.host`, `oidc.enabled/issuer/clientId/clientSecret`, `meshmonitor.sessionSecret`, `meshmonitor.replicas`. None of these keys exist in `helm/meshmonitor/values.yaml`. The real keys are `env.meshtasticNodeIp`, `ingress.hosts[]`, and `extraEnv` for OIDC and secrets.
- `docs/deployment/HELM_GUIDE.md:27-28` marks `meshtasticNodeIp` and `meshtasticUseTls` "REQUIRED". In 4.x the first is optional. Nothing reads the second: `MESHTASTIC_USE_TLS` appears in `helm/.../templates/deployment.yaml:55` but nowhere in `src/server` (only `VITE_MESHTASTIC_USE_TLS` in `src/vite-env.d.ts:5`).
- Chart default `helm/meshmonitor/values.yaml:127` `meshtasticNodeIp: "192.168.1.100"`, always emitted by `templates/deployment.yaml:53-54`. A non-empty value sets `wasProvided` (`environment.ts:568`), so a default Helm install creates an **enabled** source that dials 192.168.1.100 forever. That is the #5237 bug the Docker path fixed (`index.md:99-104`). (This is a chart bug, not a docs bug, but the docs repeat it.)
- `HELM_GUIDE.md:47-66` gives an Ingress-with-TLS example with no `extraEnv` for `ALLOWED_ORIGINS`/`TRUST_PROXY`/`COOKIE_SECURE`. By `reverse-proxy.md:39-42`, that gives a blank page.
- `helm/meshmonitor/values.yaml:160-170` still documents `autoupgrade` and `docker-compose.upgrade.yml`, both retired in 4.13 (`docs/configuration/auto-upgrade.md:3-8`).

### 1.7 Desktop page describes an older app
- `docs/configuration/desktop.md:50-60` says first-run setup asks for **Meshtastic Node IP** and Meshtastic port. The real setup form (`desktop/src/index.html:248-305`) shows only Web UI Port, Allowed Origins and Auto Start, plus the text "MeshMonitor will start with no sources configured ... add a source from the Sources page". `desktop/src-tauri/src/config.rs:8-12`, `:33-41` mark `meshtastic_ip` as legacy and empty by default.
- `desktop.md:160-180`, `:211-220` tell users to set `PORT`, `ALLOWED_ORIGINS`, `DATABASE_PATH`, `SESSION_SECRET` before launch. `desktop/src-tauri/src/lib.rs:281-298` sets all four with `.env()` on the child process, which overrides the user's values. Only Allowed Origins in the settings window works.
- `desktop.md:136` lists `auto_start` as "Start with Windows/macOS". `config.rs:18-20` says it is "not yet wired to a platform implementation".
- `desktop.md:329` table says Docker has "Auto-upgrade: Automatic". The feature was retired in 4.13. `:342` "Want automatic updates" points to the same thing.

### 1.8 Root `docker-compose.yml` points at retired and conflicting setup
- `docker-compose.yml:11-13` tells users to run with `-f docker-compose.upgrade.yml`. That file does not exist (`ls` fails) and the feature is retired.
- `docker-compose.yml:23` has `env_file: .env` with no `required: false`. A fresh clone has no `.env`, so `docker compose up` fails. (This is standard Compose behaviour, not tested here.)
- `docker-compose.yml:26` sets `NODE_ENV=development`. See 1.10.

### 1.9 Stale UI paths
- `docs/deployment/PROXMOX_LXC_GUIDE.md:68`, `:195`, `:414` say "Settings -> Node Connection". No such label exists (`grep "Node Connection" public/locales/en.json` gives 0 hits). Sources are added in the dashboard Sources sidebar (`public/locales/en.json:7089` "Sources", `:7095` "Add Source"; `features/multi-source.md:38-40`).
- `docs/features/multi-source.md:16`, `:99` say only `meshtastic_tcp` sources support Virtual Node and MeshCore ignores VN. Against that: `configuration/index.md:20` ("As of 4.11.0, a parallel MeshCore Virtual Node"), `index.md:147-148` (`MESHCORE_ENABLE_VIRTUAL_NODE`), and `virtual-node.md:8`, `:109`.
- `docs/getting-started.md:202` says 4.0 talks to "TCP, Serial, BLE, MQTT, MeshCore". Meshtastic Serial and BLE work only through bridge sidecars. `multi-source.md:4`, `:13` say this correctly.

### 1.10 `NODE_ENV` differs by install path (cross-page)
| Path | `NODE_ENV` | Evidence |
|---|---|---|
| Docker image | production | `Dockerfile:164` |
| getting-started Quick Start | production (not set) | `getting-started.md:136-153` |
| Repo `docker-compose.yml` | development | `docker-compose.yml:26` |
| Configurator default mode | development | `DockerComposeConfigurator.vue:694`, `:873-874` |
| Desktop | production | `lib.rs:281` |

Development mode raises the API rate limit 10x and the auth limit from 5 to 100 (`environment.ts:747-748`). It also adds dev CORS origins (`server.ts:168-170`) and turns on debug logging. A beginner following the configurator's default runs with a looser login brute-force limit than the Quick Start gives. `getting-started.md:221` says "The Docker container runs in production mode", which is true only for the hand-written Quick Start.

`getting-started.md:302` ("Rate limiting: Stricter (1000 requests/15min vs 10,000)") implies the home setup has the looser limit. It does not: both run in production with 1000.

### 1.11 Other wrong or risky details
- `getting-started.md:370` `docker volume rm meshmonitor-meshmonitor-data`. Compose names volumes `<project>_<name>`, i.e. `meshmonitor_meshmonitor-data`. `DEPLOYMENT_GUIDE.md:440`, `:532` use the underscore form, so the two pages disagree. The step also wipes all data as a "quick fix", with no backup warning.
- `getting-started.md:166`, `:209` say SESSION_SECRET is not needed but omit that every restart logs everyone out (`environment.ts:475`).
- `getting-started.md:147-148` and the configurator default (`DockerComposeConfigurator.vue:689`) seed `192.168.1.100`. A user who copies it unedited gets an enabled source that dials a made-up address. `index.md:61-62` says no env vars are required.
- `getting-started.md:148` "ALLOWED_ORIGINS=http://localhost:8080 # Required for CORS". That value is already the default (`environment.ts:440`). The line that matters is the LAN-IP case at `:253-258`, which comes 100 lines later. A first-timer on a headless Pi opens `http://<pi-ip>:8080` and gets the blank page.
- `getting-started.md:20`, `:57` send Kubernetes users to `DEPLOYMENT_GUIDE`, not `HELM_GUIDE`.
- `getting-started.md:352` FAQ teaser "Multiple nodes - How to run multiple MeshMonitor instances". In 4.x one instance handles many nodes (`faq.md:156`, `:184-185`).
- `DEPLOYMENT_GUIDE.md:147` says "Should be v20.x or higher". Line 111 and CLAUDE.md say 22+.
- `DEPLOYMENT_GUIDE.md:155` clones into the current directory, but the unit file (`:250`) and update steps (`:306`) expect `/var/lib/meshmonitor/meshmonitor`. No step moves it there. `:178` chowns to the current user, then `:275` chowns to `meshmonitor`, so later `git pull`/`npm install` as the current user hit permission errors (**unverified** in practice).
- `DEPLOYMENT_GUIDE.md:163`, `updating.md:258` use `npm install --legacy-peer-deps`. `.npmrc` already pins it (per CLAUDE.md), so the flag is redundant but harmless.
- `production.md:525` `curl .../api/status`. No `/status` route is mounted at the API root. `apiRouter.ts` mounts `/health`, and the status route lives at `/api/v1/sources/{id}/status` (`routes/v1/index.ts:72`, `:132`). **Unverified**: the router has 74 mounts and not all were read.
- `production.md:289`, `:309` use `ufw deny 8080`. Docker-published ports bypass ufw. The real protection is the `127.0.0.1:` bind at `:55`. (Known Docker behaviour; **unverified** here.)
- `http-vs-https.md:190-209` shows Express HTTPS code for an "Option 2" that the next line says MeshMonitor does not support. It is filler that misleads.
- `configurator.md:52` and `DockerComposeConfigurator.vue:913-914` say the VN env vars "were removed". `index.md:117-130` and `virtual-node.md:79-96` document `ENABLE_VIRTUAL_NODE` as a live first-boot var. The configurator text is half right: `VIRTUAL_NODE_ALLOW_ADMIN_COMMANDS` was removed, the other two were not.
- Configurator offers only TCP, BLE and Serial (`DockerComposeConfigurator.vue:29-45`). It has no "MeshCore", "MQTT only" or "add sources later" choice, although `getting-started.md:106-118` lists those as valid first sources.
- `configuration/tested-hardware.md` lists no MeshCore hardware (0 mentions), although MeshCore is a first-class source type.
- Sidebar label `config.mts:291` "Unattended Upgrades" links to `auto-upgrade.md`, which is a retired-feature stub. Unattended updates (Watchtower) live in `updating.md:132`.
- LXC is labelled "Community" (`getting-started.md:21`, `PROXMOX_LXC_GUIDE.md:28`), yet official CI builds and publishes it (`.github/workflows/lxc-template-build.yml`). This is a labelling call, not an error, but it confuses readers.

---

## 2. Duplication

| Topic | Where it appears | Proposed single home |
|---|---|---|
| Docker Compose quick start (compose YAML + login) | `getting-started.md:128-199`, `DEPLOYMENT_GUIDE.md:41-76`, `serial-bridge.md:86-112`, `ble-bridge.md:186-240`, configurator output, root `docker-compose.yml` | `getting-started.md` only. Others link to it and show a diff ("add this service"). |
| Image tag table | `getting-started.md:155-164`, `DEPLOYMENT_GUIDE.md:66-68`, `production.md:30-32`, `updating.md:74-83`, `faq.md:453` | FAQ entry (already canonical); one-line link elsewhere |
| HTTPS/proxy env vars (`SESSION_SECRET`, `TRUST_PROXY`, `COOKIE_SECURE`, `ALLOWED_ORIGINS`) | `getting-started.md:282-302`, `production.md:9-14`, `reverse-proxy.md:20-43`, `DEPLOYMENT_GUIDE.md:330-337`, `index.md:161-171`, `docker-compose.yml:39-48`, configurator | One "Secure it" page (see IA). Every other page links there. |
| nginx/Caddy configs | `reverse-proxy.md`, `http-vs-https.md:162-188`, `production.md:224-249`, `DEPLOYMENT_GUIDE.md:339-370`, `duckdns-https.md:112-238` | `reverse-proxy.md` |
| Bare-metal update steps | `DEPLOYMENT_GUIDE.md:301-322` and `updating.md:245-264` (identical) | `updating.md` |
| Helm install | `production.md:72-168`, `DEPLOYMENT_GUIDE.md:80-100`, `HELM_GUIDE.md`, `index.md:308-342`, `updating.md:216-232` | `HELM_GUIDE.md` (+ `updating.md` for upgrade) |
| Backups | `index.md:353-363`, `production.md:426-512`, `DEPLOYMENT_GUIDE.md:408-445`, `features/system-backup` | `features/system-backup.md`, plus one volume-backup snippet |
| "Bootstrap only" env-var warning | `getting-started.md:197-234`, `configurator.md:3-11`, `index.md:84-105`, `multi-source.md:21-34`, `values.yaml:121-124` | `multi-source.md` ("Where do sources come from") |
| Desktop vs Docker choice | `getting-started.md:13-33`, `desktop.md:318-343` | `getting-started.md` table |

---

## 3. Ordering problems

1. **getting-started puts the decision before the action.** Lines 1-127 (seven methods, two lists of the same seven, Portainer steps, prerequisites) come before the first command at line 136. A beginner wants the four-line compose first and the choice table as a side note.
2. **The radio comes before the install, but connecting happens after.** Prerequisites (`:106-118`) ask for a node before install. Yet in 4.x the cleanest path is install with no env vars, log in, then add the source in the UI. The doc never shows that path end to end. The UI step is a three-line note at `:197-199` with no screenshot or steps; `multi-source.md:36-47` has them.
3. **The LAN-IP CORS trap comes too late.** The step most first-timers need (open from another machine) is at `:244-272`, after timezone tweaks.
4. **Production material sits inside the beginner page.** `getting-started.md:274-302` repeats the HTTPS checklist. `configurator.md:28-34` sends beginners to "High Availability", "Monitoring" and "Database Optimization" right after first deploy.
5. **The configuration sidebar mixes levels.** "Get Started" (`config.mts:248-255`) leaves out getting-started itself. "Connect Your Mesh" (`:257-265`) lists only Meshtastic transports, with no MeshCore or MQTT entry, and leaves out multi-source (filed under Features → Start Here, `:53`). Deployment guides are collapsed at the bottom (`:297-306`).
6. **Pages with no sidebar.** `config.mts:225-355` has no key for `/getting-started`, `/configurator` or `/deployment/`, so those pages render with no sidebar. Clicking "Docker Compose Configurator" from the configuration sidebar drops the reader out of it.
7. **`configuration/index.md` mixes a topic index, a full env reference, wrong compose/Helm snippets, backups and logging in one 437-line page.** It is both "Overview" and "Reference", and serves neither well.

---

## 4. Proposed information architecture

Constraint: the site has no redirects (`config.mts:39-43`), and the app links to fixed doc URLs. These must keep working:
`/getting-started`, `/faq` (+ `#i-see-a-blank-white-screen-when-accessing-meshmonitor`), `/configuration/`, `/configuration/virtual-node`, `/configuration/updating`, `/configuration/duckdns-https`, `/deployment/HELM_GUIDE`, `/deployment/RETICULUM_BRIDGE_GUIDE`, `/features/multi-source`, `/features/meshcore`, `/features/mqtt-broker`, `/features/settings` (from `grep meshmonitor.org/ src desktop/src`). So "merge", "move" and "cut" mean: rewrite in place, leave a short stub page that links on (as `auto-upgrade.md` does), and regroup the sidebar. No file renames.

### New sidebar: one "Set up" group shared by `/getting-started`, `/configurator`, `/configuration/` and `/deployment/`

**1. Install**
- `getting-started.md` (rewrite). Docker Quick Start first, with **no** `MESHTASTIC_NODE_IP` and no `ALLOWED_ORIGINS` line. Then a short "Open from another device" box with the `ALLOWED_ORIGINS` rule. Then log in, change the password, and go to step 2. Move the method table to a short "Other ways to install" list at the bottom.
- `configurator.md`: keep. Add "No radio yet / MeshCore / MQTT: add sources in the UI" as a connection choice. Make the default mode emit `NODE_ENV=production` (or drop the line). Drop the "Advanced Topics" list that links to HA and tuning.
- `configuration/desktop.md`: rewrite the setup section to match `desktop/src/index.html`. Remove the env-var table, or mark it "ignored, the app sets these".
- `deployment/HELM_GUIDE.md`: canonical Kubernetes page. Fix "REQUIRED". Add `extraEnv` for the HTTPS vars to the Ingress example.
- `deployment/PROXMOX_LXC_GUIDE.md`: keep. Replace "Settings → Node Connection" with the Sources sidebar.
- `deployment/DEPLOYMENT_GUIDE.md`: shrink to **Bare metal** only. Cut its Docker and Helm "short versions". Fix the clone path and the Node version. Leave the page URL in place.

**2. Connect your radio**
- `features/multi-source.md`: make it the hub ("Add a source"). Add a short decision list at the top: WiFi/Ethernet Meshtastic → TCP source; USB Meshtastic → Serial Bridge; BLE → BLE Bridge; MeshCore USB/TCP → native source; MQTT → broker/bridge source; no hardware → meshtasticd. Fix the MeshCore VN claim. Keep the URL; list it in this sidebar group as well as Features.
- `ble-bridge.md`, `serial-bridge.md`, `meshtasticd.md`: keep as children. Replace the "set `MESHTASTIC_NODE_IP=bridge`" steps with "add a TCP source with host `<bridge container name>`, port 4403", keeping the env var as the headless option. Use one container name per bridge across pages and the configurator.
- `virtual-node.md`: move under this group (it is about connecting phone apps).
- `tested-hardware.md`: move to the bottom of this group, and add MeshCore rigs.

**3. Secure it**
- New canonical content in `http-vs-https.md` (keep the URL, rename the label to "Secure your instance"). Cover: when you need HTTPS (internet, passkeys, push), the four env vars in one block, and links to the proxy recipes. Cut the generic certificate essays (commercial CAs, internal CA, Express HTTPS code, cipher lists).
- `reverse-proxy.md`: recipes only (nginx, Caddy, Traefik, Apache, Ingress), with every upstream port fixed to 3001 (or the host-mapped 8080 where the proxy runs on the host). Remove its own copy of the env-var block and link to step 3.
- `duckdns-https.md`: keep (the app links to it). Fix the image, port and missing env vars, and link to the env block.
- `sso.md`, `passkeys`, `fail2ban.md`: keep in this group.
- `production.md`: shrink to a checklist plus Docker security (PUID, non-root, USB groups). **Cut** "High Availability" and "Load Balancing" entirely. Cut the Helm section (link `HELM_GUIDE`). Move backups to `features/system-backup`. Fix every `/app/data`.

**4. Update it**
- `updating.md`: canonical. Add Desktop (download the new installer) and Portainer (re-pull and redeploy) sections, now only in `getting-started.md:93-94`. Bump the 4.13.0 examples or use `<version>`.
- `auto-upgrade.md`: keep the stub. Rename the sidebar label from "Unattended Upgrades" to "Auto-Upgrade (retired)", or drop it from the sidebar and keep only the URL.

**Reference (separate group, collapsed)**
- `configuration/index.md`: turn into "Environment variables" reference only. Fix the defaults in 1.5. Delete the "Configuration Files", "Database Configuration" and "Security Considerations" sections (all wrong or duplicated). Keep the URL, since the app links `/configuration/`.
- `node-load.md`, `custom-tile-servers.md`, notifications: here.

### Repo-file fixes that support the docs
- `docker-compose.yml`: drop the `docker-compose.upgrade.yml` comment, make `env_file` optional (`required: false`) or remove it, and drop `NODE_ENV=development`.
- `helm/meshmonitor/values.yaml`: default `meshtasticNodeIp: ""`, remove `meshtasticUseTls` and `autoupgrade`.
- `DockerComposeConfigurator.vue:913-914`: correct the "removed" comment.
