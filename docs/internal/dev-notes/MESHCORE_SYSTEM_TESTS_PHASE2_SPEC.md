# MeshCore System-Tests — Phase 2 Implementation Spec (Messaging)

**Status:** ready for a Sonnet implementer. Phase 1 (`tests/test-meshcore.sh`)
is merged; **Phase 2 EXTENDS that same file** (no new bash script) and adds one
small Node helper. This spec is the contract; every API fact below was verified
against the worktree source (paths cited inline).

**Branch / worktree:** `feature/meshcore-system-tests-phase2` at
`/home/yeraze/Development/meshmonitor-meshcore-msg`.

**Goal — three new assertions appended to `test-meshcore.sh` (after Test 7):**
1. **DM A→B** — DM from companion A to companion B, verify **B receives it**
   (B-inbox REST poll = the required proof).
2. **Channel A→B** — create a dedicated `#mm-systest` hashtag channel on **both**
   companions (same slot + same derived PSK), send a channel message A→B on it,
   verify **B receives it** (B-inbox REST poll).
3. **Yeraze Repeater DM auto-ack** — DM the "Yeraze Repeater" contact and verify
   the firmware auto-ack via the Socket.IO `meshcore:send-confirmed` event (the
   only observable proof — we can't read the repeater's inbox).

**No product/TS change is required** (see §4). Everything is reachable through
existing REST + Socket.IO surfaces.

---

## 1. Reuse inventory (build on Phase 1; add the minimum)

### 1.1 What Phase 1 `test-meshcore.sh` already provides (reuse verbatim)
`tests/test-meshcore.sh` runs top-to-bottom and, by the time Test 7 completes,
has these in scope for the appended Phase 2 tests:

| Symbol | Meaning |
|---|---|
| `BASE_URL` | `http://localhost:8089` (container maps host 8089 → 3001). |
| `COOKIE_FILE` | curl cookie jar holding the **authenticated admin session**. |
| `CSRF_TOKEN` | post-login CSRF token (already re-fetched after auth). Refresh again before a long gap if needed — cheap. |
| `CONTAINER_NAME`, `COMPOSE_FILE`, `VOLUME_NAME` | for logs/cleanup. |
| `SRC_A_ID`, `SRC_B_ID` | the two selected companion **source ids**. |
| `PORT_A`, `PORT_B` | their ttyUSB ports (diagnostics only). |
| `SRC_NAME[$id]`, `SRC_PUBKEY[$id]` | assoc arrays: local-node **name** + full 64-hex **publicKey** per source (populated in `assert_handshake`, declared non-`local` so they survive). |
| `cleanup()` + `trap cleanup EXIT` | tears down compose `-v`, removes `COMPOSE_FILE`/`COOKIE_FILE`. Phase 2 must register its temp files for cleanup (see §3.5). |
| Colors `${GREEN}/${RED}/${YELLOW}/${NC}` | reuse for pass/fail lines. |
| `POLL_INTERVAL` | existing poll cadence constant. |

**Auth pattern (reuse):** all REST calls use `-b "$COOKIE_FILE"`; mutating POST/
PUT add `-H "X-CSRF-Token: $CSRF_TOKEN"`. The admin user is an **admin**, so it
bypasses every per-channel / per-source permission gate (important for the
channel PUT, §2.3).

### 1.2 Message round-trip idiom (from `tests/test-quick-start.sh` Test 14)
Send → capture a `since` timestamp → poll the recipient inbox with retry until a
row matching a **unique marker** appears, failing after a generous budget. Phase
2 mirrors this exactly, but polls **B's** MeshCore inbox rather than the
Meshtastic `/api/messages`.

### 1.3 Token idiom (from `tests/test-v1-api.sh:248-255`)
```bash
API_RESPONSE=$(curl -s -X POST "${BASE_URL}/api/token/generate" \
    -b "$COOKIE_FILE" -H "x-csrf-token: $CSRF_TOKEN")
API_TOKEN=$(echo "$API_RESPONSE" | jq -r '.token // empty')
```
`POST /api/token/generate` (session+CSRF) returns `{ token: "mm_v1_..." }`. That
token authenticates the **Socket.IO** handshake (`handshake.auth.token` →
`validateApiTokenAsync`, `webSocketService.ts:146-149`). Phase 2 reuses this to
give the Node helper a bearer credential for the socket.

### 1.4 Why the Node helper is the minimal new artifact
The repeater auto-ack (`meshcore:send-confirmed`) is **Socket.IO only** — never
persisted, never REST-observable (verified: `meshcoreManager.ts:1589-1607`
emits on `send_confirmed` → `dataEventEmitter.emitMeshCoreSendConfirmed`
(`dataEventEmitter.ts:423-431`) → `socket.emit(event.type, event.data)`
(`webSocketService.ts:227/229`)). Bash+curl cannot subscribe to a WebSocket, so
one tiny Node listener is unavoidable. `socket.io-client` is already a repo dep
(`node_modules/socket.io-client`), and the runner has Node ≥20 (global `fetch`),
so this adds **zero install**. Consistent with the suite's existing "shell out
to a small helper" precedent (the Virtual-Node CLI test shells to Python).

---

## 2. Exact API contracts (verified field names)

### 2.1 Send a message
`POST /api/sources/:id/meshcore/messages/send`
(`meshcoreRoutes.ts:1685`, `requireAuth()` = **session cookie only** — Bearer is
NOT accepted here, only on `/api/v1`; verified `authMiddleware.ts` requireAuth/
optionalAuth read `req.session.userId`). CSRF required.

Body: `{ text, toPublicKey?, channelIdx?, scope? }`
- **DM:** set `toPublicKey` = full 64-hex (validated by `isValidPublicKey`, must
  be 64 hex chars). Byte cap 150.
- **Channel:** set `channelIdx` (integer 0-255), omit `toPublicKey`. Byte cap
  130 (no scope) / 120 (scoped).
- Response: **`{ success: true, message: "Message sent" }` only** — no
  messageId, no ack, no delivery info. `400 {success:false,error}` on validation
  / send failure.

### 2.2 Recipient message poll (the required proof)
`GET /api/sources/:id/meshcore/messages?since=<ms>` (`meshcoreRoutes.ts:1393`,
`optionalAuth` + `messages:read`). Returns `{ success, data: MeshCoreMessage[],
count }`. Server filters `m.timestamp > since` (strict `>`; ms epoch).
Also `GET /api/sources/:id/meshcore/messages/channel/:idx` for a per-channel
backlog.

`MeshCoreMessage` inbound fields (`meshcoreManager.ts:474-495`, ingest at
1408-1451):
| Field | DM inbound | Channel inbound |
|---|---|---|
| `text` | DM body | channel body, `"Name: "` prefix already stripped |
| `fromName` | sender contact advName/name | **sender's name** (parsed from `"Name: "` prefix) |
| `fromPublicKey` | sender pubkey **prefix** (not full) | literal **`"channel-<idx>"`** (`channelPublicKey`, line 2130) |
| `toPublicKey` | B's local pubkey | B's local pubkey (broadcast) |
| `timestamp` | ms | ms |

**Match predicate (both tests):** match on the **unique text marker** we sent
(strongest, unambiguous). Optionally also assert `fromName == SRC_NAME[$SRC_A_ID]`
for the channel case. Do **not** match on `fromPublicKey` for DMs (it's only a
prefix).

### 2.3 Create the test channel
`PUT /api/channels/:id` (`channelRoutes.ts:447`, mounted at `/api/channels` via
`server.ts:867`). `requireAuth()` (session) + `requireSourceId('body')` +
per-channel write (`channel_<id>`) — **admin bypasses** the per-channel gate
(line 470). CSRF required.
- **`:id` = the slot index = the `channelIdx`.** You choose it.
- For a **meshcore** source (`sourceType === 'meshcore'`, resolved from the
  `sourceId` in the body) the 0-7 slot cap is lifted (line 463) — higher slots
  allowed.
- Body: `{ sourceId, name, psk, scope? }`.
  - `name` = `#mm-systest` (MeshCore allows up to 31 chars).
  - `psk` = **base64 of exactly 16 bytes** (validator accepts 1/16/32-byte
    base64; we use 16). Derivation in §3.3.
  - `scope` omitted (unscoped hashtag channel).
- Setting the channel on a companion source pushes it to the device
  (CMD_SET_CHANNEL) so it can encrypt/decrypt. **B must be configured too** or it
  cannot decrypt A's channel packet.

### 2.4 List channels (pick a free slot / confirm the idx)
`GET /api/channels?sourceId=<id>` (`channelRoutes.ts:165`, `optionalAuth`).
Returns the source's channels; each row has `id` (= channelIdx), `name`, and
`psk` (raw psk included only for write-scoped callers — admin qualifies).
Response may be a bare array or an envelope depending on the route branch — the
implementer must `jq` defensively: `jq -r '(.data // .) | ...'`. Use it to
enumerate **used slot ids on both A and B** and to confirm the channel persisted
after PUT.

### 2.5 Resolve a contact (the repeater)
`GET /api/sources/:id/meshcore/contacts` (`meshcoreRoutes.ts:472`). Returns
`{ success, data: MeshCoreContact[], count }`; rows have `publicKey` (full
64-hex), `advName?`, `name?`, `advType?` (COMPANION=1, **REPEATER=2**). No
resolve-by-name endpoint — filter client-side (§3.4). Extract `publicKey` for
`toPublicKey`.

### 2.6 Token + Socket.IO
- Token: `POST /api/token/generate` (§1.3) → `{token}`.
- Socket: connect to `BASE_URL` with `path: '/socket.io'`, `auth: { token }`.
  A socket that connects and does **not** call `join-source` has
  `sourceRooms.length === 0`, so the per-source filter is skipped and it receives
  **all** events globally (`webSocketService.ts:182-229`).
- Event: `meshcore:send-confirmed`, payload `{ sourceId, ackCode, roundTripMs }`
  (`dataEventEmitter.ts:425-427`). Emitted **only for DM ACKs**, never channel
  sends (`meshcoreManager.ts:1589`). Correlate by `sourceId === SRC_A_ID` (only
  our one DM is in flight on that source in the window).

---

## 3. File-by-file changes

### 3.1 New file: `tests/helpers/meshcore-await-ack.mjs` (WP1)
Pure Socket.IO **listener** (the send is done by Bash — see §3.6 rationale:
`requireAuth` on the send route is session-only, so the helper cannot POST with
its bearer token; keeping send in Bash uses the proven cookie+CSRF path and
avoids duplicating auth). Coordination via a `READY` line on stdout.

Full source:
```js
#!/usr/bin/env node
// Phase 2 helper: subscribe to Socket.IO and resolve when a MeshCore DM
// firmware auto-ack (meshcore:send-confirmed) arrives for a given source.
// The actual DM send is performed by the calling bash script (session+CSRF);
// this process only listens. Coordination: prints "READY" once connected+
// listening so bash knows it is safe to start sending.
//
// Env:
//   BASE_URL      e.g. http://localhost:8089
//   TOKEN         API bearer token (mm_v1_...) for the socket handshake
//   SOURCE_ID     source id to match on the ack event (the sender, = SRC_A_ID)
//   TIMEOUT_MS    overall wait budget after connect (default 90000)
// Output (stdout): "READY" once listening; "ACK sourceId=.. ackCode=.. rttMs=.."
// on success. Diagnostics go to stderr.
// Exit: 0 = ack seen; 1 = timeout; 2 = connect/setup error.
import { io } from 'socket.io-client';

const { BASE_URL, TOKEN, SOURCE_ID } = process.env;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '90000', 10);
if (!BASE_URL || !TOKEN || !SOURCE_ID) {
  console.error('missing env (BASE_URL, TOKEN, SOURCE_ID)');
  process.exit(2);
}

const socket = io(BASE_URL, {
  path: '/socket.io',
  auth: { token: TOKEN },
  transports: ['websocket', 'polling'],
  reconnection: true,
  timeout: 10000,
});

let done = false;
const finish = (code) => { if (done) return; done = true; try { socket.close(); } catch {} process.exit(code); };

socket.on('meshcore:send-confirmed', (data) => {
  // No join-source => all events arrive globally. Correlate by sourceId.
  if (data && data.sourceId && data.sourceId !== SOURCE_ID) return;
  console.log(`ACK sourceId=${data?.sourceId} ackCode=${data?.ackCode} rttMs=${data?.roundTripMs}`);
  finish(0);
});

socket.on('connect', () => { console.log('READY'); });
socket.on('connect_error', (e) => { console.error('connect_error:', e?.message || e); });

const connectDeadline = setTimeout(() => {
  if (!socket.connected) { console.error('socket did not connect within 12s'); finish(2); }
}, 12000);
socket.on('connect', () => clearTimeout(connectDeadline));

setTimeout(() => { console.error(`no ack within ${TIMEOUT_MS}ms`); finish(1); }, TIMEOUT_MS + 12000);
```
Notes for the implementer:
- Run it with cwd = repo root (worktree) so `socket.io-client` resolves from the
  worktree `node_modules`. `.mjs` → ESM `import` works with the repo's Node.
- `console.log('READY')` on **every** `connect` is fine (bash greps for the first
  occurrence). Keep `ACK`/`READY` on stdout, everything else on stderr.

### 3.2 `tests/test-meshcore.sh` — appended sections (WP2)
Insert **after Test 7** (before the final success banner / `exit 0`). Add temp
files to `cleanup()` (`ACK_OUT`, `ACK_ERR`). Structure:

**Test 8 — Acquire API token (for the socket helper):**
```bash
echo "Test 8: Acquire API token for Socket.IO helper"
API_TOKEN=$(curl -s -X POST "$BASE_URL/api/token/generate" \
    -b "$COOKIE_FILE" -H "x-csrf-token: $CSRF_TOKEN" | jq -r '.token // empty')
[ -n "$API_TOKEN" ] || { echo -e "${RED}✗ FAIL${NC}: no API token"; exit 1; }
echo -e "${GREEN}✓${NC} API token acquired"
```

**Test 9 — DM A→B (verify B receives):**
```bash
DM_MARKER="mm-systest-dm-$$-$(date +%s)"
SINCE=$(( $(date +%s%3N) - 2000 ))
B_PK="${SRC_PUBKEY[$SRC_B_ID]}"   # full 64-hex from Phase 1 handshake
DM_ATTEMPTS=${MESHCORE_DM_ATTEMPTS:-3}
DM_POLL_SECONDS=${MESHCORE_DM_POLL_SECONDS:-30}
recv_ok=false
all_sends_400=true      # flips false the moment any send is not a 400
for attempt in $(seq 1 "$DM_ATTEMPTS"); do
  # Capture the send HTTP status so a rejected send (400 = bad/unroutable
  # pubkey, target-not-a-contact) is visible instead of silently burning the
  # poll budget and mis-reporting "never received".
  SEND_CODE=$(curl -s -o "/tmp/mc_send.$$" -w "%{http_code}" -X POST \
    "$BASE_URL/api/sources/$SRC_A_ID/meshcore/messages/send" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"text\":\"$DM_MARKER\",\"toPublicKey\":\"$B_PK\"}")
  [ "$SEND_CODE" = "400" ] || all_sends_400=false
  [ "$SEND_CODE" = "200" ] || echo "  (DM send attempt $attempt returned HTTP $SEND_CODE: $(cat "/tmp/mc_send.$$"))"
  waited=0
  while [ $waited -lt "$DM_POLL_SECONDS" ]; do
    HIT=$(curl -s "$BASE_URL/api/sources/$SRC_B_ID/meshcore/messages?since=$SINCE" -b "$COOKIE_FILE" \
      | jq -r --arg m "$DM_MARKER" '(.data // [])[] | select(.text==$m) | .text' | head -n1)
    [ "$HIT" = "$DM_MARKER" ] && { recv_ok=true; break; }
    sleep "$POLL_INTERVAL"; waited=$((waited+POLL_INTERVAL))
  done
  $recv_ok && break
  echo "  (DM attempt $attempt: not yet received, retrying)"
done
if $recv_ok; then
  echo -e "${GREEN}✓ PASS${NC}: B received DM from A"
elif $all_sends_400; then
  # A consistent 400 is not RF loss — retrying won't fix it.
  echo -e "${RED}✗ FAIL${NC}: all DM sends rejected HTTP 400 — target pubkey not a contact / invalid (B_PK=$B_PK)"; exit 1
else
  echo -e "${RED}✗ FAIL${NC}: B never received DM after $DM_ATTEMPTS attempts"; exit 1
fi
```

**Send-status capture (Tests 11 & 12 too):** apply the same `-o "/tmp/mc_send.$$"
-w "%{http_code}"` pattern to the channel send (Test 11) and every repeater send
(Test 12); print a line whenever the code ≠ 200 so a rejected send is obvious,
and keep retrying only for transient (5xx) codes. Test 11 (channel) has no ACK
and no unique-target routing, so a consistent 400 there most likely means a bad
`channelIdx` — emit that hint after the loop. Test 12 (repeater) applies the same
"all sends 400 ⇒ bad/unroutable repeater pubkey, don't blame RF" distinct
diagnostic as Test 9. Register `/tmp/mc_send.$$` in `cleanup()` (§3.5).

**Test 10 — Create `#mm-systest` on both companions:**
- Compute PSK (§3.3).
- Pick a **free slot** free on **both** A and B:
```bash
USED=$( { curl -s "$BASE_URL/api/channels?sourceId=$SRC_A_ID" -b "$COOKIE_FILE";
          curl -s "$BASE_URL/api/channels?sourceId=$SRC_B_ID" -b "$COOKIE_FILE"; } \
        | jq -r '(.data // .)[]?.id' | sort -un )
SLOT=${MESHCORE_TEST_CHANNEL_SLOT:-}
if [ -z "$SLOT" ]; then
  for c in 1 2 3 4 5 6 7; do echo "$USED" | grep -qx "$c" || { SLOT=$c; break; }; done
fi
[ -n "$SLOT" ] || { echo -e "${RED}✗ FAIL${NC}: no free channel slot"; exit 1; }
```
- PUT the same name/psk/slot on both:
```bash
for SID in "$SRC_A_ID" "$SRC_B_ID"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE_URL/api/channels/$SLOT" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"sourceId\":\"$SID\",\"name\":\"#mm-systest\",\"psk\":\"$PSK_B64\"}")
  [ "$CODE" = "200" ] || { echo -e "${RED}✗ FAIL${NC}: channel PUT on $SID => HTTP $CODE"; exit 1; }
done
# Confirm persisted on both (idx == SLOT):
```
(Give the device a few seconds to apply, then optionally GET `/api/channels` and
assert a row with `id==$SLOT` and `name=="#mm-systest"` exists on both.)

**Test 11 — Channel message A→B on `#mm-systest` (verify B receives):**
Same shape as Test 9 but send with `channelIdx=$SLOT` (no `toPublicKey`) and poll
`GET /api/sources/$SRC_B_ID/meshcore/messages/channel/$SLOT` (fall back to
`/messages?since=` and filter `fromPublicKey=="channel-<SLOT>"`). Channel sends
are **unacked/best-effort** → more attempts, e.g.
`MESHCORE_CHAN_ATTEMPTS=${...:-4}`, `MESHCORE_CHAN_POLL_SECONDS=${...:-25}`. Match
on the unique marker; optionally also assert `fromName == "${SRC_NAME[$SRC_A_ID]}"`.

**Test 12 — Yeraze Repeater DM auto-ack (helper):**
```bash
echo "Test 12: Yeraze Repeater DM firmware auto-ack"
REPEATER_PK=$(curl -s "$BASE_URL/api/sources/$SRC_A_ID/meshcore/contacts" -b "$COOKIE_FILE" \
  | jq -r '(.data // [])
      | ( map(select((.advName // "")|ascii_downcase == "yeraze repeater")) )
      + ( map(select((.advType==2) and (((.advName // .name // "")|ascii_downcase)|test("yeraze|repeater")))) )
      | .[0].publicKey // empty')
REPEATER_PK=${MESHCORE_REPEATER_PUBKEY:-$REPEATER_PK}
if [ -z "$REPEATER_PK" ]; then
  echo -e "${RED}✗ FAIL${NC}: no 'Yeraze Repeater' contact on source $SRC_A_ID"; exit 1
fi

ACK_OUT=$(mktemp); ACK_ERR=$(mktemp)   # register both in cleanup()
TIMEOUT_MS=$(( ${MESHCORE_REPEATER_ATTEMPTS:-4} * ${MESHCORE_REPEATER_INTERVAL:-20} * 1000 + 10000 ))
BASE_URL="$BASE_URL" TOKEN="$API_TOKEN" SOURCE_ID="$SRC_A_ID" TIMEOUT_MS="$TIMEOUT_MS" \
  node "$(dirname "$0")/helpers/meshcore-await-ack.mjs" >"$ACK_OUT" 2>"$ACK_ERR" &
HELPER_PID=$!

# Wait for READY (helper connected + listening) before sending.
for _ in $(seq 1 15); do grep -q READY "$ACK_OUT" && break; sleep 1; done
grep -q READY "$ACK_OUT" || { echo -e "${RED}✗ FAIL${NC}: helper never became READY"; cat "$ACK_ERR"; kill $HELPER_PID 2>/dev/null; exit 1; }

RPT_MARKER="mm-systest-rpt-$$-$(date +%s)"
rpt_all_400=true
for attempt in $(seq 1 "${MESHCORE_REPEATER_ATTEMPTS:-4}"); do
  grep -q '^ACK ' "$ACK_OUT" && break
  SEND_CODE=$(curl -s -o "/tmp/mc_send.$$" -w "%{http_code}" -X POST \
    "$BASE_URL/api/sources/$SRC_A_ID/meshcore/messages/send" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"text\":\"$RPT_MARKER-$attempt\",\"toPublicKey\":\"$REPEATER_PK\"}")
  [ "$SEND_CODE" = "400" ] || rpt_all_400=false
  [ "$SEND_CODE" = "200" ] || echo "  (repeater send attempt $attempt returned HTTP $SEND_CODE: $(cat "/tmp/mc_send.$$"))"
  sleep "${MESHCORE_REPEATER_INTERVAL:-20}"
done
wait $HELPER_PID; HELPER_RC=$?
if [ "$HELPER_RC" = "0" ]; then
  echo -e "${GREEN}✓ PASS${NC}: repeater auto-ack ($(grep '^ACK ' "$ACK_OUT"))"
elif $rpt_all_400; then
  echo -e "${RED}✗ FAIL${NC}: all repeater sends rejected HTTP 400 — repeater pubkey not a contact / invalid (REPEATER_PK=$REPEATER_PK)"; cat "$ACK_ERR"; exit 1
else
  echo -e "${RED}✗ FAIL${NC}: no repeater auto-ack (helper rc=$HELPER_RC)"; cat "$ACK_ERR"; exit 1
fi
```

Update the final banner to mention the three messaging assertions.

### 3.3 Secret derivation (Bash, host/runner — `openssl` guaranteed present)
`deriveHashtagSecretHex` (`src/utils/meshcoreHelpers.ts:167`) =
`SHA-256("#mm-systest")[0:16]`, name hashed **verbatim incl. leading `#`**,
case-sensitive. We need base64 of those 16 bytes:
```bash
PSK_B64=$(printf '%s' '#mm-systest' | openssl dgst -sha256 -binary | head -c 16 | base64)
```
`printf '%s'` (no trailing newline) → 32 raw SHA-256 bytes → first 16 → base64
(24 chars, `Buffer.from(psk,'base64').length===16` ✓). `openssl` + `base64` are
present on the Linux self-hosted runner. (If a name other than `#mm-systest` is
ever used, keep the literal identical in the `printf` and the PUT `name`.)

### 3.4 Repeater contact tolerant match
Primary: `advName` equals "Yeraze Repeater" (case-insensitive). Fallback: first
contact with `advType==2` (REPEATER) whose `advName`/`name` matches
`/yeraze|repeater/i`. Env override `MESHCORE_REPEATER_PUBKEY` wins. Not found →
**hard FAIL** (the repeater is a rig invariant per the epic; a silent skip would
hide a real regression). The override + clear diagnostic keep it operable if the
rig's advName drifts.

### 3.5 `cleanup()` additions
Add `rm -f "$ACK_OUT" "$ACK_ERR" "/tmp/mc_send.$$" 2>/dev/null` and a
`kill $HELPER_PID 2>/dev/null`
guard so a mid-test abort doesn't leak the node process. Deleting the
`#mm-systest` channel on teardown is **not required** (fresh named volume each
run), but a best-effort `DELETE /api/channels/$SLOT?sourceId=...` is acceptable.

### 3.6 `tests/system-tests.sh` — NO change needed (confirmed)
The Phase-1 "MeshCore Hardware Test" phase already invokes `test-meshcore.sh` as
a hard-required phase; the new Tests 8-12 run **inside** that same script
invocation. No new phase, no new result var. (Verified against the Phase-1
outcome notes in `MESHCORE_SYSTEM_TESTS_EPIC.md`.) State this explicitly in the
PR description so reviewers don't expect a `system-tests.sh` diff.

---

## 4. Backend / TS change needed?
**None.** Every assertion is reachable today:
- DM + channel send: `POST .../messages/send` (exists).
- B receipt: `GET .../messages` + `.../messages/channel/:idx` (exist, `since`
  supported).
- Channel create: `PUT /api/channels/:id` with meshcore slot-cap lift (exists).
- Repeater ack: `meshcore:send-confirmed` reaches a no-room socket globally
  (exists). The helper is a **test artifact**, not product code.

If, on hardware, the channel PUT turns out **not** to push to the companion (B
never decrypts despite both configured), that is a real product finding to file
separately — but the existing `deriveHashtagSecretHex` + CMD_SET_CHANNEL path
(referenced in the epic) indicates it does. Do not pre-emptively add TS.

---

## 5. Failure modes + robustness (RF is lossy)
| Risk | Mitigation |
|---|---|
| DM A→B dropped | `MESHCORE_DM_ATTEMPTS=3`, `MESHCORE_DM_POLL_SECONDS=30` each (≈90s budget). MeshCore DMs also have firmware ACK+retry underneath. |
| Channel A→B missed (unacked) | `MESHCORE_CHAN_ATTEMPTS=4`, `MESHCORE_CHAN_POLL_SECONDS=25` (≈100s). |
| Repeater ack lost | helper deadline = `attempts*interval*1000 + slack`; bash sends up to `MESHCORE_REPEATER_ATTEMPTS=4` spaced `MESHCORE_REPEATER_INTERVAL=20`s; break early once `ACK` appears. |
| Connect/send race (repeater) | `READY` handshake — bash sends only after the helper prints `READY`. |
| Stale inbox rows | unique per-run marker (`$$`+epoch) + `since` filter. |
| Marker too long | markers are ~22 chars, well under DM 150 / channel 130 byte caps. |
| Channel wrong slot | same `SLOT` PUT on both; poll `/messages/channel/$SLOT`; `fromPublicKey=="channel-$SLOT"`. |
| **Send rejected but blamed on RF** | every send captures the HTTP status (§3.2); a `≠200` is printed immediately, and a **consistent 400** across all attempts triggers a distinct "target pubkey not a contact / invalid" (or bad `channelIdx`) diagnostic instead of the misleading "never received". Transient 5xx still retries. |
| **Never touch Primary** | all channel traffic on the dedicated `#mm-systest` slot; DMs are point-to-point. No Primary/`gauntlet` use. |

All timeouts are env-overridable so a slow rig can be tuned without editing the
script. Defaults chosen to be reliable, not fast (total added runtime ≈ 3-5 min).

### 5.1 Live-validation watch-list (diagnostic breadcrumbs — no code change)
Because A and B are **both companions on the same MeshMonitor instance**, if
Test 9 (DM A→B) fails *despite a clean HTTP 200 send*, check, in order:
1. **Self-origin guard (#3914):** MeshMonitor drops own-node events per source
   (`onMeshCoreMessage`). A→B *should* be unaffected — A and B are distinct
   pubkeys and, from source B's perspective, the sender A is not "self" — but if
   B's inbox never shows the DM despite the 200, the self-origin guard in
   `onMeshCoreMessage` is the **first** place to look.
2. **A must have B as a contact** to route the DM by `toPublicKey` (assumed true
   per the epic — both are mutual contacts). A consistent 400 on the send makes
   this concrete (handled by the all-sends-400 diagnostic); a 200 that never
   arrives is the case to inspect here **second**.

These are breadcrumbs for the person running the hardware validation, not spec
or code changes.

---

## 6. Work-package decomposition (ordered, Sonnet-sized)

### WP1 — Node ACK helper *(do first; independent)*
Create `tests/helpers/meshcore-await-ack.mjs` exactly per §3.1.
**Acceptance:**
- `node --check tests/helpers/meshcore-await-ack.mjs` passes.
- Prints `READY` on connect, `ACK ...` on a matching event, exits 0/1/2 per
  contract.
- Correlates by `SOURCE_ID`; does **not** join a source room.
- Resolves `socket.io-client` from the worktree (run with cwd = repo root).

### WP2 — Bash assertions + secret derivation *(depends on WP1)*
Append Tests 8-12 to `tests/test-meshcore.sh` per §3.2-3.5; extend `cleanup()`.
**Acceptance:**
- `bash -n tests/test-meshcore.sh` clean.
- `PSK_B64` derivation matches `deriveHashtagSecretHex('#mm-systest')` (verify:
  `printf '%s' '#mm-systest' | openssl dgst -sha256 -binary | head -c16 | xxd -p`
  equals `deriveHashtagSecretHex` hex output; base64 round-trips to 16 bytes).
- Free-slot selection avoids ids used on either source; `MESHCORE_TEST_CHANNEL_SLOT`
  overrides.
- Repeater match is tolerant (§3.4) with `MESHCORE_REPEATER_PUBKEY` override and
  hard-fail-if-absent.
- All three assertions gate the script's exit code; final banner updated.
- No `system-tests.sh` edit (§3.6).

---

## 7. Test plan
1. `bash -n tests/test-meshcore.sh` — syntax.
2. `node --check tests/helpers/meshcore-await-ack.mjs` — helper syntax.
3. **No product TS changed** ⇒ full Vitest suite + typecheck must remain green
   exactly as Phase 1 left them (run `npm run typecheck` and the full Vitest
   suite; confirm 0 failures via JSON reporter, per the `rtk` gotcha — don't
   trust the summary line).
4. Sanity of PSK derivation (WP2 acceptance bullet above).
5. **Live hardware validation** (user runs on the `meshmonitor-hw` rig): build
   `meshmonitor:test`, `bash tests/test-meshcore.sh`; expect Tests 8-12 to pass —
   B receives the DM and the channel message on `#mm-systest`, and the repeater
   returns a `meshcore:send-confirmed` auto-ack. Tune env timeouts if RF is slow.

---

## 8. Risks
- **Free-slot selection:** MeshCore companions may already use slot 0 (public).
  We scan both sources' used ids and pick the first free 1-7; env override
  escape hatch. If a companion caps channel count below the chosen slot, the PUT
  400s → clear failure, retune via `MESHCORE_TEST_CHANNEL_SLOT`.
- **B must have the channel to receive:** we PUT `#mm-systest` on **both** A and
  B with the identical derived PSK and slot before sending; the receive
  assertion is the end-to-end proof. If B never decrypts, that's a genuine
  product finding (see §4), not a test bug to paper over.
- **Repeater contact naming drift:** tolerant match + `advType==2` fallback +
  `MESHCORE_REPEATER_PUBKEY` override; hard-fail (not skip) if truly absent so a
  vanished contact surfaces as a red test.
- **RF flakiness:** retries + generous poll windows (§5); channel path has no
  ACK so it gets the most attempts. Repeater ack uses the `READY` handshake to
  avoid missing the event.
- **Socket auth split (verified, mitigated):** the send route is session-only
  (`requireAuth`); the socket is bearer/session. Hence Bash sends (cookie+CSRF)
  and the helper only listens (bearer) — no auth duplication, no Bearer-on-send
  400.
- **Same-instance A/B (self-origin guard + contact routing):** A and B are two
  companions on one MeshMonitor process, so a DM A→B crosses the self-origin
  guard (#3914) and depends on A having B as a contact. Expected to be fine, but
  if a 200-send DM never lands in B's inbox, follow the §5.1 watch-list
  (self-origin guard in `onMeshCoreMessage` first, A-has-B-as-contact second).
  Diagnostic only — not a pre-emptive code change.
