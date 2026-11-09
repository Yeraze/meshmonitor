# MeshCore Parity follow-up: Repeater new-node notifications from adverts (#6306)

## Maintainer decisions (2026-11-09, binding)
Q1: 48 h learning window + 10/h per-source cap, built as a shared protocol-neutral gate, wired to Repeater sources only (explicit exception to 'no MeshCore-only cap'); overflow adds '(+N more)' to the next alert; constants, not settings; state persisted per source. Q3: accept legacy Repeater prefs with a release note. Q4: 'new' = new to this source. Q5: a full node purge re-arms the window; offline gaps do not. Q6: silent drop + suffix.


This phase belongs to the parity epic (`docs/internal/dev-notes/MESHCORE_PARITY_EPIC.md`). Base is `main` at `4402509fe`, which includes P11 (#6305). Paths are relative to `/home/yeraze/Development/meshmonitor/src/`.

## Binding context and the tension to resolve first
- Epic decision 2 (`MESHCORE_PARITY_EPIC.md:16-17`) and P11 decision 1 (`MESHCORE_PARITY_P11_SPEC.md:6`) say: reuse the Meshtastic rules as they are, with **no MeshCore-only cap**.
- Epic decision "one implementation" (`:25-31`) says every gate must be a shared piece.
- CLAUDE.md (`:41`, `:83-134`) says notification volume is spam that needs a limit, and the maintainer picks that limit. Any learning or last-fire state goes in the DB (`:117-126`).
- The #5553 maintainer decision is quoted in code at `server/meshcoreManager.ts:4991-4998`. Repeater advert ingest is "deliberately quiet": no new-node notification and no nodeDiscovered/nodeUpdated automation events, because a logging repeater hears every advert in range.
- **The conflict:** wiring Repeater alerts with any volume limit adds a cap that only MeshCore has, unless that limit is built as a shared gate. This spec builds it as a shared, protocol-neutral gate and wires it to the Repeater only. Open question 1 decides whether it also applies elsewhere.

## Findings
1. **Repeater ingest is silent.**
   - `ingestRepeaterFrame` (`server/meshcoreManager.ts:4970-4988`) calls `ingestRepeaterAdvert` (`:5011-5022`).
   - That calls `ingestAdvertFrame` (`server/services/meshcoreFrameIngest.ts:450-505`), then `emitStoredContact` (socket refresh only).
   - `ingestAdvertFrame` returns the decoded advert. It does **not** say whether the row was inserted, and does not return the signature verdict.
     - The verdict is computed at `:478` (`verifySignature: 'always'` on the Repeater, `:5018`) and stored only as `advertSignatureVerified`.
   - The only other caller is `meshcoreMqttManager.ts:563` (out of scope).
2. **The DB knows whether a node is new but does not report it.**
   - `MeshCoreRepository.upsertNode` (`db/repositories/meshcore.ts:698-862`) reads `existing` (`:707`) and inserts at `:850-861`. It returns `Promise<void>`.
   - The lookup `getNodeByPublicKeyAndSource` (`:633-644`) matches the key exactly, case-sensitive, scoped to one source.
3. **How a Companion decides "new"** (`meshcoreManager.ts`):
   - `wasKnown = this.contacts.has(publicKey)` (`:2989`).
   - The in-memory contact map is seeded from the DB and then from device `get_contacts`, with new-node alerts suppressed during that sync (`newNodeNotifySuppressed`, `:1523`, `:2163-2169`).
   - The alert fires at `:3039-3041` for `!wasKnown` or a pending nameless key.
   - **So a Companion has a built-in learning set: the device contact table.** A fresh install never alerts for contacts the radio already holds.
   - A Repeater keeps no contact map (`emitStoredContact` doc, `:5063-5070`). The DB row is the only memory it has.
4. **`notifyNewNodeDiscovered` (`:4024-4068`) does more than notify.**
   - It dedups per process with `notifiedNewNodes` (`:1506`). That set is never cleared and is unbounded.
   - It defers nameless keys with `pendingNewNodeNotifications` (`:1517`, cleared on disconnect at `:2584`, flushed at `:4180-4191`).
   - **It also starts Auto Welcome** (`void this.checkAutoWelcome(contact)`, `:4044`; `checkAutoWelcome` at `:13749`), which sends a DM. A Repeater path must not reuse this method as it stands.
5. **Shared notifier.**
   - `notificationService.notifyNewMeshCoreNode` (`server/services/notificationService.ts:258-296`) builds "New MeshCore Device Detected" / "`<name>` detected by `<source>` - `<type>`".
   - It carries a #5729 dedup key `meshcore-new-node:${publicKey}` with a merged body (`:276-279`).
   - It fans out to push, Apprise and desktop through `broadcastToPreferenceUsers('notifyOnNewNode', …, sourceId)`.
   - Meshtastic's twin is `notifyNewNode` (`:214-246`).
6. **Meshtastic has no learning window and no cap.**
   - `databaseService.maybeNotifyNewNode` (`services/database.ts:1714-1764`) fires on the incomplete→complete transition.
   - It dedups per process with a global `newNodeNotifiedSet` keyed by nodeNum only (`:537`, shared across sources).
   - It is called from `upsertNodeAsync` (`:1776-1803`), which the Meshtastic TCP NodeDB dump and **Meshtastic MQTT ingest** both use (`server/mqttIngestion.ts:436`, `:816`).
   - **So a Meshtastic MQTT source already floods the same way a logging Repeater would, with no limit.** That is the honest parity baseline.
7. **What softens a fresh install today.**
   - `notifyOnNewNode` defaults to **false** for a never-configured (user, source) (`utils/notificationDefaults.ts:66-68`).
   - Untargeted broadcasts go only to push subscriptions on that source (`pushNotificationService.ts:672-687`).
   - On a fresh install or a newly added source, nobody receives alerts until they opt in.
   - The realistic floods are therefore:
     - (a) a user opts in while a new Repeater is still learning the mesh. A Repeater learns over 12-48 h; a Meshtastic NodeDB dump arrives in seconds.
     - (b) node purge or DB restore, with prefs left in place.
     - (c) forged adverts. A valid signature from a freshly generated keypair is cheap, so signature checks do not stop key-minting spam.
   - **Legacy prefs:** before P11 the new-node toggle was visible on every MeshCore source, Repeaters included (comment at `components/NotificationsTab.tsx:859-860`). Some saved Repeater rows may hold `notifyOnNewNode=true` and will start firing when this ships. The same pattern as P11 Q2.
8. **Rows not created by adverts.** The neighbours poll also inserts rows on the Repeater source, copied from other sources' rows (`meshcoreManager.ts:10460-10504`). A node first learned that way is then "known" when its advert arrives, so it never alerts. That is acceptable: it was already visible as a neighbour.
9. **Purge.** `POST /nodes/purge-non-favourites` (`server/routes/meshcoreContactsRoutes.ts:~405-425`, `nodes:write`) calls `deleteNonFavoriteNodes` (`db/repositories/meshcore.ts:1776`). After a purge, every node heard again is "new".
10. **Cross-source dedup (#5729).**
    - `server/services/notificationDedup.ts`: a 60 s non-sliding window (`:34`), at most 10k entries (`:37`), memory only, state per (recipient, key).
    - A Companion and a Repeater that both treat the same flood advert as new within 60 s produce **one** alert per recipient, listing both sources.
    - "New" is per source. A node a Companion learned days ago will alert again when the Repeater first hears it.
11. **Permissions.** `broadcastToPreferenceUsers` checks `messages:read` on the source and skips anonymous subscriptions (`pushNotificationService.ts:701-724`). Apprise and desktop behave the same way. This is unchanged and shared with the Companion and Meshtastic paths. A new-node alert being gated on `messages:read` rather than `nodes:read` is existing behaviour and out of scope.
12. **UI gating.**
    - `utils/notificationCapabilities.ts` returns `newNode: repeater ? 'unsupported' : 'on'`.
    - `NotificationsTab.tsx:861-886` renders the toggle or `notifications.repeater_unsupported_hint` (`public/locales/en.json:2814`). That hint text names "new-node adverts".
    - Tests: `NotificationsTab.test.tsx:121,133` and `utils/notificationCapabilities.test.ts`.
    - `server/meshcoreManager.repeaterIngest.test.ts:91` asserts "fires no new-node notification and no node automation events".
13. **Precedent for persisted per-source notifier state.** `meshcoreMentionNotificationService.ts:27-52,75-84` stores `{senderKey: lastAlertMs}` in a per-source setting (`SETTING_MENTION_STATE`). It uses injected deps (`getSourceSetting`/`setSourceSetting`) and tolerates clock skew. Per-source settings API: `databaseService.settings.getSettingForSource` / `setSourceSetting` (used at `meshcoreManager.ts:7433-7440` for `meshcoreLastFloodAdvertAt`).

## Design (shared pieces first)

**S1 – `newNodeAlertGate` (new `server/services/newNodeAlertGate.ts`, protocol-neutral, keyed by `sourceId`).** It has no MeshCore types. Reason it is shared: a Meshtastic MQTT source has the same shape of volume (Finding 6) and can adopt it later with one call.
- `admit(sourceId, opts: { now }): Promise<{ allow: boolean; reason?: 'learning'|'capped'; suppressedSinceLast?: number }>`
- `rearm(sourceId, now)`: restarts the learning window. Used by purge only.
- `learningUntil(sourceId)`: read-only, for the UI note.
- **Learning window:**
  - Per-source setting `newNodeAlertLearnUntil` (epoch ms).
  - When the setting is unset, it is initialised once as `(earliest createdAt among this source's node rows, or now) + LEARN_MS`. Rows come from a new repository method `getEarliestNodeCreatedAt(sourceId)`.
  - So an existing Repeater that has been logging for weeks is armed immediately after the upgrade, and a brand-new source learns for `LEARN_MS`.
  - Written once. **Never reset** by source edit, reconnect, a prefs save, disconnect, or a firmwareType change.
  - Only an explicit purge re-arms it. That direction can only suppress, which is safe.
- **Hourly cap (backstop):**
  - Per-source setting `newNodeAlertRate` = JSON `{ windowStart, sent, suppressed }`, a fixed (non-sliding) hour like the dedup window.
  - At most `CAP_PER_HOUR` alerts per source per hour. Overflow is counted, not sent, and logged with `HourlyLogLimiter`.
  - The next alert that is allowed carries `suppressedSinceLast`. The body gains "(+N more new nodes since the last alert)". No timer and no extra notification.
  - The state is persisted, so a restart cannot reopen a full hour (CLAUDE.md "save resets a safety timer").
  - A clock that steps backwards keeps the current window, following the mention-state pattern.
- Deps are injected (settings get/set, earliest-row lookup, now) so it can be unit-tested without the DB, mirroring `MentionNotificationDeps`.
- Constants are module consts (like `NOTIFICATION_DEDUP_WINDOW_MS`), not user settings, until the maintainer asks for one. Values come from Open question 2.

**S2 – split notification from discovery side-effects (`meshcoreManager.ts`).**
- Extract the alert-only part of `notifyNewNodeDiscovered` into `private async alertNewNode(contact)`. It keeps the name check, the pending set, `notifiedNewNodes`, the source name, and `notificationService.notifyNewMeshCoreNode`.
- `notifyNewNodeDiscovered` becomes `checkAutoWelcome` + `alertNewNode`, so Companion behaviour is unchanged.
- The Repeater path calls `alertNewNode` behind the gate and **never** Auto Welcome. A Repeater sends nothing.
- Bound `notifiedNewNodes`, for example to 4096 entries in insertion order. A forged-key stream otherwise grows it without limit.

**S3 – report insert and verify from ingest.**
- `MeshCoreRepository.upsertNode` returns `Promise<{ inserted: boolean }>`. Existing callers ignore the result.
- `ingestAdvertFrame` returns `{ advert, inserted, signatureVerified } | null`. Update `meshcoreMqttManager.ts:563` mechanically.

**S4 – Repeater wiring (`ingestRepeaterAdvert`).** After `emitStoredContact`, call `maybeAlertRepeaterNewNode(publicKey, inserted, signatureVerified)`:
1. Require `deviceType === REPEATER`, and `signatureVerified === true` (a garbled or unsigned advert never alerts).
2. Require `inserted`, or the key already in `pendingNewNodeNotifications` (nameless first advert, #5340 semantics).
3. Build the contact from the **stored row** (`contactFromNodeRow`), so the name is the sanitized one.
4. `gate.admit(sourceId)`. On `learning`, drop silently and do not park it in pending; the node is now "known". On `capped`, drop and count.
5. `alertNewNode(contact, { suppressedSinceLast })`.

`notifyNewMeshCoreNode` gains an optional `suppressedCount` that appends the suffix. The dedup key and merged body stay unchanged.
- Update the docblock at `:4991-5010`: alerts are now on, behind the gate. Automation triggers (`emitNodeDiscovered`/`emitMeshCoreNodeChanged`) **stay off** per #5553.

**S5 – purge re-arms.** On `deleted > 0`, the purge route calls `newNodeAlertGate.rearm(sourceId)`, for Repeater sources only (by manager device type), or for all MeshCore sources if Open question 1 widens the scope. `deleteNode` (a single node) does not re-arm.

**S6 – UI (`notificationCapabilities`, `NotificationsTab`).**
- Repeater gets `newNode: 'on'` and a new field `newNodeNote: 'repeater_learning' | null`.
- Under the toggle, show `notifications.new_nodes_repeater_note`: "A Repeater hears every advert on the mesh. New-node alerts start {{hours}} h after it first logs the mesh, and at most {{cap}} are sent per hour."
- Optionally add "Learning until {{time}}" from `learningUntil`, exposed on the existing MeshCore status payload. That is optional; see Out of scope.
- Rewrite `repeater_unsupported_hint` so it no longer names new-node adverts: "A Repeater does not receive direct messages or traces, so those alerts and the mention alert are not available."
- Edit only en.json, per locale convention.

## Mesh impact
- **RF: none.** Passive ingest only. Auto Welcome is explicitly kept off the Repeater path, so no DM, no advert, no CLI write. Nothing new is armed on a timer: the gate is evaluated per event.
- **Notification volume.** Assumed mesh: one logging Repeater hearing 300 nodes, about 100 repeaters on the firmware-default 12 h flood advert and about 200 companions advertising irregularly. Fan-out per alert is opted-in users × channels; 3 users × (push + Apprise) = 6 deliveries.

  | Policy | Day 1 | Days 2-7 | Steady state |
  |---|---|---|---|
  | No gate (pure Meshtastic-MQTT parity) | ~200 alerts (~8-10/h for 24 h) ≈ 1,200 deliveries | ~100 tail | true new nodes, ~0-5/day |
  | Cap only, 10/h | ≤240 (cap barely binds at ~8-10/h) | ~100 | same |
  | 48 h learning window + 10/h cap (recommended) | 0 | ~20-60 (rare companions first heard after the window; these are genuinely new to this source) | same |
  | Keep hidden | 0 | 0 | 0 |

- **Restore, purge, forged keys.**
  - Restoring an older backup makes nodes heard since that backup new again. The cap bounds this to ≤10/h; the window does not re-arm, because the setting is restored with the backup.
  - Purge re-arms the window, so it produces 0 alerts.
  - A key-minting attacker produces ≤10/h per source. Signature checks stop garbage frames but not this.
- **Cross-source.**
  - A Companion and a Repeater hearing the same new advert within 60 s produce one merged alert (#5729).
  - A Repeater that learns a node first known to a Companion days earlier alerts once more. That is per-source semantics; see Open question 4.
  - With N Repeaters on one mesh, each gate is per source, so the worst case is N × cap. Simultaneous first hearings merge through dedup.
- **Save and safety timer.**
  - `learnUntil` and the hourly counter are persisted per source.
  - Restart, reconnect, a source edit or a prefs save never reset them. A prefs toggle off→on does not re-arm.
  - Only purge writes `learnUntil`, and it can only extend suppression.
  - Container-restart verification is a WP step.

## Security and permissions
- Delivery is unchanged: `messages:read` on the source, anonymous subscriptions skipped, per-(user, source) prefs, dedup state per recipient. An advert is public, so no key-access (S2/P11) gate applies.
- The alert body uses the **stored, sanitized** name (`upsertNode` → `sanitizeMeshCoreName`), not the raw advert bytes. Advert text controlled by an attacker therefore reaches push and Apprise only in the same form the Companion path already sends.
- The signature must verify before an alert fires.
- The purge route keeps `nodes:write` and audit. The re-arm adds no new endpoint.
- No source name leaks across sources. Per-source "new" means a skip never depends on another source's rows. This holds unless Open question 4 chooses install-wide, which leaks one bit: "some other source knows this key".

## Work packages
**WP1 – shared gate and ingest reporting (server).**
- `server/services/newNodeAlertGate.ts` (new) and `newNodeAlertGate.test.ts`. The tests cover:
  - init from the earliest row vs. now;
  - an existing source is armed at once;
  - state survives a new instance (restart);
  - prefs save, source edit and reconnect leave the state alone;
  - `rearm` extends the window;
  - cap and overflow count;
  - the suffix count is consumed once;
  - a clock that steps back;
  - corrupt JSON.
- `db/repositories/meshcore.ts`: `upsertNode` returns `{inserted}`; new `getEarliestNodeCreatedAt(sourceId)`. Add a repo test on SQLite, plus the PG/MySQL suites if they cover this repo. No migration: settings are key/value.
- `server/services/meshcoreFrameIngest.ts`: new return shape. Update its tests and `server/meshcoreMqttManager.ts:563`.

**WP2 – Repeater wiring (server).**
- `server/meshcoreManager.ts`:
  - split `alertNewNode` from `notifyNewNodeDiscovered`;
  - add `maybeAlertRepeaterNewNode` in `ingestRepeaterAdvert`;
  - bound `notifiedNewNodes`;
  - update the docblock.
- `server/services/notificationService.ts`: optional `suppressedCount` suffix on `notifyNewMeshCoreNode`. Extend `notificationService.test.ts`.
- `server/meshcoreManager.repeaterIngest.test.ts`: replace `:91` with these cases:
  - a new, verified, named advert alerts once when the gate is armed;
  - a second copy or later advert does not alert;
  - nothing alerts while learning, and those nodes never alert later;
  - an unverified advert does not alert;
  - a nameless advert followed by a named one alerts once;
  - the repeater's own key does not alert;
  - a neighbour-poll-first node does not alert;
  - **Auto Welcome is never called**;
  - `emitNodeDiscovered`/`emitMeshCoreNodeChanged` are still never emitted.
- Run the Companion regression suites (`meshcoreManager.contactPersistence/advert/contactRemoval/nodeTriggers` tests) unchanged.

**WP3 – purge re-arm.**
- `server/routes/meshcoreContactsRoutes.ts` purge handler calls `rearm`.
- Route test: a purge with `deleted>0` re-arms; a purge with `0` does not.

**WP4 – UI.**
- `utils/notificationCapabilities.ts` (+ test): Repeater `newNode: 'on'` plus `newNodeNote`.
- `components/NotificationsTab.tsx`: the note under the toggle.
- `public/locales/en.json`: new `notifications.new_nodes_repeater_note` (interpolates hours and cap); rewrite `repeater_unsupported_hint`.
- `components/NotificationsTab.test.tsx`: the Repeater shows the toggle and the note; the hint no longer mentions new nodes; the Companion is unchanged.

**WP5 – docs and verification.**
- Release note for legacy Repeater prefs with `notifyOnNewNode=true` (Finding 7).
- User docs for the notifications page: Repeater learning period and cap.
- Tick the epic file and link #6306.
- Browser check on a throwaway volume with RF lockdown: Repeater Notifications tab in light and dark.
- Restart the container and confirm `newNodeAlertLearnUntil` and `newNodeAlertRate` persist.
- PR body carries the Mesh impact section above.

## Open questions for the maintainer
1. **Volume policy: which mechanism, and where?**
   - (a) 48 h learning window + 10/h cap, built shared, wired to Repeater only. **Recommended.** The reason it is Repeater-only for now: the Repeater is the one source with no device-side learned set (Finding 3). This needs an explicit exception to "no MeshCore-only cap".
   - (b) The same gate, also wired to Meshtastic MQTT (and TCP). This keeps parity strict but changes Meshtastic behaviour.
   - (c) Cap only.
   - (d) No gate, pure parity with Meshtastic MQTT (~200 alerts on day 1 at 300 nodes).
   - (e) Keep it hidden and close #6306.
2. **Numbers.**
   - Learning window: 24 h, **48 h (recommended; 4 default 12 h flood-advert cycles, and 2 at the 24 h interval many operators use)**, or 72 h.
   - Cap: **10/h per source (recommended)** or 5/h.
   - Constants, or user settings with a warning next to the input? **Recommended: constants for now.**
3. **Legacy Repeater prefs** saved with `notifyOnNewNode=true` before P11 will start alerting once the window passes. Options: accept it with a release note (**recommended**, matches P11 Q2), or a migration that sets it to false on Repeater sources.
4. **What counts as "new"?**
   - **Per source (recommended):** the same as Companion and Meshtastic, no cross-source inference, and #5729 merges simultaneous hearings.
   - Install-wide: skip when any MeshCore source already has the key. Fewer alerts, but it diverges from Companion and leaks one bit across sources.
5. **Should purge re-arm the window?** **Recommended: yes**, for a full purge only.
   - Should a long offline gap re-arm too (e.g. no advert ingested for 7 days, which covers a stale DB restore)? **Recommended: no.** The cap bounds that case.
6. **Overflow handling.** **Recommended: silent drop plus a "(+N more)" suffix on the next alert.** The alternative is a separate hourly summary notification, which needs a timer.

## Out of scope
- Repeater `trigger.nodeDiscovered`/`nodeUpdated` automation events (#5553 decision stands).
- Auto Welcome on Repeaters.
- New-node alerts and a Notifications tab for `meshcore_mqtt` (P11 follow-up). The gate makes this a one-line wire-up later.
- Changing Meshtastic new-node behaviour, unless Open question 1(b) is chosen. This includes the global-by-nodeNum `newNodeNotifiedSet` (`services/database.ts:537`).
- `messages:read` vs `nodes:read` for node alerts.
- A live "learning until" status in the UI, beyond the static note.

### Critical Files for Implementation
- /home/yeraze/Development/meshmonitor/src/server/meshcoreManager.ts
- /home/yeraze/Development/meshmonitor/src/server/services/meshcoreFrameIngest.ts
- /home/yeraze/Development/meshmonitor/src/db/repositories/meshcore.ts
- /home/yeraze/Development/meshmonitor/src/server/services/notificationService.ts
- /home/yeraze/Development/meshmonitor/src/utils/notificationCapabilities.ts (with /home/yeraze/Development/meshmonitor/src/components/NotificationsTab.tsx and the new /home/yeraze/Development/meshmonitor/src/server/services/newNodeAlertGate.ts)
