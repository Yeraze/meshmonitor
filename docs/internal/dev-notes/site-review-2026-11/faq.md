# docs/faq.md audit (v4.18.0, 2026-11-17)

Read-only review. faq.md is 1,123 lines / 6,564 words, 38 entries in 10 sections.
Verdicts: KEEP / FIX / SHORTEN-AND-LINK / CUT. Line numbers are faq.md lines.
"unverified" means I found no proof either way (often a grep that came up empty).

## 1. Headline findings (ranked)

1. **Wrong: "no merge button" (L272, L787).** An admin-only **Merge history...** flow
   with dry run and undo shipped in #5048 (2026-09-03):
   `src/components/NodeIdentityMergeDialog.tsx`, `docs/features/node-identity-changes.md` L121-153.
   The FAQ says "does not merge ... there is no button to do it" and "Informational only - nothing is merged".
2. **Login entry gives unsafe or no-op advice (L54-110).**
   - `COOKIE_SECURE` defaults to `false` (`src/server/config/environment.ts` ~L487), so Scenario B
     (`COOKIE_SECURE=false`) does nothing.
   - Scenario A (HTTPS proxy) leaves out `COOKIE_SECURE=true`, while `configuration/reverse-proxy.md`
     L20-28 says it is required and `src/server/auth/sessionConfig.ts` ~L138-141 says "Operators deploying
     over HTTPS must set COOKIE_SECURE=true". Following the FAQ gives an insecure cookie over HTTPS.
   - reverse-proxy.md L16-18 says to use `TRUST_PROXY=1` since 4.13; FAQ uses `true` (still parsed, fine).
   - Scenario C "MeshMonitor itself handles HTTPS (with TLS certificates)": I found no TLS server in
     `src/server` (grep for `https.createServer`, `createSecureServer`, `TLS_CERT`, `SSL_CERT`: none).
     Looks unsupported; drop it. (Grep-based; treat as likely, not proven.)
   - The real login-loop cause today is `COOKIE_SECURE=true` over plain HTTP, or `COOKIE_SECURE=true`
     behind a proxy without `TRUST_PROXY`. The entry should say that in one paragraph and link out.
3. **Emoji-era UI text (L114-142, L747-818).** Since #4217 (2026-07-20) interface icons are `UiIcon`
   (lucide-react SVG, `src/components/icons/UiIcon.tsx`, used in 378 component files incl. `Sidebar.tsx`).
   - "Emoji appear as blank squares ... sidebar" (L114-142) no longer applies to the UI chrome.
     Only user content (reactions, waypoint emoji, node names) still needs an emoji font.
   - The node-list and message-status tables show emoji glyphs the UI no longer draws
     (`MessageStatusIndicator.tsx` maps statuses to `error/encrypted/check/time/timer` icons).
4. **Stale tab names (L747-749, L911-923).** `public/locales/en.json`: `nav.nodes` = "Map",
   `nav.messages` = "Node Details", channel chat lives in `nav.channels` = "Channels".
   "Go to Messages tab -> select channel from dropdown" is wrong; "Nodes tab" is now "Map".
5. **Mangled update section (L492-552).** A bare-metal update block (L532-552) is stranded inside the
   retired auto-upgrade entry, so "How do I update" (L474-488) covers Docker only. The auto-upgrade
   entry cites v2.18.5 fixes for a sidecar removed in v4.13.
6. **Backup entry ignores the built-in feature (L556-592).** It never names System Backup
   (`docs/features/system-backup.md`: UI/API backups, scheduled backups, restore on startup).
   The tar recipe only covers SQLite, copies a live WAL database, and the restore runs as root in
   `alpine` (4.17+ runs as `node`; the entrypoint fixes ownership once, `configuration/updating.md`
   L85-100). Bare metal path `data/meshmonitor.db` is wrong: default is `$DATABASE_PATH`, else
   `$DATA_DIR/meshmonitor.db`, else `/data/meshmonitor.db` (`src/server/config/dataDir.ts` L17-29).
   PostgreSQL/MySQL users get nothing.
7. **Permissions entries are pre-4.x (L841-907).** "As of v3.1.0" framing; no mention that grants are
   per source (`permissions.can(\`channel_${n}\`, 'viewOnMap', sourceId)` in
   `src/server/utils/nodeEnhancer.ts` L278). `docs/features/per-source-permissions.md` already owns the
   flag table (`canRead/canWrite/canViewOnMap/canDelete`) and the Users page. Also no link to
   Public-Instance Mode (`features/public-instance-mode.md`), which is what most "public map" admins want.
8. **Firmware 2.8 wording (L284-286, L306-308).** GitHub `releases/latest` is still v2.7.26
   (2026-06-24), so "latest stable is v2.7.26" holds. But 2.8.0, 2.8.1, 2.8.2 have shipped as public
   pre-releases since 2026-08-30, and the `protobufs/` submodule is at `v2.8.2-13`. "Not released yet"
   reads as "nobody runs it". Say "2.8.x is out as alpha/beta pre-releases; 2.7.26 is the latest stable".
9. **Password-reset entry (L326-345).** "Click username -> Admin Panel -> User Management" and
   "except other admins (unless you're a super admin)": no "Admin Panel" string and no super-admin
   concept found in `src/` or `en.json` (unverified by absence). `setUserPassword`
   (`src/server/auth/localAuth.ts` ~L290-312) only blocks non-local (SSO) users and locked accounts,
   not admins. The UI has **Users** in the sidebar (admin only, `Sidebar.tsx` L250) and a
   **Set Password** button (`users.set_password`). Also `/reset-password` generates a random password
   rather than letting you type one.
10. **Duplication.** About 60% of the words restate a feature/config page (reverse-proxy, notifications,
    updating, system-backup, serial-bridge, ble-bridge, per-source-permissions, maps, device).

## 2. Link check

All 22 internal links resolve to existing pages and anchors (script: resolved each `/path#anchor` to
`docs/<path>.md` and matched heading slugs or `{#id}`). One gap: L688 and L700 link the BLE Bridge
GitHub repo, but `docs/configuration/ble-bridge.md` exists and should be the link.

**Inbound anchors the rewrite must keep** (or add `{#old-id}` on the new heading):

| Anchor | Linked from |
|---|---|
| `#i-see-a-blank-white-screen-when-accessing-meshmonitor` | `src/server/routes/authRoutes.ts` L192/202/231 and `public/cors-error.html` L148 (in-app, as `faq.html#...`) |
| `#how-often-does-meshmonitor-release` | getting-started.md L163, configuration/updating.md L81, configuration/production.md L31, deployment/DEPLOYMENT_GUIDE.md L67 |
| `#firmware-2-8-early-preview` | features/device.md L441, features/packet-monitor.md L51 |
| `#my-meshtastic-tcp-source-keeps-connecting-and-disconnecting` | features/multi-source.md L156 |
| `#the-map-is-blank-for-anonymous-not-logged-in-users`, `#understanding-channel-permissions` | blog/2026-01-22-permissions-update.md L33-35 (absolute URLs) |

Side finding (not faq.md): `getting-started.md` L163 says ":dev can briefly lag behind :latest";
`.github/workflows/docker-publish.yml` L331-341 promotes every stable to `:dev`, so the FAQ (L464) is
right and getting-started is stale.

## 3. Per-entry verdicts

| # | Lines | Entry | Verdict | Notes / evidence |
|---|---|---|---|---|
| 1 | 7-50 | Blank white screen | SHORTEN-AND-LINK (keep anchor) | Correct: CORS check in `src/server/server.ts` L199-224. Default origins are `http://localhost:8080` and `http://localhost:3001` only (`environment.ts` ~L440), so L38 "http://localhost works by default" is true only on those ports. Full text duplicates `configuration/reverse-proxy.md#troubleshooting` (L465-512). In-app error pages link here, so keep a short answer. Drop `MESHTASTIC_NODE_IP` from the snippet. |
| 2 | 54-110 | Can't log in / logs out | FIX + SHORTEN-AND-LINK | See finding 2. Owner: `configuration/reverse-proxy.md` (Critical env vars) and `configuration/http-vs-https.md`. |
| 3 | 114-142 | Emoji blank squares | CUT (or fold into an "offline / air-gapped" entry) | See finding 3. Offline users hit tile loading first: link `configuration/custom-tile-servers.md`. |
| 4 | 148-178 | Multiple nodes in one instance | KEEP, SHORTEN-AND-LINK | Correct. Missing Reticulum, a current source type (`'reticulum'` in `src/server/routes/sourceRoutes.ts`). Compose block repeats getting-started; cut it. Owner: `features/multi-source.md`. |
| 5 | 182-245 | CSRF errors, multiple instances | SHORTEN-AND-LINK | Correct (`SESSION_COOKIE_NAME`, default `meshmonitor.sid`, `environment.ts` L482). 64 lines for a niche case; one paragraph + one env line is enough. Owner: `configuration/production.md` (Session Management L251) or `configuration/index.md` env table. Also covers desktop multi-instance (#1180, #691). |
| 6 | 249-256 | 2.8 node count / blocked node | SHORTEN-AND-LINK | Owner: `features/node-identity-changes.md` or a 2.8 page. "Settings -> Ignored Nodes" path: no `settings.*ignored*` key in en.json (unverified). |
| 7 | 260-276 | Half my node list went dark (2.8 renumber) | FIX | Finding 1. Replace L272-274 with "an admin can merge history from Node Details -> Merge history...". |
| 8 | 280-300 | Stopped sharing position/telemetry (2.8) | FIX + SHORTEN | Finding 8 wording. Keep the 4-bullet "what changed" and "how to re-enable"; firmware detail belongs on meshtastic.org. |
| 9 | 304-320 | 2.8 early-preview decode | SHORTEN-AND-LINK (keep anchor) | MeshBeacon module config paragraph (L314) is feature docs: move to `features/device.md` and `features/packet-monitor.md`. Leave a 3-line summary under the same `{#firmware-2-8-early-preview}`. |
| 10 | 326-345 | Admin resets a user's password | FIX + SHORTEN-AND-LINK | Finding 9. Owner: `features/per-source-permissions.md#users-page`. |
| 11 | 349-405 | Forgot admin password | KEEP (trim) | Correct: `reset-admin.mjs` at repo root, copied in `Dockerfile` L140. The two Docker subsections run the same command; merge them. Add `ADMIN_PASSWORD` (first boot only, `environment.ts` L195-209). |
| 12 | 409-447 | Wipe the database | FIX | Bare-metal path wrong (finding 6). No PG/MySQL path. Volume name assumes project `meshmonitor`; `docker compose down -v` is simpler. Default password is `changeme` unless `ADMIN_PASSWORD` is set. Suggest "take a System Backup first". |
| 13 | 453-470 | Release cadence, :dev vs :latest | KEEP (keep anchor) | Matches `docker-publish.yml` L331-341. L468 history paragraph can go. |
| 14 | 474-488 | How do I update | FIX + SHORTEN-AND-LINK | Docker only; bare-metal block is stranded at L532-552; LXC (`meshmonitor-update`) and Helm missing. `grep "Version:"` (L487): no such log line found in `src/server` (unverified); the version shows in the UI. Owner: `configuration/updating.md`. |
| 15 | 492-552 | "Container name already in use" after auto-upgrade | CUT | Sidecar removed in v4.13; v2.18.5 details obsolete. `updating.md#migrating-from-the-old-auto-upgrade-sidecar` (L269-305) covers sidecar cleanup but not this exact error; add one line there ("`docker rm -f meshmonitor` then `docker compose up -d`") before cutting. Move L532-552 into entry 14 / updating.md (which already has it at L245). |
| 16 | 556-592 | Back up data | FIX + SHORTEN-AND-LINK | Finding 6. Owner: `features/system-backup.md`; manual DB dumps in `configuration/production.md#backups` (L426). |
| 17 | 598-638 | Can't connect to Meshtastic node | KEEP (trim) | Port 4403 correct. Step 3 "Check that TCP is enabled" - no such toggle I know of in the Meshtastic app (unverified). Step 5 "Click node name to see connection details" (unverified). Add the "one TCP client" pointer to entry 18. |
| 18 | 641-666 | TCP source connects and disconnects | KEEP (keep anchor) | Log text matches `src/server/meshtastic/quickCloseDetector.ts` L69. multi-source.md L147-156 sends readers here, so the FAQ is the owner. Good model entry. |
| 19 | 670-678 | MQTT only shows when repeated over LoRa | KEEP | Short, links out. Model entry. |
| 20 | 682-732 | Bluetooth or Serial device | SHORTEN-AND-LINK | Owners: `configuration/ble-bridge.md`, `configuration/serial-bridge.md`. The serial compose snippet overwrites the user's `docker-compose.yml` via `cat >`, risky. Note MeshCore serial/USB is native (no bridge). |
| 21 | 738-745 | Coming from MeshManager | KEEP | Added deliberately in #6104 (2026-10-31). Missing `---` separator after it. |
| 22 | 747-804 | Node List icons | FIX + SHORTEN-AND-LINK | Finding 3/4. Icons are SVG, tab is "Map". "Walking ... more than 1km" and "battery = 101%" (unverified; `nodeMobilityService.ts` computes a span in km, threshold not checked). Role list incomplete vs firmware roles (e.g. ROUTER_LATE, CLIENT_MUTE, CLIENT_HIDDEN, LOST_AND_FOUND). Owner: `features/maps.md` (node markers / battery icons sections already exist); best as a screenshot with labels. |
| 23 | 806-818 | Message status icons | SHORTEN-AND-LINK | Statuses and 30 s timeout correct (`src/utils/deliveryDiagnostics/status.ts` L14, en.json `message_status.*`). Emoji glyphs wrong. Owner: `features/delivery-diagnostics.md#status-and-what-this-means`. Asked for in #2118. |
| 24 | 822-837 | Map shows no nodes | FIX | "Browser location permissions" is not a cause of missing nodes. Missing real causes: Maximum Node Age filter (`effectiveMapMaxAge`, `NodesTab.tsx` L660; `settings.max_node_age`), `viewOnMap` permission, wrong source selected, MQTT filter, bogus/Null-Island positions. Tiles default to OSM (`src/config/tilesets.ts` L225) - OK. Link `features/maps.md`, `configuration/custom-tile-servers.md`. |
| 25 | 841-865 | Map blank for anonymous users | FIX (keep anchor) | Add "per source": the grant must be made for each source. Point to Public-Instance Mode. Path "Settings > Users" vs sidebar "Users" (per-source-permissions.md also says "Settings -> Users"; pick one). |
| 26 | 869-907 | Understanding Channel Permissions | SHORTEN-AND-LINK (keep anchor) | Content still roughly right (`channel_${n}` + `viewOnMap` in `nodeEnhancer.ts`), but it is reference docs, drop "As of v3.1.0". Move table to `features/per-source-permissions.md`; leave 2 lines + link. |
| 27 | 911-923 | Send to a specific channel | FIX or CUT | Finding 4. Basic UI how-to; better as a line in a "Using the UI" doc than a FAQ. |
| 28 | 929-935 | Device notification toasts | KEEP (trim) | No feature page covers it (grep for "device notification"/"toast" in features/ found none). Fine as FAQ. |
| 29 | 939-965 | Push fails in Brave | SHORTEN-AND-LINK | Unique content (notifications.md only lists Brave at L302). Move the fix to `features/notifications.md#troubleshooting`; FAQ keeps 2 lines. "Configuration -> Notifications": nav is a "Notifications" item in the Configuration section (en.json `nav.notifications`, `nav.section_configuration`) - OK-ish. |
| 30 | 969-1013 | No notifications on iPhone | SHORTEN-AND-LINK | Duplicates `features/notifications.md` (iOS Setup L215, Updating VAPID Contact Email L334, iOS-Specific Issues L939). Field label is "Contact Email (VAPID Subject)" (en.json `notifications.contact_email`), not "VAPID Contact Email". |
| 31 | 1019-1035 | Running slowly | FIX | "Settings -> Database -> Cleanup Old Messages" does not exist (no match in `src/` or en.json). Real feature: **Database Maintenance** (`features/settings.md#database-maintenance` L726), nightly job, off by default. Add node-load/heap pages: `configuration/node-load.md`, `features/auto-heap-management.md`. |
| 32 | 1039-1062 | View logs | KEEP (trim) | Add `LOG_LEVEL`/debug if documented (unverified) and desktop app log path (`configuration/desktop.md`). |
| 33 | 1068-1081 | Different port | KEEP (merge into entry 1) | Container port 3001 correct (`Dockerfile` L161-165). Note localhost origin default is port-specific (entry 1). |
| 34 | 1085-1095 | Subfolder / BASE_URL | KEEP | Correct (`environment.ts` L396). |
| 35 | 1099-1119 | Getting help | KEEP (trim) | "Meshtastic Discord / forums" is vague; point to GitHub Discussions if used (unverified). Add MeshCore. |
| 36 | 1123 | "Last updated: 2026-07-18" | CUT | Stale (last edit 2026-10-31 per git log). VitePress `lastUpdated` can do this. |
| 37 | 5, 146, 324... | Section headings with emoji | FIX | Violates the project's own "no hardcoded emoji icons" spirit and wastes width; plain headings. |
| 38 | 3 | Intro "developer questions -> /development/" | KEEP | Link resolves. |

Entries 7, 8, 9 and 6 together spend ~75 lines on firmware 2.8. Once 2.8 is stable, fold them into one
"Upgrading to firmware 2.8" entry that links `features/node-identity-changes.md`.

## 4. Missing questions (with evidence)

| Question | Evidence | Link target |
|---|---|---|
| Wrong time / timezone in charts and "last heard" | #2872 | getting-started.md "Custom Timezone" (`TZ`) |
| Docker network collides with my LAN subnet | #5271 | none yet - add a `networks:` snippet to `configuration/index.md` |
| Permission errors on NAS / bind mounts; PUID/PGID; scripts broke after 4.17 (non-root) | #1355, #6245 | `configuration/production.md#docker-security`, `configuration/updating.md` L85 |
| Bare-metal: runs by hand but fails as a systemd service; which Node version | #4703, #1797, #1853 | `deployment/DEPLOYMENT_GUIDE.md`; Node 22+ per CLAUDE.md |
| How do I change settings after install (env vs UI vs per-source) | #1821, #4655 | `configuration/index.md`, `features/settings.md` |
| How do I swap the radio behind a source | #2073 | `features/multi-source.md` (edit source) |
| What is a Virtual Node; why don't apps on it see each other / my position every minute | #6436, #1859, #5236, #1597 | `configuration/virtual-node.md` |
| What do Hops Away, SNR, RSSI, "RX Bad" mean | #1978, #4590, #1344, #2571 | `features/link-quality.md` |
| Why can I read "private" messages / PKI DM decryption | #2006 | `features/pki-dm-decryption.md`, `features/channel-database.md` |
| What are accuracy circles / estimated positions | #1411 | `features/estimated-accuracy.md`, `features/position-estimation.md` |
| Does MeshMonitor transmit on its own? (auto-traceroute, MeshCore polling airtime) | #3878, #5399, #1020 | `features/automation.md`, `features/meshcore.md`; CLAUDE.md mesh-impact checklist |
| Can I run it without Docker - desktop app / LXC / Helm | #1180, #1597 | `configuration/desktop.md`, `deployment/PROXMOX_LXC_GUIDE.md`, `deployment/HELM_GUIDE.md` |
| PostgreSQL or MySQL instead of SQLite? | none filed in sample | `docs/database/` |
| SSO / passkeys / MFA lockout | none in sample | `configuration/sso.md`, `features/passkeys.md` |
| Make a public read-only map safely | #2070, #3046 | `features/public-instance-mode.md`, `features/embed-maps.md` |
| MeshCore: which devices / companion vs repeater; admin password | #1890, #3697, #2574 | `features/meshcore.md` |
| Where are the default credentials (admin/changeme) | #2485, #1844 | getting-started.md L182 |

## 5. Proposed structure

Rules: one question per heading, one short paragraph answer (3-6 lines), at most one code block,
then "More: <link>". Plain headings, no emoji. Keep the six inbound anchors via `{#id}`.
Target ~2,000-2,500 words (from 6,564).

```
Frequently Asked Questions

1. Getting started
   - What are the default login details? / I forgot the admin password      (merge 11 + new)
   - Can one MeshMonitor watch many nodes, MeshCore, MQTT or Reticulum?      (4)
   - Can I use a Bluetooth or USB/serial radio?                               (20)
   - Do I need Docker? Desktop app, LXC, Helm, bare metal                    (new)
   - I used to run MeshManager. Do I still need it?                          (21)

2. Access and login
   - I see a blank white screen {#i-see-a-blank-white-screen-when-accessing-meshmonitor}  (1 + 33)
   - Login works, then I am logged straight out                              (2, fixed)
   - I run two instances on one host and keep getting logged out / CSRF       (5, short)
   - Can I serve it under /meshmonitor or another port?                       (34 + 33)

3. Connecting to radios
   - MeshMonitor can't connect to my Meshtastic node                         (17)
   - My TCP source keeps connecting and disconnecting {#my-meshtastic-tcp-source-keeps-connecting-and-disconnecting}  (18)
   - MQTT messages only show when repeated over LoRa                         (19)
   - How do I swap the radio behind a source?                                (new)
   - What is a Virtual Node, and why don't apps on it see each other?        (new)

4. Maps, nodes and messages
   - The map shows no nodes                                                  (24, fixed)
   - The map is blank for visitors who are not logged in {#the-map-is-blank-for-anonymous-not-logged-in-users}  (25 + 26 stub {#understanding-channel-permissions})
   - What do the node-list and message-status icons mean?                    (22 + 23 -> links)
   - What do Hops Away, SNR, RSSI mean?                                       (new)
   - Why can I read some private messages?                                    (new)
   - What are the pop-up toasts from my node?                                (28)

5. Firmware 2.8
   - What changes when my nodes move to 2.8? {#firmware-2-8-early-preview}   (6 + 7 + 8 + 9, fixed: merge exists)

6. Notifications
   - Push does not work in Brave / on iPhone                                 (29 + 30 -> notifications.md)

7. Updates, backups and data
   - :latest or :dev, and how often? {#how-often-does-meshmonitor-release}   (13)
   - How do I update?                                                        (14 + stranded 532-552 -> updating.md)
   - How do I back up and restore?                                           (16 -> system-backup.md)
   - How do I start over with an empty database?                             (12, fixed)
   - Scripts or files broke after 4.17 / NAS permission errors (PUID/PGID)  (new)

8. Performance and logs
   - MeshMonitor is slow or the database is huge                             (31 -> Database Maintenance)
   - Where are the logs?                                                     (32)
   - Charts show the wrong time                                               (new, TZ)

9. Getting help                                                               (35)
```

Cut outright: entry 3 (emoji fonts), entry 15 (auto-upgrade container name, after adding one line to
updating.md), entry 27 (send to channel, or move to a UI page), the "Last updated" footer, emoji headings.
