# MCOimg IM3/IM4 images in chat — Epic (#6586)

## Goal

Render standalone MCOimg `im3:` / `im4:` text payloads as inline images in
Meshtastic and MeshCore chat (channels, DMs, history, Unified Messages), with
IM4's embedded MCOtxt captions, and let a user upload a PNG/JPEG, compare the
IM3 and IM4 encodings side by side, and send one as ordinary text.

## Upstream sources (MIT, zjs81/meshcore-open, HDDen fork — port with attribution)

- IM3 spec + JS codec: `HDDen/meshcore-open@rename-mco-advanced` `docs/mcoimg_v3_reference.md`,
  `docs/mcoimg-js/mcoimg-v3-codec.global.js` (decoder + Normal/High/Extreme encoder, Base91).
- IM4 spec + porting plan: `docs/mcoimg_v4_reference.md`, `docs/mcoimg_v4_porting_plan.md`.
  Reference code: tag `9.5.1-mod-1.9.0` `lib/helpers/mcoimg_v4_codec.dart`,
  `mcoimg_v4_model.dart`, `lib/widgets/mco_image_v4_view.dart` (normative rendering).
- MCOtxt v1: `docs/MCOTXT_V1_PROTOCOL.md`, JS codec with frozen gen-0 tables `docs/mcotxt/assets/mcotxt.js`.
- Test fixtures: `docs/mcoimg-js/tests/v3-js-*-fixtures.json`; reporter samples in the issue.

## Decisions (maintainer + reporter, 2026-11-26)

- Detection: whole trimmed message is exactly one lowercase `im3:` or `im4:` payload. Anything
  else (mixed text, bad data, unsupported extension, decode failure) displays as the original text.
- Dimensions up to 256×256 for both formats; Base91 alphabet and validation per each spec.
- IM4 captions (MCOtxt text figures inside a valid IM4) render in the first IM4 receive version.
  Caption authoring in the composer is out of scope.
- Bridged messages: render only when the bridge exposes the standalone payload separately from
  the sender prefix; if the prefix is in the body, leave it as text.
- Hover/focus shows the exact payload; a **Copy original message** action for touch.
- Sending: one ordinary text message, never split. Both previews shown; an encoding over the
  current conversation's byte limit is marked and cannot be chosen. Existing send path,
  rate limiter and byte validation apply. Mesh impact: user-initiated, one message, no timer,
  no retry — no new limits needed.
- Encoding: auto-fit (largest size/palette that fits the current limit, per encoding) plus
  manual size/palette override with live preview. Compression level **High**, run in a Web
  Worker; no Extreme. IM4 encoding = a v4 document holding one IM3 raster layer (no vectorizer).
- Codecs live in a lazy-loaded chunk (main-chunk budget, #5526). Decoding is client-side only;
  no schema, API, or server changes. Public-instance redaction runs before decode.

## Phases

### Phase 1 — IM3 receive  [x]
TS port of the IM3 decoder + Base91; `McoImage` component (canvas, pixelated, payload tooltip,
Copy action); hooked into `renderMessageWithLinks` (Meshtastic channel/DM/history/Unified) and
`MeshCoreMessageStream`, next to SPIP. Exit: upstream v3 decoder fixtures + reporter IM3 sample
decode; false-positive tests; render tests per surface; docs page; browser-validated.

### Phase 2 — IM4 + MCOtxt receive  [ ]
TS port of the IM4 decoder (all figures, repeats, groups, raster layers through Phase 1's IM3
decoder, transport tail), MCOtxt v1 decoder with frozen tables, canvas vector renderer per the
normative view, captions. Exit: reporter IM4 sample renders with its caption; failure-class
tests; render tests; docs updated; browser-validated.

### Phase 3 — Compose and send  [ ]
IM3 High encoder + IM4 raster-layer encoder (Web Worker), resize/quantize pipeline, auto-fit
search, manual override, side-by-side preview decoded from each payload, byte count + fit status
for Meshtastic and MeshCore channel/DM limits, insert-and-send through existing composers.
Exit: round-trip and fit tests; composer tests; docs; browser-validated send on `gauntlet`.

## Deviations log

### Phase 1
- Codec is a faithful TS port of the upstream decoder (not vendored): `src/utils/mcoImage/` —
  `detect.ts` (sync, main chunk), `decode.ts` (lazy chunk via `src/components/McoImage/loadMcoCodec.ts`),
  `v3/*`. `decodeV3BodyWithoutNonce` is the Phase 2 raster-layer entry. Encoder deliberately absent.
- Lazy load through a hook (`useMcoImageDecode`), not React.lazy: the payload text shows while
  loading and on any failure, so no Suspense boundary is needed at call sites.
- Test vectors: 39 + 6 upstream fixtures, plus 83 differential fixtures generated with the upstream
  encoder (incl. internal entry points) so every container, hybrid marker 31, delta geometry and
  shared-palette path is exercised. Generators live outside the repo; commands in the JSON.
- Copy copies the trimmed payload. Display: longest side 192 px (integer upscale when smaller).
- Translate is hidden for image messages (MCO **and SPIP**) on Meshtastic and MeshCore rows via
  `src/utils/imageMessage.ts`. `extractUrls` skips MCO payloads (Base91 can contain `http://`).
- Not rendered as images (stay text, like SPIP): reply quotes, search results, MeshCore ingest view,
  packet/route modals, resend quote, notification bodies. Bridged `MT@Bob: im3:…` stays text.

