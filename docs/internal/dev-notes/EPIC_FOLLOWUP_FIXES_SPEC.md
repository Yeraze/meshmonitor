# Implementation spec — Per-Source Node Display epic follow-ups

**Issues closed:** #4442, #4437, #4438, and the WP7 gap deferred from Phase 6 (#4416).
**Branch:** `feature/epic-followup-fixes` (worktree `/home/yeraze/Development/meshmonitor-epic-followups`, based on `origin/main` @ `70af3101`).
**Shape:** ONE pull request, four clearly separable sections (A/B/C/D), five work packages.
**Predecessor:** `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` (deviations log, all six phases)
and `PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md` §WP7.

---

## 1. Reuse inventory — READ THIS BEFORE WRITING ANY NEW CODE

Every item below already exists on `main`. Nothing in this spec authorizes re-deriving any of it.

### 1.1 Apprise URL resolution (section A)

| Thing | Location | Notes |
|---|---|---|
| The canonical resolution chain | `src/server/services/appriseNotificationService.ts:63-88`, `private async resolveAppriseConfig(sourceId)` | Documented precedence: per-source `apprise_url` → global `appriseApiServerUrl` → `process.env.APPRISE_URL` → `http://localhost:8000`. **Currently `private`** — extracting it is WP1's job. |
| A second, partial copy of the chain | `src/server/routes/settingsRoutes.ts:1134-1137` (`POST /test-apprise`) | Global-only variant (no sourceId in scope). Correct today; must become a resolver call. |
| A third, divergent copy | `src/server/routes/notificationRoutes.ts:379-380` (`GET /apprise/status`) | See §2.3 — this is a real third inconsistency. |
| URL trailing-slash normalization + http(s) validation | `src/server/routes/settingsRoutes.ts:1100-1124`, `validateAppriseProbeUrl()` | Strips trailing `/` then appends `/health`. The same slash-stripping logic is needed for `/notify`. |
| The bug site | `src/server/services/securityDigestService.ts:414` | `await fetch('http://localhost:8000/notify', …)` — hardcoded. |

### 1.2 Settings plumbing (section B)

| Thing | Location | Notes |
|---|---|---|
| `VALID_SETTINGS_KEYS` | `src/server/constants/settings.ts:9` | The POST allowlist. |
| `PER_SOURCE_SETTINGS_KEYS` | `src/server/constants/settings.ts:340`; `externalUrl` is at `:489` | Keys the server reads via `getSettingForSource`. |
| `PER_SOURCE_KEYS_NOT_POSTABLE` | `src/server/constants/settings.ts:~600` | `externalUrl` is its last entry, under a `── KNOWN ORPHAN ──` banner explicitly saying the listing does not legitimize it and pointing at #4437. |
| `GLOBAL_ONLY_SETTINGS_KEYS` | `src/server/constants/settings.ts` | Deny-list. **Do not add `externalUrl` here** — see §3.2. |
| `SECRET_SETTINGS_KEYS` | `src/server/constants/settings.ts` | `externalUrl` is **not** secret; do not add. |
| The exact-equality allowlist guard | `src/server/constants/settings.allowlist.test.ts:~30` | `expect(missing).toEqual([...PER_SOURCE_KEYS_NOT_POSTABLE].sort())`. This test is the enforcement mechanism for §3.2 — it fails automatically if WP2 adds the key without removing the exemption. |
| The nearest-neighbour URL setting, end to end | `appriseApiServerUrl` | `settings.ts` (allowlist), `settingsRoutes.ts:760-775` (trim + `new URL()` + http(s) check + empty-clears), `SettingsTab.tsx` (draft field, baseline, fetch-effect `updateField` at `:573`, `handleSave` literal, JSX at `:2325-2340`), `server.settings-persistence.test.ts:482` (`SERVER_ONLY_SETTINGS`). **Copy this key's shape at every one of its sites.** |
| The `SettingsDraft` reducer | `src/components/SettingsTab.tsx:67-160`, `:366` initializer, `:425` `updateField`, `:620` `baseline` memo | No dependency arrays to touch (CLAUDE.md). |
| The hand-maintained POST literal | `src/components/SettingsTab.tsx:889` `const settings = {…}` | Source-extracted by `server.settings-persistence.test.ts` **and** statically executed by the scoped-POST partition guard at `:952-956`. Must stay literal source text. |
| `detailsLink()` — already omits the line when empty | `src/server/services/securityDigestService.ts:64-67` | Phase 5 WP4. **No change needed in section B.** An unset `externalUrl` must keep behaving exactly as today. |

### 1.3 MeshCore local-node convention (section C)

| Thing | Location |
|---|---|
| `MeshCoreContact` interface | `src/utils/meshcoreHelpers.ts:6-23` |
| Websocket wire type | `src/hooks/useWebSocket.ts:79-91` `MeshCoreContactPayload`, `:111-114` `MeshCoreContactUpdateEvent` |
| Server writer 1 | `src/server/routes/meshcoreContactsRoutes.ts:104-116` — `GET /contacts`, `allContacts.unshift({ advName: \`${localNode.name} (local)\`, … })` |
| Server writer 2 | `src/server/routes/meshcoreDeviceRoutes.ts:176-190` — `GET /snapshot`, comment says *"Mirror the contacts-with-localNode logic from GET /contacts"* (i.e. it is already an acknowledged copy-paste) |
| Server emit of contact updates | `src/server/services/dataEventEmitter.ts:31, 393` — `meshcore:contact:updated` |
| Read site 1 | `src/utils/meshcoreHelpers.ts:36-44` — map offset (`LOCAL_NODE_OFFSET`) |
| Read site 2 | `src/components/MeshCore/MeshCoreNodesView.tsx:293-294` — `isAgeExempt` (reads `r.name` on a `MergedRow`, **not** a contact) |
| Read site 3 | `src/components/MeshCore/MeshCoreNodesView.tsx:323-326` — `visibleContacts` |
| Read site 4 | `src/components/MeshCore/MeshCoreMessageRouteModal.tsx:108-111` — `localContact` |
| Read site 5 | `src/components/MeshCore/MeshCoreMap.tsx:329-333` — map centering |
| Read site 6 | `src/components/MeshCore/MeshCoreMap.tsx:346-349` — pathLen link filter |
| Client contact merge | `src/components/MeshCore/hooks/useMeshCore.ts:406` `contactsRef`, `:488-491` snapshot load, `:~560-575` `onContactUpdated`, `:812-820` `refreshContacts`, `:849`/`:1207` optimistic path updates |

All six read sites already carry a Phase 4/5 `NOTE:` comment naming #4438. Those comments are deleted by this work, not amended.

### 1.4 Settings-grant fan-out (section D)

| Thing | Location | Notes |
|---|---|---|
| **The shared pure module WP7 was designed against** | `src/server/services/settingsGrantFanout.ts` | Exports `RawGrantRow`, `EffectiveGrant`, `computeEffectiveGrants(rows, now)`, `pairKey(userId, sourceId)`, `computeFanOutInserts(effective, sourceIds, existingPairs)`. Pure, total, no I/O. **This already exists. WP5 writes zero new computation.** |
| Its unit tests | `src/server/services/settingsGrantFanout.test.ts` | Header literally says *"shared by migration 132 and WP7"*. |
| The migration that left the gap | `src/server/migrations/132_fan_out_settings_permissions.ts` | Its header comment (`:38-41`) names WP7 and `sourceRoutes.ts` as the closer. |
| The full WP7 design | `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC.md:908-960` | Method name, call site, three test cases, acceptance, negative control — all pre-agreed. §6 below is a restatement plus three additions. |
| Existing auth-repo permission methods | `src/db/repositories/auth.ts:320` `getPermissionsForUser`, `:334` `createPermission`, `:360`/`:377` delete-by-scope | The new method sits beside these. Drizzle only — the raw-SQL ban applies. |
| Source creation | `src/server/routes/sourceRoutes.ts:407` `POST /`, `createSource` at `:~430` | |
| Route test harness | `src/server/test-helpers/routeTestApp.ts`; canonical template `src/server/routes/sourceRoutes.permissions.test.ts` | Mandatory for WP5's new route test (CLAUDE.md). |

---

## 2. Section A — #4442: the security digest ignores `appriseApiServerUrl`

**Do this section first. It is the only live delivery bug in the batch.**

### 2.1 The defect

`securityDigestService.ts:414` posts to a hardcoded `http://localhost:8000/notify`. An operator
who moved their Apprise API server and set `appriseApiServerUrl` (or `APPRISE_URL`) gets every
other notification delivered and every security digest silently dropped — the digest logs a
connection error the operator will never correlate with the setting they changed.

### 2.2 Fix — extract the existing resolver, do not re-derive it

Add to `src/server/services/appriseNotificationService.ts` (module scope, exported):

```ts
/** Minimal settings surface the resolver needs. Deliberately structural, NOT the
 *  DatabaseService singleton: securityDigestService holds an INJECTED
 *  databaseService (`this.databaseService`), and importing the singleton here
 *  would bypass it and make the per-source tests assert nothing. */
export interface AppriseSettingsReader {
  getSetting(key: string): Promise<string | null | undefined>;
  getSettingForSource(sourceId: string, key: string): Promise<string | null | undefined>;
}

/** Resolve the Apprise **API server** base URL. Precedence unchanged from
 *  resolveAppriseConfig's documented chain (#3012):
 *    1. per-source `apprise_url`   (skipped when sourceId is null)
 *    2. global   `appriseApiServerUrl`
 *    3. process.env.APPRISE_URL
 *    4. http://localhost:8000      (bundled in the Docker image)
 *  Whitespace-only values are treated as unset. */
export async function resolveAppriseServerUrl(
  settings: AppriseSettingsReader,
  sourceId: string | null,
): Promise<string>;

/** Trailing-slash-safe endpoint builder. `http://h:8000/` must not yield `//notify`. */
export function appriseNotifyEndpoint(baseUrl: string): string;
```

Then:

1. `resolveAppriseConfig` (`appriseNotificationService.ts:74`) calls `resolveAppriseServerUrl(databaseService.settings, sourceId)` for the `url` half. Its `enabled` half is untouched.
2. `securityDigestService.sendDigestForSource` builds its endpoint as
   `appriseNotifyEndpoint(await resolveAppriseServerUrl(this.databaseService.settings, sourceId))`.
3. `settingsRoutes.ts:1130-1138` replaces its inline chain with `resolveAppriseServerUrl(databaseService.settings, null)`. Behaviour is identical; this removes copy #2.
4. `notificationRoutes.ts:380` — see §2.3.
5. Any `${config.url}/notify` string concatenation inside `appriseNotificationService` goes through `appriseNotifyEndpoint`.

**Terminology trap the implementer must not fall into:** `securityDigestAppriseUrl`
(per-source, `SECRET_SETTINGS_KEYS`) is the *destination* — a `discord://…` / `mailto://…`
Apprise notification URL, sent in the JSON body's `urls: [ … ]` array. `apprise_url` /
`appriseApiServerUrl` are the *Apprise API server* the request is POSTed **to**. They are not
interchangeable and the digest needs both. Do not "simplify" one into the other.

### 2.3 Finding on `notificationRoutes.ts:380`

```ts
url: await databaseService.settings.getSetting('apprise_url') || 'http://localhost:8000',
```

**Verdict: a third inconsistency, not intentional — but of a different and milder kind than #4442.**

Evidence:
- `apprise_url` is read **only** per-source everywhere else in the repo — the sole production
  reader is `appriseNotificationService.ts:76`, via `getSettingForSource`. There is **no global
  writer for `apprise_url` anywhere** (the only `setSetting` in `notificationRoutes.ts` is
  `:729`, for `apprise_enabled`). So this global `getSetting('apprise_url')` is a read of a key
  that is never populated at that scope: it returns null essentially always, and the endpoint
  reports `http://localhost:8000` unconditionally.
- It therefore also skips `appriseApiServerUrl` and `APPRISE_URL` entirely — the same omission
  as #4442.
- **But it dispatches nothing.** `GET /apprise/status` is a diagnostic readout. The consequence
  is an operator being told their Apprise server is at `localhost:8000` while notifications
  actually go to their configured host — misleading, not broken.

**Fix it in WP1** (one line, same resolver, `sourceId = null`), because leaving a fourth copy of
a chain we are consolidating is how #4442 happened.

**Explicitly do NOT fix** the sibling `apprise_enabled` read on `:379`. It has the same
global-vs-per-source shape, but the endpoint is unscoped and there is no sourceId to consult;
deciding what "enabled" means across N sources is a product question, not a cleanup. Leave it,
and leave a one-line comment saying so with an issue reference if the implementer files one.

### 2.4 Acceptance (WP1)

- The digest POSTs to the resolved endpoint, proven by a test that sets `appriseApiServerUrl`
  to a non-localhost host and asserts the `fetch` URL.
- The full chain has exactly **one** implementation. `grep -rn "localhost:8000" src/server --include=*.ts`
  returns hits only in `appriseNotificationService.ts` (the resolver's own last-resort literal)
  and test files.
- `GET /apprise/status` reports what a sender would actually use.

---

## 3. Section B — #4437: `externalUrl` gets a writer

**User decision, already made:** add it as a new admin setting. Options 2 (derive from a request
header) and 3 (drop the link) are closed.

### 3.1 Scope call: **GLOBAL writer, per-source read left intact**

`externalUrl` is the absolute origin at which **this MeshMonitor install** is reachable
(`https://mesh.example.com`). Justification:

1. One process, one origin, N sources. There is no per-source deployment — a per-source value
   would let an operator configure N different origins that all resolve to the same page.
2. The link target `/security` is a single global app route. `detailsLink()` emits
   `${baseUrl}/security` with no source identifier in it.
3. `env.baseUrl` (`server.ts`) is the `BASE_URL` **path prefix** (e.g. `/meshmonitor`), not an
   origin, so it cannot supply this and must not be silently concatenated (see §3.3).

**Mechanism — and this is the load-bearing detail:** the existing reader is
`getSettingForSource(sourceId, 'externalUrl')`, and `getSettingForSource` **falls back to the
global key when no per-source row exists** (confirmed by `securityDigestService.ts:333`'s own
comment: *"Apprise URL is per-source (falls back to global via getSettingForSource)"*).
So a **global write is already picked up by every source's digest with zero change to the read**,
and a future per-source override remains possible for free.

> **WP2's first task, before writing any code:** verify that fallback empirically (a two-line
> repository test or a `settings.getSettingForSource` read of a global-only key). If it does
> **not** fall back, this design is wrong and the read at `securityDigestService.ts:345` must
> change to `getSetting('externalUrl')` instead — report immediately rather than proceeding.
> Note that `securityDigestService.ts` is owned by WP1, so that change would need an ownership
> hand-off through the orchestrator.

### 3.2 Constant-file changes — exactly three, and the fourth is a trap

1. **ADD** `'externalUrl'` to `VALID_SETTINGS_KEYS`.
2. **REMOVE** `'externalUrl'` from `PER_SOURCE_KEYS_NOT_POSTABLE`, and delete the whole
   `── KNOWN ORPHAN ──` comment block above it. The entry is not merely stale once a writer
   exists — the surrounding comment says *"Do NOT fix it by adding it to `VALID_SETTINGS_KEYS`
   — that creates a new user-writable setting, which is a feature, not a cleanup."* That warning
   has now been discharged by an explicit user decision, and the comment must say so is gone,
   not linger contradicting the code.
3. **KEEP** `'externalUrl'` in `PER_SOURCE_SETTINGS_KEYS` — the server genuinely reads it through
   `getSettingForSource`, which is exactly what that list documents.
4. **DO NOT** add it to `GLOBAL_ONLY_SETTINGS_KEYS`. That deny-list refuses per-source writes,
   and its own comment names the failure mode: *"an over-eager entry silently stops a user
   setting from persisting"*, and `settings.allowlist.test.ts`'s disjointness assertion would
   fail on a key that is in both `GLOBAL_ONLY_SETTINGS_KEYS` and `PER_SOURCE_SETTINGS_KEYS`.

After 1+2, `settings.allowlist.test.ts`'s exact-equality assertion passes with no edit: the
computed gap shrinks by one on the same side as the exemption set. **If that test fails, one of
the two edits was not made** — it is the guard, not a chore.

### 3.3 Server validation (`settingsRoutes.ts`) — mirror `appriseApiServerUrl:760-775`

```
if ('externalUrl' in filteredSettings) {
  raw = trim
  if raw.length > 0:
     new URL(raw)              → 400 'externalUrl must be a valid http(s) URL'
     protocol http:|https:     → 400 'externalUrl must use http:// or https://'
     strip ALL trailing slashes          ← REQUIRED, see below
  filteredSettings.externalUrl = raw     (empty string clears → link omitted again)
}
```

**Trailing-slash stripping is not cosmetic.** `detailsLink()` emits `${baseUrl}/security`
verbatim. A user typing `https://mesh.example.com/` — the form every browser address bar
produces — would ship `https://mesh.example.com//security` in every digest. Reuse the
slash-stripping loop from `validateAppriseProbeUrl` (`settingsRoutes.ts:1118-1122`) rather than
writing a regex.

**Do not auto-prepend or auto-append `env.baseUrl`.** An operator running under
`BASE_URL=/meshmonitor` must include the prefix themselves; auto-appending would double it for
everyone who already did. Say so in the field's description text.

### 3.4 Frontend (`SettingsTab.tsx`) — the completeness rule

Do not reason about which sites need touching. **Grep `appriseApiServerUrl` in
`src/components/SettingsTab.tsx` and add an `externalUrl` sibling at every hit.** It is a
global, admin-only, `type="url"`, empty-allowed string setting — structurally identical.
Expected hits: the `SettingsDraft` field, the `useReducer` initializer default (`''`), the
`baseline` memo, the server-fetch effect's `updateField(...)`, the `handleSave` `const settings = {…}`
literal, and the JSX input. Per CLAUDE.md, **no dependency array is touched.**

Placement: a `setting-item` inside the existing admin-gated **Apprise API Server** section
(`settings-apprise-server`), or a sibling section — both are notification-adjacent and
`isAdmin`-gated. Copy strings via `t('settings.external_url_label', 'External URL')` /
`t('settings.external_url_description', …)` with English fallbacks, matching the
`apprise_server_url_*` pattern. Add the keys to the locale resources that already carry
`settings.apprise_server_url_label` (find them by grepping that key).

Suggested copy — the description must state both caveats:
> *External URL — the absolute address this MeshMonitor is reachable at, used for links in
> notifications (e.g. the "View details" link in security digests). Include your base path if
> you run under one, e.g. `https://mesh.example.com/meshmonitor`. Leave empty to omit the link.*

### 3.5 The `SERVER_ONLY_SETTINGS` trap

`server.settings-persistence.test.ts` asserts that every key sent by `handleSave` is either
loaded back by `SettingsContext` or listed in `SERVER_ONLY_SETTINGS` (the `keysNotLoaded`
assertion, ~`:462-475`). `externalUrl` is seeded from the server-fetch effect, not from
`SettingsContext` — exactly like `appriseApiServerUrl`, which is in `SERVER_ONLY_SETTINGS` at
`:482`. **WP2 must add `externalUrl` there or this test fails.** That is the guard working; do
not weaken the assertion.

The scoped-POST partition tests (`:~452+`) pass unchanged: `externalUrl` is not in
`NODE_DISPLAY_SETTING_KEYS`, so the extracted partition routes it to `globalBody`, which is what
test (1) requires (`nodeDisplayBody` keys must equal the ten exactly) and test (2) permits.
**Both must be re-run and shown green — they statically execute the literal WP2 edits.**

### 3.6 Acceptance (WP2)

- Round trip: `POST /api/settings {externalUrl:'https://mesh.example.com/'}` → 200, stored as
  `https://mesh.example.com`; a subsequent digest emits `https://mesh.example.com/security`.
- Unset (`''`) behaves **byte-identically to today**: `detailsLink` returns null, no line.
- 400 on `ftp://…`, on `not a url`, and on a non-string.
- `settings.allowlist.test.ts`, `server.settings-persistence.test.ts` green with no assertion
  weakened.

---

## 4. Section C — #4438: replace the `(local)` string convention with an explicit flag

The largest section. Split into WP3 (server + shared type) and WP4 (frontend readers).

### 4.1 The single most likely way this goes wrong

**The `(local)` suffix in `advName` is user-visible display text, not just a marker.**
`MeshCoreNodesView.test.tsx:317` asserts the rendered row name is literally `'MyNode (local)'`.
Deleting the suffix while adding the flag is a silent UX change nobody asked for.

> **RULE: the string stays as a label; the flag becomes the predicate.**
> Servers keep writing `advName: \`${localNode.name} (local)\``. Readers stop matching on it.

### 4.2 Producer enumeration — the completeness proof

An `isLocal` flag is only correct if it is set on **every** path that produces a contact a reader
sees. Miss one and the operator's own node vanishes from their node list — strictly worse than
the bug being fixed. Enumerated exhaustively:

| # | Producer | File | Local row today? | Action |
|---|---|---|---|---|
| P1 | `GET /api/sources/:id/meshcore/contacts` | `meshcoreContactsRoutes.ts:104-116` | yes (`unshift`) | call shared builder |
| P2 | `GET /api/sources/:id/meshcore/snapshot` | `meshcoreDeviceRoutes.ts:176-190` | yes (acknowledged copy of P1) | call shared builder |
| P3 | `POST /api/sources/:id/meshcore/contacts/refresh` | `meshcoreContactsRoutes.ts` | **UNVERIFIED — assume no** | see below |
| P4 | Websocket `meshcore:contact:updated` | `dataEventEmitter.ts:393` → `useMeshCore.onContactUpdated` | n/a — device contacts only, never the synthetic local row | client re-stamp, §4.4 |
| P5 | Client optimistic path updates | `useMeshCore.ts:849`, `:1207` | spread-preserving (`{...c, …}`) | no change, but pinned by a test |
| P6 | `MeshCorePathfindingFilterSection` / `MeshCoreTimerTriggersSection` | own `MeshCoreContactRow` type, `/contacts` | no local logic at all | out of scope; note only |

**P3 is a live pre-existing hazard and WP3's first investigation.** `useMeshCore.refreshContacts`
(`:812-820`) does `setContacts(data.data)` — a wholesale replacement. If `POST /contacts/refresh`
does not include the synthetic local row, then **today**, clicking "Refresh Contacts" already
drops the local node from the list until the next snapshot. Verify. If confirmed:
- fix it in WP3 by routing P3 through the same builder (it is the same three lines), and
- say so in the PR body — it is a second user-visible bug found by the enumeration, which is the
  entire argument for doing the enumeration.

### 4.3 Chokepoint + type design

**Chokepoint (WP3).** One exported builder, e.g.
`src/server/routes/meshcoreLocalContactRow.ts`:

```ts
export function buildLocalContactRow(localNode: MeshCoreLocalNode): MeshCoreContactResponse & { isLocal: true };
```

It owns the `(local)` suffix, the field set, and `lastSeen: Date.now()`. P1, P2 (and P3 if
applicable) call it. "Every producer sets the flag" then reduces to "there is exactly one
construction site", which a grep-based test can pin (T-C1 below).

**Types.**
- Server response type (new or narrowed, in the builder module): `isLocal: boolean` **required**.
  Omitting it on the wire is a compile error. This is the only place a compile-time guarantee
  buys anything.
- Client `MeshCoreContact` (`src/utils/meshcoreHelpers.ts:6`): `isLocal?: boolean` **optional**.
  Rationale: making it required breaks ~15 hand-built fixtures (`meshcorePath.test.ts:14,26`,
  `MeshCoreContactDetailPanel.test.tsx:32,377`, …) and `useMeshCore.ts:1212`'s `{ publicKey }`
  partial — churn with no safety, because the wire type already guarantees it. `undefined` reads
  as falsy = "not local", the safe default at five of six read sites.
  **The exception is read site 2 (`isAgeExempt`), where falsy means "eligible for filtering out".**
  That asymmetry is precisely why §4.4's client-side re-stamp exists.
- `MeshCoreContactPayload` (`useWebSocket.ts:79`): add `isLocal?: boolean` for shape parity;
  the server never sets it there (P4).

### 4.4 Client-side re-stamp — belt and braces, deliberately

`useMeshCore` merges snapshot contacts and push-event contacts into one `contactsRef` map keyed
by `publicKey` (`:406`, `:488-491`, `onContactUpdated`). A push event for the local node's own
public key **overwrites** the snapshot row and drops the flag — the local node disappears from
the list minutes after page load, with no user action. (This failure mode exists today with the
string convention too, and is unpinned by any test.)

Fix: when any contact enters `contactsRef`, stamp
`isLocal: c.publicKey === localNodeRef.current?.publicKey || c.isLocal === true`.
`localNodeRef` is already maintained by the hook (`:803`). The server flag remains the wire truth
for any other API consumer; the hook's re-stamp makes the client independent of it surviving a
merge. Comment both, saying why there are two.

### 4.5 Read-site conversion — all six, no fallback

| Site | From | To |
|---|---|---|
| `meshcoreHelpers.ts:39` | `c.advName?.includes('(local)')` | `c.isLocal === true` |
| `MeshCoreNodesView.tsx:294` | `r.name.includes('(local)')` | `r.isLocal === true` |
| `MeshCoreNodesView.tsx:324` | `c.advName?.includes('(local)')` | `c.isLocal === true` |
| `MeshCoreMessageRouteModal.tsx:111` | `c.advName?.includes('(local)')` | `c.isLocal === true` |
| `MeshCoreMap.tsx:332` | `c.advName?.includes('(local)')` | `c.isLocal === true` |
| `MeshCoreMap.tsx:349` | `!c.advName?.includes('(local)')` | `c.isLocal !== true` |

**Site 2 needs a type change the issue did not list.** `isAgeExempt` operates on a `MergedRow`
produced by `mergeNodesAndContacts` (`MeshCoreNodesView.tsx:65`), reading `r.name` — not a
contact. `MergedRow` must carry `isLocal` and the merge function must propagate it from the
contact. Count this as the 7th production file (or 7th type) — Phase 5's estimate of 7 production
files did not include it.

Delete all six `NOTE: … #4438` comments as the sites convert.

### 4.6 Fallback decision: **remove the string match outright. No transitional `||`.**

Justification, in order of weight:

1. **A `||` fallback preserves the exact bug the issue exists to fix.** With
   `c.isLocal || c.advName?.includes('(local)')`, a user who names their device `Foo (local)` is
   still silently exempted from age filtering and still hijacks the map centre. The PR would
   close nothing while claiming to close #4438.
2. **There is no compatibility surface to bridge.** The suffix is synthesized per-request by the
   same server build that serves the frontend bundle — it is never persisted with a marker, never
   cached across versions, never produced by firmware. Client and server ship in one image
   (Docker/LXC/desktop all bundle both). There is no "old server, new client" window to protect.
3. **Keeping it keeps the ambiguity documented in six `NOTE:` comments**, which is the actual
   cost the epic flagged.

The one thing that *is* retained is the `(local)` **suffix on `advName`** (§4.1) — display text,
not a predicate. Do not conflate "remove the string match" with "remove the string".

### 4.7 Completeness tests — the ones that fail if a producer is missed

- **T-C1 (structural, decisive, cheap):** assert that `(local)` appears in `src/server/**`
  in **exactly one** module — the shared builder. A future third route that hand-rolls a local
  row fails this immediately. Implement as a source-read assertion (the repo already uses
  source-extraction tests: `server.settings-persistence.test.ts`, `050_*.test.ts:185`).
- **T-C2 (behavioural, table-driven over an explicit endpoint list):** for each contact-returning
  endpoint (`GET /contacts`, `GET /snapshot`, and `POST /contacts/refresh` if P3 applies), with a
  manager stub whose `getLocalNode()` returns a positioned node, assert the response contains
  **exactly one** row with `isLocal === true` and that its `publicKey` matches the local node.
  Table-driven so adding an endpoint is a one-line addition an author cannot skip silently.
- **T-C3 (the push-event overwrite, §4.4):** load a snapshot containing the local row, deliver a
  `meshcore:contact:updated` push for that same `publicKey` **without** `isLocal`, assert the
  merged contact still reports `isLocal === true`. This is the regression nothing currently pins.
- **T-C4 (the negative control, at every converted read site that has a test):** a contact named
  `'Imposter (local)'` with `isLocal: false` and a stale `lastSeen` must be filtered out /
  must not become the map centre. **This is the assertion that fails against unfixed code**, and
  every read-site test must have one.

---

## 5. Section D — WP7: a source created after migration 132 gets no `settings` grants

### 5.1 The gap

Migration 132 fans out `settings` grants across **the sources that existed when it ran**, then
deletes the now-inert `sourceId IS NULL` rows. It explicitly does **not** delete when there are
zero sources (`132_…ts:38-41` and PHASE6 §3.6). Either way, a source created *afterwards* gets no
`settings` rows, so a non-admin has no settings access on it until an admin grants it manually,
with no error message anywhere in the product explaining why.

### 5.2 Implementation — restated from PHASE6 §WP7, plus three additions

1. `src/db/repositories/auth.ts` — new
   `async fanOutGlobalGrantsToSource(resource: string, sourceId: string): Promise<number>`.
   Drizzle query builders **only** (`sourceRoutes.ts` and repositories are not exempt from the
   raw-SQL ban). Reads the user's `permissions` rows for `resource`, runs them through
   `computeEffectiveGrants` / `computeFanOutInserts` / `pairKey` from
   `src/server/services/settingsGrantFanout.ts` (§1.4 — **do not reimplement**), inserts the new
   rows, deletes the `sourceId IS NULL` ones, returns the count.
2. `src/server/routes/sourceRoutes.ts` — after `createSource` succeeds, call
   `fanOutGlobalGrantsToSource('settings', source.id)`. The `'settings'` literal lives **at the
   call site**, per the shared module's contract (neither caller may import a mutable resource
   list). Failure is logged, **never fatal** to the create.
3. New `src/server/routes/sourceRoutes.settingsGrantFanout.test.ts` using
   `createRouteTestApp()`:
   - surviving NULL settings grant + zero sources → create a source → the user can write settings
     on it, and the NULL row is gone;
   - no NULL settings rows → create a source → **zero** permission rows created (proves the
     no-op in the overwhelmingly common path);
   - the fan-out throwing does not fail source creation.

**Additions this spec makes to PHASE6's design:**

4. **Ordering.** Place the fan-out **immediately after `createSource` and before** the
   `MeshtasticManager` / `ensureMeshCoreManagerStarted` block (`sourceRoutes.ts:~440+`). A slow or
   failing manager start must not be able to skip the grant reconciliation. Assert the ordering
   in the test, not just the effect.
5. **Idempotency / concurrency.** Two sources created concurrently could both read the NULL rows.
   `computeFanOutInserts` already skips existing `(userId, sourceId)` pairs, the insert is
   conflict-tolerant, and the delete is last and idempotent — so the worst case is a redundant
   no-op. Add a test that calls the create path twice and asserts the second is a no-op.
6. **Negative control (required).** Stub the fan-out call out of the create handler; the first
   test must fail. Paste the observed failure in the WP report.

### 5.3 Scope call on the new-user global `settings` seed: **OUT OF SCOPE — file a separate issue**

Phase 6 validation observed that new-user creation still seeds a global `settings` row, inert
under the sourcey branch. Investigation for this spec found the problem is **materially larger
than that note implies**:

```
src/server/auth/localAuth.ts:84       defaultResources = ['dashboard','nodes','messages','settings','info','traceroute']
src/server/auth/authMiddleware.ts:69  (identical hardcoded list)
src/server/auth/oidcAuth.ts:330       (identical hardcoded list)
src/server/auth/oidcAuth.ts:309       (a fourth, longer list, incl. 'configuration')
```

**Four** of those six resources — `nodes`, `messages`, `settings`, `traceroute` — are sourcey.
So every newly created user (local **and** OIDC just-in-time provisioned) receives global rows
that the sourcey branch never reads, for four resources, in three-to-four duplicated hardcoded
lists. `settings` is merely the newest member; `nodes`/`messages`/`traceroute` have been in this
state since before #4416.

Reasons to keep it out of this PR:

1. **It is not bookkeeping, it is an authorization default.** Fixing it requires deciding *which*
   sources a brand-new user should be granted on — all existing? the primary only? none, with an
   admin step? That is a product decision of the same class as #4437's, and it should be asked,
   not assumed.
2. **It spans the OIDC JIT-provisioning path**, which nothing in this PR otherwise touches and
   which none of the five packages would give test coverage.
3. **It is not a regression this batch introduced** and it is currently harmless — the rows are
   inert, not wrong-way-permissive.
4. Folding it in would make section D the largest of the four and drag an auth-defaults debate
   into a follow-up-fixes PR whose value is that it is four small, separable things.

**Required action:** file the issue **before this PR opens**, titled for the symptom
(*"New users get inert global grants for sourcey resources (nodes, messages, settings,
traceroute) — no access until an admin grants per source"*), citing the four file:line sites and
the four-resource count. WP5 adds a one-line comment at the `sourceRoutes` call site referencing
it, so the next reader sees the two halves of the same family together.

---

## 6. Test audit

### 6.1 The rule, stated once and binding on every package

> **Every new test must be demonstrated failing against unfixed code before it counts.**
> Write the test, run it against the pre-fix tree (or revert the fix, or stub the new call out),
> observe the failure, **paste the observed failure text into the work-package report**, then
> apply the fix. A test that has never been red is not evidence. This rule caught two bad tests
> at design time in Phase 5 and produced a crash-strength control in Phase 6.

A corollary the epic learned the hard way: **a test that mocks the thing under test cannot fail
when the thing under test regresses.** Where an existing test re-implements the logic it claims to
verify, rewriting it is mandatory, not optional.

### 6.2 Classification

| Test | Verdict | Why | Owner |
|---|---|---|---|
| `securityDigestService.test.ts` — 8 `formatDigest*` cases | **keep** | Pure formatting; unaffected. | — |
| `securityDigestService.test.ts:61` "no externalUrl → no dangling link" | **keep** | Still the correct requirement for an unset value after WP2. | — |
| `securityDigestService.test.ts:79` "externalUrl configured → absolute link" | **keep** | ⚠️ *Today it passes on a value no production write path can produce.* Becomes non-fictional the moment WP2 lands. Comment it to that effect. | WP2 (comment only) |
| `securityDigestService.perSource.test.ts:73,102` | **rewrite** | ⚠️ **Would pass with #4442 present** — asserts per-source dispatch and never asserts the fetch URL. Also carries Phase 5's now-obsolete *"no production write path"* annotation on its `externalUrl` fixture. | WP2 (annotation), WP1's new URL assertions go in a **new file** to avoid co-ownership |
| *(absence)* no test anywhere asserts the digest's delivery endpoint | **new** | This gap is exactly why #4442 shipped. | WP1 |
| `notificationRoutes.test.ts:231` "GET /apprise/status returns availability and settings" | **rewrite** | ⚠️ **Encodes the §2.3 inconsistency as the expectation.** Two ordered `mockResolvedValueOnce`s pin the buggy implementation's call sequence, and it asserts a `url` sourced from a key with no global writer. Cannot fail when the resolution is wrong. | WP1 |
| `notificationRoutes.test.ts:310` `setSetting('apprise_enabled')` | **keep** | Untouched path. | — |
| `appriseNotificationService.test.ts:52-77` | **rewrite (or delete)** | ⚠️ **Re-implements the resolver inline** (`const url = databaseService.getSetting('apprise_url') \|\| defaultUrl`) and asserts its own copy against a scratch SQLite db. Structurally incapable of failing when `resolveAppriseConfig` changes. Replace with tests that call the exported `resolveAppriseServerUrl`. | WP1 |
| `appriseNotificationService.broadcastToPreferenceUsers.test.ts:77-78` | **keep, verify** | Mocks `apprise_url`/`apprise_enabled`; confirm the mock still matches the refactored call shape. | WP1 |
| `appriseNotificationService.notifyDirect.test.ts:66` | **keep, verify** | Same. | WP1 |
| `settings.allowlist.test.ts` (5 cases) | **keep — unchanged** | ✅ **The model.** Its exact-equality assertion is the mechanism that forces §3.2's paired edit. Do not touch. | WP2 (read-only) |
| `server.settings-persistence.test.ts` `keysNotLoaded` | **keep** | Will fail until `externalUrl` is added to `SERVER_ONLY_SETTINGS`. The guard working. | WP2 |
| `server.settings-persistence.test.ts` scoped-POST partition (1)(2) | **keep — unchanged** | Statically executes the literal WP2 edits; must be re-run and shown green. | WP2 |
| `MeshCoreNodesView.test.tsx:312` "bypasses the cutoff for the local node" | **rewrite** | ⚠️ **Would pass with #4438 present.** Fixture is `advName: 'MyNode (local)'` and the assertion is on the rendered string — it asserts the naming convention, not "the local node is exempt". A stranger named `X (local)` passes it too. | WP4 |
| `MeshCoreMessageRouteModal.test.tsx:172-188` "prepends sender, appends local node" | **rewrite** | ⚠️ Same defect, fixture `advName: 'Base (local)'` at `:176`. | WP4 |
| `meshcoreHelpers.test.ts` | **new** | ⚠️ *Has no `mapContactsToNodes` test at all* — every case is hashtag-channel. The `LOCAL_NODE_OFFSET` behaviour is completely unpinned today. Add: offset applied when `isLocal`; **not** applied for a non-local contact named `'X (local)'`. | WP3 |
| `meshcorePath.test.ts:14,26` and `MeshCoreContactDetailPanel.test.tsx:32,377` fixtures | **keep** | No local logic. Cited as the reason `isLocal` stays optional on the client type (§4.3). | — |
| `sourceRoutes.permissions.test.ts` | **keep** | Canonical harness template WP5 follows. | — |
| `sourceRoutes.settingsCleanup.test.ts` | **keep, verify** | Nearest neighbour to WP5's create path — check it does not already assert "no permission rows are created on create", which WP5 would flip. | WP5 |
| `settingsGrantFanout.test.ts` | **keep — unchanged** | Already covers the pure computation WP5 reuses. WP5 adds no computation, therefore no unit tests here. | — |
| `132_fan_out_settings_permissions*.test.ts` | **keep — unchanged** | WP5 must not touch the migration or its tests. | — |

### 6.3 Roll-up: tests that would still pass with their defect present

Seven, matching the epic's running theme:

1. `securityDigestService.perSource.test.ts:73` — no fetch-URL assertion (#4442).
2. `securityDigestService.perSource.test.ts:102` — same.
3. `notificationRoutes.test.ts:231` — encodes the §2.3 inconsistency as the expected value.
4. `appriseNotificationService.test.ts:52-77` — asserts a re-implementation of the resolver.
5. `MeshCoreNodesView.test.tsx:312` — asserts the naming convention, not the requirement (#4438).
6. `MeshCoreMessageRouteModal.test.tsx:172` — same.
7. `securityDigestService.test.ts:79` — passes on a fixture no writer can produce (#4437); correct
   in intent, non-evidential until WP2 lands.

Plus one absence: **nothing anywhere asserts the security digest's delivery endpoint.**

---

## 7. Work packages

### 7.1 Dependency order

```
WP1 (A — apprise resolver)        ─┐
WP2 (B — externalUrl setting)     ─┤
WP3 (C1 — isLocal server + type)  ─┼─ run in parallel
WP5 (D — WP7 grant fan-out)       ─┘
                                    └─→ WP4 (C2 — isLocal frontend readers), needs WP3's type + wire
```

WP1 starts first per the user's instruction that #4442 is the live bug.

### 7.2 File ownership — no file is written by two packages

| File | Owner |
|---|---|
| `src/server/services/appriseNotificationService.ts` | WP1 |
| `src/server/services/securityDigestService.ts` | WP1 |
| `src/server/routes/notificationRoutes.ts` | WP1 |
| `src/server/routes/notificationRoutes.test.ts` | WP1 |
| `src/server/services/appriseNotificationService.test.ts` | WP1 |
| `src/server/services/appriseNotificationService.broadcastToPreferenceUsers.test.ts` | WP1 |
| `src/server/services/appriseNotificationService.notifyDirect.test.ts` | WP1 |
| `src/server/services/securityDigestService.appriseEndpoint.test.ts` *(new)* | WP1 |
| `src/server/constants/settings.ts` | WP2 |
| `src/server/routes/settingsRoutes.ts` | WP2 |
| `src/components/SettingsTab.tsx` | WP2 |
| locale resource files carrying `settings.apprise_server_url_label` | WP2 |
| `src/server/server.settings-persistence.test.ts` | WP2 |
| `src/server/services/securityDigestService.perSource.test.ts` | WP2 *(comment/annotation only)* |
| `src/server/routes/settingsRoutes.externalUrl.test.ts` *(new)* | WP2 |
| `src/server/routes/meshcoreContactsRoutes.ts` | WP3 |
| `src/server/routes/meshcoreDeviceRoutes.ts` | WP3 |
| `src/server/routes/meshcoreLocalContactRow.ts` *(new)* | WP3 |
| `src/server/routes/meshcoreLocalContactRow.test.ts` *(new)* | WP3 |
| `src/server/routes/meshcoreRoutes.test.ts` *(only if edits needed)* | WP3 |
| `src/utils/meshcoreHelpers.ts` | WP3 |
| `src/utils/meshcoreHelpers.test.ts` | WP3 |
| `src/hooks/useWebSocket.ts` | WP3 |
| `src/components/MeshCore/MeshCoreNodesView.tsx` | WP4 |
| `src/components/MeshCore/MeshCoreMap.tsx` | WP4 |
| `src/components/MeshCore/MeshCoreMessageRouteModal.tsx` | WP4 |
| `src/components/MeshCore/hooks/useMeshCore.ts` | WP4 |
| `src/components/MeshCore/MeshCoreNodesView.test.tsx` | WP4 |
| `src/components/MeshCore/MeshCoreMessageRouteModal.test.tsx` | WP4 |
| `src/components/MeshCore/hooks/useMeshCore.isLocal.test.ts` *(new)* | WP4 |
| `src/db/repositories/auth.ts` | WP5 |
| `src/db/repositories/auth.test.ts` *(only if edits needed)* | WP5 |
| `src/server/routes/sourceRoutes.ts` | WP5 |
| `src/server/routes/sourceRoutes.settingsGrantFanout.test.ts` *(new)* | WP5 |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` (deviations) | **orchestrator only** |

**Ownership edge case:** if `mergeNodesAndContacts` / `MergedRow` turn out to live outside
`MeshCoreNodesView.tsx`, that file transfers to WP4 and WP3 must not touch it. WP3 reports the
location in its first status update.

### 7.3 Per-package acceptance

**WP1 — Apprise URL resolver (section A, #4442)**
- `resolveAppriseServerUrl` + `appriseNotifyEndpoint` exported; all four call sites converted
  (`resolveAppriseConfig`, `securityDigestService`, `settingsRoutes:1130-1138`,
  `notificationRoutes:380`).
- The digest POSTs to the resolved endpoint; test proves it with a non-localhost
  `appriseApiServerUrl`.
- Trailing-slash safety: `http://h:8000/` → `http://h:8000/notify`, never `//notify`.
- `notificationRoutes.test.ts:231` rewritten; `appriseNotificationService.test.ts:52-77` rewritten.
- §2.3's verdict on `apprise_url` recorded in the PR body.
- Targeted: `npx vitest run src/server/services/appriseNotificationService*.test.ts src/server/services/securityDigestService*.test.ts src/server/routes/notificationRoutes.test.ts src/server/routes/settingsRoutes.test.ts`
- Negative control: revert the `securityDigestService` line → the new endpoint test fails.

**WP2 — `externalUrl` setting (section B, #4437)**
- The `getSettingForSource` global-fallback verification from §3.1 done and reported **first**.
- Three constant edits per §3.2; `GLOBAL_ONLY_SETTINGS_KEYS` untouched.
- Validation per §3.3 incl. trailing-slash stripping; `''` clears and behaves identically to today.
- All `appriseApiServerUrl` sites in `SettingsTab.tsx` have an `externalUrl` sibling; no dependency
  array touched.
- `externalUrl` added to `SERVER_ONLY_SETTINGS`.
- Targeted: `npx vitest run src/server/constants/settings.allowlist.test.ts src/server/server.settings-persistence.test.ts src/server/routes/settingsRoutes.test.ts src/server/routes/settingsRoutes.externalUrl.test.ts src/server/services/securityDigestService.test.ts`
- Negative control: omit the `PER_SOURCE_KEYS_NOT_POSTABLE` removal → `settings.allowlist.test.ts` fails.

**WP3 — `isLocal` server + shared type (section C1, #4438)**
- P3 (`POST /contacts/refresh`) investigated and its result reported explicitly.
- One builder; `(local)` appears in exactly one `src/server` module (T-C1 green).
- Wire type requires `isLocal`; client type optional; websocket payload has the optional field.
- `mapContactsToNodes` reads the flag; new `meshcoreHelpers.test.ts` cases incl. the T-C4 negative.
- T-C2 table-driven endpoint test green.
- **The `(local)` suffix in `advName` is unchanged** — assert it explicitly in a test so WP4 or a
  later contributor cannot remove it silently.
- Targeted: `npx vitest run src/utils/meshcoreHelpers.test.ts src/server/routes/meshcoreLocalContactRow.test.ts src/server/routes/meshcoreRoutes.test.ts`

**WP4 — `isLocal` frontend readers (section C2, #4438)** *(after WP3)*
- All six read sites converted; all six `NOTE: … #4438` comments deleted; `MergedRow` carries the flag.
- `useMeshCore` re-stamps `isLocal` from `localNodeRef` on every merge (§4.4); T-C3 green.
- `MeshCoreNodesView.test.tsx:312` and `MeshCoreMessageRouteModal.test.tsx:172` rewritten with
  T-C4 negative controls.
- `grep -rn "(local)" src/components src/utils` returns only display strings and unrelated matches
  (`ownNodePositions.ts`, `useDashboardData.ts`, `WaypointEditorModal.tsx` are prose/unrelated).
- Targeted: `npx vitest run src/components/MeshCore src/utils/meshcoreHelpers.test.ts`
- Negative control: revert one read site to the string match → its T-C4 case fails.

**WP5 — source-creation grant reconciliation (section D, WP7)**
- `fanOutGlobalGrantsToSource` in `auth.ts`, Drizzle only, reusing all three functions from
  `settingsGrantFanout.ts` (zero new computation).
- Called after `createSource`, **before** the manager-start block; non-fatal on error.
- Four tests: fan-out case, no-op case, throw-is-non-fatal case, double-create idempotency.
- The separate issue from §5.3 filed, and referenced in a comment at the call site.
- `npm run lint:ci` shows no new raw-SQL violation for `sourceRoutes.ts` or `auth.ts`.
- Targeted: `npx vitest run src/server/routes/sourceRoutes.settingsGrantFanout.test.ts src/server/routes/sourceRoutes.permissions.test.ts src/db/repositories/auth.test.ts`
- Negative control: stub the fan-out call out of the create handler → the first test fails.

### 7.4 Test-execution discipline — mandatory

**No package runs the full suite.** Concurrent full runs corrupt the shared MySQL test schema.
Each package runs only its targeted list above. The orchestrator runs the single authoritative
full suite after all packages report, and confirms success via `numPendingTests` in the JSON
reporter (not just `success`) per CLAUDE.md.

**WP5 is the sole owner of PostgreSQL/MySQL container access** (ports 5433 / 3307). It is the only
package touching permissions SQL that has multi-backend suites. No other package starts, stops, or
runs against those containers. This PR adds **no migration**, so no other package needs them.

`npm run lint:ci` is run once by the orchestrator, filtered per CLAUDE.md:
`npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'`.

---

## 8. Risks for the orchestrator to weigh

1. **HIGH — the `(local)` suffix is display text (§4.1).** The most likely way WP4 breaks something
   nobody asked to change. WP3 pins it with an explicit assertion; verify that assertion exists
   before WP4 starts.
2. **HIGH — `POST /contacts/refresh` (P3) may already drop the local node.** If confirmed, this PR
   fixes a second user-visible bug the issue did not mention, and the PR body must say so. If WP3
   reports "P3 does include the local row", ask how it was verified — a wrong answer here is the
   exact "miss one producer" failure the section exists to prevent.
3. **MEDIUM — WP2's design rests on `getSettingForSource` falling back to the global key.** The
   evidence is a code comment (`securityDigestService.ts:333`), not a test. WP2 verifies this
   first; if it does not hold, the read at `securityDigestService.ts:345` must change — a file
   owned by WP1, requiring an ownership hand-off mid-flight.
4. **MEDIUM — the new-user default-seed problem is four sourcey resources in three-to-four
   hardcoded lists (§5.3), not one settings row.** Larger than the Phase 6 note implies. File the
   issue before the PR opens so WP5 can cite a real number. If the user would rather fold it in,
   that is a scope decision to take now, not after WP5 has landed.
5. **LOW-MEDIUM — WP1 broadens behaviour for anyone currently depending on the hardcoded
   `localhost:8000`.** After the fix, an operator who set `appriseApiServerUrl` to a host where
   digests were *never* being delivered starts receiving them. That is the intended fix, but it is
   a behaviour change in a notification path and belongs in the release notes.
6. **LOW — WP5 concurrency.** Two simultaneous source creations both reading the NULL rows. The
   shared module's `existingPairs` skip and the delete-last ordering make the worst case a
   redundant no-op, and the idempotency test pins it. Noted for completeness, not action.
7. **LOW — `securityDigestService.perSource.test.ts` is annotated by WP2 but conceptually about
   WP1's fix.** Resolved by giving WP1 a new test file, but if WP2 finishes first the annotation
   will briefly reference a fix that has not landed. Harmless; sequence the merge of the four
   sections in the PR so section A's commit precedes section B's.
