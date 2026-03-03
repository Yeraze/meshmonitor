# OTA Bootloader Detection & Retry Guidance — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OTA bootloader prerequisite warnings, flash timeout detection, retry support, log rotation, and documentation to the firmware update wizard.

**Architecture:** Backend `FirmwareUpdateService` gets elapsed-time tracking in `executeFlash()` to detect the "quick reboot" failure pattern (node reboots in <20s = missing OTA bootloader), a `retryFlash()` method to re-enter the flash step without re-downloading, and log rotation in `appendLog()`. Frontend gets an info banner at the preflight step and a "Retry Flash" button on flash errors. A new VitePress doc page explains OTA prerequisites.

**Tech Stack:** TypeScript, Express 5, React, Vitest, VitePress, i18n (react-i18next)

**Design doc:** `docs/plans/2026-03-03-ota-bootloader-detection-design.md`

---

## Reference: Existing Code Patterns

### UpdateStatus interface (firmwareUpdateService.ts:56-77)
```typescript
export interface UpdateStatus {
  state: UpdateState;         // 'idle' | 'awaiting-confirm' | 'in-progress' | 'success' | 'error'
  step: UpdateStep | null;    // 'preflight' | 'backup' | 'download' | 'extract' | 'flash' | 'verify'
  message: string;
  progress?: number;
  logs: string[];
  targetVersion?: string;
  error?: string;
  preflightInfo?: { currentVersion, targetVersion, gatewayIp, hwModel, boardName, platform };
  backupPath?: string;
  downloadUrl?: string;
  downloadSize?: number;
  matchedFile?: string;
  rejectedFiles?: Array<{ name: string; reason: string }>;
}
```

### Service test mock pattern (firmwareUpdateService.test.ts)
```typescript
vi.mock('./firmwareHardwareMap.js', () => ({ getBoardName: vi.fn(), ... }));
vi.mock('../../services/database.js', () => ({ default: { getSettingAsync: mockFn, ... } }));
```

### Route test mock pattern (firmwareUpdateRoutes.test.ts)
```typescript
const { mockGetStatus, mockExecuteFlash, ... } = vi.hoisted(() => ({ ... }));
vi.mock('../services/firmwareUpdateService.js', () => ({
  firmwareUpdateService: { getStatus: mockGetStatus, executeFlash: mockExecuteFlash, ... }
}));
```

### i18n key pattern (public/locales/en.json)
```json
"firmware.wizard_preflight_title": "Pre-flight Check",
"firmware.reboot_warning": "The node will reboot during the update..."
```

---

## Task 1: Add log rotation to `appendLog()`

**Files:**
- Modify: `src/server/services/firmwareUpdateService.ts` (line 848-851)
- Test: `src/server/services/firmwareUpdateService.test.ts`

**Step 1: Write the failing test**

Add to the existing `describe('FirmwareUpdateService')` block, after the last `describe`:

```typescript
describe('appendLog', () => {
  it('should cap logs at 1000 entries and trim to 500', () => {
    // Fill logs to 1001 entries via direct status manipulation
    const service = firmwareUpdateService as any;
    service.status.logs = Array.from({ length: 1000 }, (_, i) => `log-${i}`);
    // Trigger appendLog (private method, call via executeFlash's error path or directly)
    service.appendLog('overflow-entry');
    expect(service.status.logs.length).toBe(501);
    expect(service.status.logs[0]).toBe('log-500');
    expect(service.status.logs[500]).toBe('overflow-entry');
  });

  it('should not trim when under 1000 entries', () => {
    const service = firmwareUpdateService as any;
    service.status.logs = ['a', 'b', 'c'];
    service.appendLog('d');
    expect(service.status.logs).toEqual(['a', 'b', 'c', 'd']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — logs array will have 1001 entries (no trimming yet)

**Step 3: Write minimal implementation**

Replace `appendLog` in `src/server/services/firmwareUpdateService.ts` (line 848-851):

```typescript
private appendLog(message: string): void {
  this.status.logs.push(message);
  if (this.status.logs.length > 1000) {
    this.status.logs = this.status.logs.slice(-500);
  }
  this.updateStatus({});
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/services/firmwareUpdateService.ts src/server/services/firmwareUpdateService.test.ts
git commit -m "feat: add log rotation to firmware update service (cap at 1000, trim to 500)"
```

---

## Task 2: Add flash elapsed-time tracking and bootloader detection hint

**Files:**
- Modify: `src/server/services/firmwareUpdateService.ts` (executeFlash, lines 722-766)
- Test: `src/server/services/firmwareUpdateService.test.ts`

**Step 1: Write the failing tests**

Add to the `describe('Update Pipeline')` block. These tests need to mock `spawn` (child_process):

```typescript
describe('executeFlash', () => {
  it('should add bootloader hint when flash fails in under 20 seconds', async () => {
    // Mock spawn to exit quickly with non-zero code
    const { spawn } = await import('child_process');
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: any) => {
        if (event === 'close') setTimeout(() => cb(1), 10); // exits in 10ms
      }),
      kill: vi.fn(),
    };
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const service = firmwareUpdateService as any;
    // Set state so executeFlash can run
    service.status = {
      ...service.status,
      state: 'in-progress',
      step: 'flash',
      preflightInfo: { gatewayIp: '192.168.1.100' },
    };
    service.tempDir = '/tmp/test';

    await expect(service.executeFlash('192.168.1.100', '/tmp/test/firmware.bin'))
      .rejects.toThrow(/OTA bootloader/i);
  });

  it('should NOT add bootloader hint when flash fails after 20+ seconds', async () => {
    const { spawn } = await import('child_process');
    const mockProc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: any) => {
        // We'll check the timing logic without actually waiting 20s
        // by mocking Date.now
        if (event === 'close') setTimeout(() => cb(1), 10);
      }),
      kill: vi.fn(),
    };
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const service = firmwareUpdateService as any;
    service.status = {
      ...service.status,
      state: 'in-progress',
      step: 'flash',
      preflightInfo: { gatewayIp: '192.168.1.100' },
    };
    service.tempDir = '/tmp/test';

    // Mock Date.now to simulate 25 seconds elapsed
    const originalNow = Date.now;
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // First call (start time) returns 0, subsequent calls return 25000
      return callCount === 1 ? 0 : 25000;
    });

    await expect(service.executeFlash('192.168.1.100', '/tmp/test/firmware.bin'))
      .rejects.toThrow();
    // Should NOT mention bootloader
    try {
      await service.executeFlash('192.168.1.100', '/tmp/test/firmware.bin');
    } catch (e: any) {
      expect(e.message).not.toMatch(/OTA bootloader/i);
    }

    Date.now = originalNow;
    vi.restoreAllMocks();
  });
});
```

Note: These tests will need the `child_process` mock to be set up. The existing test file may already mock it — check during implementation and adjust accordingly.

**Step 2: Run test to verify they fail**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: FAIL — no bootloader detection logic exists yet

**Step 3: Write minimal implementation**

Replace `executeFlash` in `src/server/services/firmwareUpdateService.ts` (lines 722-766):

```typescript
async executeFlash(gatewayIp: string, firmwarePath: string): Promise<void> {
  this.updateStatus({
    state: 'in-progress',
    step: 'flash',
    message: `Flashing firmware to ${gatewayIp}...`,
  });

  const startTime = Date.now();

  try {
    const result = await this.runCliCommand('meshtastic', [
      '--host', gatewayIp,
      '--timeout', '30',
      '--ota-update', firmwarePath,
    ]);

    if (result.exitCode !== 0) {
      const elapsed = Date.now() - startTime;
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
      let errorMessage = `Flash command failed with exit code ${result.exitCode}:\n${combined}`;

      // If the process exited quickly (<20s), the OTA bootloader is likely missing
      if (elapsed < 20000) {
        errorMessage += '\n\nThe node rebooted before firmware could be transferred. ' +
          'This usually means the OTA bootloader has not been installed. ' +
          'The OTA bootloader must be flashed once via USB before Wi-Fi OTA updates will work. ' +
          'See the Firmware OTA Prerequisites documentation for instructions.';
      }

      throw new Error(errorMessage);
    }

    this.updateStatus({
      state: 'awaiting-confirm',
      step: 'flash',
      message: 'Firmware flashed successfully. Device is rebooting — reconnecting MeshMonitor and waiting for verification.',
    });

    logger.info('[FirmwareUpdateService] OTA flash completed successfully, reconnecting MeshMonitor');
    await meshtasticManager.userReconnect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this.updateStatus({
      state: 'error',
      step: 'flash',
      message: `Flash failed: ${message}`,
      error: message,
    });
    logger.info('[FirmwareUpdateService] Reconnecting MeshMonitor after flash failure');
    await meshtasticManager.userReconnect();
    throw error;
  } finally {
    this.cleanupTempDir();
  }
}
```

**Step 4: Run test to verify they pass**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/services/firmwareUpdateService.ts src/server/services/firmwareUpdateService.test.ts
git commit -m "feat: detect likely missing OTA bootloader via flash elapsed time"
```

---

## Task 3: Add `retryFlash()` method to service

**Files:**
- Modify: `src/server/services/firmwareUpdateService.ts`
- Test: `src/server/services/firmwareUpdateService.test.ts`

**Step 1: Write the failing tests**

```typescript
describe('retryFlash', () => {
  it('should reset status to awaiting-confirm at flash step when temp dir and matched file exist', () => {
    const service = firmwareUpdateService as any;
    service.tempDir = '/tmp/firmware-test';
    service.status = {
      ...createIdleStatus(),
      state: 'error',
      step: 'flash',
      matchedFile: 'firmware-heltec-v3-2.7.19.abc123.bin',
      preflightInfo: {
        currentVersion: '2.7.18',
        targetVersion: '2.7.19',
        gatewayIp: '192.168.1.100',
        hwModel: 'Heltec V3',
        boardName: 'heltec-v3',
        platform: 'esp32s3',
      },
      downloadUrl: 'https://example.com/fw.zip',
      targetVersion: '2.7.19',
    };

    service.retryFlash();

    expect(service.status.state).toBe('awaiting-confirm');
    expect(service.status.step).toBe('flash');
    expect(service.status.error).toBeUndefined();
    expect(service.status.matchedFile).toBe('firmware-heltec-v3-2.7.19.abc123.bin');
    expect(service.status.logs).toEqual([]);
  });

  it('should throw if tempDir is not set', () => {
    const service = firmwareUpdateService as any;
    service.tempDir = null;
    service.status = { ...createIdleStatus(), state: 'error', step: 'flash' };

    expect(() => service.retryFlash()).toThrow(/firmware files are no longer available/i);
  });

  it('should throw if matched file is not set', () => {
    const service = firmwareUpdateService as any;
    service.tempDir = '/tmp/firmware-test';
    service.status = { ...createIdleStatus(), state: 'error', step: 'flash', matchedFile: undefined };

    expect(() => service.retryFlash()).toThrow(/firmware files are no longer available/i);
  });

  it('should throw if state is not error', () => {
    const service = firmwareUpdateService as any;
    service.tempDir = '/tmp/firmware-test';
    service.status = { ...createIdleStatus(), state: 'idle', matchedFile: 'fw.bin' };

    expect(() => service.retryFlash()).toThrow(/can only retry from error state/i);
  });
});
```

**Step 2: Run test to verify they fail**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `retryFlash` method doesn't exist

**Step 3: Write minimal implementation**

Add new method to `FirmwareUpdateService` class (after `cancelUpdate`, around line 336):

```typescript
retryFlash(): void {
  if (this.status.state !== 'error') {
    throw new Error('Can only retry from error state');
  }
  if (!this.tempDir || !this.status.matchedFile) {
    throw new Error(
      'Cannot retry: firmware files are no longer available. Please start a new update.'
    );
  }

  this.updateStatus({
    state: 'awaiting-confirm',
    step: 'flash',
    message: 'Ready to retry flash. Confirm to proceed.',
    error: undefined,
    logs: [],
  });

  logger.info('[FirmwareUpdateService] Retry flash requested — re-entering flash step');
}
```

Also modify `executeFlash` to NOT call `this.cleanupTempDir()` in the error path (only on success/cancel). Move `this.cleanupTempDir()` from the `finally` block to only the success path:

```typescript
// In executeFlash, change the finally block:
} finally {
  // Only clean up temp dir on success — keep it for retry on failure
  if (this.status.state !== 'error') {
    this.cleanupTempDir();
  }
}
```

**Step 4: Run test to verify they pass**

Run: `npx vitest run src/server/services/firmwareUpdateService.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/services/firmwareUpdateService.ts src/server/services/firmwareUpdateService.test.ts
git commit -m "feat: add retryFlash method to preserve temp dir and re-enter flash step"
```

---

## Task 4: Add retry-flash handling to confirm route

**Files:**
- Modify: `src/server/routes/firmwareUpdateRoutes.ts` (confirm handler, lines 159-262)
- Test: `src/server/routes/firmwareUpdateRoutes.test.ts`

**Step 1: Write the failing test**

Add to the route test file's existing `describe` block. First, add `mockRetryFlash` to the `vi.hoisted()` call:

```typescript
// Add to vi.hoisted() return object:
mockRetryFlash: vi.fn(),

// Add to the mock service object:
retryFlash: (...args: unknown[]) => mockRetryFlash(...args),
```

Then add the test:

```typescript
describe('POST /api/firmware/update/retry', () => {
  it('should call retryFlash and return updated status', async () => {
    mockRetryFlash.mockReturnValue(undefined);
    mockGetStatus
      .mockReturnValueOnce({
        state: 'error',
        step: 'flash',
        matchedFile: 'fw.bin',
        preflightInfo: { gatewayIp: '192.168.1.1' },
      })
      .mockReturnValueOnce({
        state: 'awaiting-confirm',
        step: 'flash',
        message: 'Ready to retry flash.',
      });

    const res = await request(app).post('/api/firmware/update/retry');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRetryFlash).toHaveBeenCalled();
  });

  it('should return error if retryFlash throws', async () => {
    mockRetryFlash.mockImplementation(() => {
      throw new Error('Cannot retry');
    });

    const res = await request(app).post('/api/firmware/update/retry');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/routes/firmwareUpdateRoutes.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — route doesn't exist (404)

**Step 3: Write minimal implementation**

Add new route to `src/server/routes/firmwareUpdateRoutes.ts` (after the cancel route, around line 277):

```typescript
/**
 * POST /api/firmware/update/retry
 * Retry a failed flash step (re-enters flash awaiting-confirm with existing firmware)
 */
router.post('/update/retry', (_req: Request, res: Response) => {
  try {
    firmwareUpdateService.retryFlash();
    const status = firmwareUpdateService.getStatus();
    return res.json({ success: true, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[FirmwareRoutes] Error retrying flash:', error);
    return res.status(500).json({ success: false, error: message });
  }
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/routes/firmwareUpdateRoutes.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/routes/firmwareUpdateRoutes.ts src/server/routes/firmwareUpdateRoutes.test.ts
git commit -m "feat: add POST /api/firmware/update/retry route for flash retry"
```

---

## Task 5: Add i18n keys for new UI elements

**Files:**
- Modify: `public/locales/en.json` (after line 4030, the last firmware.* key)

**Step 1: Add the new keys**

Add after the `"firmware.reboot_warning"` line (line 4030):

```json
"firmware.ota_bootloader_warning": "Wi-Fi OTA requires a one-time OTA bootloader flash via USB. If this is your first OTA update, ensure the bootloader has been installed.",
"firmware.ota_bootloader_learn_more": "Learn More",
"firmware.retry_flash": "Retry Flash",
"firmware.retry_flash_unavailable": "Cannot retry: firmware files are no longer available. Please start a new update.",
```

**Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('public/locales/en.json','utf8')); console.log('JSON valid')"`
Expected: `JSON valid`

**Step 3: Commit**

```bash
git add public/locales/en.json
git commit -m "feat: add i18n keys for OTA bootloader warning and retry flash"
```

---

## Task 6: Add info banner and retry button to frontend

**Files:**
- Modify: `src/components/configuration/FirmwareUpdateSection.tsx`

**Step 1: Add the OTA bootloader info banner**

After the preflight info card (after line 547, closing `</div>` of the preflight info card), add a conditional banner that shows when the step is `preflight` and state is `awaiting-confirm`:

```tsx
{/* OTA bootloader prerequisite warning */}
{effectiveStatus.step === 'preflight' &&
  effectiveStatus.state === 'awaiting-confirm' && (
  <div style={{
    padding: '0.5rem 0.75rem',
    borderRadius: '4px',
    backgroundColor: 'rgba(250, 179, 40, 0.1)',
    border: '1px solid var(--ctp-peach)',
    color: 'var(--ctp-text)',
    fontSize: '0.85rem',
    marginBottom: '0.75rem',
    lineHeight: '1.5',
  }}>
    {t('firmware.ota_bootloader_warning',
      'Wi-Fi OTA requires a one-time OTA bootloader flash via USB. If this is your first OTA update, ensure the bootloader has been installed.'
    )}{' '}
    <a
      href={`${baseUrl}/docs/firmware-ota-prerequisites`}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'var(--accent-color)' }}
    >
      {t('firmware.ota_bootloader_learn_more', 'Learn More')}
    </a>
  </div>
)}
```

**Step 2: Add the Retry Flash button**

Modify the error action buttons section (around line 656-660). Replace the existing error Dismiss button block:

```tsx
{effectiveStatus.state === 'error' && (
  <>
    {effectiveStatus.step === 'flash' && (
      <button className="save-button" onClick={handleRetryFlash}>
        {t('firmware.retry_flash', 'Retry Flash')}
      </button>
    )}
    <button className="save-button" onClick={handleDone}>
      Dismiss
    </button>
  </>
)}
```

**Step 3: Add the `handleRetryFlash` handler**

Add after `handleDone` (around line 305):

```typescript
const handleRetryFlash = async () => {
  try {
    const res = await csrfFetch(`${baseUrl}/api/firmware/update/retry`, {
      method: 'POST',
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to retry flash');
    }
    queryClient.invalidateQueries({ queryKey: ['firmware', 'status'] });
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Error retrying flash', 'error');
  }
};
```

**Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | tail -20`
Expected: No errors

**Step 5: Commit**

```bash
git add src/components/configuration/FirmwareUpdateSection.tsx
git commit -m "feat: add OTA bootloader warning banner and retry flash button to wizard UI"
```

---

## Task 7: Add documentation page

**Files:**
- Create: `docs/firmware-ota-prerequisites.md`
- Modify: `docs/.vitepress/config.mts` (add sidebar entry under Features)

**Step 1: Create the documentation page**

Create `docs/firmware-ota-prerequisites.md`:

```markdown
# Firmware OTA Prerequisites

Wi-Fi Over-The-Air (OTA) firmware updates allow you to update your Meshtastic node's firmware without physical USB access. Before using MeshMonitor's OTA update feature, your node must meet the following prerequisites.

## Requirements

1. **ESP32-based hardware** — OTA updates are only supported on ESP32 and ESP32-S3 boards (e.g., Heltec V3/V4, T-Beam, RAK WisBlock)
2. **Wi-Fi enabled** — The node must be connected to your local Wi-Fi network with a known IP address
3. **Firmware >= 2.7.18** — The running firmware must support the `--ota-update` CLI command
4. **OTA bootloader installed** — A one-time USB flash of the OTA bootloader partition is required

## One-Time OTA Bootloader Setup

The OTA bootloader must be flashed **once via USB** before Wi-Fi OTA updates will work. This writes a small bootloader to the `ota_1` partition that enables the node to receive firmware over the network.

### What You Need

- A USB data cable connected to the node
- Python with `esptool` installed: `pip install esptool`
- The OTA bootloader file (`mt-esp32s3-ota.bin` or `mt-esp32-ota.bin`) from the [Meshtastic firmware release](https://github.com/meshtastic/firmware/releases)

### Flash the Bootloader

Download the latest firmware `.zip` from [Meshtastic Firmware Releases](https://github.com/meshtastic/firmware/releases) and extract it. Locate the appropriate OTA bootloader file:

- **ESP32-S3 boards** (Heltec V3/V4, T-Beam Supreme, etc.): `mt-esp32s3-ota.bin` at address `0x340000`
- **ESP32 boards** (T-Beam, T-Lora, etc.): `mt-esp32-ota.bin` at address `0x260000`

**Linux:**
```bash
esptool.py --port /dev/ttyUSB0 --baud 460800 write_flash 0x340000 mt-esp32s3-ota.bin
```

**Windows:**
```powershell
python -m esptool --port COM3 --baud 460800 write_flash 0x340000 mt-esp32s3-ota.bin
```

Replace the port (`/dev/ttyUSB0` or `COM3`) with your actual serial port, and adjust the address and filename for your board type.

### Verify Success

The flash is successful when you see:
```
Hash of data verified.
Leaving...
Hard resetting via RTS pin...
```

The node will reboot and return to normal Meshtastic operation. You can now disconnect the USB cable — all future firmware updates can be done over Wi-Fi.

## Troubleshooting

### Node reboots immediately during OTA update

If the node reboots back to Meshtastic within ~15 seconds of starting an OTA update (without accepting the firmware), the OTA bootloader is likely not installed. Connect via USB and flash the bootloader as described above.

### First OTA attempt fails, second succeeds

Some users report that the first OTA attempt after installing the bootloader does nothing, but the second attempt works. If your first flash attempt fails, try clicking **Retry Flash** in the MeshMonitor wizard.

### Flash times out

Ensure the node's Wi-Fi IP address is correct and reachable from the MeshMonitor server. You can verify connectivity with:
```bash
meshtastic --host <NODE_IP> --info
```
```

**Step 2: Add sidebar entry to VitePress config**

In `docs/.vitepress/config.mts`, add to the Features sidebar items array (after the existing items, around line 57):

```typescript
{ text: 'Firmware OTA Prerequisites', link: '/firmware-ota-prerequisites' },
```

**Step 3: Verify docs build**

Run: `cd docs && npx vitepress build 2>&1 | tail -5`
Expected: Build succeeds without errors

**Step 4: Commit**

```bash
git add docs/firmware-ota-prerequisites.md docs/.vitepress/config.mts
git commit -m "docs: add firmware OTA prerequisites guide"
```

---

## Task 8: Run full test suite and verify

**Step 1: Run all unit tests**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass, including the new firmware tests

**Step 2: TypeScript compilation check**

Run: `npx tsc --noEmit --pretty 2>&1 | tail -10`
Expected: No errors

**Step 3: Docker build check**

Run: `docker compose -f docker-compose.dev.yml build meshmonitor 2>&1 | tail -10`
Expected: Build succeeds

**Step 4: Commit any fixups if needed, then push**

```bash
git push origin feat/gateway-ota-updates
```
