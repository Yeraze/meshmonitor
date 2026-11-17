# MeshMonitor docs review: large feature pages (how-to / reference / concept split)

Read-only review, MeshMonitor 4.18.0, 2026-11-17. All paths are relative to the repo root
`/home/yeraze/Development/meshmonitor`. "unverified" marks claims I did not prove in code.

## 0. Two constraints that shape every proposal

1. **No redirects.** `docs/.vitepress/config.mts:40-43` says the site has no redirect
   mechanism and that moving a page "would break every inbound link permanently". So every
   existing URL must stay alive. A split means: the old page becomes a short hub, and new
   pages hold the detail.
2. **The app deep-links into these pages by anchor.** Full sweep of non-test `src/**/*.ts(x)`
   for `features/<page>#<anchor>`:
   - `features/automation#` (15): auto-acknowledge, auto-announce, auto-delete-by-distance,
     auto-favorite, auto-key-management, auto-localstats, auto-ping, auto-responder,
     auto-time-sync, auto-traceroute, auto-welcome, forwarding, ignored-nodes,
     remote-admin-scanner, timer-triggers.
   - `features/meshcore#` (4): auto-announce, auto-responder, forwarding, timer-triggers.
   - `features/device#` (12): node-identity, device-configuration, lora-radio-configuration,
     position-configuration, power-configuration, display-configuration,
     telemetry-configuration, network-configuration, mqtt-configuration, neighbor-info,
     canned-message-configuration, store-and-forward-configuration.
   - `features/mqtt-broker#why-no-mqtt-traffic`, `features/mqtt-setups#how-much-airtime-downlink-costs`,
     `features/coverage-report#why-a-survey-looks-sparse`.

   Docs-to-docs links also target ~60 anchors on these pages (grep of `docs/**/*.md` for
   `/features/(automation|automation-engine|meshcore|settings)#…`). Most cited:
   `settings#likely-aircraft-detection` (5), `automation#forwarding` (4),
   `settings#map-settings` (3), and 2 each for `automation#geofence-triggers`,
   `automation#auto-acknowledge`, `automation-engine#sent-by`,
   `automation-engine#broadcast-a-waypoint`, `meshcore#regions-scopes`,
   `meshcore#automated-channel-send-auto-retry`, `settings#hide-incomplete-nodes`,
   `settings#database-maintenance`, `settings#tropospheric-ducting-overlay`,
   `settings#mqtt-root-directory-refresh`. A split must either keep these as stubs or update
   the linking pages in the same PR. **Any split must keep each anchor
   on the old page** as a stub heading with the same `{#id}` and one line plus a link. The
   existing `## Auto Heap Management` stub (`docs/features/automation.md:2443-2451`, pointing
   to `auto-heap-management.md`) is the pattern to copy.

**Three in-app help links are already broken:**

| App link | Source | Why it fails |
|---|---|---|
| `features/automation#auto-localstats` | `src/components/AutoLocalStatsSection.tsx:434` | Heading is `{#auto-remote-localstats}` (`automation.md:379`) |
| `features/automation#auto-delete-by-distance` | `src/components/AutoDeleteByDistanceSection.tsx:250` | No such section exists in `automation.md` |
| `features/automation#auto-delete-by-distance` | `src/components/MeshCore/MeshCoreAutoDeleteByDistanceSection.tsx:166` | Same |

(Checked by a script that slugs every heading on the target page and compares it with each
`features/<page>#<anchor>` string in non-test `src/` files.)

---

## 1. automation.md (19.6k words) and automation-engine.md (16.5k words)

### 1.1 What the app shows users today (the key question)

The UI has **three automation surfaces, and none uses the doc title "Automatic Responses"**:

| Surface | UI label | Evidence |
|---|---|---|
| Per-source built-ins (Meshtastic) | sidebar **Automation** | `public/locales/en.json:67` `"nav.automation": "Automation"`, `:1479` `"automation.title": "Automation"`; tab id `'automation'` in `VALID_TABS` (`src/types/ui.ts:29`) |
| Per-source built-ins (MeshCore) | MeshCore sub-toolbar **Automations** | `src/components/MeshCore/MeshCoreSubToolbar.tsx:51` (fallback `'Automations'`) |
| Global engine | dashboard sidebar **Automation Engine**, page heading **Automation Engine**, route `/automations` | `src/components/Dashboard/DashboardSidebar.tsx:1142-1149` (`t('source.sidebar.automations', 'Automation Engine')`, gated on `hasPermission('automations','read')`); `src/components/automations/AutomationsPage.tsx:130` `<h1>Automation Engine</h1>` |

- `grep "Automatic Responses"` over `src/` and `public/locales/en.json` finds **zero hits**. The
  phrase lives only in the docs: the H1 at `docs/features/automation.md:1` and the sidebar
  entry at `docs/.vitepress/config.mts:125`.
- The built-ins are **not** marked legacy or deprecated in the UI: `grep -i 'legacy\|deprecat'`
  over `public/locales/en.json` finds no automation, timer, geofence, responder, announce or
  engine string, and the hits in `AutoAcknowledgeSection.tsx`, `AutoResponderSection.tsx`,
  `TimerTriggersSection.tsx` and `AutomationTab.tsx` are code comments about data formats or
  single-source views, not user text. The Meshtastic
  Automation tab's only pointer to the engine is a footer in the token reference: "Want
  maximum flexibility? Try the **Automation Engine** — build global 'when this happens, do
  that' workflows across every source." (`src/components/AutomationTab.tsx:157-165`,
  `en.json:8497,8504,8505`). The MeshCore Automations view carries the same link
  (`MeshCoreAutomationsView.tsx:205-206`).
- **Only Auto Acknowledge has a converter** to the engine (`src/components/autoack/AutoAckConvertDialog.tsx`;
  `en.json` has one `automation.auto_ack.convert*` key family and no other `*.convert*`
  family). Timers, geofences, responder and announce have no migration path.
- The Meshtastic Automation tab has **18 sections** (`src/components/search/configSections.ts:312-329`):
  Cutoff Airtime Utilization Threshold, Auto Welcome, Auto Favorite, Auto Traceroute, Auto
  Remote LocalStats, Auto Ping, Auto Heap Management, Remote Admin Scanner, Auto Time Sync,
  Auto Acknowledge, Auto Announce, Auto Responder, Forwarding, Auto Key Management, Timer
  Triggers, Geofence Triggers, Auto Delete by Distance, Ignored Nodes. The MeshCore view has
  12 (`configSections.ts`, ids `meshcore-automation-*`): Auto-Pathfinding, Auto-Acknowledge,
  Auto-Announce, Auto-Responder, Auto Ping, Forwarding, Timer Triggers, Auto Delete by
  Distance, Time Sync, Remote Telemetry, Auto Favorite, Auto Welcome.
- The engine's Template Gallery ships four templates: Auto-Ack, MT↔MC Bridge, Device Health,
  Timed Announcement (`src/components/automations/templates/*.ts`). Together with the
  schedule and geofence triggers and the `action.setSourceForwardingEnabled` action, the
  engine overlaps these built-ins: Auto Ack, Auto Announce, Timer Triggers, Geofence
  Triggers. It has **no equivalent** for Auto Ping, Remote Admin Scanner, Auto Key
  Management, Auto Heap Management, Auto Favorite, Auto Time Sync, Auto Traceroute
  (scheduled), Auto Delete by Distance, Ignored Nodes, or the airtime cutoff (unverified for
  a full engine-catalog sweep; based on the action headings at `automation-engine.md:406-917`).
- Permissions are separate too: the engine uses global `automations`, the built-ins use
  per-source `automation` (`automation-engine.md:48-49`).

**Answer: do not merge the two pages, and do not call the built-ins "legacy" in user docs
yet.** The app presents them as two first-class features: a per-source settings tab of
ready-made behaviours, and a global rule builder. Most built-ins have no engine
equivalent, and only one has a converter. A merged 36k-word page would be worse. What the
docs should change:

1. **Rename the built-ins page to match the UI.** Retitle `automation.md` from "Automatic
   Responses" to **"Automation tab (built-in automations)"**, and rename the sidebar entry
   (`config.mts:125`) the same way. Keep the URL.
2. **Fix the engine page's location wording.** `automation-engine.md:20` says the engine "lives
   on its own top-level **Automations** tab", and `:922` says "the Automations page". The UI
   says **Automation Engine** (dashboard sidebar), and "Automations" is what the MeshCore
   per-source built-ins tab is called, so the current wording points MeshCore users at the
   wrong screen.
3. **Stop the engine page from calling the built-ins "legacy"** (`automation-engine.md:23`
   "Where a legacy automation gives you…", `:49` "legacy per-source `automation`
   permission", `:1197` "The legacy Auto Acknowledge feature predates the engine"). Either
   the product treats them as legacy, in which case the UI should say so, or it does not.
   That is a product decision for the maintainer. Ask before you pick one. For the four
   overlapping built-ins (Ack, Announce, Timer, Geofence), the honest framing is "built-in,
   simpler; the engine can do the same and more", with a link to the matching template or
   trigger.
4. **Add one shared chooser** (a table: "I want to… → use") at the top of both pages, in place
   of the two near-identical "Two automation pages — which one?" tips
   (`automation.md:3-10` and `automation-engine.md:8-14`).

### 1.2 Current structure (brief)

- `automation.md` (2465 lines): one H2 per built-in, each with the same template: How It
  Works / Configuration / Side Effects / Use Cases / Best Practices / Troubleshooting /
  Related Meshtastic docs. Biggest blocks: Auto Responder `:928-1615` (~690 lines, of which
  script material `:1116-1436` is ~320 lines), Geofence Triggers `:1923-2166` (~245), Timer
  Triggers `:1686-1922` (~235), Auto Acknowledge `:27-318` (~290). Ends with Auto Key Mgmt,
  Auto Favorite, Remote Favorites, Ignored Nodes, a heap stub, storage, permissions.
- `automation-engine.md` (1562 lines): Overview `:27`, Triggers `:61` (each trigger, cooldown,
  rate limit), Conditions `:310`, Actions `:406-917` (~510 lines), Template Gallery `:919`,
  three Recipes `:958-1194`, Converting Auto-Ack `:1195-1277`, Variables `:1278`, Tokens
  `:1330-1511`, Testing `:1512`, Live trace `:1545`.

### 1.3 Duplication

| Topic | Location A | Location B |
|---|---|---|
| "Which page?" tip | `automation.md:3-10` | `automation-engine.md:8-14` |
| Auto-Ack → engine conversion | `automation.md:286-298` ("A **Convert to an Automation…** button in this section turns your current Auto Acknowledge configuration into one or two editable … workflows") | `automation-engine.md:1195-1277` ("A **Convert to an Automation…** button in its settings section … turns an existing per-source configuration into one or two editable automations") |
| Geofence | `automation.md:1923-2166` (full reference) | `geofence-triggers.md` (494-word how-to) and `automation-engine.md:237-243` (engine geofence trigger, which itself links to geofence-triggers.md) |
| Cron / scheduling | `automation.md:1719-1742` "Cron Expression Format" (Timer Triggers) | `automation-engine.md:183-229` "Schedule trigger (live cron)"; `meshcore.md:1019-1025` Timer Triggers |
| Forwarding | `automation.md:1616-1685` | `automation-engine.md:802-846` (action that flips the master switch, re-explains it); `meshcore.md:1015-1017` |
| Auto Responder | `automation.md:928-1615` | `meshcore.md:990-1013` (MeshCore Auto-Responder, incl. Match mode, pre-send delay, scope, route tokens) |
| Auto Announce | `automation.md:820-927` | `meshcore.md:980-988` |
| Auto Ping (MeshCore) | `automation.md:528-557` "MeshCore Companion Sources" | `meshcore.md:976-978` |
| Script args / parameters / env vars / response format | `automation.md:1116-1151` "Script Arguments (Auto Responder)", `:1244-1277` "Parameter Extraction", `:1278-1432` "Script Response Details", `:1754-1805` Timer script args, `:2023-2071` Geofence script args | `developers/auto-responder-scripting.md:234-383` "Script Arguments", `:553-693` "Parameter Extraction / Multiple Patterns", `:197-233` "JSON Output Format", `:384-552` "Environment Variables". Same wording in places, e.g. `automation.md:1118` and `auto-responder-scripting.md:236` both say "Arguments support token expansion, allowing dynamic val[ues]…" |
| Engine script env | `automation-engine.md:656-695` (`MM_*` vars) | `auto-responder-scripting.md` has the `MM_` names (7 hits) without saying they come from the engine |
| Token tables | `automation.md` (per-feature token lists) | `automation-engine.md:1330-1511` Tokens; `meshcore.md:1001-1013` route tokens; the app itself has a token reference panel (`AutomationTokenReference`) |

### 1.4 Stale or missing content

- **"Automatic Responses" is not a UI name** (see 1.1). Stale title and sidebar label.
- **"top-level Automations tab" / "Automations page"** (`automation-engine.md:20, 922`): UI says
  "Automation Engine".
- **Cutoff Airtime Utilization Threshold has no section of its own.** It is a top-level
  section in the UI (`configSections.ts:312`, `src/components/AirtimeCutoffSection.tsx`, which
  holds the infrastructure picker: 21 "infra" hits; `en.json:7457-7475`). The docs file its
  measurement-source and picker settings under **Auto Remote LocalStats** as "Airtime gate:
  measurement source" (`automation.md:412-431`). A user looking for the cutoff will not find
  it.
- **Auto Delete by Distance is undocumented** on the automation page, though both Meshtastic and
  MeshCore show the section and link to `#auto-delete-by-distance` (broken, see §0). It is
  only described in a 2026-03-15 blog post, a superpowers spec, and a row in
  `multi-source.md:194`.
- **MeshCore Auto Welcome, Auto Favorite and Auto Delete by Distance** appear in the MeshCore
  Automations view (`configSections.ts`, `meshcore-automation-*`), but are documented for
  MeshCore nowhere. `meshcore.md` has no mention of "welcome" or "delete by distance", and
  its "favourite"/"favorite" hits (`:320-665`, `:1085`) are about the star and the radio
  contact list, not the Auto Favorite automation. In `automation.md`, the Auto Welcome
  section (`:731-819`) and Auto Favorite section (`:2236-2318`) contain zero "MeshCore"
  mentions. (MeshCore Auto-Acknowledge and Time Sync are mentioned in `meshcore.md`, 8 and 2
  hits, but have no heading of their own.)
- **"Remote Admin tab"** (`automation.md:2325`, Remote Favorites): the nav label is **Admin
  Commands** (`en.json:70`), and the section label there is "Automatic Favorites"
  (`configSections.ts`, `admin-auto-favorites`). Remote Favorites is not on the Automation
  tab at all, so it belongs in `admin-commands.md` with a stub left here.
- `automation.md:1` H1 and the `automation-engine.md` tips say Meshtastic-flavoured "Auto
  Acknowledge"; MeshCore UI says "Auto-Acknowledge" with a hyphen. Minor.

### 1.5 Proposed structure

Keep both URLs. Turn `automation.md` into a hub. Add pages under a new sidebar group.

**Sidebar group "Automation" (replaces the first two entries at `config.mts:125-126`):**

1. **Automation overview** (`/features/automation`, existing URL, rewritten to ~800 words):
   - Chooser table: "I want to… → built-in or engine → link".
   - The `is_automation` flag (`automation.md:16-25`, keep here, it applies to both).
   - The airtime cutoff (move from `:412-431` into its own `{#airtime-cutoff}` section here; it
     pauses everything).
   - One short stub per built-in, keeping every anchor the app uses (§0), each "what it does
     in one sentence → link to its page". Add the missing `{#auto-localstats}` anchor (or fix
     the app link) and a real `{#auto-delete-by-distance}` stub.
   - Storage and permissions (`:2453-2460`).
   - **Start here:** "Reply to anyone who sends `ping`: Automation tab → Auto Responder →
     Add trigger → `ping` → Text `pong` → Done → Save" (5 steps).
2. **Message bots** (new, `/features/automation-replies`): Auto Acknowledge, Auto Responder
   (text and HTTP), Auto Welcome, Auto Announce, Forwarding. How-to first ("Answer range
   testers", "Run a keyword bot", "Forward DMs to my phone"), then a reference table per
   feature. Absorbs the MeshCore copies at `meshcore.md:976-1025` (one page, both protocols,
   per the project's MT/MC parity rule), with a "MeshCore differences" box per feature
   (160-byte cap, no reply-to, scope).
3. **Scheduled and location triggers** (new, `/features/automation-triggers`): Timer
   Triggers and Geofence Triggers, how-to first. Fold `geofence-triggers.md` into it or keep
   that page as the short how-to and move the long reference `automation.md:1923-2166` there.
   Each section ends with "Need conditions or several actions? The engine's schedule /
   geofence trigger".
4. **Node and network upkeep** (new, `/features/automation-upkeep`): Auto Traceroute, Auto
   Remote LocalStats, Auto Ping, Auto Time Sync, Auto Key Management, Auto Favorite, Auto
   Delete by Distance (new text needed), Remote Admin Scanner, Ignored Nodes, and the existing
   Auto Heap Management page linked.
5. **Automation Engine** (`/features/automation-engine`, existing URL): keep as the concept and
   how-to page: Overview, a "Build your first automation in 5 steps" task, Template Gallery,
   Testing, Live trace, Variables. **Start here:** "Install Device Health from the gallery
   and enable the Low battery alert."
6. **Automation Engine reference** (new, `/features/automation-engine-reference`): every
   trigger, condition, action (`:61-917`) and token (`:1330-1511`). This is ~60% of the
   current page and is lookup material.
7. **Automation Engine recipes** (new): the three recipes (`:958-1194`) and the Auto-Ack
   conversion (`:1195-1277`). Leave stub anchors behind for
   `#recipe-per-channel-range-test-acks-issue-4340`, `#recipe-mt-mc-bridge`,
   `#flood-safety`, `#converting-auto-acknowledge-to-an-automation`, which other pages link to.
8. **Scripting** (`developers/auto-responder-scripting.md`): make it the single home for script
   requirements, args, env vars, JSON output and `mm_meta`, for **all four** script callers
   (Auto Responder, Timer, Geofence, Engine "Run a script"). Replace `automation.md:1116-1151`,
   `:1244-1277`, `:1278-1432`, `:1754-1805`, `:2023-2071` with links. Rename it "Writing
   automation scripts".

---

## 2. developers/auto-responder-scripting.md (4.5k words)

**Structure:** Overview, Supported Languages, Quick Start (create, deploy, configure, test),
Script Requirements (`mm_meta`, JSON output), Script Arguments, Environment Variables
(location, timezone, parameter extraction, custom regex, multiple patterns), language
examples, advanced patterns, debugging, security, performance, troubleshooting, API
reference, version table.

**Duplication:** see §1.3 row "Script args…". `automation.md` carries a ~320-line second copy.

**Stale:**
- `auto-responder-scripting.md:13` lists Node.js **v22.21.1**. The image is
  `FROM node:24.22.1-alpine3.24` (`Dockerfile:87`). The Python 3.12.12 row is unverified
  against Alpine 3.24.
- `:1256-1258` (Support) and two more hits link to `github.com/MeshAddicts/meshmonitor`; the
  repo is `Yeraze/meshmonitor` (`git remote -v`), and `automation.md` already uses Yeraze. One
  more MeshAddicts link is in `automation.md` (`grep -c` = 1).
- `:1246-1251` Version Compatibility (v2.17.8 / v2.18.0) is ancient history for a 4.18 product;
  drop it.
- The title says "Auto Responder" but Timer, Geofence and Engine scripts use the same runner
  (`automation-engine.md:658` "the same directory the Auto Responder uses"). The page never
  mentions the engine.

**Proposal:** retitle "Writing automation scripts"; add a "Which caller passes what" table
(Auto Responder: `MESSAGE`, `PARAM_*`…; Timer: `{IP}`/`{PORT}` arg tokens; Geofence:
`GEOFENCE_NAME`, `NODE_LAT`…; Engine: `MM_*` plus aliases). **Start here:** the existing Quick
Start (`:17-112`) is good; keep it first.

---

## 3. meshcore.md (19.1k words)

**Structure:** Overview, Source Types, Requirements, Adding a source (TCP, env vars, headless
first boot), Device Types, What a Repeater Shows (repeater/remote settings), The MeshCore Page
(map, channels, channel order, node details, route line, send bar, contact tokens, API
sender names, reactions, node info, configuration), Backups, Telemetry, Regions/Scopes, Radio
contact table, Remote Administration, Analyzer Observer (stub), Path Visualization, Trace SNR
History, Position History, Ignore and Block, Neighbor Discovery, Active Node Discovery,
Auto-Pathfinding, Adverts, then **automation sections** (Auto Ping, Auto-Announce,
Auto-Responder, Forwarding, Timer Triggers), Security, Auto-Retry, Room Servers, Dashboard,
API, Permissions, Receive-Only (stub), Per-Source Settings, Autopoll, Radio Config, Packet
Monitor, Notifications, Still Early, Troubleshooting.

**Duplication:** automation sections `:976-1025` vs `automation.md` (§1.3). Receive-only
(`:1105`) and Analyzer Observer (`:795`) are already stubs linking to their own pages, which
is the right pattern.

**Stale / gaps:**
- MeshCore Auto Welcome, Auto Favorite and Auto Delete by Distance have UI sections but no
  doc coverage for MeshCore anywhere; Auto-Acknowledge and Time Sync are mentioned but have
  no heading (see §1.4).
- "Still Early" (`:1185-1194`) says a Repeater source "cannot send messages or traces";
  unverified against the 4.17.3 parity work (blog `2026-11-13-v4.17.3-meshcore-parity.md`).
  Worth a re-check; it reads like a 4.5-era roadmap note.

**Proposal (keep `/features/meshcore` as hub, ~1.5k words):**
1. **MeshCore overview** (existing URL): what it is, source and device types, a feature map,
   links. **Start here:** "Add a Companion over TCP and send your first channel message"
   (from `:53-90`, `:239`, `:365`).
2. **Set up a MeshCore source** (new): Adding a source, TCP, env vars, headless boot,
   requirements, troubleshooting `:1196-1216`.
3. **Using the MeshCore page** (new): map, channels, node details, send bar, reactions,
   contact tokens, regions/scopes, ignore/block, room servers.
4. **Paths and discovery** (new): path visualization, trace SNR, neighbor discovery, active
   discovery, auto-pathfinding, adverts and flood limit, autopoll.
5. **Repeaters and remote admin** (new): what a repeater shows, remote settings, remote
   console, credential store, danger commands, audit, CLI history.
6. Automation: move to the shared automation pages (§1.5), with stubs left for the four
   anchors the app links to (`#auto-responder`, `#auto-announce`, `#forwarding`,
   `#timer-triggers`).
7. Keep Backups, Telemetry, Permissions, API on a **MeshCore reference** page.

---

## 4. device.md (10.5k words)

**Structure:** one H2 per Device Configuration section (Node Identity, Device, LoRa, Position,
Power, Display, Telemetry, Network, MQTT, Neighbor Info, Canned Message, Store and Forward,
Status Message, TAK, Security), then Applying Changes, Troubleshooting, **Device
Configuration Backup** (`:1524-1802`, ~280 lines), Firmware Updates. Each field has
Description / Effect / Use Cases, plus "Related Meshtastic Documentation" after every
section. Device Role alone is `:67-252` (~185 lines).

**Duplication:**
- MQTT module `:1060-1210`, especially Proxy to Client `:1151-1181`, overlaps
  `mqtt-broker.md:118-128` "Three ways a device can reach MQTT" and `mqtt-setups.md:36-49`
  "How a node reaches the broker". Three tables explaining the same two modes.
- Store and Forward `:1323-1398` vs `store-forward.md` (unverified depth).

**Stale:** not swept field by field (unverified either way). Spot checks: the backup UI names
match (`en.json:4995` "Device Backup Management", `:5011` "Saved Backups"), and all 12
`device#` anchors the app links resolve. A diff of each H3 against the Device Configuration
field labels is the next step if this page is touched.

**Proposal:** this page is already reference-shaped and the app links to 12 of its section
anchors, so **keep it as the reference**. Changes:
- Move **Device Configuration Backup** (`:1524-1802`) to its own page, "Back up and restore a
  node's config", with a how-to first ("Take a backup now / restore one"), leaving a stub.
- Add a 10-line **"Common tasks"** box at the top: change region and preset, set a fixed
  position, set role to CLIENT_BASE, point MQTT at MeshMonitor (link to mqtt-setups).
- Shrink Device Role to a table plus a link to Meshtastic's role guide.
- Replace the MQTT "Proxy to Client" prose with a link to `mqtt-setups.md#how-a-node-reaches-the-broker`.

---

## 5. MQTT: mqtt-broker.md (9.9k), mqtt-setups.md (3.2k), meshcore-mqtt-broker.md (1.4k), meshcore-mqtt-ingest.md (1.8k)

**Structure:**
- `mqtt-broker.md`: problem, two source types (broker, bridge, feature matrix, recipes),
  three ways a device reaches MQTT, Quick setup (3 steps), topic rewriting, bridges don't
  relay each other, keep automation off upstream, hop limit (clamp, raise), comparison with
  the proxy sidecar, Why don't I see MQTT traffic, Troubleshooting, Limitations.
- `mqtt-setups.md`: already a how-to: parts and traffic flow, Setup 1/2/3, airtime cost, root
  topic, checklist. This is the best-shaped page in the set.
- The two MeshCore pages are short and task-shaped already.

**Duplication:**
- `mqtt-broker.md:118-128` vs `mqtt-setups.md:36-49` vs `device.md:1151-1181` (direct vs
  client-proxy table).
- `mqtt-broker.md:130-246` "Quick setup" vs `mqtt-setups.md:51-143` Setups 1-3. Two
  competing "start here" paths.
- `mqtt-broker.md:314-338` "Keep automation traffic off the upstream broker" vs
  `mqtt-setups.md:71-87` "Filters worth turning on".

**Stale:**
- `mqtt-broker.md:128` calls the picker "Device Configuration → MQTT **Quick Configure**
  dropdown". The UI label is **"Quick configure from a MeshMonitor MQTT source"** in the
  **MQTT Module** section (`src/components/configuration/MQTTConfigSection.tsx:485`;
  `en.json:4795` `"mqtt_config.title": "MQTT Module"`). `mqtt-setups.md:43` (Client proxy row) gets it right: "Device Configuration → MQTT Module → Quick configure from a MeshMonitor MQTT source".
  (Side note: `mqtt_config.quick_configure` has no `en.json` key, it renders from the inline
  fallback.)
- The sidebar puts the two MeshCore MQTT pages under "MeshCore" and the Meshtastic ones under
  "Integrations" (`config.mts:160-173`), with no cross-link between the groups (unverified
  whether the pages link each other).

**Proposal:** make `mqtt-setups.md` the only "start here", and turn `mqtt-broker.md` into a
pure reference. Concretely: delete `mqtt-broker.md:130-246` Quick setup (or reduce to "See the
MQTT Setup Guide"); move the device-path table to `mqtt-setups.md` only; split
`mqtt-broker.md` into **Broker and Bridge reference** (source types, matrix, topic
rewriting, hop limit, limitations) and **MQTT troubleshooting** (`:464-621`, keeping
`#why-no-mqtt-traffic` on the old URL as a stub since the app links it three times). Add an
"MQTT" sidebar group holding all four pages, with the MeshCore two under a "MeshCore"
sub-heading. **Start here:** Setup 1 in `mqtt-setups.md`.

---

## 6. settings.md (9.6k) and global-settings.md (1.1k)

**Structure:** `settings.md` says it "covers both the global and the per-source options"
(`:12`) and documents each field with a **Location** line. `global-settings.md` is a map of
what lives on the Global Settings page, plus a per-source comparison.

**Duplication:** both pages explain the 4.0 three-page split (`settings.md:3-13` and
`global-settings.md:3-5, 13-17`); both carry the 4.17 "install-wide only" note
(`settings.md:17` and `global-settings.md:30`); ducting overlay is in `settings.md:702`,
`global-settings.md:77` and `maps.md:387`; map tilesets / custom tile servers are in
`settings.md:579-665` and `maps.md:574-786` with two separate step lists
(`settings.md:618` and `maps.md:747-760`).

**Stale / contradictory:**
- **Solar Monitoring location.** Code puts `settings-solar` in `GLOBAL_SETTINGS_SECTIONS`
  (`src/components/search/configSections.ts:95-97`, "one per install"). `settings.md:472` is
  correct ("Global Settings"), but `global-settings.md:113` lists "solar settings" under the
  per-source Settings page, and its "What lives here" list (`:19-99`) has no Solar entry.
- `global-settings.md` never mentions several global sections the code lists
  (`configSections.ts:46-100`); `grep -c -i` = 0 for: link previews, public instance,
  MeshCore messaging, MeshWars, ATAK/CoT, Virtual Node replay, mesh issues, auto-enrichment,
  restart/shutdown. Solar is only mentioned on the wrong side (`:113`). A user cannot use it
  as a map of the page.
- **Map settings path.** `maps.md:734` and `:749` say "**Settings** → **Map Settings**";
  `map-analysis.md:140` says "Settings → Map". The Map section is global
  (`configSections.ts:57` `'settings-map'`); `settings.md:552,564,577,618` correctly say
  "Global Settings → Map".
- `settings.md:104` "identified by ❓ icon" and `:158` "🚫 icon": the UI renders these through
  `UiIcon` (`src/components/icons/UiIcon.tsx:165,197`), lucide `CircleHelp` / `Ban` by default
  with the emoji only under the emoji icon style (default style unverified).

**Proposal:** split by **page in the app**, which is how users look for a setting.
1. **Settings overview** (`/features/settings`, existing URL, short): the three settings pages
   (Global, per-source Settings, Device Configuration) with a one-line "what goes where" and
   a link to Configuration Search. **Start here:** "Change the theme and units" (Global) and
   "Hide nodes not heard for 2 hours" (per-source Node Display).
2. **Global Settings reference** (`/features/global-settings`, existing URL): one H2 per
   section in `GLOBAL_SETTINGS_SECTIONS`, in UI order, taking the field text now in
   `settings.md` (Display Preferences `:746-862`, Map `:535-665`, Elevation, ADS-B, ducting,
   MQTT root refresh, maintenance, public instance, Solar, Restart/Shutdown).
3. **Source Settings reference** (new, `/features/source-settings`): sections in
   `SOURCE_SETTINGS_SECTIONS` (`configSections.ts:103+`): Node Display and its filters
   (`settings.md:31-292`), sign-flip correction, Node Details block, Telemetry, Notifications
   (link), Packet Monitor, Danger Zone (`:964-1037`).
4. Leave stub anchors on `settings.md` for every anchor that moves (the app links
   `/features/settings` without a fragment; other docs link `#default-landing-page`,
   `#map-settings`, `#node-channel`, `#settings-public-instance` etc.).
5. Tilesets: one home (Global Settings reference); `maps.md` links to it.

---

## 7. notifications.md (8.6k)

**Structure:** Overview (Web Push, Apprise), Browser Support, **Server Requirements**
(HTTPS, SSL options, VAPID, Docker, Kubernetes), **Client Setup** (iOS, Android, Desktop),
Administrator Configuration, **Apprise Setup**, Muting, **Notification Settings** (services,
mesh-wide default, per source, filters, message format, waypoint arrivals, MeshCore, MeshCore
MQTT region feeds, client/server settings), multi-source dedup, Troubleshooting, How It Works,
Security & Privacy, **API Reference**.

**Duplication:** VAPID / HTTPS setup also appears in `configuration/index.md`, `faq.md`,
`deployment/PROXMOX_LXC_GUIDE.md` (grep hits for "VAPID"; depth unverified). The API
Reference (`:1125-1218`) duplicates `api/REST_API.md` (grep hit; unverified overlap).

**Stale / contradictory:**
- The 4.0 tip at `:5-8` says Apprise URLs are "per-user, per-source … set on each source's
  Notifications tab". Later, `:583-593` describes a **Mesh-wide default** that all sources
  share (UI: `en.json:8651` `"notifications.mesh_title": "Mesh-wide default"`). A reader
  stops at the tip and gets the old model.
- Same tip: "Security Digest Apprise URL — a single admin-set URL on the Security tab". The UI
  strings speak of a per-source URL with a global fallback ("No Apprise URL is set for this
  source", "sends this source in one message with other sources that use the global Apprise
  URL", `en.json:1223,1233,1234`). Likely stale (unverified in code).
- The sidebar calls the page "Push Notifications" (`config.mts:128`), but half of it is
  Apprise and its H1 is "Notifications".

**Proposal:**
1. **Notifications** (existing URL): concept + how-to. **Start here:** "Get a phone alert
   for DMs": pick Web Push (iOS/Android/desktop steps `:213-331`) or Apprise (`:388-460`),
   then tick "Direct messages" under the Mesh-wide default. Then filters, muting, the
   mesh-wide-vs-source model, dedup across sources.
2. **Notification settings reference** (new): every filter and format option (`:572-881`).
3. **Push notification server setup** (new, admin): HTTPS, SSL options, VAPID, Docker, k8s,
   admin config, troubleshooting HTTPS/VAPID, How It Works, Security. Most users never need
   it, and it now sits between the overview and the client steps.
4. API Reference: move to `api/REST_API.md` (link).
5. Rename the sidebar entry to "Notifications".

---

## 8. maps.md (8.9k) and map-analysis.md (5.8k)

**Structure:** `maps.md`: Map Features (node visualization, controls, traceroutes, transport
filtering, cross-source links, live packet traffic, waypoints, ATAK, estimated positions,
ducting, age filter, MeshCore nodes without position, aircraft, asset tracking, GNSS, 3D stub),
Tilesets (built-ins, custom), Configuring Map Settings, Offline Maps, Privacy, Troubleshooting,
Performance, Advanced (subdomains, retina, tile formats), Limits, Best Practices.
`map-analysis.md`: why, opening, toolbar, layers, pins, Terrain Link Profile, Site Planner, 3D,
time slider, inspector, cross-source, permissions, performance, persistence, limitations.

**Duplication:**
- Custom tile servers: `maps.md:658-727` + `:747-786` vs `settings.md:607-665`.
- 3D terrain: `maps.md:567-572` is a stub to `map-analysis.md:295` (fine).
- Ducting: `maps.md:387-398` vs `settings.md:702-713` vs `global-settings.md:77-79`.
- Likely aircraft: `maps.md:449-519` vs `settings.md:232-292` (Likely-Aircraft Detection)
  vs `automation-engine.md:115` (trigger). Three explanations (unverified wording overlap).

**Stale:** `maps.md:734, 749` and `map-analysis.md:140` give the old "Settings → Map
Settings" path (see §6).

**Proposal:** `maps.md` mixes three jobs: using the map, choosing tiles, and running offline.
1. **Using the map** (existing URL `/features/maps`): Map Features and Controls, with a
   **Start here:** "Find a node and see its last traceroute" task.
2. **Map tiles and offline maps** (new): Tilesets, Custom tile servers (single home, moved
   from settings.md too), Offline Operation `:787-874`, Privacy `:875-929`, Tile
   troubleshooting `:930-1006`, Performance and Advanced `:1007-1071`. Mostly admin
   reference.
3. **Map Analysis** stays as is; it is long but well ordered. Add a **Start here:** "Check if
   two hilltops can hear each other with the Terrain Link Profile" at the top, and move
   Limitations/Persistence/Performance into a closing "Reference" H2.

---

## 9. mesh-issues.md (4.2k) and mesh-issues-test-reference.md (4.0k)

**Structure:** `mesh-issues.md`: passive guarantee, how it works, **What each rule means**
(tables per tier, `:51-115`), where thresholds come from (`:116-167`), reading the report,
acting on findings, coverage/silent rules, dismissing, muting, settings, overlap with
Security, permissions/API. Test reference: naming, severity, one block per rule (Fires
when / Severity / Threshold / Why it matters / What to do), threshold sources `:380-404`.

**Duplication:**
- Per-rule "Fires when / Threshold / Severity" appears twice: table rows at
  `mesh-issues.md:61-115` (e.g. A1: "Node's role is REPEATER or ROUTER_CLIENT | — | warning")
  and blocks at `mesh-issues-test-reference.md:35-379` (A1: "A node's role is set to
  REPEATER or ROUTER_CLIENT … warning … None").
- `mesh-issues.md:116-167` "Where the thresholds come from" vs test-reference `:380-404`
  "Threshold sources".

**Stale / gaps:**
- **C2 Advert cadence** (MeshCore) is in code (`'C2_advert_cadence'` in
  `src/server/services/meshIssues/*.ts`, `src/components/Analysis/meshIssueTypes.ts`) and in
  `mesh-issues.md:206`, but has **no block in the test reference**, whose purpose is "every
  test ID".
- Three rules share the label **C1** (excessive packets, key security, time offset). That
  matches code (`C1_excessive_packets`, `C1_key_security`, `C1_time_offset`), so it is not a
  doc error, but the test reference's anchors (`#c1-excessive-packet-rate` etc.) are the only
  way to tell them apart. Worth a note in "Naming scheme".

**Proposal:** this pair is already split the right way (concept/how-to vs per-rule reference).
Make it strict: replace the per-rule tables in `mesh-issues.md:61-115` with one compact
table "ID | name | one-line meaning | link to test reference" (drop Threshold/Severity
there), keep thresholds only in the test reference, add C2 Advert cadence there. **Start
here:** move "Acting on findings" (`:238`) up, right after "How it works", as "Your first
report: open Analysis & Reports → Mesh Issues, sort by severity, open the top finding".

---

## Note on "Start here" tasks

The start-here tasks above are illustrative. The UI labels they use (for example "Add
trigger", "Direct messages", "Mesh Issues") were not each checked against `en.json`; check
them when the page is written. Duplication rows without a quote are structure overlap: same
topic in both places, wording not compared line by line.

## 10. Ranking (biggest user gain first)

1. **Automation**: rename "Automatic Responses" to match the UI, fix "Automations tab" for the
   engine, fix the 3 broken in-app help anchors, give Airtime Cutoff and Auto Delete by
   Distance real sections, then split `automation.md` into hub + 3 task pages and the engine
   into concept + reference + recipes. Do not merge; do not call built-ins "legacy" without
   a product decision.
2. **Scripting**: one home for script docs across four callers; delete ~600 lines of
   duplicates from `automation.md`; fix Node version and MeshAddicts links.
3. **Settings**: split by app page (Global / Source); fix Solar contradiction and the
   "Settings → Map Settings" paths in maps.md/map-analysis.md; complete the Global list.
4. **meshcore.md**: hub + setup + page usage + paths + remote admin; move automation to
   shared pages; document MeshCore Auto Welcome / Favorite / Delete by Distance.
5. **Notifications**: fix the outdated 4.0 tip (mesh-wide default), move server/VAPID setup
   and API out, lead with a phone-alert task.
6. **MQTT**: one start-here (`mqtt-setups.md`), broker page as reference + troubleshooting;
   one device-path table instead of three.
7. **Maps**: split tiles/offline out; single home for custom tile servers.
8. **device.md**: keep as reference; move Backup out; add a common-tasks box.
9. **Mesh Issues**: drop duplicated thresholds from the overview; add C2 Advert cadence to the
   test reference.

Every split must keep old URLs and in-app anchors alive with stub headings.
