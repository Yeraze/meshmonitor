# MeshCore System Tests — Phase 3 Implementation Spec

**Phase 3 goal:** append two assertions to `tests/test-meshcore.sh` after Test 12
(Yeraze Repeater DM auto-ack):

- **Test 13 — Remote-admin login** into the Yeraze Repeater using
  `MESHCORE_REPEATER_ADMIN_PASSWORD`. **SKIP (exit-0) when the env var is
  unset/empty**; when set, log in and hard-assert success.
- **Test 14 — Remote telemetry poll.** Assert a telemetry request round-trips and
  writes at least one record. Design is **repeater-first** to survive the Phase 2
  near-field finding (see §3).

Plus: wire `MESHCORE_REPEATER_ADMIN_PASSWORD` into `system-tests.yml`. No backend
change. No TS change. `api-exercise-test.sh` left as smoke checks (see §4.4).

This spec was written against verified source in the worktree
`/home/yeraze/Development/meshmonitor-meshcore-admin`
(branch `feature/meshcore-system-tests-phase3`). Line numbers below are current as
of writing and are anchors, not hard offsets.

---

## 1. Reuse inventory (what Phase 3 does NOT rebuild)

Phase 3 appends to `tests/test-meshcore.sh` and runs in the **same bash process**
as Tests 1–12, so all of the following are already in scope — do not re-derive:

| Symbol | Where set | Reuse in Phase 3 |
|---|---|---|
| `BASE_URL` | harness top | curl base |
| `COOKIE_FILE` | Test 3 login | session cookie for all curls |
| `CSRF_TOKEN` | Test 3 (re-fetched post-login) | required header on **POST** (`/admin/login`, `/telemetry/poll`) |
| `API_TOKEN` | harness | only needed by the socket helper — **Phase 3 does NOT need it** (both new calls are synchronous request/response) |
| `SRC_A_ID`, `SRC_B_ID` | Test 5 auto-select | source ids of the two live companions |
| `SRC_PUBKEY[$SRC_*_ID]`, `SRC_NAME[...]` | Test 7 (`assert_handshake`, non-`local` assoc arrays) | companion pubkeys (needed only for the opt-in companion-telemetry fallback) |
| `REPEATER_PK` | **Test 12, lines 688–694** — non-`local`, so it persists | **login + telemetry target.** Already resolved via contacts by `advName=="yeraze repeater"` OR (`advType==2` AND name matches `yeraze|repeater`), overridable by `MESHCORE_REPEATER_PUBKEY`. |
| `RED/GREEN/NC` colors | harness top | pass/fail/skip lines |
| `cleanup()` + trap, `mktemp` registration | harness | reuse the temp-file registration pattern for any curl body dumps |
| `meshcore-await-ack.mjs` | `tests/helpers/` | **NOT used by Phase 3** — telemetry poll returns a written-count synchronously; no ACK listener needed |

### Factoring `REPEATER_PK` (recommended, low-risk)
Test 12 resolves `REPEATER_PK` inline (lines 688–694) and the value survives into
Tests 13/14 because it is a plain (non-`local`) global. Two acceptable options:

- **Option A (minimal):** Tests 13/14 simply reuse the existing `$REPEATER_PK` and
  each re-guard `[ -z "$REPEATER_PK" ]`. Zero refactor.
- **Option B (recommended):** extract the resolver into a `resolve_repeater_pk()`
  function defined **before** Test 12, called once, assigning the global
  `REPEATER_PK`. Test 12 then calls it too. This decouples Tests 13/14 from Test
  12's execution order and makes the reuse explicit. Keep the exact jq from line
  688–692 and the `MESHCORE_REPEATER_PUBKEY` override.

Either way, Phase 3 must re-validate that `REPEATER_PK` is a **64-char hex string**
before login (see §2.1 — `/admin/login` rejects non-64-hex with HTTP 400).

---

## 2. Exact API contracts (verified against source)

### 2.1 Remote-admin login — `POST /api/sources/:id/meshcore/admin/login`
`src/server/routes/meshcoreRoutes.ts:1796`.

- **Middleware:** `meshcoreDeviceLimiter`, `requireAuth()`,
  `requirePermission('remote_admin', 'write', { sourceIdFrom: 'params.id' })`.
  The default `admin` user has all permissions, so the harness session passes.
- **Method:** POST → **needs `-b $COOKIE_FILE` + `-H "X-CSRF-Token: $CSRF_TOKEN"`**.
- **Body:** `{ "publicKey": "<64-hex>", "password": "<string>" }`.
  - Omit `rememberPassword` (defaults false). **Do NOT set `rememberPassword:true`** —
    that path needs an explicitly-configured `SESSION_SECRET`; without it the route
    returns HTTP 400 `CREDENTIAL_PERSISTENCE_DISABLED`. We only want a live login.
  - `password` may be empty string (guest login), but Phase 3 always sends the env value.
- **Validation:** non-string `publicKey`/`password` → 400; `publicKey` not 64-char
  hex (`isValidPublicKey`) → 400.
- **Success signal:** **HTTP 200** with body
  `{ "success": true, "message": "Login successful", "persisted": false }`.
- **Failure signal:** **HTTP 401** `{ "success": false, "error": "Login failed" }`
  (bad password / no LoginSuccess frame). 400 = malformed pubkey. 500 = internal.
- **Manager path:** `managerFor(...).loginToNode(pk, pw)` → `sendBridgeCommand('login', {public_key, password})` wrapped in `sendWithDefaultScope` (floods when the path is unknown). Returns non-null `MeshCoreLoginResult` on `response.success`. Local device must be COMPANION (SRC_A is) — otherwise `loginToNode` returns null → route 401.
- **RF reachability:** login is a request→response round-trip to the repeater. The
  repeater is proven reachable by Test 12 (DM auto-ack ~492 ms), so this is expected
  to succeed on the reference rig.

### 2.2 Optional post-login check — `GET /api/meshcore/admin/status/:publicKey`
`meshcoreRoutes.ts:2412`. GET (cookie only, no CSRF). Perm `remote_admin:read`.
`requestNodeStatus(pk)` → `get_status` bridge cmd (15 s). Returns 200
`{ success:true, data:{ batteryMv, uptimeSecs, ... } }` or 404
`{ success:false, error:"No status received" }`.
**Caveat:** `get_status` does **not** require a prior login at the protocol level, so
a 200 here is *not* strong proof the password was accepted — the login 200/401 is the
real assertion. Treat `/admin/status` as an **optional informational** follow-up only.

### 2.3 Remote telemetry poll — `POST /api/sources/:id/meshcore/nodes/:publicKey/telemetry/poll`
`meshcoreRoutes.ts:2736`.

- **Middleware:** `meshcoreDeviceLimiter`, `requireAuth()`,
  `requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' })`.
- **Method:** POST → **needs cookie + CSRF header**.
- **Body:** `{ "type": "status" | "lpp" }`. Any other value → 400.
  - `type:"status"` → `SendStatusReq → StatusResponse` (16-field operational stats:
    battery, uptime, packet counters, RSSI/SNR…). **No login required. Works on any
    reachable Repeater / Room Server.** Companion firmware does **not** ship these
    counters (scheduler skips status for companions).
  - `type:"lpp"` → `GetTelemetryData` binary → Cayenne-LPP sensor records
    (`requestRemoteTelemetry`). Primary for companions with sensors; a repeater may
    also answer LPP once a guest session exists.
- **Response codes:**
  - **200** `{ success:true, data:{ type, written:<number>, sources:<string[]> } }`.
    `written` = telemetry rows written to DB. `sources` = per-path tags e.g.
    `["status:16"]` or `["lpp:3"]`. **`written:0` with `sources:[]` is still HTTP 200**
    and means empty/timeout/no-data. **The success test is `data.written >= 1`, not the
    HTTP status.**
  - **400** invalid pubkey / bad `type`.
  - **409** `MeshCore source is not connected`.
  - **429** `{ success:false, retryAfterSecs:<n> }` + `Retry-After` header — the
    **per-source 60 s mesh-TX gate**. Fires when `<60 s` since the last mesh TX on that
    source. **This is expected in Phase 3** because Test 12 (DM) and Test 13 (login)
    both transmit on `SRC_A_ID` just before Test 14. The poll loop MUST honor
    `Retry-After` and retry, not fail.
  - **503** telemetry scheduler unavailable.
- **Manager path:** route stamps `recordMeshTx()` + `markTelemetryRequested()` then
  calls `scheduler.requestTelemetryForNode(manager, {publicKey, advType}, {includeStatus:type==='status', includeLpp:type==='lpp'})`, which returns `{written, sources}`.

---

## 3. Near-field telemetry analysis + recommended design (the crux)

### 3.1 Is telemetry subject to the Phase 2 near-field limitation?
**Yes, for companion↔companion.** Both `type` paths are RF request→response
round-trips to the *target* node:
- `type:"lpp"` → `request_telemetry` → RF to target, wait for BinaryResponse. This is
  the **same round-trip shape that Phase 2 proved fails between the two ~3-inch-apart
  companions** (near-field receiver overload — broadcasts get through, but the
  directed request→ACK/response does not).
- `type:"status"` → `get_status`/SendStatusReq → RF to target. Also a round-trip;
  **and** companion firmware doesn't emit status counters at all, so even if it
  arrived it would return `written:0`.

So **companion→other-companion telemetry is doubly unlikely** on this rig: LPP dies to
near-field, status returns empty by firmware design.

### 3.2 Does the repeater answer telemetry?
**Yes — via `type:"status"`.** The scheduler comment (verified) states SendStatusReq
"Works on any reachable Repeater / Room Server with no login required, returns the
16-field operational stats blob." The Yeraze Repeater is reachable (Test 12). So a
`type:"status"` poll of `REPEATER_PK` reliably yields `written >= 1`
(`sources:["status:N"]`). `type:"lpp"` on the repeater is *not* guaranteed (depends on
its `telemetry_mode_*` config) — so status is the robust choice.

### 3.3 Interview-vs-reality conflict — flagged
The locked interview answer was "remote poll one companion's telemetry from the other
companion." **That predates the 2026-07-20 near-field finding** and would make the
default suite RED on the reference rig (both failure modes in §3.1). This spec
therefore recommends overriding that decision, consistent with how Phase 2 already
demoted companion↔companion DM to an opt-in. **User to confirm.**

### 3.4 Recommended design — repeater-first, companion opt-in
Mirror the Phase 2 pattern exactly:

- **Primary (hard assertion): poll the Yeraze Repeater with `type:"status"`.**
  Pass when a poll returns HTTP 200 **and** `data.written >= 1`. This keeps the default
  run green on the current rig.
- **Fallback / documentation of the limitation (opt-in, default SKIP):** poll the
  *other companion* with `type:"lpp"`, gated behind `MESHCORE_COMPANION_TELEMETRY=1`
  (parallel to Phase 2's `MESHCORE_COMPANION_DM`). Default = a `⊘ SKIP` line noting the
  near-field limitation. When opted in, treat empty as a soft/skip rather than a hard
  fail (so a rig with separated nodes can exercise it without the default rig failing).

Rejected alternative — "try repeater then companion, pass if EITHER": functionally
green too, but repeater-status is deterministic here, so the extra companion attempt
only adds air-time + a 60 s gate wait for no signal. Repeater-first is cleaner and
matches Phase 2. (If the user prefers the EITHER form, it is a trivial reshaping of the
same primitives.)

### 3.5 The 60 s mesh-TX gate — mandatory handling
Because Test 12 + Test 13 transmit on `SRC_A_ID` immediately before Test 14, the first
poll will very likely 429. The telemetry loop MUST:
1. On **429**: read `retryAfterSecs` (body or `Retry-After` header), sleep that long
   (+1 s), retry — do **not** count as failure.
2. On **200 `written>=1`**: PASS.
3. On **200 `written==0`**: retry after a short interval (empty can be transient RF).
4. Bound the whole thing by `MESHCORE_TELEMETRY_ATTEMPTS` × `MESHCORE_TELEMETRY_INTERVAL`
   (defaults ~5 × 20 s ≈ 100 s + gate) so it can't hang the suite.

Optionally poll from `SRC_B_ID` (the other companion→repeater) to sidestep A's gate —
but simpler to just wait A's gate out. Recommend polling from `SRC_A_ID` for
locality with Tests 12/13.

---

## 4. File-by-file changes

### 4.1 `tests/test-meshcore.sh` — Test 13 (login, skip-if-unset)
Append after Test 12's final `echo ""`. Uses the existing global `REPEATER_PK`.

```bash
echo "Test 13: Yeraze Repeater remote-admin login"
if [ -z "${MESHCORE_REPEATER_ADMIN_PASSWORD:-}" ]; then
  echo -e "${YELLOW}⊘ SKIP${NC}: MESHCORE_REPEATER_ADMIN_PASSWORD not set (login assertion skipped)"
else
  # /admin/login requires a full 64-hex public key; guard before we send.
  if ! printf '%s' "$REPEATER_PK" | grep -Eiq '^[0-9a-f]{64}$'; then
    echo -e "${RED}✗ FAIL${NC}: REPEATER_PK is not a 64-hex key (got '${REPEATER_PK}'); cannot log in"; exit 1
  fi
  LOGIN_BODY=$(mktemp); TMP_FILES+=("$LOGIN_BODY")   # or the harness's temp registration
  LOGIN_CODE=$(curl -s -o "$LOGIN_BODY" -w "%{http_code}" -X POST \
    "$BASE_URL/api/sources/$SRC_A_ID/meshcore/admin/login" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"publicKey\":\"$REPEATER_PK\",\"password\":$(printf '%s' "$MESHCORE_REPEATER_ADMIN_PASSWORD" | jq -R .)}")
  LOGIN_OK=$(jq -r '.success // false' "$LOGIN_BODY" 2>/dev/null)
  if [ "$LOGIN_CODE" = "200" ] && [ "$LOGIN_OK" = "true" ]; then
    echo -e "${GREEN}✓ PASS${NC}: remote-admin login succeeded (repeater ${REPEATER_PK:0:8}…)"
  else
    echo -e "${RED}✗ FAIL${NC}: login HTTP $LOGIN_CODE body=$(cat "$LOGIN_BODY")"; exit 1
  fi
fi
echo ""
```

Notes:
- `jq -R .` safely JSON-escapes the password (handles quotes/specials/spaces).
- Add `YELLOW` to the colors block at the top if not already present
  (`YELLOW='\033[1;33m'`) — Phase 2 uses only RED/GREEN, so this is likely new.
- Register `LOGIN_BODY` for cleanup using whatever the harness already does
  (`TMP_FILES+=` array or a `cleanup()`-referenced var — match the existing style;
  Test 12 uses `mktemp` vars declared up front and cleaned in `cleanup()`).

### 4.2 `tests/test-meshcore.sh` — Test 14 (telemetry, repeater-first)
Append after Test 13.

```bash
echo "Test 14: Remote telemetry poll (Yeraze Repeater, status)"
TELE_ATTEMPTS=${MESHCORE_TELEMETRY_ATTEMPTS:-5}
TELE_INTERVAL=${MESHCORE_TELEMETRY_INTERVAL:-20}
TELE_BODY=$(mktemp); TMP_FILES+=("$TELE_BODY")
tele_ok=false
for attempt in $(seq 1 "$TELE_ATTEMPTS"); do
  CODE=$(curl -s -o "$TELE_BODY" -w "%{http_code}" -X POST \
    "$BASE_URL/api/sources/$SRC_A_ID/meshcore/nodes/$REPEATER_PK/telemetry/poll" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"type":"status"}')
  if [ "$CODE" = "429" ]; then
    RA=$(jq -r '.retryAfterSecs // empty' "$TELE_BODY" 2>/dev/null); RA=${RA:-$TELE_INTERVAL}
    echo "  (attempt $attempt: 60s TX-gate, retry in ${RA}s)"; sleep $((RA + 1)); continue
  fi
  if [ "$CODE" = "200" ]; then
    WRITTEN=$(jq -r '.data.written // 0' "$TELE_BODY" 2>/dev/null)
    if [ "${WRITTEN:-0}" -ge 1 ] 2>/dev/null; then
      tele_ok=true
      echo -e "${GREEN}✓ PASS${NC}: telemetry poll wrote $WRITTEN record(s) ($(jq -c '.data.sources' "$TELE_BODY"))"
      break
    fi
    echo "  (attempt $attempt: HTTP 200 but written=0 / empty; retrying)"
  else
    echo "  (attempt $attempt: HTTP $CODE: $(cat "$TELE_BODY"))"
  fi
  sleep "$TELE_INTERVAL"
done
if ! $tele_ok; then
  echo -e "${RED}✗ FAIL${NC}: no telemetry records from repeater within budget"; exit 1
fi

# Opt-in, default-SKIP companion telemetry (documents the near-field limitation).
if [ "${MESHCORE_COMPANION_TELEMETRY:-}" = "1" ]; then
  echo "  (opt-in) companion->companion LPP telemetry poll..."
  # SRC_A -> SRC_B pubkey, type:lpp, same 429/written loop as above but SOFT:
  #   on empty/timeout print a note and continue (do NOT exit 1) — near-field.
else
  echo -e "${YELLOW}⊘ SKIP${NC}: companion<->companion telemetry (near-field RF; set MESHCORE_COMPANION_TELEMETRY=1 to attempt)"
fi
echo ""
```

Then extend the final summary block (the `echo "=== ... ==="` at the end of Phase 2)
with two lines for login + telemetry status, matching the existing summary style.

### 4.3 `.github/workflows/system-tests.yml` — CI secret
The "Run system tests" step (line 67–68) currently has **no** `env:` block. Add one
scoped to that step:

```yaml
      - name: Run system tests
        run: ./tests/system-tests.sh
        env:
          MESHCORE_REPEATER_ADMIN_PASSWORD: ${{ secrets.MESHCORE_REPEATER_ADMIN_PASSWORD }}
```

(Job-level `env:` at line 44 also works, but step-level keeps the secret scoped to the
one step that needs it.) If the repo secret is absent, the expansion is empty → Test 13
prints `⊘ SKIP` and the suite stays green. Adding the actual secret in repo settings is
the user's responsibility.

### 4.4 `tests/api-exercise-test.sh:602–605` — recommendation: LEAVE AS SMOKE CHECKS
These hit the **legacy non-source-scoped** aliases (`/api/meshcore/status|nodes|
contacts|messages`) tolerating `200 404`. `api-exercise-test.sh` runs against a
**different container** that has no guaranteed MeshCore source, so a 404 is *correct*
there — upgrading to a hard 200 would make that suite flaky/false-fail. The real
MeshCore assertions live in `test-meshcore.sh` (actual hardware). **Do not change**
this block in Phase 3.

---

## 5. Backend / TypeScript changes needed

**None.** Every endpoint, permission, body field, and response field used above exists
in the current tree (`meshcoreRoutes.ts`, `meshcoreManager.ts`,
`meshcoreRemoteTelemetryScheduler.ts`). Phase 3 is pure bash (`test-meshcore.sh`) +
one YAML edit. `typecheck` and the vitest suite are unaffected but must still be run
green as a gate (see §8).

---

## 6. Failure modes / robustness

| Mode | Handling |
|---|---|
| Secret unset | Test 13 `⊘ SKIP`, exit 0. Default local & CI-without-secret stay green. |
| `REPEATER_PK` not 64-hex (contact stored a prefix) | Guard before login → hard fail with a clear message (login would 400 anyway). Overridable via `MESHCORE_REPEATER_PUBKEY`. |
| Wrong password | `/admin/login` 401 → Test 13 hard fail with body echoed. |
| 60 s mesh-TX gate (429) after Tests 12/13 TX | Retry loop honors `retryAfterSecs`/`Retry-After`; not a failure. |
| Repeater answers but `written:0` | Retry within budget; only fail if still 0 after `MESHCORE_TELEMETRY_ATTEMPTS`. |
| Repeater unreachable / RF flake | Bounded by attempts×interval, then hard fail — same class as Test 12's bounded repeater loop. |
| Companion telemetry (near-field) | Opt-in only, default SKIP; even opted-in it's SOFT (note + continue), never fails the default rig. |
| Not connected / scheduler down | 409/503 surfaced in the attempt log; loop exhausts → hard fail with body. |
| Env-tunable timeouts | `MESHCORE_TELEMETRY_ATTEMPTS`, `MESHCORE_TELEMETRY_INTERVAL` (mirror Phase 2's `MESHCORE_REPEATER_ATTEMPTS/INTERVAL`). |

---

## 7. Work packages (Sonnet-sized) + acceptance criteria

- **WP-1: Colors + optional `resolve_repeater_pk()` factor.**
  Add `YELLOW` to the colors block. (Optional, recommended) extract Test 12's
  `REPEATER_PK` resolver into a function called once before Test 12; Test 12 uses it.
  *Accept:* `bash -n` clean; Test 12 still resolves `REPEATER_PK` identically; no
  behavior change to Tests 1–12.

- **WP-2: Test 13 (remote-admin login, skip-if-unset).**
  Implement §4.1 exactly: SKIP when secret empty; 64-hex guard; POST `/admin/login`
  with cookie+CSRF+`jq -R` password; PASS on `200 && .success==true`, else hard fail.
  *Accept:* with secret unset → `⊘ SKIP`, exit 0; with a bad secret (manual) → hard
  fail 401; temp file registered for cleanup.

- **WP-3: Test 14 (repeater-first telemetry) + opt-in companion fallback.**
  Implement §4.2: 429-aware retry loop, PASS on `data.written>=1` from
  `type:"status"` against `REPEATER_PK`; opt-in `MESHCORE_COMPANION_TELEMETRY` block
  default SKIP (soft when enabled).
  *Accept:* default run PASSes on rig (repeater status); loop tolerates ≥1 429; empty
  handled; companion block SKIPs by default.

- **WP-4: Summary + CI secret.**
  Add login/telemetry lines to the end-of-run summary. Add the step-level `env:` in
  `system-tests.yml` (§4.3).
  *Accept:* summary prints login+telemetry outcomes; `yaml` parses; secret absent →
  suite still green.

- **WP-5: Docs.**
  Mark Phase 3 complete in `MESHCORE_SYSTEM_TESTS_EPIC.md` (record the interview-vs-
  near-field override and the repeater-first decision). Reference this spec.
  *Accept:* epic Phase 3 section updated with the shipped design + env vars.

---

## 8. Test plan

- **Static:** `bash -n tests/test-meshcore.sh` (and `system-tests.sh` if touched);
  `node --check tests/helpers/meshcore-await-ack.mjs` (unchanged, sanity only);
  YAML lint / `yq`-parse `system-tests.yml`.
- **Unit/build gate:** `npm run typecheck` + **full** `vitest` suite green (no source
  change expected, but run it per project rule before PR). `npm run lint:ci` exit 0.
- **Live hardware (author-run):**
  - Deploy the two-companion rig (Phase 1/2 harness path).
  - **Test 13:** without the secret → confirm `⊘ SKIP`. With
    `MESHCORE_REPEATER_ADMIN_PASSWORD=<pw>` exported → confirm login PASS. *Note: the
    author may not have the repeater password locally, so Test 13 may only SKIP locally
    and be exercised in CI once the repo secret is added.*
  - **Test 14:** confirm repeater `type:"status"` poll PASSes with `written>=1`
    (expect ≥1 429 first from the Test 12/13 TX gate). Confirm companion block SKIPs by
    default; optionally `MESHCORE_COMPANION_TELEMETRY=1` to observe the near-field soft
    path.
- **CI:** label the PR `system-test`; the hardware runner picks up the new phase
  automatically. Login runs only if the secret exists (else SKIP); telemetry is a hard
  assertion.
