# MeshCore Parity P7b: rates, clock-offset flag, scanner, digest, export, notification DM (#6281)

## Maintainer decisions (2026-11-09, binding)
Q1: MeshCore uses the same 30 packets/hour and 30 min thresholds from one shared constant. Q2: notification DM is draft-only (never auto-sent), English template <= 75 bytes, Companion sources and chat-contact targets only, flood warning when no path is known, no extra cooldown beyond messageLimiter and the existing DM retry machine. Q3: Meshtastic also gets the draft Send notification on excessive-packet and clock-offset rows. Q4: flag never-set clocks as "Clock not set". Q5: digest settings saved per source with a global fallback for the 4 per-source keys (release note: MeshCore digests start for installs with a global Apprise URL). Q6: nodes:read on the source for /issues, /export, /key-mismatches on both protocols (release note). Q7: the shared export lists spam/clock-only nodes too. Migration: use the NEXT FREE number at implementation time (another phase, #6276, also adds one).


Part of `MESHCORE_PARITY_EPIC.md`. Base is `origin/main` 4402509fe. Paths below are relative to `src/`, and line numbers were checked on 2026-11-09.

The binding rule is the one-implementation rule: one scanner, one issues collector, one digest formatter, one export, one Security tab and one notification-text builder, each with protocol adapters. P7a decision 1 already assigns migration **225** to this phase (P8b holds 226). No `225_*` file exists yet (`server/migrations/` ends at 224).

## Already decided (do not re-ask)
From the P7 entry in the epic and the P7 spec:
- P7b covers per-key rates, a persisted clock-offset flag, and MeshCore in the scanner, digest, export and notification DM.
- It uses migration 225.
- The issue's proposed thresholds equal Meshtastic's (30 pkt/h, 30 min), but **they are not yet answered** (Q1).
- Findings stay DB reads on the tab's 30 s poll.
- Global `SecurityTab.css` is frozen, so new styling goes in CSS modules.
- `meshcore_mqtt` endpoints are accepted, but its UI is a follow-up.

## Findings (evidence)

**Scanner** (`server/services/duplicateKeySchedulerService.ts`)
- The thresholds are module constants: `EXCESSIVE_PACKETS_THRESHOLD = 30` (`:9`) and `TIME_OFFSET_THRESHOLD_MINUTES` from env, default 30 (`:12-13`).
- MeshCore is excluded in `runScanAllSources` (`:82`) and in `getStatus` (`:408`).
- Spam is "packets in the last hour at scan time" (`:271-337`, via `database.ts:1843`), and it writes only on a state change.
- Time offset is computed at `:342-390`.
- The timer runs every 24 h plus an initial run 5 min after boot (`:50-57`), and `lastScanTime` lives in memory only.

**Routes** (`server/routes/securityRoutes.ts`)
- `/issues` (`:39-146`) holds the issue-merge logic (three near-identical blocks). `securityDigestService.ts:381-403` copies it, and the comment there says "same pattern as securityRoutes.ts". The issue asks to de-duplicate this.
- `/issues`, `/export` and `/key-mismatches` check only the global `security:read` (`:36`). They have **no `nodes:read` on the source**, whereas P7a's `/dead-nodes` (`:416`) and `/meshcore/findings` (`:662`) do.
- `/scanner/scan` rejects anything that is not Meshtastic (`:178-180`).
- `/export` (`:214-293`) has three problems:
  - It exports **only key-issue nodes** (`getNodesWithKeySecurityIssuesAsync`, `:219`), so nodes flagged only for spam or time offset never appear, even though it has columns for them.
  - Its CSV escaping only swaps commas for semicolons (`:269-280`).
  - Its audit line does not name the source.
- `/nodes/:nodeNum/clear` (`:296`) is Meshtastic-only.
- `/digest/send` (`:760`) with no `sourceId` sends a digest for every Meshtastic source.

**Digest** (`server/services/securityDigestService.ts`)
- MeshCore is excluded (`:316-322`).
- The formatters are fixed to four Meshtastic categories and `!hex` ids (`:37-272`).
- It reads `securityDigestAppriseUrl / ReportType / SuppressEmpty / Format` per source with **no global fallback** (`:340-350`; `db/repositories/settings.ts:283-288`; keys are in `PER_SOURCE_SETTINGS_KEYS`, `server/constants/settings.ts:854-858`).
- **Pre-existing bug:** the Security tab loads and saves these keys **globally**:
  - GET `/api/settings` at `SecurityTab.tsx:221`.
  - POST without `?sourceId` at `:239-246`.
  - The settings route writes per source only when `?sourceId=` is set (`settingsRoutes.ts:384-388`).

  As a result, an Apprise URL saved in the UI is never read for any source except through migration 050's one-time copy, and the digest reports "No Apprise URL configured".
- "Send now" posts `{}` (`SecurityTab.tsx:259`), which means all sources.
- A source with no URL configured counts as a failure (`:343-345`).

**Capabilities** (`utils/securityCapabilities.ts:66-86`)
- MeshCore has `scanner / spam / timeOffset / digest / notifyDm` set to false.
- `SecurityTab.tsx:93` calls `securityCapabilities(sourceType)` **without `deviceType`**, and `MeshCorePage.tsx:362-367` passes neither the device type nor `onOpenDmWithDraft`. So `deviceDelete` and any Companion-only capability always read false on MeshCore.
- No route uses the caps as a guard, even though the header comment says they do.

**Notification DM on Meshtastic** (`SecurityTab.tsx:370-390`)
- It is only a pre-filled draft and never sends automatically. It covers low-entropy and duplicate-key nodes only, not spam or time offset.
- The text is hard-coded English, about 100–120 bytes, with bit.ly links.
- The UI checks `messages:read`, not `write`, before opening it.
- It reaches the composer through `App.tsx:3348` → `openDmWithDraft`.

**MeshCore DM path**
- `navigateToDm` (`MeshCorePage.tsx:165-168`) sets only `pendingDmContact`, which reaches `initialSelectedContact` (`:307`). **There is no draft hand-off.**
- `MeshCoreMessageStream` creates its own `draftStore` (`:194`) with `maxBytes` defaulting to 130 (`:182`).
- The send route uses `messageLimiter` and `messages:write` per source (`server/routes/meshcoreMessagingRoutes.ts:440`).
- Every UI DM arms the ack-retry machine (`meshcoreManager.ts:6500-6509`): 2 same-path retries plus 1 flood (`:6561-6580`), so the worst case is 4 transmissions with the last one a flood.

**Packet data**
- `meshcore_packet_log` is opt-in (`meshcore_packet_log_enabled`, `meshcorePacketLogService.ts:129-131`).
- Retention is 24 h and 1,000 rows per device source, or 50,000 per `meshcore_mqtt` source (`:15-27`).
- Companion OTA, Repeater RAW (`meshcoreManager.ts:4923` → `handleOtaPacket :3377-3413`) and MQTT (`meshcoreMqttManager.ts:499`) all write to it.
- `timestamp` is the server receive time in ms. MQTT writes **one row per observer** (`observerId`).
- Derived fields (`utils/meshcorePacketDerived.ts:8-10`):
  - ADVERT and ANON_REQ carry the full `senderPubKey`.
  - REQ, RESPONSE and TXT_MSG carry only a 1-byte `srcHash`.
  - GRP_TXT has no sender at all.
- Flood copies differ in `rawHex` (the path bytes), and `meshCorePacketHashOrUndefined` (`server/services/meshcoreObserverPacket.ts:325`) leaves the path out, which makes it the right dedupe key.

**The C2 read to reuse**
- `meshIssuesAnalysisService.ts:778-802` `loadMeshcoreAdverts` pages `getPackets` at 5,000 rows, up to 10 pages (`:102-103`).
- The call site is `:728-746`, and it feeds `buildMeshCoreAdvertCadence` (`meshIssues/meshcoreSnapshot.ts:222-262`).
- It is private to the service.

**Clock data**
- The sender advert time is the u32 at offset 32 of the ADVERT payload (`utils/meshcorePacketDecode.ts:511-524`), and it is recoverable from `rawHex`.
- DM sender time is stored as `meshcore_messages.senderTimestamp` (s) next to `receivedAt` / `createdAt`. `utils/meshcoreMessageTime.ts:66-80` computes the offset per message for display only (#5973) and gates it at ±24 h.
- The Companion contact `last_advert` versus `last_mod` (`meshcoreManager.ts:6032-6046`) is **not usable**, because `last_mod` also moves on messages and path updates.
- The `meshcore_nodes` schema (`db/schema/meshcoreNodes.ts`) has no rate or offset columns.

**Mesh Issues C1** (`meshIssues/rulesTierC.ts:166-176`) folds the Meshtastic `isExcessivePackets` and `isTimeOffsetIssue` flags into findings. It is Meshtastic-only (P6).

## Design: shared pieces first

| ID | Piece | Used by |
|---|---|---|
| S1 | `server/constants/securityThresholds.ts`: `EXCESSIVE_PACKETS_PER_HOUR = 30` and `TIME_OFFSET_THRESHOLD_MS` (env `TIME_OFFSET_THRESHOLD_MINUTES`). Moved out of the scheduler. | both scanners, UI copy, digest |
| S2 | `server/services/meshcorePacketWindow.ts`: `loadMeshcorePackets(sourceIds, sinceMs, {payloadType?})`. This is `loadMeshcoreAdverts` moved here (same paging constants), and its rows now include `rawHex`, `payloadType` and `srcHash`. Mesh Issues C2 calls it with `payloadType: ADVERT`. The security scan calls it **once** per source over the log window. One reader, one read per consumer run. | C2, MeshCore scan |
| S3 | `server/services/meshcoreSecurityScan.ts` (pure): `computeMeshcorePacketRates(packets, nodes, {nowMs, windowMs: 3_600_000, localKeys})` → `Map<pk, {packets, adverts}>` and `computeMeshcoreClockOffsets({adverts, dms, nodes, nowMs})` → `Map<pk, {offsetMs, source: 'advert'\|'message', observedAt}>`. Rules are listed below. | scan |
| S4 | `server/services/securityIssuesService.ts`: `collectSecurityIssues(sourceId, {topBroadcasters: n})` → `{protocol, total, counts: Record<kind, number>, nodes: SecurityIssueNode[], topBroadcasters}`. The Meshtastic adapter is today's `/issues` merge; the old wire fields stay and `nodeKey`/`protocol` are added. The MeshCore adapter combines the flag columns with P7a findings (signature failures, name reuse, own-key pending). This replaces both merge copies. | `/issues`, `/export`, digest |
| S5 | Digest formatter generalised to `DigestSection[]` (`{title, count, lines}`). The Meshtastic sections produce **byte-identical** output (existing `securityDigestService*.test.ts` must pass unchanged). MeshCore sections are Excessive packets, Clock offset, Advert signature failed, Name reused under new key, and Own key changed (pending acknowledge). Collisions are left out because they are a config matter, not a security issue. | digest |
| S6 | Export: one `buildSecurityExport(issues, format)` built on `csvCell/csvRow` (`server/utils/messageCsv.ts:46-56`). Meshtastic columns keep their order and new columns are appended; MeshCore has its own column set. | `/export` |
| S7 | `utils/securityNotificationText.ts`: `securityNotificationText(kind, params)` for kinds `lowEntropy`, `duplicateKey`, `excessivePackets` and `timeOffset`. The Meshtastic strings for the first two stay exact. The new kinds are English (it goes over the air, like today) and **≤ 75 UTF-8 bytes**, enforced by a test. Example: `MeshMonitor: your node's clock is 2h 14m behind. Please set its time.` (69 B). | both tab adapters |
| S8 | `securityCapabilities`. Every MeshCore source type gets `scanner`, `spam`, `timeOffset` and `digest`. `notifyDm` is true only when the source type is `meshcore` and the device type is Companion. Routes use the caps as guards, and `SecurityTab` receives `deviceType`. | routes, tab |
| S9 | Shared tab components moved out of `SecurityTab.tsx`, keyed on `nodeKey`, keeping today's global class names so Meshtastic renders identically: `ScannerStatusCard`, `SecurityExportMenu`, `SecurityDigestCard` (per-source save, see below), `TopBroadcastersTable`, `ExcessivePacketsSection`, `TimeOffsetSection`. New styling goes in CSS modules. | both branches |
| S10 | MeshCore draft hand-off: `MeshCorePage` keeps `pendingDmDraft` next to `pendingDmContact`. `MeshCoreDirectMessagesView` gets an `initialDraft` prop, and `MeshCoreMessageStream` gets an `initialDraft` prop that seeds `draftStore` once per selection, so a later contact switch does not re-seed it. | MeshCore DM button |

**S3 rules: rates**
- The window is the last 60 min at scan time (Meshtastic parity).
- Count **distinct packet hashes** (S2 row `rawHex` → hash), so MQTT per-observer rows and multi-path flood copies count once.
- A packet is attributed to a key:
  - by full key for ADVERT and ANON_REQ;
  - by `srcHash` only when exactly one known contact on the source has that first byte;
  - never for GRP_TXT, ACK or PATH, which carry no sender.
- `adverts` is reported separately for information. Advert cadence policy stays in Mesh Issues C2, so there is no second rule.
- The local key is excluded (P7a `localMeshcoreKeys`).

**S3 rules: clock offset**
- Offset = receipt ms − sender ms, so a positive value means the node is behind. This is Meshtastic's sign convention (`SecurityTab.tsx:330`).
- Candidates are the newest ADVERT in the window (sender time read from `rawHex`) and the newest DM per sender in the last 7 days. DM rows come from a bounded repo read, and a sender prefix is resolved to a full key only when the prefix is unique. Room posts are excluded because they replay on login.
- The newest observation wins.
- A node is flagged when |offset| > S1. Q4 covers clocks that were never set.

**MeshCore scan** (`runMeshcoreScan(sourceId)` in the existing scheduler, under the same `isScanning` / `lastScanTime` maps):
1. Load the nodes, then make one S2 read covering the whole log window and one DM read.
2. Run S3.
3. Write through `meshcore.setNodeSecurityFlags(sourceId, rows)`, only for rows whose flag changed or that are still flagged (to keep the shown rate fresh).
4. Clear flags for keys with no observation in the window (Meshtastic parity).

If the packet log is disabled, rates are skipped and existing rate flags are left untouched. The tab then shows the hint "Enable the MeshCore Packet Monitor to measure rates". Offsets still work from DMs.

**Migration 225** (`225_add_meshcore_node_security_flags`) adds these `meshcore_nodes` columns, all nullable or default false, on SQLite, PG and MySQL, idempotent through the `helpers.ts` add-column helpers, with no backfill:

| Column | Type | Notes |
|---|---|---|
| `isExcessivePackets` | bool, default false | |
| `packetRatePerHour` | int | |
| `advertRatePerHour` | int | |
| `packetRateLastChecked` | bigint | ms |
| `isTimeOffsetIssue` | bool, default false | |
| `timeOffsetSeconds` | int | |
| `timeOffsetSource` | text / varchar(16) | `'advert'` or `'message'` |
| `timeOffsetCheckedAt` | bigint | ms |

- Only the scanner, through `setNodeSecurityFlags`, and the clear route write these columns. `upsertNode` never writes them; test that a contact sync leaves them intact.
- The API converts the ms columns to seconds (the P7a S3 contract).

**Routes**
- `/issues`: for MeshCore, use S4 plus `nodes:read` on the source.
  - Top broadcasters come from the **stored** `packetRatePerHour` (top 5). The 30 s poll must not read the packet log.
- `/scanner/status` and `/scanner/scan`: accept MeshCore.
- `/export`: S6, with the audit line naming the source.
- New `POST /nodes/clear {sourceId, nodeKey}` with `security:write` and `ok()/fail()`. It clears the spam and offset flags on both protocols. The old `:nodeNum` route stays as an alias.
- `/digest/send`: the UI sends `{sourceId}` for the page's source.

**Digest settings fix**
- `SecurityDigestCard` reads `GET /api/settings?sourceId=`.
- It writes the 4 per-source keys with `?sourceId=` and the global `securityDigestEnabled` / `securityDigestTime` without it.
- The service falls back to the global row for those 4 keys (Q5).
- "Not configured" becomes `skipped` instead of a failure.

**UI**
- The MeshCore branch adds `ScannerStatusCard`, the export menu, `ExcessivePacketsSection`, `TimeOffsetSection`, top broadcasters and `SecurityDigestCard` around the P7a cards. It also adds the packet-log-off hint.
- The "Send notification" button appears on excessive-packet and time-offset rows only when all of these hold:
  - `caps.notifyDm` is true;
  - the target is a chat contact (`advType === 1`), since Repeaters and Room Servers do not read DMs;
  - the user has `hasPermission('messages','write',{sourceId})`.
- When the contact has no `outPath`, a warning shows next to the button: "No known path: this DM will flood the mesh".
- WP5 must check whether the Companion can send to a contact that is not on the device. If it cannot, the button is disabled with a hint.
- The contact detail panel gets a "Clock offset" row from the persisted columns through `utils/meshcoreNodeFieldMerge.ts`.
- `MeshCorePage` passes `deviceType={status?.deviceType}` and `onOpenDmWithDraft`.

## Mesh impact

LoRa cost is calculated with `utils/loraAirtime.ts`, the same math as P9:
- US preset: SF7 / BW 62.5 / CR 4/5.
- EU preset: SF8 / BW 62.5 / CR 4/8.
- DM packet = 2 header bytes + h path bytes + 4 (dest, src, MAC) + ciphertext padded to 16. A text of ≤ 75 B gives an 89 B packet at h = 3.

| Case | US | EU |
|---|---|---|
| One DM, known path, h = 3 (4 transmissions) | **1.43 s** + ACK 0.53 s | **3.74 s** + ACK 1.12 s |
| Same with a 130 B text (today's composer cap) | 2.21 s | 5.84 s |
| No path → flood, R = 50 repeaters | **≈18 s** mesh-wide | **≈46 s** mesh-wide |
| Worst case per Send click with no ACK (2 path retries + 1 flood, `meshcoreManager.ts:6571-6580`) | ≈ 3 × 1.43 s + 18 s ≈ 22 s | ≈ 3 × 3.74 s + 46 s ≈ 57 s |

**Who sends what**
- The DM is user-initiated only: it pre-fills a draft and the user presses Send.
- One click is one DM. It does not scale with node count, has no timer, and never auto-sends.
- It goes through the existing `messageLimiter` (`env.rateLimitMessages` per minute) and the existing DM retry machine (bounded, no infinite retry).

**Limits proposed (Q2):**
- (a) draft only, never auto-send;
- (b) the template is capped at 75 B, which keeps h = 3 at 1.4 s / 3.7 s instead of 2.2 s / 5.8 s;
- (c) Companion source and chat-contact target only;
- (d) the flood warning next to the button;
- (e) no extra cooldown (Meshtastic has none).

**Non-RF effects**
- **Scanner:** DB reads only, once per MeshCore source per scan interval (24 h, plus a scan 5 min after boot). An MQTT source costs at most 10 × 5,000 rows. Nothing is sent, and no events or automations are triggered: flag writes emit no `dataEventEmitter` event and no socket contact update, and Mesh Issues C1 stays Meshtastic-only.
- **Digest:** existing cron, one Apprise POST per configured MeshCore source per day. It is suppressed when empty by default. No RF.
- **Timer reset:** a digest settings save calls `reschedule()`, which re-arms a fixed clock time and does not fire. The scanner is not tied to settings. A restart runs a scan, which sends nothing and alerts no one. `lastScanTime` being in memory is cosmetic.
- **Feedback loop:** none. A flag never triggers a send.

## Security / permissions
- `security` is a global resource (`types/permission.ts:78-88`). Node data needs `nodes:read` on the source.
- MeshCore `/issues` and `/export` require `nodes:read` with `sourceIdFrom: 'query', requireSourceId: true`, as `/dead-nodes` does. Whether Meshtastic gets the same check is Q7.
- `/scanner/scan` and `/nodes/clear`: `security:write` (as today) plus `nodes:read` on the source.
- Digest per-source keys need `settings:write` on the source through the existing `?sourceId=`. `securityDigestAppriseUrl` is in `SECRET_SETTINGS_KEYS` (`settings.ts:1131`); verify the per-source GET masks it the same way as the global GET.
- The DM send is enforced server-side (`messages:write` per source, `meshcoreMessagingRoutes.ts:440`). The UI check moves to `messages:write` for both protocols.
- Export holds names, a 16-hex key prefix (public), flags and rates. It has no secrets and no message text.
- Per-source scoping: every new repo method takes `sourceId` and gets a `*.perSource` test.

## Work packages

Order: WP1 → WP2 → WP3 → WP4 → WP5; WP6 last. WP5 component extraction can start in parallel with WP2.

Every WP must pass:
- typecheck and the lint ratchet;
- `.js` server imports;
- no raw SQL outside repos and migrations;
- `ok()/fail()` on new handlers;
- flat `en.json` keys, `UiIcon`, CSS-module tokens;
- PG and MySQL containers up for repo and migration tests.

**WP1 Migration and repo.** Use the `/migration` skill.
- Files:
  - `server/migrations/225_add_meshcore_node_security_flags.ts`, plus `.test.ts` (SQLite) and `.pgmysql.test.ts`;
  - register in `db/migrations.ts`;
  - `db/schema/meshcoreNodes.ts` (all three dialects);
  - `db/repositories/meshcore.ts`: `setNodeSecurityFlags`, `getSecurityFlaggedNodes`, `clearNodeSecurityFlags`, `getLatestDmSenderTimes(sourceId, sinceMs, limit)`, and the `DbMeshCoreNode` type;
  - check the hand-written meshcore DDL in migration tests (e.g. `215_*.pgmysql.test.ts`) still matches.
- Tests: idempotent re-run on all three backends; source isolation; `upsertNode` leaves the flags alone; DM read excludes room posts and is bounded.

**WP2 Shared analysis.**
- Files:
  - `server/constants/securityThresholds.ts`;
  - `server/services/meshcorePacketWindow.ts`;
  - `meshIssuesAnalysisService.ts` switched to S2 with no behaviour change (the C2 tests pass unchanged);
  - `server/services/meshcoreSecurityScan.ts`.
- Tests:
  - MQTT copies from 3 observers count as 1;
  - flood copies on different paths count as 1;
  - an ambiguous `srcHash` is not attributed, a unique one is;
  - GRP_TXT is never attributed;
  - the local key is excluded;
  - offset sign and threshold edge;
  - a no-RTC 2024 clock follows the Q4 rule;
  - a DM prefix resolves only when unique;
  - the newest observation wins;
  - room posts are ignored.

**WP3 Scanner, collector and digest.**
- Files:
  - `duplicateKeySchedulerService.ts`: MeshCore branch `runMeshcoreScan`, `getStatus` includes MeshCore, uses the S1 constants;
  - `server/services/securityIssuesService.ts`;
  - `securityDigestService.ts`: S4, S5, MeshCore sources, settings fallback, "skipped" result.
- Tests:
  - existing `securityDigestService*.test.ts` and `duplicateKeySchedulerService*.test.ts` stay green and unchanged;
  - new: MeshCore scan writes and clears flags, packet log off leaves rate flags alone, a failure in one source does not block another, MeshCore digest sections, per-source dispatch includes MeshCore, global fallback.

**WP4 Routes.**
- Files: `server/routes/securityRoutes.ts` and `utils/securityCapabilities.ts` (S8).
- Tests in `securityRoutes.meshcore.test.ts` (`createRouteTestApp`):
  - `/issues` MeshCore shape (seconds units, stored top broadcasters);
  - Meshtastic `/issues` deep-equal to before apart from the additive fields;
  - scan accepted for MeshCore and 409 while busy;
  - CSV escaping of quotes, commas and newlines;
  - MeshCore export columns;
  - `/nodes/clear` both protocols;
  - the permission matrix (nodes:read on the source, security:write);
  - `/digest/send` with `sourceId` hits only that source;
  - `securityCapabilities.test` for Companion, Repeater and MQTT.

**WP5 UI.**
- Files:
  - `components/SecurityTab.tsx`;
  - the new `components/security/{ScannerStatusCard, SecurityExportMenu, SecurityDigestCard, TopBroadcastersTable, ExcessivePacketsSection, TimeOffsetSection}.tsx` plus `.module.css`;
  - `utils/securityNotificationText.ts`;
  - `components/MeshCore/MeshCorePage.tsx` (deviceType, `onOpenDmWithDraft`, `pendingDmDraft`);
  - `MeshCoreDirectMessagesView.tsx` and `MeshCoreMessageStream.tsx` (`initialDraft`);
  - `utils/meshcoreNodeFieldMerge.ts` and `MeshCoreContactDetailPanel.tsx` (clock row);
  - `App.tsx` if the Meshtastic DM kinds change (Q3);
  - `public/locales/en.json`.
- Tests:
  - the Meshtastic tab renders the same sections and DOM classes;
  - the MeshCore tab shows the scanner, rates, offset, digest, export and the packet-log-off hint;
  - the digest card saves per-source keys with `?sourceId` and global keys without;
  - the DM button is hidden for Repeater sources, for Repeater or Room targets and without `messages:write`;
  - the flood warning shows when there is no path;
  - the draft is pre-filled once and survives the view switch;
  - template byte caps.

**WP6 Docs and epic.**
- Files: `docs/features/security.md` (thresholds, the packet log requirement, the airtime table), `docs/features/meshcore.md`, and the epic P7 log entry.
- Release note on the digest settings fix and on MeshCore digests starting.

**Browser check** on a throwaway volume with the RF lockdown applied:
- Seed a MeshCore source with a packet log of 40 adverts in the last hour from one key, an advert with a 2 h offset, and a DM from a never-set (2024) clock.
- Run Scan now and confirm the rows appear.
- Export CSV and JSON.
- Save digest settings per source, then Send now; it should report "skipped" with no URL.
- The DM button opens a pre-filled draft. **Do not send.**
- Run a visual regression pass on the Meshtastic tab in light and dark, and check the console has no errors.

## Open questions for the maintainer
1. **Thresholds.** Should MeshCore use Meshtastic's 30 packets per hour and 30 min, from the same constants? The MeshCore count is distinct packets attributable to the key in the last 60 min (adverts, ANON_REQ, and unique-`srcHash` REQ/RESPONSE/TXT_MSG). **Recommended: yes, one source of truth.** Advert cadence policy stays with Mesh Issues C2.
2. **DM limits.** **Recommended:** a ≤ 75 B English template (1.4 s US / 3.7 s EU at h = 3), draft only, Companion source and chat-contact target only, the flood warning when there is no path, and no extra cooldown beyond `messageLimiter` and the existing 3-retry machine. The alternative is a persisted per-(source, target, kind) 24 h "already notified" UI lock.
3. **Meshtastic DM kinds.** Should Meshtastic also get "Send notification" on excessive-packet and time-offset rows, to keep one implementation? **Recommended: yes**, draft only, with the same S7 texts. The other option is to leave Meshtastic unchanged.
4. **Never-set clocks.** These are no-RTC nodes stamping the 2024 firmware default, so they are years off. **Recommended: flag them, labelled "Clock not set".** This matters because peers drop adverts older than one they already hold. The alternative is to ignore offsets outside the ±24 h plausibility gate.
5. **Digest settings fix.** The UI saves these globally but the service reads them per source only, so today the digest silently does not send. **Recommended:** save per source, and fall back to the global row for the 4 per-source keys. A consequence is that installs with a global Apprise URL start getting MeshCore digests: one per MeshCore source per day, only when issues exist (suppress-empty is the default). The alternative is per-source only, where users re-enter their URL.
6. **Permissions.** Should `/issues`, `/export` and `/key-mismatches` require `nodes:read` on the source for **both** protocols, as P7a did for dead-nodes? **Recommended: yes**, a slight tightening for Meshtastic. The alternative is MeshCore only.
7. **Meshtastic export content.** The shared collector fixes the export so that nodes flagged only for spam or time offset now appear, with new columns appended. **Recommended: yes.**

## Out of scope
- Mesh Issues C1 on MeshCore. The flags now exist, so this is a small follow-up.
- Push or Apprise alerts when a flag changes. Meshtastic does not alert either, and P11's pipeline is not needed.
- Auto-sent DMs.
- DMs to Repeaters or Room Servers, which do not read them.
- Per-sender spam on GRP_TXT, which has no sender on the wire.
- Low-entropy or duplicate keys on MeshCore, where identity is the key.
- Peak-hour or sliding-window rates.
- Turning the packet log on by default.
- The Security view on the `meshcore_mqtt` ingest page. The scanner does cover MQTT sources, but their digest stays unconfigured until that UI exists.
- Persisting scanner `lastScanTime`.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/services/duplicateKeySchedulerService.ts
- /home/yeraze/Development/meshmonitor/src/server/services/securityDigestService.ts
- /home/yeraze/Development/meshmonitor/src/server/routes/securityRoutes.ts
- /home/yeraze/Development/meshmonitor/src/server/services/meshIssuesAnalysisService.ts (C2 loader at :778-802 to extract)
- /home/yeraze/Development/meshmonitor/src/components/SecurityTab.tsx (plus `src/components/MeshCore/MeshCorePage.tsx`, `src/db/schema/meshcoreNodes.ts`, `src/db/repositories/meshcore.ts`)
