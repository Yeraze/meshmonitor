# MeshCore Parity P7a — Security (#6254)

Part of the parity epic (`MESHCORE_PARITY_EPIC.md`). Base: `main` with P1–P6. Paths relative to `src/`; line refs
checked 2026-11-08. Binding rule: ONE Security tab with protocol adapters — MeshCore gets a `security` view in
`MeshCorePage` rendering the shared `SecurityTab`; no MeshCore copy.

## Maintainer decisions (2026-11-08, binding)
1. **Split.** P7a (this PR): dead contacts + bulk delete, path-hash collisions, advert signature (tri-state) in contact
   panel / map popup / filter, Repeater signature recording, name-under-new-key, own-key change (Companion + Repeater)
   with alert. No migration. P7b (follow-up issue): per-key rates, persisted clock-offset flag, MeshCore in
   scanner / digest / export / notification DM, migration: the next free number (225 went to P16 #6285; take the next one when implementing).
2. **Dead threshold**: one shared per-source setting `securityDeadNodeDays` for both protocols, editable on the tab.
   Defaults: Meshtastic 7, MeshCore 14. (New setting key → `VALID_SETTINGS_KEYS`.)
3. **Bulk delete**: requires `security:write` AND `nodes:write` on the source, both protocols (slightly tightens
   Meshtastic). MeshCore Companion deletes from radio AND DB; UI warns contacts can re-appear on their next advert.
4. **Exclusions**: local node, ignored nodes, favourites (device flag or app) excluded; never-heard listed but
   unselected by default.
5. **Own-key alert**: existing `notifyOnServerEvents` preference; one alert per detected change, persisted (survives
   restart/reconnect); card persists until a `security:write` user acknowledges.
6. **Name reuse**: display-only, no alert; trimmed, case-insensitive.
7. **Filter**: reuse the existing Security filter (`flaggedOnly`/`hideFlagged`); flagged = signature failed OR
   name-reuse suspect.
8. **Signatures**: Repeater RAW adverts always verified (CPU only); MQTT stays behind the cross-source toggle;
   unchecked stored as null (never shown as "failed").
9. **Collisions**: report at the source's `meshcoreDefaultPathHashSize` (default 1) plus counts at 2 and 3 bytes.
10. **meshcore_mqtt**: P7a server endpoints accept it (findings + DB-only delete); a Security view on the ingest page
    is a follow-up.

## Mesh impact — P7a sends nothing over RF
- Bulk delete on Companion: `remove_contact` ∈ `SERIAL_ONLY_BRIDGE_COMMANDS` (`server/constants/meshcoreTx.ts:36`) —
  serial/TCP, one device round-trip per contact (≤ radio maxContacts); reuse the single-flight `bulkRemoveInFlight`
  (`meshcoreManager.ts:8510-8553`) and 300 s `extendRequestTimeout` (`meshcoreContactsRoutes.ts:87,330-338`).
  Repeater / disconnected / meshcore_mqtt: DB only via `forgetLocalContact` (`meshcoreManager.ts:8879`).
- Repeater signature check: one Ed25519 verify per advert already heard.
- Own-key on Repeater reuses the existing on-connect `get public.key` (`meshcoreManager.ts:5749-5751`, local CLI).
- Own-key alert: edge-triggered, one per detected change, persisted; no timer. Name reuse never alerts.
- No new timers/schedulers; findings are DB reads on the tab's existing 30 s poll (`SecurityTab.tsx:147`).

## Shared pieces
| ID | Piece | Used by |
|---|---|---|
| S1 | `utils/securityCapabilities.ts` (browser-safe) `securityCapabilities(sourceType, deviceType?)` → `{lowEntropy, duplicateKeys, keyMismatchLog, scanner, spam, timeOffset, deadNodes, deviceDelete, pathHashCollisions, advertSignatures, nameReuse, ownKeyChange, digest, notifyDm}`. Meshtastic = today's set; MeshCore P7a = deadNodes, deviceDelete (Companion), pathHashCollisions, advertSignatures, nameReuse, ownKeyChange. | SecurityTab sections, route guards |
| S2 | `/api/security/*` stays one router, branches on `isAnyMeshCoreSourceType`; existing endpoints keep wire shapes; new endpoints `ok()/fail()`. | dead-nodes, bulk-delete, findings |
| S3 | `DeadNode` row + `nodeKey` (`mt:<n>`/`mc:<pk>`), `publicKey?`, `protocol`, `isFavorite`; `lastHeard` always SECONDS (MeshCore adapter converts ms); selection keyed on `nodeKey`; bulk-delete accepts `nodeKeys`, keeps `nodeNums` for back-compat. | DeadNodesSection |
| S4 | `server/services/meshcoreSecurityFindings.ts`: pure `findPathHashCollisions(nodes, width)` (on `hopByteForKey`, `utils/meshcorePath.ts:80`), `findNameReuse(nodes)`, `listSignatureFailures(nodes)` + loader from `meshcore.getNodesBySource`. | findings route, P7b digest |
| S5 | `server/services/meshcoreOwnIdentityTracker.ts`: `observe(sourceId, pk)` → `baseline|same|changed`, `acknowledge(sourceId)`; persisted in internal per-source settings `meshcoreOwnIdentityKey` / `meshcoreOwnIdentityChange` (JSON `{previousKey,currentKey,detectedAt}`), NOT in the settings-API allowlist (like `meshcorePkiExportUnsupported`). | Companion + Repeater connect, alert, card |
| S6 | `SecurityTab` props generalised: `onOpenNode(nodeKey)`, `onOpenDmWithDraft(nodeKey, text)`; Meshtastic adapter maps to today's `!hex` calls; MeshCore `onOpenNode` → `navigateToDm(pk)`. | App.tsx, MeshCorePage |
| S7 | `NodeFilterSubject.securityFlagged?` + shared `isSecurityFlagged` (used by `NodesTab.tsx:1536-1541`); MeshCore adapter = `advertSignatureVerified === false` OR name-reuse suspect; enable the popup's `security` feature for MeshCore (`MeshCoreNodesView.tsx:47-51`). | node lists (both) |
| S8 | `utils/meshcoreNodeFieldMerge.ts`: one DB→live-contact field merge replacing `MeshCoreNodesView.tsx:436-464` and `MeshCoreDirectMessagesView.tsx:94-99,322-326`; adds `advertSignatureVerified`. | panel, map, filter |

## Findings (evidence)
- Tab routed only in Meshtastic shell (`App.tsx:3603-3604`, `Sidebar.tsx:253`), gated `security:read` (`App.tsx:705`);
  router applies `security:read` globally (`securityRoutes.ts:22`); `security` is a GLOBAL resource
  (`types/permission.ts:78-88`). MeshCore views: `meshCoreViewAccess.ts` (`MESHCORE_VIEWS`, `visibleMeshCoreViews`) +
  `MeshCoreSubToolbar.tsx:40-51` — no `security`. Precedent for shared tab in MeshCorePage: `NotificationsTab` (~:322).
- Dead nodes: `GET /dead-nodes` Meshtastic-only, 400 `INVALID_SOURCE_TYPE` (`securityRoutes.ts:375-436`), hard-coded 7 d,
  excludes local/broadcast/ignored, includes never-heard. `POST /dead-nodes/bulk-delete` (`:438-504`) checks
  `security:write` only, no source gate. `getInactiveMeshcoreNodes` (`db/repositories/meshcore.ts:1666`) excludes null
  lastHeard, ms, used by `inactiveNodeNotificationService.ts:387` → leave it; add `getDeadNodes`. `removeContact`
  (`meshcoreManager.ts:8765`) device+DB+tombstone; favourite handling to mirror: `removeNonFavoriteContacts`
  (`:8520-8553`). Single delete needs `nodes:write` (`meshcoreContactsRoutes.ts:850-900`).
- Collisions: width setting `meshcoreDefaultPathHashSize` (1/2/3, `server/constants/settings.ts:478-481`); primitives
  `repeaterHopOptions` / `resolveHop` / `resolveRoute` (`utils/meshcorePath.ts:137-240`).
- Signatures: `meshcore_nodes.advertSignatureVerified` (`db/schema/meshcoreNodes.ts:51-54`) written only by
  meshcore_mqtt (`meshcoreMqttManager.ts:563-566`), read only by `meshcoreHopCandidates.ts:118`. Repeater RAW adverts
  call `ingestAdvertFrame` without `recordSignature` (`meshcoreManager.ts:4935-4944`). **Bug**: `advertSignatureMarker`
  writes `false` for both skipped and failed (`meshcoreFrameIngest.ts:426-441`); `upsertNode` keeps stored on null —
  `CLEARABLE_VIA_NULL = {outPath, pathLen}` (`db/repositories/meshcore.ts:26`); add the column → true tri-state.
- Name reuse: from `meshcore_nodes` (`name`, `firstHeard` ms `:73`, `publicKey`) per source.
- Own key: `keyMismatch` only written in `maybeExportAndStorePkiKey` (`meshcoreManager.ts:9352-9428`), which returns
  early for non-Companion, `!canStore`, or no private-key export (`:9397-9405`) → a key change is usually MISSED; hence
  S5 tracks identity independently. Current key: Companion `localNode.publicKey` (`:1547`), Repeater `repeaterPublicKey`
  (`:5751`). Only reader of `keyMismatch`: `sourceObserverRoutes.ts:277`.
- Alert path: `serverEventNotificationService.ts` per-source broadcast under `notifyOnServerEvents` (`:45-143`).
- `SecurityTab.tsx` uses global `styles/SecurityTab.css` (frozen) — new sections use CSS modules.

## Not feasible / out of scope
Low-entropy key list; "same node, new key" (identity = key); duplicate keys (rows key on pk). P7b items (decision 1).
meshcore_mqtt ingest-page UI (follow-up). Automatic dead-contact deletion (stays manual). Own-key on Meshtastic (no
signal; card is generic, MeshCore adapter only).

## Design
**Routes** (`server/routes/securityRoutes.ts`):
- `GET /dead-nodes?sourceId` (`requireSourceId('query')`): threshold from `securityDeadNodeDays` (per source; default
  per protocol). Meshtastic unchanged + `nodeKey`, `protocol`. MeshCore → new `meshcore.getDeadNodes(sourceId,
  cutoffMs, {includeNeverHeard:true})` excluding local key + ignored, favourites excluded (decision 4); `inDeviceDb` =
  live contact `onDevice === true`; `role` = advType.
- `POST /dead-nodes/bulk-delete {sourceId, nodeKeys|nodeNums}`: `security:write` + `nodes:write` on source (decision 3).
  MeshCore Companion connected → new `manager.removeContactsBulk(keys)` under `bulkRemoveInFlight` (busy → 409
  `BULK_REMOVE_BUSY`; per-key fallback to `forgetLocalContact` on device failure). Repeater / disconnected /
  meshcore_mqtt → `forgetLocalContact`. Keys 64-hex, ≤1000/request, `extendRequestTimeout`, audit log.
- `GET /meshcore/findings?sourceId` → `ok({pathHashCollisions:{width, countsByWidth:{1,2,3}, groups:[{hash,nodes}]},
  signatureFailures, nameReuse:[{name, original, suspects}], ownKey:{currentKey, previousKey, detectedAt,
  pkiKeyMismatch}})`; non-MeshCore → 400 `INVALID_SOURCE_TYPE`. Collisions: advType 2/3 heard within the dead window.
- `POST /own-key/acknowledge {sourceId}`: `security:write`; re-baseline; `ok()`.
- The `securityDeadNodeDays` setting is read/written per source through the existing settings API (add to
  `VALID_SETTINGS_KEYS`; validate 1–365).

**Ingest**: `advertSignatureVerified` → `CLEARABLE_VIA_NULL`; `advertSignatureMarker` returns null when unchecked;
`ingestAdvertFrame` option `verifySignature: 'always' | 'toggle'` — Repeater `'always'`, MQTT `'toggle'`.

**Own key**: `tracker.observe` after self-info on Companion (beside `maybeExportAndStorePkiKey`) and after
`get public.key` on Repeater (skip the `'repeater'` placeholder). On `changed`: write change record, warn log, call new
`serverEventNotificationService.notifyOwnKeyChanged(sourceId, sourceName, oldPrefix8, newPrefix8)` once. PKI
`keyMismatch` surfaces as a sub-note ("stored DM-echo key belongs to the previous identity").

**UI**: `SecurityTab` reads source type (`useSource()` + sources query) → sections per S1; scanner/digest cards hidden on
MeshCore until P7b. New CSS-module components `components/security/{DeadNodesSection, PathHashCollisionsSection,
AdvertSignatureSection, NameReuseSection, OwnKeyChangeCard}`; dead-node list moves into the nodeKey-based
`DeadNodesSection` for both protocols, with the editable threshold and the re-appear warning. `UiIcon`,
`var(--color-*)`, flat `security.mc_*` keys. `MeshCorePage` `view === 'security'`; `meshCoreViewAccess` adds
`security: canRead('security')` (+ doc table); `MeshCoreSubToolbar` reuses shared nav icon/label. Contact panel row
"Advert signature: Verified / Failed / Not checked"; map popup (`MeshCoreMap.tsx` `renderContactPopup`) line only when
non-null; filter per S7.

## Work packages — WP1 → (WP2 ∥ WP4); WP3 after WP2; WP5 last
Every WP: typecheck, lint ratchet (no FAIL outside `.claude/worktrees`), `.js` server imports, no raw SQL, `ok()/fail()`
for new handlers. PG/MySQL up for repo tests.
- **WP1 Server foundations**: `utils/securityCapabilities.ts`; `db/repositories/meshcore.ts` (`getDeadNodes`,
  CLEARABLE_VIA_NULL); `server/services/meshcoreSecurityFindings.ts`; `server/services/meshcoreOwnIdentityTracker.ts`;
  `server/services/meshcoreFrameIngest.ts`; `server/services/serverEventNotificationService.ts`;
  `server/meshcoreManager.ts` (Repeater `verifySignature:'always'`, tracker hooks, `removeContactsBulk`);
  `server/constants/settings.ts` (`securityDeadNodeDays`). Tests: multi-backend isolated (`getDeadNodes` scoping,
  never-heard included, cutoff ms; signature clears to null); pure (collisions widths 1/2/3, advType 2/3 only,
  countsByWidth; name reuse case/whitespace, original by firstHeard, empty names ignored); tracker (baseline silent,
  same no-op, change notifies ONCE across repeated observe + simulated restart, acknowledge re-baselines); ingest
  (Repeater forged → false, valid → true, MQTT toggle off → null); `removeContactsBulk` busy guard + fallback.
- **WP2 Routes** (after WP1): `server/routes/securityRoutes.ts` + `securityRoutes.meshcore.test.ts`
  (`createRouteTestApp`, mocked managers): Meshtastic responses unchanged apart from additive `nodeKey`/`protocol`
  (and the new threshold source); MeshCore Companion bulk delete hits device; Repeater/disconnected DB-only; busy 409;
  bad key / over-limit 400; permission matrix (security:write AND nodes:write on source, both protocols); findings
  shape; non-MeshCore 400; acknowledge needs security:write; missing sourceId 400.
- **WP3 Security tab** (after WP2): `components/SecurityTab.tsx`; `components/security/*` + `.module.css`; `App.tsx` (S6);
  `components/MeshCore/{MeshCorePage, meshCoreViewAccess, MeshCoreSubToolbar}.tsx`; `public/locales/en.json`. Tests:
  Meshtastic tab renders today's sections; MeshCore hides low-entropy/duplicate/scanner/digest and shows the new ones;
  bulk delete sends `nodeKeys`+`sourceId`; threshold edit saves per source; `visibleMeshCoreViews` includes
  `security` only with `security:read` (update `MeshCorePage.viewAccess.test`); acknowledge hidden without write.
- **WP4 Signature surfacing** (after WP1): `utils/meshcoreNodeFieldMerge.ts`; `components/MeshCore/hooks/useMeshCore.ts`
  (type); `MeshCoreNodesView.tsx`; `MeshCoreDirectMessagesView.tsx`; `MeshCoreContactDetailPanel.tsx`;
  `MeshCoreMap.tsx`; `utils/nodeAdvancedFilter.ts`; `NodesTab.tsx` (shared `isSecurityFlagged`);
  `utils/meshcoreNodeRows.ts`. Confirm the nodes endpoint returns the column, and whether Companion firmware drops
  forged adverts before labelling Companion contacts "verified" (else show "Not checked"). Tests: merge helper replaces
  both copies with no behaviour change; panel + popup tri-state; MeshCore "flagged only" / "hide flagged"; Meshtastic
  filter results unchanged.
- **WP5 Docs + epic + P7b issue**: `docs/features/security.md`, `docs/features/meshcore.md`, epic log.

## Browser check
Throwaway volume, seeded MeshCore source: two repeaters sharing a 1-byte prefix, one node
`advertSignatureVerified=false`, two keys sharing a name, three contacts lastHeard > 15 d, a tracker change record.
API: findings returns all four blocks; dead-nodes `mc:` rows with lastHeard in seconds; bulk delete on a disconnected
source → DB-only, rows gone; Meshtastic `/dead-nodes` unchanged. Browser: MeshCore nav shows Security only with
`security:read`; Meshtastic sections absent; collisions / signature / name-reuse / own-key cards render; acknowledge
clears; panel + popup signature row; "flagged only" narrows; no console errors in light + dark; Meshtastic Security tab
visual regression pass.
