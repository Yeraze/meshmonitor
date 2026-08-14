# Reticulum Phase 2 WP0, LXMF Spike Evidence (#3960)

**Date:** 2026-08-13 · **Gate for:** WP1 (bridge LXMF implementation).

## Result: GATE PASSES

The one truly gating risk (R1, does LXMF force an `rns` upgrade past the Phase 1a pin?) is **retired**.

### 1. `lxmf` pins cleanly against `rns==1.4.2`, wheels-only on `python:3.12-alpine`

Verified by resolving in a fresh `python:3.12-alpine` container with `--only-binary=:all:` (forces prebuilt musllinux wheels, no compiler):

```
docker run --rm python:3.12-alpine \
  pip install --only-binary=:all: 'rns==1.4.2' lxmf
→ installs cleanly, then:
  rns     Version: 1.4.2   (unchanged — LXMF did NOT force an rns upgrade)
  lxmf    Version: 1.1.1
```

- **Pin for `bridge/requirements.txt`: `lxmf==1.1.1`** (alongside the existing `rns==1.4.2`, `websockets>=13`).
- **Wheels-only on musllinux confirmed**, the Phase 1a "no compiler on alpine" build property is preserved. No `python:3.12-slim` fallback needed.
- `rns` stays at **1.4.2** → the Phase 1a spike/fixtures are **not** re-opened; no coordinated rns re-pin needed. R1 closed.

### 2. Send / receive / delivery-proof, delegated to WP1's integration test

The end-to-end LXMF send+receive+delivery-proof proof over the dual-`rnsd` loopback harness is **built and asserted as part of WP1** (spec §7 / §8 WP1 acceptance: `integration/test_dual_rnsd.py` extended with LXMF send/receive between two identities, matching `hash`/`content`, `signature_validated=True`, terminal delivery state). Establishing it there (rather than as a throwaway spike script) means the proof lands as a permanent CI regression test, which is the better outcome. WP1 does not proceed on faith: its acceptance gate IS that integration test passing hardware-free.

- **Propagation / store-and-forward:** best-effort per spec; treat as a documented `xfail`/manual gate in the dual-`rnsd` harness if it proves flaky in CI. The hard send/receive + delivery-proof assertions are non-negotiable; propagation is not.

### 3. LXMF API notes for WP1 (verify against `lxmf==1.1.1` at implementation time)

- Use `LXMF.LXMRouter(identity=<RNS.Identity>, storagepath=<LXMF_STORAGE_DIR>)`; register the local delivery destination with the display name; `router.register_delivery_callback(cb)` for inbound.
- Outbound: construct an `LXMF.LXMessage(...)` and hand it to `router.handle_outbound(msg)`; the message's `hash` is the correlation key returned to Node.
- Delivery states are numeric constants on `LXMessage` (e.g. DRAFT/OUTBOUND/SENDING/SENT/DELIVERED/FAILED-style), map them to the string enum `sending|sent|delivered|failed` in ONE place in `rns_manager.py`. Confirm the exact constant names/values against the installed `lxmf==1.1.1` source during WP1.
- `signature_validated` and ratchet status are attributes on the received message object; surface both on the `lxmf_message` event.

**Bottom line:** proceed to WP1 with `lxmf==1.1.1`. The gating dependency question is answered; the behavioral proof is WP1's integration-test acceptance.
