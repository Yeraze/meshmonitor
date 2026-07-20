# MeshCore System Tests — Phase 1 Implementation Spec

**Epic:** `docs/internal/dev-notes/MESHCORE_SYSTEM_TESTS_EPIC.md`
**Branch:** `feature/meshcore-system-tests`
**Scope:** Phase 1 ONLY — harness + connect/handshake for two USB companions.
Messaging (DM/channel), remote-admin login, and remote telemetry are Phases 2/3
and MUST NOT be implemented here.

This spec is written to be executed verbatim by a Sonnet implementer. All paths
are absolute against the worktree
`/home/yeraze/Development/meshmonitor-meshcore-systemtests`.

Deliverables:
1. New file `tests/test-meshcore.sh`.
2. Edits to `tests/system-tests.sh` (wire a new hard-required phase).
3. No TypeScript changes (see §4 for the proof).

---

## 1. Reuse inventory (mandatory — reuse before writing anything new)

`tests/test-meshcore.sh` is a near-clone of the container-mode half of
`tests/test-quick-start.sh`. Every primitive below already exists there; copy the
exact idiom rather than inventing a new one. Line refs are into
`tests/test-quick-start.sh` unless noted.

| Primitive | Source (copy this) | Notes |
|-----------|--------------------|-------|
| Colors block (`GREEN/RED/YELLOW/BLUE/NC`) | L "Colors for output" (top of file) | Copy verbatim. |
| `COMPOSE_FILE` / `CONTAINER_NAME` vars | L18–19 | Rename values (see §3). |
| `cleanup()` + `trap cleanup EXIT` | L "Cleanup function" (L~34–52) + trap | Copy shape; `docker compose -f "$COMPOSE_FILE" down -v`, `rm -f "$COMPOSE_FILE"`, `rm -f /tmp/meshmonitor-mc-cookies.txt`. Add a `KEEP_ALIVE` early-return branch identical to quick-start's so the orchestrator can hold the container. |
| Inline compose heredoc (`cat > "$COMPOSE_FILE" <<EOF ... EOF`) | L73–91 | Model for §3 compose. Add `devices:` (from `docker-compose.dev.local.yml`) + `group_add:` using the **numeric GID `"20"`**, not the name `dialout` (see §3.1 step 3). |
| `docker compose -f "$COMPOSE_FILE" up -d` | L95 | Verbatim. |
| Readiness loop *shape* (`MAX_WAIT=60`, logs-on-fail, `sleep 2` admin-settle after) | L102–129 | Copy the loop STRUCTURE only. **Change the probe** (see §3.1 step 4): poll `GET /api/health` for HTTP 200, **NOT** `/api/poll` grepping `"connection"`. This container boots with **zero sources**, so the `"connection"` string may never appear and a `/api/poll` grep would hang until timeout. Keep the `docker logs` dump on timeout and the trailing `sleep 2`. |
| CSRF fetch (`/api/csrf-token`, `-c cookies`, extract `csrfToken`) | L216–231 (Test 8) | Copy the `grep -o '"csrfToken":"[^"]*"' \| cut -d'"' -f4` extraction verbatim. |
| Login (`POST /api/auth/login`, `X-CSRF-Token`, `admin/changeme`) | L233–249 (Test 9) | Copy verbatim. Credentials: `{"username":"admin","password":"changeme"}`. |
| **Re-fetch CSRF after login** (session regenerates) | L251–263 | MANDATORY — the POST to `/api/sources` is CSRF-protected; a pre-login token 403s. Copy verbatim. |
| Stability-poll loop (accumulate `STABLE_FOR`, reset on flap, `LIVE_MAX_WAIT` cap, print `.`) | L "Test 12b" (the `while [ $LIVE_ELAPSED -lt $LIVE_MAX_WAIT ]` block) | This is the template for the §3 connection-stability gate. Reuse the loop structure exactly; only the polled endpoint and the two `grep -q` predicates change (see §3 step 6). |
| `abort_remaining` / result-var / summary-row idiom | `tests/system-tests.sh` L120–141 (helper), L368–383 (API-Exercise phase), L455–461 (console row), L540–546 (md row), L552 (gate) | Templates for §3's `system-tests.sh` edits. |

**JSON parsing:** `jq` is available on the runner (already used in
`tests/test-v1-api.sh` L255: `jq -r '.token // empty'`). Use `jq -r` for the
source-create response `.id` and for `.data.*` reads from the MeshCore
endpoints. Do **not** hand-roll `grep -o` for nested JSON — reserve the
`grep -q '"field":value'` idiom only for the stability-gate polling (fast,
allocation-free, mirrors Test 12b).

**No new helpers are justified.** Every need maps 1:1 to an existing idiom above.
The only genuinely new logic is "create a MeshCore source and poll its
per-source status", which is a straight application of the existing curl+jq and
stability-loop patterns — not a new abstraction.

---

## 2. Exact API contracts (verified against source)

All reads confirmed in `src/server/routes/sourceRoutes.ts`,
`src/server/routes/meshcoreRoutes.ts`, `src/server/meshcoreConfig.ts`,
`src/server/meshcoreManager.ts`.

### 2.1 Create a MeshCore source
`POST /api/sources` — `requirePermission('sources','write')`
(`sourceRoutes.ts:374`). CSRF-protected; send `X-CSRF-Token` + session cookie.

Request body (JSON):
```json
{
  "name": "MeshCore Companion A",
  "type": "meshcore",
  "enabled": true,
  "config": {
    "transport": "usb",
    "serialPort": "/dev/ttyUSB1",
    "baudRate": 115200,
    "deviceType": "companion",
    "autoConnect": true
  }
}
```
Field rules (from code):
- `type` must be `"meshcore"` (`sourceRoutes.ts:381`).
- `config` must be a non-null object (`sourceRoutes.ts` "config is required").
- `meshcoreConfigFromSource` (`meshcoreConfig.ts`) maps
  `transport ∈ {usb,serial}` (or omitted) **+** `serialPort` (or `port`) →
  `ConnectionType.SERIAL` with `baudRate ?? 115200`, `firmwareType` from
  `deviceType` (`'repeater'` → repeater, else companion).
- `enabled:true` **and** `autoConnect !== false` triggers auto-connect via
  `ensureMeshCoreManagerStarted(source, mcConfig)` at create time
  (`sourceRoutes.ts:471–475`). **No separate `/connect` call is needed.**

**Response:** `201` with the **bare source object** (NOT enveloped):
`res.status(201).json(source)` (`sourceRoutes.ts`). Read the generated id with
`jq -r '.id'`. On error: `4xx/500` with bare `{ "error": "..." }`.

> The generated `id` is the source key used in every subsequent
> `/api/sources/:id/meshcore/*` call. Do **not** use the literal string
> `"default"` — capture the real id per source.

### 2.2 Per-source MeshCore status
`GET /api/sources/:id/meshcore/status` — `optionalAuth()` +
`requirePermission('connection','read', {sourceIdFrom:'params.id'})`
(`meshcoreRoutes.ts:314`).

**Response envelope** (`meshcoreRoutes.ts:320`):
```json
{
  "success": true,
  "data": {
    "connected": true,
    "deviceType": 1,
    "config": { "...": "MeshCoreConfig | null" },
    "localNode": { "publicKey": "…64hex…", "name": "…", "...": "…" },
    "deviceTypeName": "COMPANION"
  }
}
```
- `data.connected` — `boolean` (`getConnectionStatus()`,
  `meshcoreManager.ts:5445`).
- `data.deviceType` — enum int; `MeshCoreDeviceType`: `UNKNOWN=0, COMPANION=1,
  REPEATER=2, ROOM_SERVER=3` (`meshcoreManager.ts:131`).
- `data.deviceTypeName` — string name of the enum, so `"COMPANION"` when
  connected to a companion. **Grep this** — it is the human-readable, stable
  form.
- `data.localNode` — the local node self-info (has `publicKey`, `name`). Present
  only **after** the device-query/handshake completes, so a non-empty
  `data.localNode.publicKey` is a direct proof of handshake success.

### 2.3 Per-source nodes
`GET /api/sources/:id/meshcore/nodes` — `optionalAuth()` +
`requirePermission('nodes','read',{sourceIdFrom:'params.id'})`
(`meshcoreRoutes.ts:408`). Response:
```json
{ "success": true, "data": [ /* MeshCoreNode[] */ ], "count": <n> }
```
`getAllNodes()` merges persisted rows + live contacts + the local node, so
`count >= 1` once the handshake has produced a local node.

### 2.4 Per-source contacts
`GET /api/sources/:id/meshcore/contacts` — same guards
(`meshcoreRoutes.ts:472`). Response:
```json
{ "success": true, "data": [ /* contacts, local node prepended if geo-located */ ], "count": <n> }
```
The device syncs its contact list on connect; both companions already have the
**Yeraze Repeater** (and each other) as contacts, so `count >= 1` is expected
after a stable connect.

---

## 3. File-by-file changes

### 3.1 NEW FILE — `tests/test-meshcore.sh`

`#!/bin/bash` + `set` conventions matching `test-quick-start.sh` (it does **not**
use `set -e`; it checks exit codes explicitly and `exit 1`s on failure). Make it
executable (`chmod +x`).

**Config constants (top of file):**
```bash
COMPOSE_FILE="docker-compose.meshcore-test.yml"
CONTAINER_NAME="meshmonitor-meshcore-test"
VOLUME_NAME="meshmonitor-meshcore-test-data"
BASE_URL="http://localhost:8089"
COOKIE_FILE="/tmp/meshmonitor-mc-cookies.txt"
# Two dialout-accessible companion ports (see §7 "port selection"). Overridable.
MESHCORE_PORT_A="${MESHCORE_PORT_A:-/dev/ttyUSB1}"
MESHCORE_PORT_B="${MESHCORE_PORT_B:-/dev/ttyUSB3}"
# Stability gate timing
STABLE_SECONDS=10
LIVE_MAX_WAIT=120
POLL_INTERVAL=2
# Handshake/contact-sync poll
CONTACT_MAX_WAIT=60
```

> **Port choice:** `8089`. Used host ports across the suite are
> `8080` (reverse-proxy/oidc, message-deletion), `8081` (api-exercise,
> proxy-auth), `8082` (tileserver), `8083` (quick-start, security),
> `8084` (config-import), `8086` (v1-api), `8087` (db-migration source).
> `8089` is free. **Note the epic's suggested `8086` is already taken by
> `test-v1-api.sh` — do not use it.**

**Sections, in order:**

1. **Colors + config constants** — copy the colors block from
   `test-quick-start.sh`; add the constants above.

2. **`cleanup()` + `trap cleanup EXIT`** — mirror `test-quick-start.sh` L34–52:
   - If `KEEP_ALIVE=true`, print the manual-cleanup hint and `return 0`.
   - Else: `docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true`;
     `rm -f "$COMPOSE_FILE"`; `rm -f "$COOKIE_FILE"`; force-stop/rm the container
     by name as a fallback.

3. **Generate `docker-compose.meshcore-test.yml` (inline heredoc)** — model on
   `test-quick-start.sh` L73–91, **plus** the device/group mapping copied
   verbatim from `docker-compose.dev.local.yml`:
   ```bash
   cat > "$COMPOSE_FILE" <<EOF
   services:
     meshmonitor:
       image: meshmonitor:test
       container_name: ${CONTAINER_NAME}
       ports:
         - "8089:3001"
       volumes:
         - ${VOLUME_NAME}:/data
       devices:
         - /dev/ttyUSB0:/dev/ttyUSB0:rw
         - /dev/ttyUSB1:/dev/ttyUSB1:rw
         - /dev/ttyUSB2:/dev/ttyUSB2:rw
         - /dev/ttyUSB3:/dev/ttyUSB3:rw
       group_add:
         - "20"   # dialout GID on the hw runner (getent group dialout -> 20).
                  # Different runner? re-check: getent group dialout
       restart: unless-stopped

   volumes:
     ${VOLUME_NAME}:
   EOF
   ```
   Notes:
   - **No `MESHTASTIC_NODE_IP`** and no `SESSION_SECRET`: we want a MeshCore-only
     install (no Meshtastic TCP source) and the app boots fine with zero sources.
     Omitting `SESSION_SECRET`/`COOKIE_SECURE` matches quick-start's minimal
     config; auto-gen secret + `COOKIE_SECURE=false` default are correct for
     `http://localhost`.
   - The `meshmonitor:test` image is built by `system-tests.sh` Step 1; the
     compose reuses it (no `build:` block).
   - All four `ttyUSB` are mapped verbatim per the locked interview decision even
     though only `ttyUSB1`/`ttyUSB3` are dialout-accessible.
   - **`group_add` MUST be the numeric GID `"20"`, not the name `dialout`.** The
     dev.local override targets the *dev* image; this test runs the *production*
     `meshmonitor:test` image, whose `/etc/group` may lack a `dialout` entry.
     Docker resolves group *names* against the container's `/etc/group` and
     **fails container start** if the name is absent, whereas a numeric GID always
     works. `20` is the host's dialout group (`getent group dialout` → 20) that
     owns ttyUSB1/ttyUSB3. Keep the inline comment so a future reader on a
     different runner knows to re-check `getent group dialout`.

4. **Boot + readiness** — `docker compose up -d`, then poll for HTTP 200 from
   **`GET $BASE_URL/api/health`** (reuse the quick-start loop *shape* from
   L95–129: `MAX_WAIT=60`, `docker logs` dump on timeout + `exit 1`, `sleep 2`
   admin-settle after). Use a status-code probe, not a body grep:
   ```bash
   CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health" 2>/dev/null || echo 000)
   if [ "$CODE" = "200" ]; then echo -e "${GREEN}✓${NC} API is ready"; break; fi
   ```
   **Do NOT** poll `/api/poll` grepping `"connection"`: quick-start only sees that
   string because it has a Meshtastic source from `MESHTASTIC_NODE_IP`; **this
   container boots with zero sources**, so `"connection"` may never appear and the
   loop would hang until timeout. `/api/health` returns 200 unconditionally with
   no source dependency (`apiRouter.use('/health', healthRoutes)` →
   `router.get('/', …)` returns `res.json({...})`).

5. **CSRF + login + re-fetch CSRF** — copy Test 8 / Test 9 / re-fetch
   (`test-quick-start.sh` L216–263) verbatim, swapping the cookie file to
   `$COOKIE_FILE`. End with a valid post-login `$CSRF_TOKEN`.

6. **Create the two companion sources.** For each `(NAME, PORT)` in
   `(Companion A, $MESHCORE_PORT_A)` and `(Companion B, $MESHCORE_PORT_B)`:
   ```bash
   RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/sources" \
       -H "Content-Type: application/json" \
       -H "X-CSRF-Token: $CSRF_TOKEN" \
       -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
       -d "{\"name\":\"$NAME\",\"type\":\"meshcore\",\"enabled\":true,\"config\":{\"transport\":\"usb\",\"serialPort\":\"$PORT\",\"baudRate\":115200,\"deviceType\":\"companion\",\"autoConnect\":true}}")
   HTTP_CODE=$(echo "$RESP" | tail -n1)
   BODY=$(echo "$RESP" | head -n-1)
   SRC_ID=$(echo "$BODY" | jq -r '.id // empty')
   ```
   Assert `HTTP_CODE == 201` and `SRC_ID` non-empty; else print `$BODY` and
   `exit 1`. Store the two ids as `SRC_A_ID` and `SRC_B_ID`.

7. **Connection-stability gate (mirrors Test 12b) — per source.** Define a
   function `wait_stable <SRC_ID> <label>` that runs the Test-12b loop against
   `GET $BASE_URL/api/sources/$SRC_ID/meshcore/status`, requiring **both**
   predicates on the same sample:
   ```bash
   echo "$STATUS" | grep -q '"connected":true'          # data.connected
   echo "$STATUS" | grep -q '"deviceTypeName":"COMPANION"'
   ```
   Accumulate `STABLE_FOR += POLL_INTERVAL` when both match; reset to 0 on any
   miss (print the "flap detected" note like Test 12b); success when
   `STABLE_FOR >= STABLE_SECONDS`; hard-fail + `exit 1` when
   `LIVE_ELAPSED >= LIVE_MAX_WAIT`, printing the last `$STATUS`. Call it for
   `SRC_A_ID` then `SRC_B_ID` (sequential is fine; both lines are independent
   serial handles in the one container).
   - **Timing justification:** serial is a dedicated line — it has none of the
     Meshtastic "single TCP client, firmware force-closes after ~4s" churn that
     forced quick-start's 20s window, so `STABLE_SECONDS=10` is sufficient to
     prove the handshake settled and the manager did not immediately drop.
     `LIVE_MAX_WAIT=120` absorbs slow USB enumeration / device boot.

8. **Handshake / device-query assertion — per source.** After both sources are
   stable, for each `SRC_ID`:
   - **Local node present (primary handshake proof):**
     ```bash
     STATUS=$(curl -s "$BASE_URL/api/sources/$SRC_ID/meshcore/status" -b "$COOKIE_FILE")
     PK=$(echo "$STATUS" | jq -r '.data.localNode.publicKey // empty')
     ```
     Assert `PK` is non-empty (64-hex). A populated `localNode` only exists after
     the companion returns self-info, so this is a direct handshake assertion.
   - **Nodes populated:**
     ```bash
     NODES=$(curl -s "$BASE_URL/api/sources/$SRC_ID/meshcore/nodes" -b "$COOKIE_FILE")
     NODE_COUNT=$(echo "$NODES" | jq -r '.count // (.data | length)')
     ```
     Assert `NODE_COUNT >= 1`.
   - **Contacts populated (with a short poll window).** The device streams its
     contact list asynchronously right after connect, so poll up to
     `CONTACT_MAX_WAIT` for `count >= 1`:
     ```bash
     GET $BASE_URL/api/sources/$SRC_ID/meshcore/contacts
     CONTACT_COUNT=$(echo "$RESP" | jq -r '.count // (.data | length)')
     ```
     Assert `CONTACT_COUNT >= 1` within the window; else `exit 1` with the last
     body. (Both companions have the Yeraze Repeater + each other as contacts,
     so this is reliable — see §7 risk on determinism: Phase 1 does **not**
     require identifying *which* contact is which.)

9. **Success footer** — print a green summary
   (`✓ Both MeshCore companions connected + handshake verified`) and `exit 0`.
   Every failing assertion above must `exit 1` (fail-fast) so the orchestrator's
   `if bash …` branch catches it.

### 3.2 EDITS — `tests/system-tests.sh`

Result var: `MESHCORE_RESULT`. Console label column width: match the existing
`printf`-style alignment (`"MeshCore Hardware Test:   "`). Six edits:

**(a) Cleanup — after L52** (inside `cleanup()`, alongside the other
`docker compose … down -v` lines, ~L50–53), add:
```bash
    docker compose -f docker-compose.meshcore-test.yml down -v 2>/dev/null || true
```
and near the `rm -f docker-compose.*.yml` block (~L77–86) add:
```bash
    rm -f docker-compose.meshcore-test.yml 2>/dev/null || true
```
Also add to the `KEEP_ALIVE` hint list (~L39–42):
```bash
        echo "  docker compose -f docker-compose.meshcore-test.yml down -v"
```

**(b) Phase invocation — insert between L383 (`echo ""` after the API-Exercise
`fi`) and L385 (`# Summary`).** New block (mirror API-Exercise L368–383):
```bash
echo "=========================================="
echo -e "${BLUE}Running MeshCore Hardware Test${NC}"
echo "=========================================="
echo ""

# MeshCore companion connect + handshake against the two USB companions.
# Hard-required (no secret dependency in Phase 1).
if bash "$SCRIPT_DIR/test-meshcore.sh"; then
    MESHCORE_RESULT="PASSED"
    echo ""
    echo -e "${GREEN}✓ MeshCore Hardware test PASSED${NC}"
else
    MESHCORE_RESULT="FAILED"
    echo ""
    echo -e "${RED}✗ MeshCore Hardware test FAILED${NC}"
    abort_remaining "MeshCore Hardware Test"
fi
echo ""
```

**(c) Console summary row — insert after L461** (after the API-Exercise console
`fi`, before the `echo ""` at L463):
```bash
if [ "$MESHCORE_RESULT" = "PASSED" ]; then
    echo -e "MeshCore Hardware Test:   ${GREEN}✓ PASSED${NC}"
else
    echo -e "MeshCore Hardware Test:   ${RED}✗ FAILED${NC}"
fi
```

**(d) Markdown report row — insert after L546** (after the API-Exercise md `fi`,
before the `echo "" >> "$REPORT_FILE"` at L548):
```bash
if [ "$MESHCORE_RESULT" = "PASSED" ]; then
    echo "| MeshCore Hardware Test | ✅ PASSED |" >> "$REPORT_FILE"
else
    echo "| MeshCore Hardware Test | ❌ FAILED |" >> "$REPORT_FILE"
fi
```

**(e) REQUIRED gate — edit L552.** Append to the `if [ … ]; then` condition:
```bash
 || [ "$MESHCORE_RESULT" != "PASSED" ]
```
(insert immediately before the closing `; then`). This makes the phase
hard-required.

**(f) Failed-tests detail — insert in the FAILED branch after L679** (after the
`DB_BACKING` detail block, before the closing banner at ~L681):
```bash
    if [ "$MESHCORE_RESULT" != "PASSED" ]; then
        echo "- **MeshCore Hardware Test:** MeshCore companion connect/handshake test failed" >> "$REPORT_FILE"
    fi
```

> **Do not** add `MESHCORE_RESULT` to any `SKIPPED` branch — Phase 1 never skips.
> (The skip exception in the epic applies only to the Phase 3 remote-admin login
> assertion.)

---

## 4. TypeScript changes needed?

**No.** Every capability the harness exercises already exists and is reachable
non-interactively:
- MeshCore serial companion source creation via `POST /api/sources`
  (`type:"meshcore"`, `config.transport:"usb"`, `serialPort`, `deviceType`,
  `autoConnect`) auto-connects at create time via
  `ensureMeshCoreManagerStarted` (`sourceRoutes.ts:471–475`) — no CLI/interactive
  step.
- `GET …/meshcore/status` already exposes `data.connected`,
  `data.deviceType`/`data.deviceTypeName`, and `data.localNode`
  (`meshcoreRoutes.ts:314–327`) — everything the stability gate and handshake
  assertion need.
- `GET …/meshcore/nodes` and `…/contacts` already return `{success,data,count}`
  (`meshcoreRoutes.ts:408,472`).

Because no product TS is touched, the vitest suite and typecheck are unaffected;
the implementer still runs them (see §5) to satisfy the epic exit criteria, but
no `*.test.ts` needs adding or editing. The system test is a shell script — it is
**not** a vitest test and is not collected by Vitest.

---

## 5. Test plan (how Phase 1 is verified)

1. **Static:** `bash -n tests/test-meshcore.sh` (syntax) and
   `bash -n tests/system-tests.sh` after edits.
2. **Local run (requires the two connected companions on the hw runner):**
   - Build the image the orchestrator uses: `docker build -t meshmonitor:test .`
     (or run once through `system-tests.sh` Step 1).
   - `bash tests/test-meshcore.sh` → expect green: both sources 201-created,
     both reach `connected:true`+`COMPANION` stable ≥10s, both show a non-empty
     `localNode.publicKey`, `nodes.count>=1`, `contacts.count>=1`. Exit 0.
   - Confirm cleanup removed the container/volume/compose file
     (`docker ps -a | grep meshmonitor-meshcore-test` empty).
3. **Orchestrator integration:** run `bash tests/system-tests.sh` on the runner
   (or confirm via the `system-test`-labeled PR CI). Expect the new
   "MeshCore Hardware Test" row PASSED in both the console summary and
   `test-results.md`, and the overall gate still reaches
   `✓ ALL SYSTEM TESTS PASSED` (exit 0).
4. **Suite still green (no TS change, so should be unchanged):**
   `npm run typecheck` and the full `npx vitest run` — both green. Run them
   because the epic exit criteria require it, not because Phase 1 alters TS.
5. **Lint gate:** `npm run lint:ci` must exit 0 (shell scripts are outside the
   ESLint scope; this only guards the no-TS-change claim).

---

## 6. Work-package decomposition

Two packages, ordered. Each is sized for one Sonnet agent.

### WP1 — `tests/test-meshcore.sh` (the harness script)
Implement §3.1 in full: constants, cleanup+trap, inline compose (with the
device/group mapping), `/api/health` HTTP-200 readiness, CSRF+login+re-fetch,
two-source create, per-source stability gate, per-source handshake/nodes/contacts
assertions, success footer. Reuse the idioms in §1 verbatim.
**Depends on:** nothing.
**Acceptance:**
- `bash -n tests/test-meshcore.sh` passes; file is `chmod +x`.
- Against the connected rig, `bash tests/test-meshcore.sh` exits 0 and both
  companions reach a stable `COMPANION` connection with `localNode.publicKey`
  set and `nodes.count>=1` / `contacts.count>=1`.
- On a forced failure (e.g. point `MESHCORE_PORT_A` at a non-existent
  `/dev/ttyUSB9`), the script `exit 1`s at the stability gate with a clear
  message and cleanup still runs.
- Uses port `8089`; readiness via `/api/health` (200), not `/api/poll`; creates a
  fresh named volume; maps all four `ttyUSB` + `group_add: "20"` (numeric GID).

### WP2 — Wire the phase into `tests/system-tests.sh` (+ doc)
Apply the six edits in §3.2 (cleanup, phase invocation, console row, md row,
REQUIRED gate, failed-tests detail). Commit this Phase 1 spec doc and mark
Phase 1 status in the epic doc.
**Depends on:** WP1 (the script must exist for the phase to invoke).
**Acceptance:**
- `bash -n tests/system-tests.sh` passes.
- `grep -c MESHCORE_RESULT tests/system-tests.sh` ≥ 5 (invocation, console row,
  md row, gate, failed-detail).
- The REQUIRED gate line (L552) includes `[ "$MESHCORE_RESULT" != "PASSED" ]`.
- Full `system-tests.sh` run shows the MeshCore row in console + `test-results.md`
  and the overall result reflects it.
- `npm run typecheck` + `npx vitest run` + `npm run lint:ci` green (proves no TS
  regressions were introduced).

*(A third trivial package is not warranted — the doc commit folds into WP2.)*

---

## 7. Risks / assumptions (carried from the epic)

1. **Serial→node non-determinism.** Which physical companion enumerates as
   `ttyUSB1` vs `ttyUSB3` is not guaranteed stable across reboots. **Phase 1 is
   immune:** it only requires *both* sources to reach a stable companion
   connection with populated contacts/nodes — it never needs to know *which*
   companion is on which port. (Phase 2's "B is a contact of A" assertion is
   where identity matters; the survey notes `ttyUSB3` is the CP2102 with a
   stable `by-id` path if a deterministic anchor is later needed.)
2. **Port selection is a fixed rig assumption.** Only `ttyUSB1` and `ttyUSB3` are
   dialout-accessible (the two the `group_add: dialout` grants), so those are the
   two companions. Hardcoding them (with `MESHCORE_PORT_A/B` env overrides) is
   correct for this dedicated runner; enumeration/auto-discovery is
   over-engineering for a known fixture and is explicitly out of scope.
3. **"B is not yet a contact" is Phase 2, not here.** Phase 1 asserts
   `contacts.count>=1` (repeater + peer already in the contact list per the
   locked topology); it does **not** add contacts, exchange adverts, or resolve a
   specific peer key.
4. **Device contention.** The MeshCore container maps all four `ttyUSB` and holds
   the two companion handles for the phase's duration. It runs as its own
   sequential phase on its own port (`8089`) + fresh volume, so it does not
   contend with the Meshtastic-TCP phases (quick-start/config-import/v1-api,
   which talk to `TEST_NODE_IP`, not serial). Two companion sources in the single
   container open two independent serial lines — no intra-container contention.
5. **Fresh-volume source creation.** MeshCore sources are DB rows, not env
   config; the fresh named volume means no pre-seeded sources — the test creates
   both via the API every run. If a prior aborted run left the container/volume,
   `cleanup()` (and the orchestrator's cleanup) removes them; the `up -d` on a
   fresh volume starts from an empty DB (default admin seeded → `admin/changeme`).
6. **Auto-connect is fire-and-forget + error-swallowing.** `sourceRoutes.ts`
   wraps `ensureMeshCoreManagerStarted` in try/catch and only logs on failure, so
   a bad port yields a `201` create but `connected:false` at status time. The
   stability gate is therefore the real connect assertion — it must be the gate
   that fails (with the last `/status` body printed), not the create call.
