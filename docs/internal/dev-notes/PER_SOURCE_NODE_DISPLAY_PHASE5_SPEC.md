# Phase 5 Spec — Close the follow-up defects (#4419 + migration 050 drift + `externalUrl`)

**Epic:** #4412 (per-source Node Display). **Phase:** 5 of 6. **Issue:** #4419.
**Worktree:** `/home/yeraze/Development/meshmonitor-followups`
**Branch:** `feature/per-source-settings-followups` (base `origin/main`, Phase 4 = `6cc26bcb`).
**Status:** spec only — nothing implemented.

Phase 5 is a **cleanup** phase. Every item below is a pre-existing defect this epic
surfaced. Nothing here adds a user-facing feature, and nothing here changes upgrade
semantics. Two candidate items are explicitly **deferred** with reasoning (§5, §6).

---

## 1. Reuse inventory (read this before writing a line)

Everything Phase 5 needs already exists somewhere in the tree. Nothing new is
invented except one private helper (1.2) and one frozen constant (1.6).

### 1.1 The prefixed-lookup pattern — `auditSettingsWrite`
`src/server/routes/settingsRoutes.ts:187-224`

```ts
const prefix = sourceId ? `source:${sourceId}:` : '';
const before = currentSettings[`${prefix}${key}`];
```

This is the **correct** shape and the model for the #4419(a) fix. It works because
`getAllSettings()` (`src/db/repositories/settings.ts:35`) returns *every* row
including `source:{id}:{key}` ones — so the scoped before-value needs **no extra
query**. WP1 extracts this expression into a named helper and calls it from both
`auditSettingsWrite` and the auto-ack regex guard. **Do not add a second DB read.**

### 1.2 The dialect-branched LIKE/ESCAPE — `deleteSourceSettings`
`src/db/repositories/settings.ts:292-299`, with the empirically-verified rationale in
the doc comment at `:274-291`:

```ts
const pattern = this.sourcePrefix(sourceId).replace(/([\\%_])/g, '\\$1') + '%';
const query = this.isMySQL()
  ? sql`${settings.key} LIKE ${pattern} ESCAPE '\\\\'`   // MySQL: TWO literal backslashes
  : sql`${settings.key} LIKE ${pattern} ESCAPE '\\'`;    // SQLite/PG: exactly ONE
```

WP2 **extracts this into a private `sourceNamespaceMatch(sourceId): SQL`** and calls it
from both `getSourceSettings` (new) and `deleteSourceSettings` (unchanged behaviour).
This is the one new helper in the phase, and it exists to *remove* a duplicate, not add one.
Do not re-derive the backslash rule; it cost a live-container debugging session in Phase 1.

### 1.3 `sourcePrefix()` / `isMySQL()`
`src/db/repositories/settings.ts:171` and `src/db/repositories/base.ts:102`.
Already private/protected and already correct. Use them; do not inline `` `source:${id}:` ``.

### 1.4 `getSettingForSources(ids, key)` — the Phase 2 batched primitive
`src/db/repositories/settings.ts:222-247`. **Deliberately not used by Phase 5** — see §3.3
for the analysis of why none of `getSourceSettings`' three callers should convert to it.

### 1.5 The one-query proof harness
`src/db/repositories/settings.test.ts:369-395` —
`getSettingForSources - issues exactly one SELECT for the whole batch`. It monkey-patches
the protected drizzle handle and counts `select` calls:

```ts
const dbHandle = (repo as any).db;
const realSelect = dbHandle.select.bind(dbHandle);
let selectCalls = 0;
dbHandle.select = (...args: unknown[]) => { selectCalls += 1; return realSelect(...args); };
try { /* … */ expect(selectCalls).toBe(1); } finally { dbHandle.select = realSelect; }
```

WP2 copies this verbatim for `getSourceSettings`. It satisfies the epic's exit criterion
"a test proving `getSourceSettings` issues one scoped query rather than reading the whole table."

### 1.6 The frozen-key-list pattern — migration 131
`src/server/migrations/131_seed_per_source_node_display.ts:52-80`. `NODE_DISPLAY_SEED` is
an exported local constant with a doc comment that names the hazard explicitly
("Deliberately does NOT import `PER_SOURCE_SETTINGS_KEYS` (contrast migration 050)…").
WP3 gives 050 the identical treatment: exported `PROMOTED_SETTING_KEYS`, same style of
doc comment, plus the drift guard 131 never got.

### 1.7 The three-backend test body — `runSettingsTests`
`src/db/repositories/settings.test.ts:49-435`, invoked by three `describe` blocks
(SQLite always; PG/MySQL under `describe.skipIf`). A test added **inside `runSettingsTests`
runs on all three backends for free.** WP2 must add its tests there, not in a new file.

### 1.8 The PG/MySQL migration test template
`src/server/migrations/131_seed_per_source_node_display.pgmysql.test.ts` — two halves
(fake-client always-runs + live-container `skipIf`), with the "silent skip still reports
`success: true`" warning in its header. WP3 copies the scaffolding wholesale.

### 1.9 The route test harness
`src/server/test-helpers/routeTestApp.ts` → `createRouteTestApp()`; already used by
`settingsRoutes.perSource.test.ts` (`:27`). Provides `app`, `sourceA`, `sourceB`, `admin`,
`limited`, `loginAs()`, `grant()`, `cleanup()` against a real `:memory:` SQLite DB with all
migrations applied. **All new route tests go here.**

### 1.10 Prototype-safe property writes
`setSourceSettings` (`settings.ts:257-272`) and `auditSettingsWrite`
(`settingsRoutes.ts:207-210`) both use `Object.defineProperty` rather than `obj[key] = v`
to prove to CodeQL that a non-literal key cannot reach a prototype-pollution sink.
WP2 reuses this in the rewritten `getSourceSettings` (§3.1) — the current implementation
writes `result[k.slice(prefix.length)] = v`, and `setSourceSettings`' key filter
(`/^[A-Za-z0-9_.-]+$/`) *permits* `__proto__`, so the sink is reachable today.

### 1.11 Existing `PER_SOURCE_KEYS_NOT_POSTABLE` orphan entry
`src/server/constants/settings.ts:625-631` already documents `externalUrl` in place.
WP4 edits that comment; it does **not** move the key or touch `VALID_SETTINGS_KEYS`.

---

## 2. WP1 — #4419(a): per-source POST must compare against the per-source current value

### 2.1 The defect
`src/server/routes/settingsRoutes.ts:326-330`:

```ts
const willBeEnabled =
  'autoAckEnabled' in filteredSettings
    ? filteredSettings.autoAckEnabled === 'true'
    : currentSettings.autoAckEnabled === 'true';       // ← global row
const regexChanged = pattern !== (currentSettings.autoAckRegex ?? '');   // ← global row
```

`currentSettings` is `await databaseService.settings.getAllSettings()` (`:284`), which
returns **bare, un-prefixed** keys alongside the prefixed ones. On
`POST /api/settings?sourceId=X` the correct "current" value lives at
`source:X:autoAckEnabled` / `source:X:autoAckRegex`. Both `autoAckEnabled` and
`autoAckRegex` are in `PER_SOURCE_SETTINGS_KEYS`, so a source that overrides the global
gets change-detection wrong **in both directions**:

| Scenario | Today | Correct |
|---|---|---|
| Source X stores a lookaround regex (persisted before RE2), auto-ack OFF, user re-saves it unchanged to toggle something else. Global row differs. | `regexChanged = true` → RE2 rejects → **400, section permanently stuck** — the exact #3806 failure the guard was written to prevent | `regexChanged = false` → 200 |
| Source X's regex differs from global; user changes X's regex to a *new* bad pattern that happens to equal the global row. | `regexChanged = false` → bad pattern **saved unvalidated** | `regexChanged = true` → 400 |
| Auto-ack disabled on source X but enabled globally; user saves a bad regex. | `willBeEnabled = true` → 400 on a source where auto-ack is off | `willBeEnabled = false` → 200 |

### 2.2 Audit of every other `currentSettings.<key>` read

Full enumeration (`grep -n currentSettings src/server/routes/settingsRoutes.ts`):

| Line | Read | Reachable from the per-source branch? |
|---|---|---|
| `:284` | assignment (`getAllSettings()`) | n/a |
| `:329` | `currentSettings.autoAckEnabled` | **YES — defect. Fix.** |
| `:330` | `currentSettings.autoAckRegex` | **YES — defect. Fix.** |
| `:198` | `currentSettings[`${prefix}${key}`]` inside `auditSettingsWrite` | yes, and **already correct** |
| `:886` | `currentSettings['autoWelcomeEnabled']` | **NO.** The per-source branch (`:765`) ends with `return ok(res, { ignoredKeys });` at `:842`. `:886` is unreachable when `sourceId` is non-null. |
| `:1176`, `:1187` | `DELETE /api/settings` handler | separate route, global-only |

`:886` needs no code change, but WP1 **must add a one-line comment** anchoring the
invariant, because the safety of that read is positional and a future edit that moves the
`return` would silently reintroduce the same class of bug:

```ts
// Global-branch only: the `if (sourceId)` branch above returns at :842, so
// `currentSettings[...]` here is always the un-prefixed global row by construction (#4419).
```

### 2.3 Change

Add a module-level helper next to `auditSettingsWrite` (before it, so the doc comment reads
in order):

```ts
/**
 * The `settings` row key that holds the current value of `key` for this write's scope:
 * `source:{id}:{key}` for a scoped POST, the bare key for a global one.
 *
 * `currentSettings` is one `getAllSettings()` snapshot containing BOTH namespaces, so
 * scoped change-detection costs no extra query — that is the whole point (#4419).
 * Any pre-write comparison inside `POST /` that can run with a non-null `sourceId` MUST
 * go through this; reading `currentSettings.<bareKey>` directly compares a per-source
 * save against the global row.
 */
function scopedSettingKey(key: string, sourceId: string | null): string {
  return sourceId ? `source:${sourceId}:${key}` : key;
}
```

Then:

```ts
// settingsRoutes.ts — inside auditSettingsWrite, replacing the local `prefix` const
const before = currentSettings[scopedSettingKey(key, sourceId)];

// settingsRoutes.ts:326-330
const willBeEnabled =
  'autoAckEnabled' in filteredSettings
    ? filteredSettings.autoAckEnabled === 'true'
    : currentSettings[scopedSettingKey('autoAckEnabled', sourceId)] === 'true';
const regexChanged = pattern !== (currentSettings[scopedSettingKey('autoAckRegex', sourceId)] ?? '');
```

Notes for the implementer:
- `auditSettingsWrite`'s `Object.defineProperty` block at `:207-210` and the
  `validKeySet` check at `:197` are **load-bearing for CodeQL** (see the comment at
  `:200-206`). Leave them exactly as they are; only the `before =` line changes.
- Deleting the now-unused `const prefix = …` at `:195` is required (ESLint).
- Behaviour on the **global** path is byte-identical (`sourceId === null` ⇒
  `scopedSettingKey` is the identity function). This must be asserted, not assumed — see
  the regression tests in 2.5.
- A scoped POST for a source with **no** stored `autoAckRegex` row now compares against
  `undefined ?? ''`. A first-ever non-empty pattern therefore reads as changed and is
  validated. That is the intended semantics (there is no stored pattern to unstick).

### 2.4 Files
| File | Change |
|---|---|
| `src/server/routes/settingsRoutes.ts` | add `scopedSettingKey`; rewrite `:198`, `:329`, `:330`; drop `:195`; add the `:886` invariant comment |
| `src/server/routes/settingsRoutes.perSource.test.ts` | new `describe` block (2.5) |

### 2.5 New tests — `settingsRoutes.perSource.test.ts`

Harness-based (§1.9), `harness.admin` (permission is not the subject). Add:

```
describe('POST /api/settings — autoAck change-detection is scope-correct (#4419a)')
```

1. **`a scoped re-save of the source's own bad regex is allowed while auto-ack is off (the #3806 unstick, per source)`**
   Seed `source:{A}:autoAckRegex = 'foo(?=bar)'` and `source:{A}:autoAckEnabled = 'false'`
   directly via `databaseService.settings.setSourceSetting`; seed a *different* global
   `autoAckRegex = 'plain'`. POST `?sourceId=A` with `{autoAckRegex:'foo(?=bar)', autoAckEnabled:'false'}` → **200**.
   *Fails with the defect present* (global differs ⇒ `regexChanged` true ⇒ RE2 400).
2. **`a scoped change to a NEW bad regex is rejected even when it equals the global row`**
   Global `autoAckRegex = 'foo(?=bar)'`; `source:{A}:autoAckRegex = 'plain'`, auto-ack off.
   POST `?sourceId=A` `{autoAckRegex:'foo(?=bar)', autoAckEnabled:'false'}` → **400**.
   *Fails with the defect present* (equals global ⇒ `regexChanged` false ⇒ unvalidated 200).
3. **`willBeEnabled reads this source's own flag, not the global one`**
   Global `autoAckEnabled = 'true'`; `source:{A}:autoAckEnabled = 'false'`. POST
   `?sourceId=A` `{autoAckRegex:'foo(?=bar)'}` (no `autoAckEnabled` in body) → **200**.
   *Fails with the defect present* → 400.
4. **`sourceA's regex state does not affect a sourceB save`**
   Seed a bad regex on A only; POST the same pattern on B with auto-ack off → **400**
   (B has no stored pattern to unstick). Confirms no cross-source leak in the new lookup.
5. **`the unscoped POST still compares against the global row (no regression)`**
   Global `autoAckRegex = 'foo(?=bar)'`, `autoAckEnabled='false'`, plus a *different*
   `source:{A}:autoAckRegex`. POST with **no** `sourceId` and the same pattern → **200**.
   Pins the identity-function property of `scopedSettingKey`.
6. **`the audit row records the per-source before-value`**
   Scoped POST that changes `source:{A}:autoAckMessage`; assert the emitted audit
   `oldValue` JSON carries the **source's** prior value, not the global one. (Guards the
   `auditSettingsWrite` refactor — it must stay behaviour-identical.)

### 2.6 Acceptance criteria (WP1)
- [ ] Tests 1–3 each **fail on `git stash`-ed production code and pass after** — the
      implementer must run them against the unfixed file once and record the failure
      output in the commit message. A test that passes both ways is not evidence.
- [ ] `npx vitest run src/server/routes/settingsRoutes.perSource.test.ts src/server/routes/settingsRoutes.test.ts` — 0 failures.
- [ ] `grep -n 'currentSettings\.' src/server/routes/settingsRoutes.ts` returns **no** hits
      inside the `POST /` handler above line 842.
- [ ] `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` is empty.

---

## 3. WP2 — #4419(b): `getSourceSettings` becomes a prefix-scoped query

### 3.1 The defect and the change
`src/db/repositories/settings.ts:178-188` reads the **entire** `settings` table and
filters in JS. Migration 131 made that table grow as (keys × sources), and the function is
on the `GET /api/settings?sourceId=` path — i.e. every settings page load.

Replace with:

```ts
/**
 * Predicate matching every row in one source's `source:{id}:` namespace.
 *
 * Extracted so the wildcard escaping and the dialect-dependent ESCAPE literal are
 * stated exactly once, and so the read (getSourceSettings) and the write
 * (deleteSourceSettings) can never disagree about what "this source's namespace" means.
 *
 * `_` and `%` are LIKE wildcards; source ids are UUIDs today, but escape defensively so
 * a future non-UUID id cannot over-match a sibling namespace.
 *
 * The ESCAPE literal's backslash count is dialect-dependent (verified empirically against
 * live containers in #4412 Phase 1, not by inspection): MySQL's default backslash-escape
 * mode means a single-quoted string needs TWO literal backslash characters to represent
 * ONE escape character, and errors ("syntax error near ''\''") on a single-backslash
 * literal. SQLite and PostgreSQL (standard_conforming_strings, the default) treat
 * backslash as an ordinary character in a '...' string, so ONE literal backslash there
 * already IS the one-character escape sequence — a two-backslash literal fails there
 * ("ESCAPE expression must be a single character").
 */
private sourceNamespaceMatch(sourceId: string): SQL {
  const { settings } = this.tables;
  const pattern = this.sourcePrefix(sourceId).replace(/([\\%_])/g, '\\$1') + '%';
  return this.isMySQL()
    ? sql`${settings.key} LIKE ${pattern} ESCAPE '\\\\'`
    : sql`${settings.key} LIKE ${pattern} ESCAPE '\\'`;
}

/**
 * Get all settings for one source, keyed by BARE key (prefix stripped).
 *
 * One prefix-scoped query. The previous implementation called getAllSettings() and
 * filtered in JS — O(total settings) per call, and migration 131 grew that table as
 * (keys x sources) (#4419).
 *
 * Rows are written with Object.defineProperty, not `result[k] = v`: setSourceSettings'
 * key filter (/^[A-Za-z0-9_.-]+$/) permits the literal name `__proto__`, so a stored row
 * `source:{id}:__proto__` would otherwise reach a prototype-pollution sink on the read
 * path. defineProperty creates an own data property and never invokes the setter.
 */
async getSourceSettings(sourceId: string): Promise<Record<string, string>> {
  const { settings } = this.tables;
  const prefix = this.sourcePrefix(sourceId);
  const rows = await this.db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(this.sourceNamespaceMatch(sourceId));

  const result: Record<string, string> = {};
  for (const row of rows as Array<{ key: string; value: string }>) {
    if (!row.key.startsWith(prefix)) continue;
    Object.defineProperty(result, row.key.slice(prefix.length), {
      value: row.value, enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

async deleteSourceSettings(sourceId: string): Promise<void> {
  await this.db.delete(this.tables.settings).where(this.sourceNamespaceMatch(sourceId));
}
```

Implementation notes:
- Keep the return type a **plain object literal**, not `Object.create(null)` — callers
  spread it (`settingsRoutes.ts:260`), mutate it (`settingsRoutes.ts:1717-1738`), and tests
  assert `toEqual({…})`. `defineProperty` on a normal `{}` closes the sink without changing
  the object's shape.
- The `startsWith(prefix)` re-check is belt-and-braces against a dialect LIKE surprise;
  it costs nothing and makes the slice provably safe.
- `SQL` needs importing from `drizzle-orm` alongside the existing `eq, inArray, sql`.
- The `deleteSourceSettings` doc comment at `:274-291` moves onto `sourceNamespaceMatch`;
  leave a short pointer on `deleteSourceSettings` (its #4233 single-statement rationale
  is still its own and must survive).

**Honest performance note to put in the commit message, not in a claim of an index win:**
on PostgreSQL with a non-`C` collation, a plain btree PK does **not** serve `LIKE 'x%'`
(that needs `text_pattern_ops`), so PG may still seq-scan. The win is real regardless —
filtering happens in the DB, only matching rows cross the wire, and the whole-table JS
object build disappears. Do **not** add an index; the `settings` table is hundreds of rows.

### 3.2 Callers — blast radius
`grep -rn getSourceSettings src --include=*.ts --include=*.tsx | grep -v '\.test\.'`:

| Site | Use | Impact |
|---|---|---|
| `settingsRoutes.ts:259` | `GET /api/settings?sourceId=` merge | needs the whole namespace — unchanged |
| `settingsRoutes.ts:1675` | `GET /auto-ping` override prefetch | unchanged |
| `settingsRoutes.ts:1707` | `POST /auto-ping` override prefetch (mutated in place) | unchanged |

Return shape and semantics are identical, so all three are no-diff.

### 3.3 Should any caller use `getSettingForSources` instead? — **No.**
The brief asked. Answer with reasoning so it is not re-litigated:
- `:259` genuinely wants the *whole* namespace to merge over globals. `getSettingForSources`
  is one-key-many-sources; the wrong axis.
- `:1675`/`:1707` prefetch 4 keys for **one** source and then fall through to
  `getSetting()` for the global. Converting them to 4 × `getSettingForSource` swaps one
  range scan for four point lookups (no win), and `:1707` **mutates `sourceOverrides` in
  place** after each write (`sourceOverrides['autoPingEnabled'] = …`), so the conversion is
  a restructure, not a substitution.

Fixing the primitive fixes all three call sites with a zero-line caller diff. That is the
complete fix; converting callers is neither necessary nor beneficial.

### 3.4 Files
| File | Change |
|---|---|
| `src/db/repositories/settings.ts` | add `sourceNamespaceMatch`; rewrite `getSourceSettings`; re-point `deleteSourceSettings` |
| `src/db/repositories/settings.test.ts` | 5 new tests inside `runSettingsTests` |

### 3.5 New tests — inside `runSettingsTests` (all three backends, §1.7)

`getSourceSettings` currently has **zero** tests as a subject (§7). Add:

1. **`getSourceSettings - returns this source's rows with the prefix stripped`** — seed
   two keys on A, one on B, one bare global; assert A's map is exactly the two bare keys.
2. **`getSourceSettings - excludes the un-namespaced global rows`** — seed
   `maxNodeAgeHours = '24'` globally and nothing per-source; assert `{}`.
3. **`getSourceSettings - a sourceId containing a LIKE wildcard does not over-match a lookalike namespace`** —
   mirror of the existing `deleteSourceSettings` test at `:281`: seed `source_a` and
   `sourceXa`; assert `getSourceSettings('source_a')` returns only `source_a`'s rows. **This
   is the test that would catch a wrong ESCAPE literal on MySQL** and is the reason the
   whole suite must be confirmed to have run on all three backends (§8.2).
4. **`getSourceSettings - issues exactly one SELECT and does not read the whole table`** —
   copy the harness at `:369-395`; assert `selectCalls === 1` **and** that the query is
   scoped, by seeding 3 sibling sources and asserting the returned map has only A's keys.
   (Count alone is insufficient: `getAllSettings()` is also one `select`.)
5. **`getSourceSettings - a stored __proto__ key does not pollute the prototype`** —
   `setSourceSetting(A, '__proto__', 'pwned')`; assert
   `({} as any).polluted === undefined`, `Object.getPrototypeOf({}) === Object.prototype`,
   and that the returned map carries `__proto__` as an own enumerable property.

### 3.6 Acceptance criteria (WP2)
- [ ] `npx vitest run src/db/repositories/settings.test.ts src/server/routes/sourceRoutes.settingsCleanup.test.ts src/server/routes/unifiedRoutes.perSource.test.ts src/server/routes/settingsRoutes.test.ts` — 0 failures.
- [ ] The PG and MySQL halves of `settings.test.ts` are **proven to have run**, not
      skipped — see §8.2 for the exact command and what to paste into the commit message.
- [ ] Test 4 fails if `getSourceSettings` is reverted to the scan-and-filter body.
- [ ] `npm run lint:ci` clean (worktree-filtered).

---

## 4. WP3 — Migration 050: freeze the promoted key list

### 4.1 The defect
`src/server/migrations/050_promote_globals_to_default_source.ts:34` imports
`PER_SOURCE_SETTINGS_KEYS` and iterates it in all three backends (`:68`, `:129`, `:202`).
Fresh installs replay every migration (#3962 deleted `createTables`), so 050 runs against
whatever that array holds **today**. The array has grown from 87 keys to 170 since 050 was
authored; the drift is live, and this epic contributed 9 of those keys.

### 4.2 **Decision: freeze at today's 170-key list (a verbatim snapshot), not the 87-key authoring-time list.**

Measured facts (computed by diffing `src/server/constants/settings.ts` at
`aae251a64a573965c5bc6fb24b926dd52fb2d78b` — the commit that added 050, 2026-04-28 — against `HEAD`):

- `PER_SOURCE_SETTINGS_KEYS`: **87 keys then, 170 now. 83 added, 0 removed.** Today's list
  is a strict superset.
- Of those 83 added keys, exactly **9** were already user-writable global settings at
  050-authoring time (i.e. present in `VALID_SETTINGS_KEYS` then): `maxNodeAgeHours`,
  `inactiveNodeThresholdHours`, `inactiveNodeCheckIntervalMinutes`,
  `inactiveNodeCooldownHours`, `nodeHopsCalculation`, `hideIncompleteNodes`,
  `nodeDimmingEnabled`, `nodeDimmingStartHours`, `nodeDimmingMinOpacity` — **exactly this
  epic's Node Display nine.**
- The other **74** did not exist as valid settings keys at 050-authoring time, so an
  install old enough to still need 050 cannot have a global row for them written through
  `POST /api/settings`. 050's `if (!globalRow) continue` makes them inert.

Justification:

1. **A cleanup phase must not change upgrade semantics.** Snapshotting today's array is the
   only option with a provably zero behaviour delta at the moment of the fix. The migration
   keeps doing exactly what `main` does today; it just stops being a moving target.
2. **Freezing at 87 would be an active regression, not a restoration.** It would stop
   promoting those 9 keys for every future v3.x/early-4.x upgrader. Migration 131 does
   re-seed the same ten Node Display keys from globals for every row in `sources`, so the
   user-visible loss is small — but "make the upgrade path do less" is a behaviour change,
   and this phase is not authorised to make one.
3. **The remaining 74 keys cost nothing to keep.** Provably inert on the promote path for
   any install that has not yet run 050.
4. **The existing-vs-fresh divergence the brief flags is pre-existing and unavoidable, and
   freezing at today resolves it in the safe direction.** An install that ran 050 in April
   got the April list; nothing can retroactively change that. Between "an install migrating
   later gets *more* of its legacy config preserved" and "gets *less*", the former is the
   only defensible default.
5. **Fresh installs are unaffected either way.** On a genuinely empty database 050 finds
   zero global rows and promotes nothing. The list content only matters on the *upgrade*
   path — which is exactly what point 2 protects.
6. **Freezing does not create a future gap; it makes an existing implicit one explicit and
   forces the correct pattern.** After the freeze, key #171 will not be promoted by 050 —
   but it already isn't, for every install that ran 050 before #171 existed. The correct
   remedy for a newly-per-source key is its own seed/promote migration, which is precisely
   the precedent migration 131 set. WP3 writes that rule into 050's doc comment.

### 4.3 Change

In `050_promote_globals_to_default_source.ts`:

- **Delete** `import { PER_SOURCE_SETTINGS_KEYS } from '../constants/settings.js';`
- **Add** an exported frozen constant immediately after `const LABEL`:

```ts
/**
 * The per-source settings keys this migration promotes, FROZEN as of 4.13.3.
 *
 * Deliberately NOT an import of PER_SOURCE_SETTINGS_KEYS (contrast the original 050, and
 * compare migration 131's NODE_DISPLAY_SEED): a migration is a statement about a point in
 * time, and fresh installs replay every migration (#3962 deleted createTables), so an
 * imported array runs against whatever it contains *today*, not what it contained when
 * this migration shipped. That drift was live — the array grew 87 -> 170 keys between 050
 * shipping and this freeze (#4419).
 *
 * This snapshot is the 170-key list as of the freeze, NOT the 87-key list 050 originally
 * ran with. That choice is deliberate: a snapshot of today changes nothing for anyone at
 * freeze time, whereas reverting to the 87-key list would stop promoting nine long-standing
 * globals (maxNodeAgeHours and the node-dimming / inactive-node group) for every future
 * v3.x upgrader. See PER_SOURCE_NODE_DISPLAY_PHASE5_SPEC.md §4.2 for the full analysis.
 *
 * DO NOT append to this list when a new setting becomes per-source. This list is history.
 * A key that becomes per-source AFTER this freeze needs its own seed/promote migration —
 * that is what migration 131 is, and it is the pattern to copy.
 */
export const PROMOTED_SETTING_KEYS: readonly string[] = [
  /* … 170 string literals, verbatim from PER_SOURCE_SETTINGS_KEYS at this commit … */
];
```

- Replace the three `for (const key of PER_SOURCE_SETTINGS_KEYS)` loops (`:68`, `:129`,
  `:202`) with `PROMOTED_SETTING_KEYS`. **No other logic changes.**

**How to produce the 170 literals — do not hand-transcribe.** Run this in the worktree and
paste the output verbatim:

```bash
node -e "
const fs=require('fs');
const t=fs.readFileSync('src/server/constants/settings.ts','utf8');
const m=t.match(/export const PER_SOURCE_SETTINGS_KEYS[^=]*=\s*\[([\s\S]*?)\]\s*as const;/);
const k=[...m[1].matchAll(/'([^']+)'/g)].map(x=>x[1]);
console.error('count='+k.length);
console.log(k.map(x=>\"  '\"+x+\"',\").join('\n'));
"
```
Assert `count=170` before pasting. Keep the source array's grouping comments **out** —
the frozen list is a flat historical record, not a maintained taxonomy.

### 4.4 Explicitly out of scope for WP3
The PG (`:129-144`) and MySQL (`:202-…`) loops do **one SELECT and one INSERT per key** —
170 sequential round trips each, the #4233 anti-pattern. Under the migration ledger this
runs once per database (~170 ms), so it is not worth the risk in a cleanup phase.
**Do not batch it.** Record it as an observation in the epic deviations log; the
orchestrator can file it separately if it wants. Consequence for testing: the new
pgmysql test must assert **behaviour**, never round-trip counts — pinning 170 round trips
would itself be an implementation-asserting test, the exact thing §7 audits for.

### 4.5 Files
| File | Change |
|---|---|
| `src/server/migrations/050_promote_globals_to_default_source.ts` | drop the import, add `PROMOTED_SETTING_KEYS`, re-point 3 loops |
| `src/server/migrations/050_promote_globals_to_default_source.test.ts` | add the 2 drift-guard tests (4.6) |
| `src/server/migrations/050_promote_globals_to_default_source.pgmysql.test.ts` | **NEW** (4.7) |

`src/db/migrations.ts` needs **no** change — the registry entry, `settingsKey`, and
migration number are all untouched. `src/db/migrations.test.ts` is registry-derived and
also needs no change.

### 4.6 New tests — `050_…test.ts` (SQLite)
The existing 8 tests all stay (§7, Area 3). Add:

1. **`the promoted key list is frozen — 050 does not import the live constants array (#4419)`**

```ts
const src = readFileSync(new URL('./050_promote_globals_to_default_source.ts', import.meta.url), 'utf8');
expect(src).not.toMatch(/PER_SOURCE_SETTINGS_KEYS/);
expect(src).not.toMatch(/from ['"]\.\.\/constants\/settings\.js['"]/);
```
   This is the **only** test that can catch the defect. Everything else is blind to it.

2. **`PROMOTED_SETTING_KEYS is the 170-key 4.13.3 snapshot`** — assert
   `toHaveLength(170)`, `new Set(...).size === 170` (no dupes), and three era sentinels:
   `'autoResponderEnabled'` (original 050 list), `'meshcoreAutoAckEnabled'` (4.9-era),
   `'maxNodeAgeHours'` (added by this epic's Phase 1).
   **Do not** assert equality against `PER_SOURCE_SETTINGS_KEYS` — that re-couples them and
   defeats the entire fix. The magic number 170 is the point; it must never change.

### 4.7 New test — `050_…pgmysql.test.ts` (NEW)
Copy the two-half structure and header warning from
`131_seed_per_source_node_display.pgmysql.test.ts` (§1.8).

**Fake-client half** (always runs — this is what makes the WP verifiable even with the
containers down):
- PG: promotes a global row for a key in `PROMOTED_SETTING_KEYS` into
  `source:{default}:{key}`; SQL shape is quoted-camelCase columns + `ON CONFLICT (key) DO NOTHING`.
- MySQL: same, with backticked `` `key` `` + `INSERT IGNORE`.
- A global row whose key is **not** in `PROMOTED_SETTING_KEYS` is never inserted —
  this is the fake-client expression of the freeze.
- No assertions on query counts (§4.4).

**Container half** (`describe.skipIf(!postgresAvailable)` / `!mysqlAvailable`) — same
invariants as the SQLite suite, against `localhost:5433` / `localhost:3307`:
- promotes globals into the default source's namespace;
- leaves the original global row intact (non-destructive);
- does not overwrite an existing per-source override;
- is idempotent across two consecutive runs;
- backfills `NULL`-`sourceId` rows in `auto_traceroute_nodes` / `auto_time_sync_nodes`.

Required DDL: `settings`, `sources`, `auto_traceroute_nodes`, `auto_time_sync_nodes`.
Read `src/server/migrations/_legacyDefaultSource.ts` first — `ensureDefaultSourceIdPostgres` /
`…Mysql` determine the `sources` columns the fixture must provide.

This is 050's **first** PG/MySQL coverage of any kind. Two of the invariants above
(non-destructive, no-override-clobber) are correctness properties of the `ON CONFLICT` /
`INSERT IGNORE` clause that nothing currently tests on those backends.

### 4.8 Acceptance criteria (WP3)
- [ ] `npx vitest run src/server/migrations/050_promote_globals_to_default_source.test.ts src/server/migrations/050_promote_globals_to_default_source.pgmysql.test.ts src/db/migrations.test.ts` — 0 failures.
- [ ] `count=170` from the generator command is recorded in the commit message.
- [ ] Test 4.6(1) fails when the import is restored (demonstrate once).
- [ ] The PG and MySQL container halves are **proven to have run** — §8.2.
- [ ] `grep -c "'" src/server/migrations/050_*.ts` sanity: `PROMOTED_SETTING_KEYS` has 170
      entries and the diff touches no logic outside the three loop headers and the import.

---

## 5. WP4 — `externalUrl`: recommendation and minimal safe change

### 5.1 Findings
- **One reader:** `src/server/services/securityDigestService.ts:332` —
  `const baseUrl = (await …getSettingForSource(sourceId,'externalUrl')) || '';`
- **Zero writers.** Repo-wide grep hits only `constants/settings.ts` (the
  `PER_SOURCE_SETTINGS_KEYS` entry at `:489` and the `PER_SOURCE_KEYS_NOT_POSTABLE`
  orphan comment at `:625-631`), the service, and its own test.
- **Downstream:** `baseUrl` flows into `formatDigestSummary` / `formatDigestDetailed`
  (`:59`, `:125`, `:255`, `:389-390`) which emit `[View details](${baseUrl}/security)` or
  `View details: ${baseUrl}/security`. With `baseUrl === ''` **every Apprise security
  digest ever sent contains a dead relative link** — `View details: /security` — in a
  Discord/email/ntfy message where a relative path resolves to nothing.
- **No existing source of truth to wire it to.** `env.baseUrl` (`server.ts:75`) is the
  `BASE_URL` *path prefix* (`/meshmonitor`), not an absolute origin. Producing a working
  link needs a scheme + host the server does not know.

### 5.2 Recommendation

**This needs a product decision; Phase 5 must not make it.** Wiring a writer means a new
user-facing "External URL" setting (new `VALID_SETTINGS_KEYS` entry, new UI field,
validation, per-source vs. global scope, secret-stripping question) — a feature. Deleting
the read means deleting the "View details" link from digests — a product removal.

**Minimal safe change for this phase: suppress the dangling link when no URL is
configured.** It is pure output correctness — it removes text that is broken 100% of the
time today, adds no setting, deletes no working behaviour, and the link returns
automatically the day a writer is wired.

```ts
/**
 * The digest's "View details" line. Omitted entirely when no absolute external URL is
 * configured, because `${''}/security` renders as a dead relative path in an Apprise
 * message. `externalUrl` currently has NO writer anywhere in the repo (#4419 / <new issue>);
 * whether it should become a user-configurable setting is a product decision, not a
 * cleanup. Until then this keeps the broken line out of every digest.
 */
function detailsLink(baseUrl: string, markdown: boolean): string | null {
  if (!baseUrl) return null;
  return markdown ? `[View details](${baseUrl}/security)` : `View details: ${baseUrl}/security`;
}
```
Route all six emission sites (`:80`, `:88`, `:105`, `:119`, `:146`, `:154`, `:255`) through
it, pushing only when non-null. No test currently asserts the string `View details`
anywhere in the repo, so this is a low-collision edit.

Also update the `PER_SOURCE_KEYS_NOT_POSTABLE` comment (`constants/settings.ts:625-631`) to
reference the newly filed product issue instead of "§8.7", and **leave the key exactly
where it is**. Do not touch `VALID_SETTINGS_KEYS`.

**Fallback if the orchestrator judges even this too much:** document-only — update the two
comments, add the test at 5.4(1) as a `.todo`, file the issue, change no behaviour. Say so
explicitly rather than half-doing it.

### 5.3 File the product issue
Title: `[QUESTION] externalUrl is read by the security digest and written nowhere — wire a writer or drop the link?`
Body: the §5.1 findings, both options with their costs, and the note that adding the key to
`VALID_SETTINGS_KEYS` is the one thing that must not happen by accident. Link #4419, #4412.

### 5.4 New tests — `securityDigestService.test.ts`
1. **`a digest with no externalUrl configured contains no dangling "/security" link`** —
   assert the rendered body does **not** match `/View details/`. Fails on today's code.
2. **`a digest with externalUrl configured emits an absolute link`** — seed
   `https://mesh.example`; assert `View details: https://mesh.example/security`. Pins that
   the suppression is conditional, not a deletion.

Also add a two-line comment to `securityDigestService.perSource.test.ts:42,47`: the fixture
seeds `externalUrl: 'https://a.example'` into a mocked settings map, a value **no production
write path can produce** — a fiction that helped this orphan hide. The test's own subject
(per-source dispatch) is fine; the comment stops the next reader inferring a writer exists.

---

## 6. The `(local)` naming heuristic — **defer to its own issue. Do not implement here.**

### 6.1 Actual surface (larger than the brief's "two server route files and three components")
**Writers (server):** `src/server/routes/meshcoreContactsRoutes.ts:108`,
`src/server/routes/meshcoreDeviceRoutes.ts:181` — both synthesize
`` advName: `${localNode.name} (local)` ``.
**Readers (client):** `src/utils/meshcoreHelpers.ts:36`,
`src/components/MeshCore/MeshCoreNodesView.tsx:294` and `:324`,
`src/components/MeshCore/MeshCoreMap.tsx:329` and `:343`,
`src/components/MeshCore/MeshCoreMessageRouteModal.tsx:108`.
**Tests pinning the convention:** `MeshCoreNodesView.test.tsx:314`,
`MeshCoreMessageRouteModal.test.tsx:176`.
That is **7 production files** (2 server + 1 shared util + 3 components + a
`MeshCoreContact` type change), a server response-shape change, and 2+ test files.

### 6.2 Why defer
1. **Bigger than the other four items combined.** WP1–WP4 touch 6 production files total.
2. **The hard part is not the flag, it is proving completeness.** An `isLocal` flag is only
   correct if it is present on **every** path that produces a `MeshCoreContact` — the REST
   contacts list, the device route, any websocket push, any cached/persisted path. Missing
   one silently *un*-exempts the local node, which is a worse regression than the bug being
   fixed (a user's own node vanishing from the list beats a stranger's oddly-named node
   staying). Establishing that is a survey, not a cleanup.
3. **The failure mode requires a user to literally include the string `(local)` in their
   device name.** Zero reports. Low severity, non-zero fix risk — the wrong trade for a
   cleanup phase.
4. **It straddles the phase.** WP1–WP4 are backend/DB; folding in a MeshCore UI + API-shape
   change defeats the file-ownership discipline and makes the PR two reviews.

### 6.3 What WP4 does do (cheap, in scope)
Phase 4 left `NOTE:` comments only in `MeshCoreNodesView.tsx` (`:285-289`, `:319`). The
other **four** read sites carry no warning at all. Add a one-line pointer at
`meshcoreHelpers.ts:36`, `MeshCoreMap.tsx:329`, `MeshCoreMap.tsx:343`, and
`MeshCoreMessageRouteModal.tsx:108`:

```ts
// `(local)` is a server-side naming convention (meshcoreContactsRoutes.ts:108,
// meshcoreDeviceRoutes.ts:181), not a protocol field — a user-chosen name containing
// "(local)" matches here too. Tracked for an explicit isLocal flag in #<new issue>.
```

File the issue: `[BUG] MeshCore local-node detection matches on the name string "(local)"`,
listing all 7 files, the 2 writers, and the completeness constraint from 6.2(2).

---

## 7. Test audit — keep / rewrite / delete

Classification of every existing test touching the four areas. The column that matters is
the last one.

### Area 1 — `settingsRoutes` POST change-detection (#4419a)
| Test | Verdict | Green with the defect present? |
|---|---|---|
| `settingsRoutes.test.ts:275` rejects lookaround when enabling | **keep** | **YES** — global path (`sourceId=null`), where `prefix=''` makes buggy and fixed code byte-identical |
| `settingsRoutes.test.ts:287` allows toggling OFF with a persisted bad regex (#3806) | **keep** | **YES** — same |
| `settingsRoutes.test.ts:307` rejects newly changing to a bad pattern while disabled | **keep** | **YES** — same |
| `settingsRoutes.test.ts:323` accepts a valid regex when enabling | **keep** | **YES** — same |
| `settingsRoutes.test.ts:237/248/259` regex too long / complex / invalid syntax | keep | yes — global path, and they enable auto-ack so `regexChanged` is not load-bearing |
| `settingsRoutes.perSource.test.ts` (all 12) | keep | yes — none touch `autoAckRegex` |

**Finding:** the four `#3806` tests are not bug-pinning — they assert the right thing for
the global path — but the scoped path has **zero** coverage, so the defect was structurally
invisible. WP1 §2.5 closes it. `settingsRoutes.test.ts` stays on the deprecated
`vi.mock('../../services/database.js')` pattern; **WP1 must not touch that file**, or
CLAUDE.md's opportunistic-conversion rule drags a 1,270-line harness migration into a
cleanup phase. New tests go in the already-converted `perSource` file.

### Area 2 — `getSourceSettings` (#4419b)
| Test | Verdict | Green with the defect present? |
|---|---|---|
| `settings.test.ts:243` `deleteSourceSettings - removes only the target prefix` | keep | yes — uses `getSourceSettings` as an oracle only |
| `settings.test.ts:267` `deleteSourceSettings - no-op on unknown sourceId` | keep | yes |
| `settings.test.ts:281` `deleteSourceSettings - LIKE wildcard lookalike` | **keep — and it becomes load-bearing for the read too** once both share `sourceNamespaceMatch` | yes |
| `sourceRoutes.settingsCleanup.test.ts` (3 tests) | keep | yes — asserts the requirement through the public surface. Good test. |
| `unifiedRoutes.perSource.test.ts` | keep | mentions `getSourceSettings` only in a doc comment |

**Finding (new):** **no test anywhere calls `getSourceSettings` as its subject.** Bare-key
stripping, sibling-namespace exclusion, global-row exclusion, wildcard-lookalike
over-matching, and query count are all uncovered. The function Phase 5 is rewriting is
untested. WP2 §3.5 adds 5.

### Area 3 — Migration 050
| Test | Verdict | Green with the defect present? |
|---|---|---|
| `050_…test.ts:72` promotes legacy globals | keep | **YES** |
| `:89` preserves the original global (non-destructive) | keep | **YES** |
| `:98` does not overwrite an existing per-source override | keep | **YES** |
| `:108` skips keys with no global value | keep (verify it still asserts 0 rows) | **YES** |
| `:121` idempotent | keep | **YES** |
| `:135` backfills `auto_traceroute_nodes` | keep | **YES** |
| `:155` backfills `auto_time_sync_nodes` | keep | **YES** |
| `:166` synthesizes a default source when `sources` is empty | keep | **YES** |

**Finding (new, and the most serious in this audit): all eight tests stay green with the
drift bug fully present.** They exercise three concrete keys —
`autoResponderEnabled`, `autoResponderTriggers`, `tracerouteIntervalMinutes` — that are in
*both* the 87-key authoring list and today's 170, so the suite is structurally incapable of
observing that the migration's input set changes over time. It is the same failure class as
the four bug-pinning tests Phases 2–3 deleted, one level up: the tests aren't wrong, they
are aimed at a property that cannot vary. The only test that can catch it is the
source-text drift guard at §4.6(1). Second finding: **050 has no PG/MySQL coverage at all**
despite shipping hand-written PG and MySQL implementations — WP3 §4.7.

### Area 4 — `externalUrl`
| Test | Verdict | Green with the defect present? |
|---|---|---|
| `securityDigestService.perSource.test.ts:42,47` — fixture seeds `externalUrl` per source | **keep, annotate** | **YES** |
| `securityDigestService.test.ts` (all) | keep | yes — none assert on `View details` |

**Finding (new):** the `perSource` fixture seeds `externalUrl: 'https://a.example'` into a
mocked settings map — **a value no production write path can produce.** The test's actual
subject (per-source dispatch) is sound and it is not bug-pinning, but the fixture presents
a configured-and-working setting, which is how a reader concludes a writer exists. WP4
adds the annotation; §5.4 adds the two tests that assert the requirement.

### Area 5 — `(local)` heuristic (deferred, §6)
| Test | Verdict | Green with the defect present? |
|---|---|---|
| `MeshCoreNodesView.test.tsx:312` `bypasses the cutoff for the local node` | **asserts the implementation** — hard-codes `advName: 'MyNode (local)'`, i.e. it tests the naming convention rather than "the local node is exempt". It passes today for a *user-named* node containing `(local)` — which is the bug. | yes |
| `MeshCoreMessageRouteModal.test.tsx:176` `'Base (local)'` fixture | same class | yes |
| Verdict for Phase 5 | **leave both untouched** — the deferral issue owns them; rewriting them without the `isLocal` flag would just re-pin the convention | |

### Audit summary
| | count |
|---|---|
| keep, unchanged | 24 |
| keep + annotate | 3 (`settings.test.ts:281`, `securityDigestService.perSource.test.ts` fixture ×2) |
| rewrite | 0 |
| delete | 0 |
| **would stay green with their area's defect fully present** | **19** |
| new tests added by this phase | 15 (6 WP1 + 5 WP2 + 2 WP3-SQLite + ~11 WP3-pgmysql + 2 WP4) |

Nothing needs deleting this phase — a first for this epic. The problem here is not
tests pinning bugs; it is **19 tests aimed at properties that cannot vary**, which is why
four real defects survived four merged phases. Every new test in this spec names the
mutation it is supposed to catch, and WP1/WP3 must demonstrate the failure once.

---

## 8. Test plan

Standard Vitest suite only. No system tests, no browser validation (this phase has no
user-visible surface beyond the digest line in §5.2, which has no UI).

### 8.1 Prerequisites
PostgreSQL on `localhost:5433` and MySQL on `localhost:3307` are already up. Confirm
before starting:
```bash
(exec 3<>/dev/tcp/127.0.0.1/5433) 2>/dev/null && echo "pg up" || echo "PG DOWN"
(exec 3<>/dev/tcp/127.0.0.1/3307) 2>/dev/null && echo "mysql up" || echo "MYSQL DOWN"
```
If either is down, restart with the commands in CLAUDE.md → Multi-Database. A missing
container makes the suites **skip silently** while still reporting `success: true`.

### 8.2 Proving multi-backend tests actually ran (required for WP2 and WP3)
`success: true` is not evidence. Use the JSON reporter and check the skip count:

```bash
npx vitest run <files> --reporter=json --outputFile=/tmp/claude-1000/-home-yeraze-Development-meshmonitor/53db95f3-753a-437d-b735-fb47603d2993/scratchpad/wpN.json
jq '{success, passed:.numPassedTests, failed:.numFailedTests, pending:.numPendingTests}' \
   /tmp/claude-1000/-home-yeraze-Development-meshmonitor/53db95f3-753a-437d-b735-fb47603d2993/scratchpad/wpN.json
```
- **`pending` must be 0** for these files. Any non-zero value means a `describe.skipIf`
  block was skipped — the run does not count.
- Additionally, `settings.test.ts` and the pgmysql suites print
  `✓ PostgreSQL connection established` / `✓ MySQL connection established` on stdout.
  Capture both lines.
- Paste the `jq` output **and** both `✓` lines into the WP's commit message. A WP that
  claims three-backend verification without them is not accepted.

### 8.3 Targeted commands per WP (parallel-safe)
**Concurrent full-suite runs corrupt the shared MySQL test schema** (Phase 3 deviations
log — an agent's parallel `vitest` invocations produced failures in files it never
touched). While WPs run in parallel each runs **only** its own list:

| WP | Command |
|---|---|
| WP1 | `npx vitest run src/server/routes/settingsRoutes.perSource.test.ts src/server/routes/settingsRoutes.test.ts` |
| WP2 | `npx vitest run src/db/repositories/settings.test.ts src/server/routes/sourceRoutes.settingsCleanup.test.ts src/server/routes/unifiedRoutes.perSource.test.ts src/server/routes/settingsRoutes.test.ts` |
| WP3 | `npx vitest run src/server/migrations/050_promote_globals_to_default_source.test.ts src/server/migrations/050_promote_globals_to_default_source.pgmysql.test.ts src/db/migrations.test.ts` |
| WP4 | `npx vitest run src/server/services/securityDigestService.test.ts src/server/services/securityDigestService.perSource.test.ts src/components/MeshCore/` |

**WP2 and WP3 both touch PG/MySQL containers.** If they run concurrently, run WP3's
container half *after* WP2 finishes, or serialise the two. Note it in the ownership table.

### 8.4 Orchestrator-only: the single authoritative full run
After all WPs merge into the branch, **one** run, nothing else executing:
```bash
npx vitest run --reporter=json --outputFile=<scratchpad>/full.json
jq '{success, passed:.numPassedTests, failed:.numFailedTests, pending:.numPendingTests}' <scratchpad>/full.json
```
`success: true` **and** `failed: 0`. Compare `pending` against a pre-change baseline —
it should drop (WP3 adds container tests) and must not rise.

Then: `npm run lint:ci 2>&1 | grep '^FAIL' | grep -v '.claude/worktrees'` → empty.
And `npx tsc --noEmit`.

### 8.5 Mutation checks (required evidence, not optional)
| WP | Mutation | Must fail |
|---|---|---|
| WP1 | revert `:329`/`:330` to `currentSettings.autoAck*` | §2.5 tests 1, 2, 3 |
| WP2 | revert `getSourceSettings` to the `getAllSettings()` + JS filter body | §3.5 test 4 |
| WP3 | restore `import { PER_SOURCE_SETTINGS_KEYS }` and re-point one loop | §4.6 test 1 |
| WP4 | remove the `if (!baseUrl) return null` guard | §5.4 test 1 |
Each WP records the failure output in its commit message.

---

## 9. Work packages, ordering, and file ownership

Four packages, each one Sonnet agent. **All four are independent — no dependencies.** They
may run fully in parallel subject to the container caveat in §8.3.

| WP | Title | Depends on | Size |
|---|---|---|---|
| **WP1** | #4419(a) — scope-correct change detection in `POST /api/settings` | — | S |
| **WP2** | #4419(b) — `getSourceSettings` prefix-scoped query | — | S |
| **WP3** | Migration 050 — freeze the promoted key list + first PG/MySQL coverage | — | **L** (the pgmysql suite is the bulk) |
| **WP4** | `externalUrl` minimal fix + `(local)` deferral comments + 2 issues filed | — | S |

### 9.1 File ownership — no file is written by two packages

| File | Owner |
|---|---|
| `src/server/routes/settingsRoutes.ts` | **WP1** |
| `src/server/routes/settingsRoutes.perSource.test.ts` | **WP1** |
| `src/db/repositories/settings.ts` | **WP2** |
| `src/db/repositories/settings.test.ts` | **WP2** |
| `src/server/migrations/050_promote_globals_to_default_source.ts` | **WP3** |
| `src/server/migrations/050_promote_globals_to_default_source.test.ts` | **WP3** |
| `src/server/migrations/050_promote_globals_to_default_source.pgmysql.test.ts` (new) | **WP3** |
| `src/server/services/securityDigestService.ts` | **WP4** |
| `src/server/services/securityDigestService.test.ts` | **WP4** |
| `src/server/services/securityDigestService.perSource.test.ts` | **WP4** |
| `src/server/constants/settings.ts` | **WP4** (comment only, `:625-631`) |
| `src/utils/meshcoreHelpers.ts` | **WP4** (comment only) |
| `src/components/MeshCore/MeshCoreMap.tsx` | **WP4** (comment only) |
| `src/components/MeshCore/MeshCoreMessageRouteModal.tsx` | **WP4** (comment only) |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_EPIC.md` | **orchestrator only** |
| `docs/internal/dev-notes/PER_SOURCE_NODE_DISPLAY_PHASE5_SPEC.md` | **orchestrator only** |

Read-only for everyone: `src/server/migrations/131_seed_per_source_node_display*.ts`,
`src/server/test-helpers/routeTestApp.ts`, `src/db/migrations.ts`.

**No WP edits the epic doc.** Each reports its deviations in its commit message; the
orchestrator writes the Phase 5 deviations-log section once, at the end. This removes the
only serialisation point between the four packages.

**Read-only file both WP3 and WP4 depend on:** `src/server/constants/settings.ts`. WP3
*reads* `PER_SOURCE_SETTINGS_KEYS` (via the generator command in §4.3) but never writes the
file; WP4 owns the write. WP3 must run its generator **before** WP4's comment edit lands,
or simply re-run it — the array itself is untouched either way, so there is no race.

**Shared-worktree hazard (see auto-memory `feedback_parallel_agents_rtk_commit_hazard`):**
all four WPs run in the same checkout. Commit with an **explicit pathspec**
(`git commit -- <files>`), never a bare `git commit -a` / rtk-wrapped auto-stage, or one
agent sweeps another's in-progress files. Audit the file list on every commit.

### 9.2 Per-package acceptance criteria
See §2.6 (WP1), §3.6 (WP2), §4.8 (WP3). WP4:
- [ ] `npx vitest run src/server/services/securityDigestService.test.ts src/server/services/securityDigestService.perSource.test.ts src/components/MeshCore/` — 0 failures.
- [ ] `grep -c externalUrl src/server/constants/settings.ts` unchanged (2 hits: the
      `PER_SOURCE_SETTINGS_KEYS` entry and the `PER_SOURCE_KEYS_NOT_POSTABLE` entry) and
      `grep -n externalUrl src/server/constants/settings.ts` shows it is **still absent**
      from `VALID_SETTINGS_KEYS`.
- [ ] Both issues filed; their numbers are in the comments, not `TODO` or `#XXXX`.
- [ ] `npm run lint:ci` clean (worktree-filtered).

### 9.3 Phase exit criteria (orchestrator)
- [ ] All four WPs merged into `feature/per-source-settings-followups`.
- [ ] Single authoritative full suite green — §8.4 — with `pending` not risen.
- [ ] `npm run lint:ci` clean, `npx tsc --noEmit` clean.
- [ ] The five mutation checks in §8.5 each demonstrated once.
- [ ] Two issues filed (`externalUrl` product question; `(local)` → `isLocal` flag).
- [ ] Epic deviations log updated with the Phase 5 section, **including** the §4.4
      observation about 050's PG/MySQL per-key round trips.
- [ ] #4419 closable.

---

## 10. Risks for the orchestrator to weigh

1. **The migration-050 frozen list is the one judgement call in this phase.** §4.2 argues
   for today's 170-key snapshot over the 87-key authoring-time list, and the argument turns
   on nine specific keys. If the user's instinct is "a migration should replay exactly what
   it originally did," the 87-key answer is defensible — but it must be a *deliberate*
   choice to stop promoting `maxNodeAgeHours` and the node-dimming/inactive-node group on
   future v3.x upgrades (partly mitigated by migration 131 re-seeding the same ten keys).
   **Worth a one-line confirmation before WP3 starts** — it is cheap to ask and expensive
   to redo, since the frozen list becomes history the moment it ships.
2. **WP3 is materially larger than the other three.** Its pgmysql suite is 050's first
   PG/MySQL coverage and needs `settings` + `sources` + two `auto_*` tables of fixture DDL.
   If the phase needs to fit a smaller budget, the container half is the splittable part:
   the fake-client half alone still proves the freeze. Do not drop the fake-client half —
   it is the only always-runs evidence.
3. **`externalUrl` §5.2 changes digest output.** It removes a line that is broken 100% of
   the time, but it *is* an output change in a notification path with live users. The
   document-only fallback in §5.2 is available; decide before WP4 starts rather than
   reverting after review.
4. **The `(local)` deferral (§6) is a recommendation, not a decision I can make alone.**
   If the user wants it in this epic, it should be Phase 5b or a Phase 7 — not folded into
   these four packages. The blocking question is 6.2(2): proving every `MeshCoreContact`
   producer sets the flag.
5. **Parallel WPs + shared PG/MySQL containers.** WP2 and WP3 both hit `localhost:5433`
   and `:3307`. §8.3 says serialise their container-touching runs; if the orchestrator
   would rather not manage that, run WP3 alone after WP1/WP2/WP4 finish — it is the only
   WP with no logical dependency on ordering anyway.
6. **`settingsRoutes.test.ts` (1,270 lines) is still on the deprecated `vi.mock` pattern.**
   WP1 is explicitly forbidden from touching it (§7 Area 1) to avoid triggering CLAUDE.md's
   opportunistic-conversion rule mid-cleanup. That leaves a known-deprecated file in the
   tree; if a reviewer flags it, the answer is "separate PR," not "convert it now."
7. **19 existing tests would stay green with their area's defect present** (§7). The
   remedy in this spec is per-test mutation evidence (§8.5). If the orchestrator drops that
   requirement to save time, Phase 5 will produce tests with the same blind spot as the ones
   it is auditing.
