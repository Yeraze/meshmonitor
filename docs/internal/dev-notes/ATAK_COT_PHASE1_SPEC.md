# ATAK / CoT Epic — Phase 1 Implementation Spec

**Issue:** #3691 (epic). **Phase 1:** TAKPacket V1 decode + Packet Monitor previews + GeoChat → Messages.
**Scope:** RX-only. Decode portnum 72 (`ATAK_PLUGIN` → `meshtastic.TAKPacket`); label 78 (`ATAK_PLUGIN_V2`) and 257 (`ATAK_FORWARDER`) without decoding; persist GeoChat variants as message rows.
**Out of scope (this phase):** sending TAKPackets, V2 (zstd) decode, unishox2 decompression, ATAK contact table + map layer (Phase 2), CoT feed (Phase 3).

All line anchors below were verified against the worktree `/home/yeraze/Development/meshmonitor-atak-phase1` at spec time. They **will drift** as the files change — re-verify with grep/serena before editing. Every symbol/signature cited was read from source.

---

## 1. Reuse inventory (mandatory — use these, do not reinvent)

### Decode path
- **`meshtasticProtobufService.processPayload(portnum: number, payload: Uint8Array): any`** — `src/server/meshtasticProtobufService.ts:855`. A `switch (portnum)` (opens at **:865**, `default:` returns raw `payload` at **:920–921**) that decodes each known port via `root.lookupType('meshtastic.<Type>').decode(payload)`. The whole switch is wrapped in `try { … } catch (error) { logger.error(...); return payload; }` (**:922–925**) — **decode throws never propagate**; they return the raw `Uint8Array`. This is the existing crash-safety guarantee we rely on for malformed TAKPackets. Add the port-72 case here, exactly mirroring `case PortNum.POSITION_APP` / `case PortNum.MESH_BEACON_APP` (**:914–919**, the closest precedent — a `{ }`-scoped case doing one `lookupType`+`decode`).
- **`getProtobufRoot()`** (imported in that file) — returns the loaded protobufjs `Root`; the TAK types are `meshtastic.TAKPacket`, and its nested `meshtastic.TAKPacket.GeoChat` / `.PLI` / `.Contact` / `.Group` / `.Status`. Verified present in the pinned submodule at `protobufs/meshtastic/atak.proto` (message `TAKPacket` at :15 with `oneof payload_variant { PLI pli=5; GeoChat chat=6; bytes detail=7 }`, `bool is_compressed=1`, `Contact contact=2`, `Group group=3`, `Status status=4`).
- **`PortNum` constants** — `src/server/constants/meshtastic.ts` already defines `ATAK_PLUGIN: 72` (:43), `ATAK_PLUGIN_V2: 78` (:49), `ATAK_FORWARDER: 257` (:52). **No constants change needed.** Both `meshtasticProtobufService.ts` and `meshtasticManager.ts` import `PortNum` from there and already reference `PortNum.ATAK_PLUGIN`-style members.
- **`getPortNumName(portnum)`** — `meshtasticProtobufService.ts:1005` and the mirror `getPortNumName()` in `constants/meshtastic.ts:193`. Both already map 72/73/78/257 to names (`ATAK_PLUGIN`, `ATAK_PLUGIN_V2`, `ATAK_FORWARDER`). **No change needed** — the port name shown in the Packet Monitor is already correct.
- **`normalizePortNum(portnum)`** — `meshtasticProtobufService.ts` (~:930). Already maps `'ATAK_PLUGIN' → 72` etc. **No change needed.**

### Preview + packet-log path (Packet Monitor)
- **`meshtasticManager.processMeshPacket(...)`** — the packet-log block runs `if (await packetLogService.isEnabled())` (~:5383). Inside:
  - `const portnum = meshPacket.decoded?.portnum ?? 0;` (~:5396). **Existing branches compare this raw value against numeric `PortNum.*`** (e.g. `portnum === PortNum.TEXT_MESSAGE_APP`) — follow that same convention (numeric compare); do not re-normalize here.
  - `let decodedPayload: any = null;` then, for non-encrypted packets, `decodedPayload = meshtasticProtobufService.processPayload(portnum, meshPacket.decoded.payload)` inside a `try`, followed by a long **`if/else if` preview chain** producing `payloadPreview` per port (TEXT `substring(0,100)`, POSITION `[Position: lat°, lon°]`, NODEINFO, TELEMETRY, PAXCOUNTER, TRACEROUTE, NEIGHBORINFO, and last **`MESH_BEACON_APP`**). The chain ends just before **“Build metadata JSON”** at **:5520**.
  - `metadata.decoded_payload = decodedPayload` is set **only when `decodedPayload != null`** (**:5546–5550**). This is the field the frontend renders generically.
- **Frontend `PacketMonitorPanel.tsx`** — renders `packet.payload_preview` (:834) and, in the detail view, destructures `decoded_payload` out of parsed `metadata` and shows it (and any complex object) **as formatted JSON** (:907–927). **Zero frontend structural change** — a decoded `TAKPacket` object renders automatically.
- **`getPortnumColor(portnum)`** — `src/utils/packetFormat.ts:34`. Has `case 72` (teal, shared with 73) and `case 257` (gray, shared with 256). **Missing `case 78`** — the only frontend gap. Add it (WP1).

### GeoChat persistence path (Messages)
- **`meshtasticManager.processTextMessageProtobuf(meshPacket, messageText, context?)`** — `src/server/meshtasticManager.ts:5929`. This is the canonical incoming-message persister and the template for GeoChat. Key mechanics to **reuse (not copy blindly)**:
  - Ensures the `from` node row exists via `databaseService.nodes.getNode(fromNum)` + `databaseService.upsertNodeAsync(basicNodeData, this.sourceId)` (:5938–5953).
  - Ensures the broadcast pseudo-node `!ffffffff` (nodeNum `4294967295`) exists (with **no `lastHeard`**, #2602) when `toNum === 4294967295` (:5958–5985).
  - `const isDirectMessage = toNum !== 4294967295;` (:5987) — DM ⇒ `channelIndex = -1`; broadcast ⇒ `channelIndex = meshPacket.channel ?? 0` (server-decrypt dual-channel logic in between is **text-specific; GeoChat does not need it**).
  - **Row construction (:6053–6104), the load-bearing part:**
    ```ts
    const message: TextMessage = {
      id: `${this.sourceId}_${fromNum}_${meshPacket.id || Date.now()}`,  // ← EXACT format, do not change
      fromNodeNum: fromNum, toNodeNum: actualToNum,
      fromNodeId, toNodeId, text: messageText,
      channel: channelIndex, portnum: PortNum.TEXT_MESSAGE_APP,
      timestamp: Date.now(), rxTime: …, hopStart, hopLimit, relayNode,
      replyId, emoji, viaMqtt, rxSnr, rxRssi, createdAt: Date.now(),
      decryptedBy: context?.decryptedBy ?? null,
      sourceIp: null, sourcePath: 'tcp_radio', spoofSuspected: …,
    };
    ```
    The `id` format `${sourceId}_${fromNum}_${packetId}` (underscores, packetId last) is required for cross-source dedup in `/api/unified/messages` (memory: “Message row-ID format is load-bearing”). GeoChat rows MUST use the identical construction.
  - `const wasInserted = await databaseService.messages.insertMessage(message, this.sourceId);` (:6108) then `dataEventEmitter.emitNewMessage(message as any, this.sourceId)` on insert, `sendMessagePushNotification(...)`, then `checkAutoAcknowledge` / `handleAutoPingCommand` / `checkAutoResponder` — **the auto-* command handlers must NOT run for ATAK GeoChat** (RX-only; a MeshMonitor auto-reply would go out as a plain Meshtastic text an ATAK client can’t consume). GeoChat persistence reuses only *ensure-node → build row → insertMessage → emit → (optional) push notification*.
  - The whole method body is inside `try { … } catch (error) { logger.error('❌ Error processing text message:', error); }` (:5930/:6172) — replicate this envelope so a bad TAK packet can’t crash the pipeline.
- **`type TextMessage`** — `meshtasticManager.ts:284` (local alias; the repo type is `DbMessage`). GeoChat rows use the same `TextMessage`/`DbMessage` shape.
- **`databaseService.messages.insertMessage(messageData: DbMessage, sourceId?): Promise<boolean>`** — `src/db/repositories/messages.ts:24`. Already `sourceId`-scoped and source-prefixed via the row id. **No new repository method and no new query surface is introduced by Phase 1** — GeoChat reuses `insertMessage` verbatim. (Consequence for tests: a dedicated `*.perSource.test.ts` for a *new query* is not strictly required by the “new query surface” rule; per-source isolation is instead asserted via the row-id prefix — see §4.)
- **`messages` schema** — `src/db/schema/messages.ts` (SQLite/PG/MySQL). Columns available: `text`, `channel`, `portnum`, `fromNodeNum/toNodeNum`, `fromNodeId/toNodeId`, `timestamp`, `rxTime`, `rxSnr/rxRssi`, `hopStart/hopLimit`, `relayNode`, `decryptedBy`, `sourceId`, `sourcePath`, `spoofSuspected`, etc. **There is no callsign column** — ATAK callsign must be carried inside `text` (see §3 decision).

### Dispatch (side-effect) switch
- **Second `processPayload` call site** — `meshtasticManager.ts:5723`: `const processedPayload = meshtasticProtobufService.processPayload(normalizedPortNum, payload)` followed by `switch (normalizedPortNum) { case … }` that routes to `processTextMessageProtobuf` / `processPositionMessageProtobuf` / … The switch ends with `case PortNum.MESH_BEACON_APP` (**:5775–5784**, decodes + logs but deliberately does **not** persist) then `default:` (**:5785**). This is where the GeoChat persistence case lands. `MESH_BEACON_APP` is the exact structural precedent for “decode + selectively act.”

### Test harness (existing, to model on)
- **Decode unit tests:** `src/server/meshtasticProtobufService.test.ts` — `beforeAll` loads protobufs (`loadProtobufDefinitions()` + `service.initialize()`), skips via `requireProtobufs()` when the submodule is absent. Fixtures are built with `root.lookupType('meshtastic.<Type>')` → `.create()/.encode().finish()` (see `encodeClientNotification`, :435). Model TAK fixtures on this.
- **Manager persistence tests:** `src/server/meshtasticManager.duplicate-message.test.ts` is the canonical template:
  - hoisted `vi.mock('../services/database.js', …)` returning a shared object with `messages.insertMessage: mockInsertMessage` (also exposed at top level), `nodes.getNode/upsertNode`, `channels.*`, etc.; returns `{ default: shared, databaseService: shared }`.
  - Obtains the manager via the dynamically imported **`module.fallbackManager`** (:227) and calls the private method directly: `await (manager as any).processTextMessageProtobuf(packet, 'text')` (:250), asserting `expect(mockInsertMessage).toHaveBeenCalledWith(objectContaining({ id: … }))`.
  - `meshtasticManager.waypoint.test.ts` shows the fuller hoisted-mock set (tcpTransport, virtualNodeServer, protobufService mock) if the new test needs a freshly-constructed manager rather than `fallbackManager`.

---

## 2. File-by-file changes

### 2a. `src/server/meshtasticProtobufService.ts` — decode + preview helper

**(i) Add port-72 decode case** in `processPayload`’s switch, immediately before `default:` (~:919):
```ts
case PortNum.ATAK_PLUGIN: {
  const TAKPacket = root.lookupType('meshtastic.TAKPacket');
  return TAKPacket.decode(payload);   // throws are caught by the outer try/catch → returns raw payload
}
```
Ports **78 and 257 get no decode case** — they fall through to `default:` (returns raw `Uint8Array`), and the manager preview branch labels them and nulls out `decodedPayload` (§2b). This matches the epic’s “labeled, not decoded.”

**(ii) Add an exported pure preview helper** (new function — justified: the other ports’ previews are trivial inline one-liners, but TAK’s is branchy per `payload_variant` and must be unit-tested in isolation without the manager harness; the closest existing code is the inline preview chain, which is not reusable/testable). Place near the other exported helpers:
```ts
/** Human-readable one-line preview for a decoded TAKPacket (Packet Monitor). */
export function formatTakPreview(tak: any, payloadSize: number): string {
  // Guard: decode failed upstream → processPayload returned the raw Uint8Array.
  if (!tak || typeof tak !== 'object' || tak instanceof Uint8Array) {
    return `[ATAK packet, ${payloadSize} bytes (undecodable)]`;
  }
  const compressed = tak.isCompressed ?? tak.is_compressed ?? false;
  const callsign = tak.contact?.callsign ?? tak.contact?.device_callsign ?? tak.contact?.deviceCallsign;
  const who = callsign ? ` ${callsign}` : '';

  // oneof payload_variant — protobufjs exposes only the set field as an own property.
  const pli  = tak.pli;
  const chat = tak.chat;
  const detail = tak.detail;

  if (pli) {
    // PLI ints are valid even when is_compressed=true (only string fields are unishox2'd).
    const lat = Number(pli.latitudeI ?? pli.latitude_i ?? 0) / 1e7;
    const lon = Number(pli.longitudeI ?? pli.longitude_i ?? 0) / 1e7;
    return `[ATAK PLI${who}: ${lat.toFixed(5)}°, ${lon.toFixed(5)}°]`;
  }
  if (chat) {
    const receiptType = Number(chat.receiptType ?? chat.receipt_type ?? 0);
    if (receiptType !== 0 || chat.receiptForUid || chat.receipt_for_uid) {
      return `[ATAK GeoChat receipt${who}]`;
    }
    if (compressed) return `[ATAK GeoChat${who} (compressed)]`;
    const msg = typeof chat.message === 'string' ? chat.message.substring(0, 80) : '';
    return `[ATAK GeoChat${who}: "${msg}"]`;
  }
  if (detail) {
    const n = detail.length ?? 0;
    return `[ATAK detail${who}: ${n} bytes]`;
  }
  return `[ATAK packet${who}]`;
}
```
Notes: defensive camel/snake access follows the existing `pos.latitudeI || pos.latitude_i` convention in the preview chain. `formatTakPreview` is exported so it can be unit-tested directly.

### 2b. `src/server/meshtasticManager.ts` — preview branch + GeoChat persistence

**(i) Preview branches** — append to the `if/else if` preview chain (after the `MESH_BEACON_APP` branch, before the “Build metadata JSON” at :5520):
```ts
} else if (portnum === PortNum.ATAK_PLUGIN) {
  payloadPreview = meshtasticProtobufService.formatTakPreview(
    processedPayload, meshPacket.decoded.payload.length);
  // decodedPayload keeps the decoded TAKPacket object → renders as JSON in the detail view.
} else if (portnum === PortNum.ATAK_PLUGIN_V2) {
  payloadPreview = `[ATAK V2 (not decoded), ${meshPacket.decoded.payload.length} bytes]`;
  decodedPayload = null;   // suppress raw-Uint8Array dump into metadata.decoded_payload
} else if (portnum === PortNum.ATAK_FORWARDER) {
  payloadPreview = `[ATAK Forwarder (not decoded), ${meshPacket.decoded.payload.length} bytes]`;
  decodedPayload = null;
}
```
`decodedPayload = null` for 78/257 is important: `processPayload` returns the raw `Uint8Array` for those (default case), which would otherwise be JSON-serialized into `metadata.decoded_payload` as an ugly indexed-byte object. Nulling it keeps the metadata clean; the label carries the info.

**(ii) Dispatch case** — add to the side-effect `switch (normalizedPortNum)` (before `default:` at :5785, alongside `MESH_BEACON_APP`):
```ts
case PortNum.ATAK_PLUGIN:
  await this.processTakPacket(meshPacket, processedPayload as any, {
    ...context, decryptedBy, decryptedChannelId: decryptedChannelId ?? undefined,
  });
  break;
```

**(iii) New private method `processTakPacket`** — insert after `processTextMessageProtobuf` ends (:6175). Signature mirrors the text path:
```ts
private async processTakPacket(meshPacket: any, tak: any, context?: ProcessingContext): Promise<void> {
  try {
    // 1. Guard: decode failed upstream (raw Uint8Array) or wrong shape → nothing to persist.
    if (!tak || typeof tak !== 'object' || tak instanceof Uint8Array) return;

    // 2. Only GeoChat becomes a message. PLI → Phase 2 (contacts); detail → preview-only.
    const chat = tak.chat;
    if (!chat) return;

    // 3. Compressed strings are unishox2 (out of scope) → don't persist garbage text.
    if (tak.isCompressed ?? tak.is_compressed) return;

    // 4. Receipts (delivered/read acks, empty message) must NOT surface as chat messages.
    const receiptType = Number(chat.receiptType ?? chat.receipt_type ?? 0);
    const receiptForUid = chat.receiptForUid ?? chat.receipt_for_uid;
    if (receiptType !== 0 || receiptForUid) return;

    const rawMsg = typeof chat.message === 'string' ? chat.message.trim() : '';
    if (!rawMsg) return;

    // 5. Presentation: no callsign column → prefix into text for provenance (see §3).
    const callsign = tak.contact?.callsign ?? tak.contact?.deviceCallsign ?? tak.contact?.device_callsign;
    const toCallsign = chat.toCallsign ?? chat.to_callsign;
    const tag = callsign
      ? (toCallsign ? `[ATAK ${callsign}→${toCallsign}]` : `[ATAK ${callsign}]`)
      : '[ATAK]';
    const messageText = `${tag} ${rawMsg}`;

    // 6. Routing/channel: use the Meshtastic envelope, NOT the ATAK UID fields.
    const fromNum = Number(meshPacket.from);
    const toNum = Number(meshPacket.to);
    const isDirectMessage = toNum !== 4294967295;
    const channelIndex = isDirectMessage ? -1 : (meshPacket.channel ?? 0);

    // 7. Ensure endpoint node rows exist (reuse the text-path pattern; see note below).
    //    - ensure `from` node
    //    - if broadcast, ensure the !ffffffff pseudo-node (no lastHeard)
    // 8. Build the row with the EXACT id format and portnum = ATAK_PLUGIN.
    const message: TextMessage = {
      id: `${this.sourceId}_${fromNum}_${meshPacket.id || Date.now()}`,
      fromNodeNum: fromNum,
      toNodeNum: toNum,
      fromNodeId: `!${fromNum.toString(16).padStart(8, '0')}`,
      toNodeId: `!${toNum.toString(16).padStart(8, '0')}`,
      text: messageText,
      channel: channelIndex,
      portnum: PortNum.ATAK_PLUGIN,
      timestamp: Date.now(),
      rxTime: plausibleRxTime(meshPacket.rxTime ? Number(meshPacket.rxTime) * 1000 : undefined) ?? undefined,
      hopStart: (meshPacket as any).hopStart ?? (meshPacket as any).hop_start ?? null,
      hopLimit: (meshPacket as any).hopLimit ?? (meshPacket as any).hop_limit ?? null,
      relayNode: meshPacket.relayNode ?? undefined,
      viaMqtt: meshPacket.viaMqtt === true || isViaMqtt(meshPacket.transportMechanism),
      rxSnr: meshPacket.rxSnr ?? (meshPacket as any).rx_snr,
      rxRssi: meshPacket.rxRssi ?? (meshPacket as any).rx_rssi,
      createdAt: Date.now(),
      decryptedBy: context?.decryptedBy ?? null,
      sourceIp: null,
      sourcePath: 'tcp_radio',
      spoofSuspected: this.assessLocalSpoof(meshPacket),
    };

    const wasInserted = await databaseService.messages.insertMessage(message, this.sourceId);
    if (wasInserted) {
      dataEventEmitter.emitNewMessage(message as any, this.sourceId);
      await this.sendMessagePushNotification(message, messageText, isDirectMessage);
      // Deliberately NO checkAutoAcknowledge / handleAutoPingCommand / checkAutoResponder — RX-only.
    }
  } catch (error) {
    logger.error('❌ Error processing ATAK TAKPacket:', error);
  }
}
```

**Node-ensure reuse (step 7):** `processTextMessageProtobuf` has ~30 lines of inline node-ensuring (`from` node + broadcast pseudo-node). **Recommended:** extract a small private helper `private async ensureMessageEndpointNodes(fromNum: number, toNum: number): Promise<void>` from that block and call it from **both** `processTextMessageProtobuf` and `processTakPacket` (DRY; the text-path tests already cover the extracted code). **Acceptable fallback** if the implementer wants zero blast-radius on the text path: replicate the ~30 lines inline in `processTakPacket`. Either way the pseudo-node must be created **without `lastHeard`** (#2602).

### 2c. `src/utils/packetFormat.ts` — frontend color (WP1, minor)
Add `case 78:` to `getPortnumColor` (currently absent; 72 and 257 exist). Give V2 its own tint, e.g. group it distinctly from 72:
```ts
case 78:
  return '#26a69a'; // ATAK_PLUGIN_V2 - lighter teal
```
No other frontend change — `getPortNumName` (backend) and generic `decoded_payload` JSON rendering already cover the rest.

---

## 3. Design decisions (explicit)

- **GeoChat text presentation:** no callsign column exists, so the ATAK callsign is prefixed into `text`: `[ATAK <callsign>] <message>`, or `[ATAK <callsign>→<toCallsign>] <message>` when `to_callsign` is set, or `[ATAK] <message>` when contact is absent. This makes ATAK provenance visible in the Messages UI.
- **`portnum` on the row = `PortNum.ATAK_PLUGIN` (72)**, not `TEXT_MESSAGE_APP`. It’s honest metadata and lets future consumers distinguish ATAK chat; the Messages UI queries by `channel`, so the value doesn’t affect rendering.
- **Channel attribution = the Meshtastic envelope**, exactly like text: broadcast (`to == 0xFFFFFFFF`) ⇒ `channel = meshPacket.channel`; DM (`to != 0xFFFFFFFF`) ⇒ `channel = -1`, `toNodeNum = meshPacket.to`. The GeoChat `to` / `to_callsign` fields are **ATAK UID strings, not Meshtastic nodeNums**, and there is no ATAK-UID→node map until Phase 2’s contact table — so they are used only for the text prefix, never for routing. **When `to`/`to_callsign` does not resolve to a known node, the message still persists** (as a channel/broadcast or DM row per the envelope) — it is never dropped.
- **Reply-capability concern — acceptable as-is, no frontend gate:** a GeoChat lands on a normal channel (or DM). A user reply would send a plain Meshtastic `TEXT_MESSAGE_APP`, which the ATAK plugin (portnum-72 only) does not ingest. The `[ATAK …]` text prefix is the Phase-1 mitigation (explicit provenance). True “no reply / reply-as-CoT” UX is out of scope (bidirectional ATAK is explicitly out of scope for the epic). No `PacketMonitorPanel`/Messages change required.

---

## 4. Edge cases (each needs a test)

| Case | Expected behavior |
|---|---|
| **Malformed protobuf** (TAKPacket.decode throws) | `processPayload` outer try/catch returns raw `Uint8Array`; `formatTakPreview` guard → `[ATAK packet, N bytes (undecodable)]`; `processTakPacket` guard returns early (no persist). No crash. |
| **No `payload_variant`** | preview `[ATAK packet]` (+ callsign if present); `processTakPacket` returns (no chat) → no message. |
| **Missing contact** | preview/prefix omit callsign (`[ATAK]`); still persists if GeoChat present. |
| **`is_compressed = true`** | preview `[ATAK GeoChat (compressed)]` / `[ATAK PLI …]` (PLI ints still valid); `processTakPacket` returns before persist (strings are unishox2). PLI coords in preview are fine. |
| **GeoChat receipt** (`receipt_type != None` OR `receipt_for_uid` set, message empty) | preview `[ATAK GeoChat receipt]`; **NOT persisted** as a message. |
| **PLI variant** | preview `[ATAK PLI …]`; not persisted to messages (Phase 2 → contacts). |
| **`detail` variant** (bytes) | preview `[ATAK detail: N bytes]`; not persisted; decoded object still stored in `metadata.decoded_payload`. |
| **V2 (port 78) / Forwarder (257)** | labeled preview + byte size; `decodedPayload` nulled; not decoded, not persisted. |
| **Two sources receive the same TAK packet** | two distinct rows — ids differ only by `sourceId` prefix (`srcA_…` vs `srcB_…`); neither deduped away. |

---

## 5. Test plan (all in the standard Vitest suite — no standalone scripts)

### 5a. `src/server/meshtasticProtobufService.test.ts` (extend)
Add a `describe('TAKPacket / ATAK', …)` guarded by `requireProtobufs()`. Build fixtures with the loaded root:
```ts
function encodeTak(fields: Record<string, unknown>): Uint8Array {
  const T = getProtobufRoot()!.lookupType('meshtastic.TAKPacket');
  return T.encode(T.create(fields)).finish();
}
```
Assertions:
- **PLI decode:** `encodeTak({ contact:{callsign:'FALKE'}, pli:{latitudeI:371234500, longitudeI:-1225432100, altitude:10, speed:3, course:90} })` → `processPayload(72, …)` returns an object with `.pli`; `formatTakPreview(obj, size)` === `` `[ATAK PLI FALKE: 37.12345°, -122.54321°]` ``.
- **GeoChat decode:** `encodeTak({ contact:{callsign:'ALPHA'}, chat:{message:'moving out'} })` → preview `` `[ATAK GeoChat ALPHA: "moving out"]` ``.
- **GeoChat receipt:** `chat:{ message:'', receiptType:1, receiptForUid:'x' }` → preview `[ATAK GeoChat receipt …]`.
- **detail variant:** `detail: new Uint8Array([1,2,3])` → preview `[ATAK detail …: 3 bytes]`.
- **compressed:** `isCompressed:true, chat:{message:'…'}` → preview `[ATAK GeoChat (compressed)]`.
- **V2 passthrough:** `processPayload(78, someBytes)` returns the raw bytes (default case) — assert it’s the `Uint8Array` (identity/length), i.e. **not** decoded.
- **Malformed:** `processPayload(72, new Uint8Array([0xff,0xff,0xff,0xff]))` does not throw and returns a value; `formatTakPreview(result, 4)` returns the `(undecodable)` string (when decode failed) — assert no throw.

### 5b. `src/server/meshtasticManager.atak.test.ts` (new)
Model on `meshtasticManager.duplicate-message.test.ts`: hoisted `vi.mock('../services/database.js', …)` exposing `messages.insertMessage: mockInsertMessage`, `nodes.getNode`(→null) + `upsertNodeAsync`, plus the top-level async stubs the manager touches; obtain `manager = module.fallbackManager`; drive `await (manager as any).processTakPacket(packet, takObj, ctx)` with `takObj` built from the real protobuf root (or a plain object matching the decoded shape). Assert:
- **GeoChat broadcast persists with correct row-id:** `packet={ from: 0x1111, to: 0xFFFFFFFF, id: 42, channel: 3, decoded:{ portnum:72 } }`, `tak={ contact:{callsign:'ALPHA'}, chat:{message:'hi'} }` → `mockInsertMessage` called once with `objectContaining({ id: '<sourceId>_4369_42', channel: 3, portnum: 72, text: '[ATAK ALPHA] hi' })`. (`fallbackManager.sourceId` — assert the literal id string the manager produces.)
- **DM routing:** `to = <a real nodeNum>` → row `channel === -1`, `toNodeNum === that nodeNum`.
- **Receipt not persisted:** `chat:{message:'', receiptType:1, receiptForUid:'u'}` → `mockInsertMessage` not called.
- **Compressed not persisted:** `isCompressed:true` → not called.
- **PLI not persisted / detail not persisted:** `tak={pli:{…}}` and `tak={detail:new Uint8Array([1])}` → not called.
- **Malformed (raw Uint8Array passed as `tak`)** → not called, no throw.
- **No auto-responder side effects:** if the mock exposes `checkAutoResponder`/`checkAutoAcknowledge` spies, assert they’re **not** called for GeoChat.

### 5c. `src/server/meshtasticManager.atak.perSource.test.ts` (new)
Assert source isolation via row-id prefix: instantiate/point two manager sourceIds (or call `processTakPacket` twice with different `this.sourceId` — see how `.perSource.test.ts` files set `sourceId`) on the **same** packet (same `from`/`id`), and assert the two `insertMessage` calls carry ids `${srcA}_…_…` and `${srcB}_…_…` (distinct) and each call passes its own `sourceId` as the 2nd arg. (No new query surface is added, so this test targets the id-prefix guarantee rather than a new scoped read.)

### 5d. Full-suite gate
Run the **entire** Vitest suite (not just targeted files) before PR. Schema is untouched (no migration), so PG/MySQL containers are not strictly required for this phase — but if `messages` DDL in `nodes.test.ts` literals were touched (it is **not** here), they would be. Confirm `success: true` via the JSON reporter, and filter worktree noise per CLAUDE.md.

---

## 6. Work packages

Both backend packages edit `src/server/meshtasticManager.ts`, so **WP1 and WP2 must be sequential (WP1 → WP2), not parallel** — they will otherwise conflict. WP3 is independent.

### WP1 — Decode + Packet Monitor previews (first)
**Files:** `meshtasticProtobufService.ts` (port-72 decode case + `formatTakPreview` export), `meshtasticManager.ts` (three preview branches + null-out for 78/257), `src/utils/packetFormat.ts` (`case 78` color), `meshtasticProtobufService.test.ts` (§5a).
**Acceptance:**
- `processPayload(72, …)` returns a decoded `TAKPacket`; `processPayload(78/257, …)` returns raw bytes.
- Packet Monitor shows correct previews for PLI/GeoChat/detail/compressed/receipt, and `[ATAK V2 (not decoded), N bytes]` / `[ATAK Forwarder (not decoded), N bytes]`; `metadata.decoded_payload` present for 72, absent for 78/257.
- §5a tests pass; `getPortnumColor(78)` returns a color; lint:ci clean; full suite green.

### WP2 — GeoChat → Messages persistence (after WP1)
**Files:** `meshtasticManager.ts` (dispatch `case PortNum.ATAK_PLUGIN`, new `processTakPacket`, optional `ensureMessageEndpointNodes` extraction), `meshtasticManager.atak.test.ts` (§5b), `meshtasticManager.atak.perSource.test.ts` (§5c).
**Acceptance:**
- Broadcast GeoChat persists one message row with id `${sourceId}_${fromNum}_${packetId}`, `channel = packet.channel`, `portnum = 72`, `text = "[ATAK <callsign>] <message>"`; appears in Messages.
- DM GeoChat → `channel = -1`, `toNodeNum = packet.to`.
- Receipts, compressed, PLI, detail, and malformed inputs persist nothing; no pipeline crash; no auto-responder side effects.
- Two sources → two distinct rows. §5b/§5c pass; full suite green.

### WP3 — V2 follow-up issue + docs (independent)
- File the **V2 (ATAK_PLUGIN_V2, zstd-with-shared-dictionary) decode spike** GitHub issue the epic calls for (dictionary sourcing from plugin/firmware), and link it from `ATAK_COT_EPIC.md`.
- Add a short note to `ATAK_COT_EPIC.md` Phase 1 checklist marking decode/preview/GeoChat done and referencing this spec.
**Acceptance:** issue filed + linked; epic doc updated. No code.

---

## 7. Open questions / flags for the phase lead
1. **`ensureMessageEndpointNodes` extraction** vs inline replication in `processTakPacket` — extraction is DRY but touches the heavily-tested text path. Spec recommends extraction; flagging for reviewer preference.
2. **`portnum = 72` on message rows** — confirm no Messages-list consumer hard-filters on `portnum === 1`. Grep of the read path shows channel-based querying (no portnum filter), so this is assessed safe, but worth a reviewer glance.
3. **Push notifications for GeoChat** — spec enables `sendMessagePushNotification` (GeoChat is a real message). If ATAK chat should be silent by default, drop that one call; trivial toggle.
4. **`detail` bytes in `metadata.decoded_payload`** — rendered as an indexed-byte JSON object in the detail view (opaque but harmless). Left as-is; could be nulled like 78/257 if reviewers find it noisy.
