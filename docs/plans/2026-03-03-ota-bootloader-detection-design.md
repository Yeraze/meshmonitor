# OTA Bootloader Detection & Retry Guidance — Design Document

**Issue:** #2108 (comment feedback)
**PR:** #2110
**Date:** 2026-03-03
**Status:** Approved

## Problem

Wi-Fi OTA firmware updates require a one-time OTA bootloader flash via USB (`mt-esp32s3-ota.bin` to the `ota_1` partition). The Meshtastic protocol provides **no way** to detect whether this bootloader is installed — there is no protobuf field, no admin message, and no CLI flag for partition inspection over the network.

When a node without the OTA bootloader receives an OTA update command, it reboots into OTA mode but automatically reboots back within ~15 seconds without accepting firmware. The current wizard has no awareness of this failure mode.

Additionally, community reports indicate that OTA flashes sometimes fail on the first attempt but succeed on retry.

## Design

### 1. Preflight Info Banner

At the preflight step, show an amber info banner below the preflight info card:

- Text: "Wi-Fi OTA requires a one-time OTA bootloader flash via USB. If this is your first OTA update, ensure the bootloader has been installed."
- Includes a "Learn More" link to `/docs/firmware-ota-prerequisites` (VitePress doc page)
- Does NOT gate the flow — informational only

### 2. Flash Timeout Detection (Backend)

In `executeFlash()`, track elapsed time of the `meshtastic --ota-update` command:

- Record `Date.now()` before spawning the process
- If the process exits with non-zero code AND completed in under 20 seconds, augment the error message with specific guidance about the OTA bootloader likely being missing
- Standard errors (timeout, network, etc.) retain their existing messages

### 3. Retry Flash Button (Frontend)

When the flash step errors out:

- Show a "Retry Flash" button alongside "Dismiss"
- Clicking "Retry Flash" re-runs the flash step using the already-downloaded/extracted firmware (skips preflight, backup, download, extract)
- Backend: new `retryFlash()` method that resets status to the flash step's `awaiting-confirm` state if temp dir and matched file still exist

### 4. Documentation Page

New VitePress doc page at `docs/firmware-ota-prerequisites.md`:

- What the OTA bootloader is and why it's required
- One-time USB flash instructions (esptool command, partition addresses)
- ESP32-S3 vs ESP32 differences (0x340000 vs 0x260000)
- Troubleshooting: "node reboots immediately" = bootloader not installed

### 5. Log Rotation

Cap `status.logs` at 1000 entries. When exceeded, trim to the last 500.

## Files Changed

| File | Change |
|------|--------|
| `src/components/configuration/FirmwareUpdateSection.tsx` | Info banner at preflight, "Retry Flash" button on flash error |
| `src/server/services/firmwareUpdateService.ts` | Elapsed time tracking in executeFlash, log rotation in appendLog, retryFlash method |
| `src/server/routes/firmwareUpdateRoutes.ts` | Handle retry in confirm route |
| `public/locales/en.json` | New i18n keys |
| `docs/firmware-ota-prerequisites.md` | New documentation page |
| Test files | Update for new behavior |
