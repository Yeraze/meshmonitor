/**
 * Repeater-mode serial path validation (#5178).
 *
 * `connectSerialDirect()` — the Repeater connect path — handed
 * `config.serialPort` straight to the serialport library, while only
 * `startNativeBackend()` (Companion) ran it through `sanitizeSerialPort()`. The
 * two paths therefore disagreed about what a valid serial path is.
 *
 * Repeater now runs the same check, but WARN ONLY: the path has never been
 * validated here, so an unrecognised one (a socat/virtual PTY outside /dev)
 * connects today and must keep connecting. An odd path is logged, not refused —
 * the value only ever reaches the serialport library, never a shell.
 *
 * The connect attempt never reaches hardware in these tests: the serialport
 * module is never loaded, so the call fails at the availability check straight
 * after the path is judged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshCoreManager, ConnectionType } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function repeaterManager(serialPort: string): MeshCoreManager {
  const manager = new MeshCoreManager('src-a');
  (manager as any).config = {
    connectionType: ConnectionType.SERIAL,
    firmwareType: 'repeater',
    serialPort,
    baudRate: 115200,
  };
  return manager;
}

/** Drive the Repeater connect path far enough to see how the path was judged. */
async function connectError(serialPort: string): Promise<string> {
  try {
    await (repeaterManager(serialPort) as any).connectSerialDirect();
    return '<resolved>';
  } catch (error) {
    return (error as Error).message;
  }
}

/** The text of every warning the connect attempt logged. */
function warnings(): string[] {
  return (logger.warn as any).mock.calls.map((c: unknown[]) => String(c[0]));
}

describe('MeshCore Repeater serial path validation (#5178)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns about an unrecognised path but still attempts the connection', async () => {
    // Past the path check — the failure is the un-loaded serialport module.
    expect(await connectError('/tmp/ttyV0')).toMatch(/Serial port support not loaded/);
    expect(warnings().join('\n')).toMatch(/not a recognised device path/);
  });

  it('stays silent for the paths the Companion path accepts', async () => {
    for (const port of [
      '/dev/ttyACM0',
      '/dev/serial/by-id/usb-Seeed_Studio_XIAO_nRF52840_7142450D89DEE83A-if00',
      '/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0',
      'COM3',
    ]) {
      expect(await connectError(port)).toMatch(/Serial port support not loaded/);
    }
    expect(warnings()).toEqual([]);
  });

  it('names the offending path in the warning, so a typo is obvious', async () => {
    await connectError('/dev/ttyACM0 ');
    expect(warnings().join('\n')).toContain('/dev/ttyACM0 ');
  });

  it('still reports an unconfigured port distinctly, without a path warning', async () => {
    expect(await connectError('')).toMatch(/Serial port not configured/);
    expect(warnings()).toEqual([]);
  });
});
