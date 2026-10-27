/**
 * MESHCORE_* env var parsing for the first-boot MeshCore default source
 * (#5874 follow-up).
 *
 * Dependency-free so `environment.ts`, `bootstrapSources.ts` and the
 * migrations can all share it.
 *
 * Like the Meshtastic vars, these only shape the source when it is first
 * created. An install that already has sources never grows a MeshCore source
 * because someone added these vars later.
 */
import { parseMeshCoreVirtualNodeEnv, type VirtualNodeEnvConfig } from './virtualNodeEnv.js';

/**
 * TCP port MeshCore's WiFi/Ethernet companion builds listen on. Same as
 * `MESHCORE_DEFAULT_TCP_PORT` in `src/constants/index.ts`, which the Add
 * Source form pre-fills (#5160).
 */
export const DEFAULT_MESHCORE_TCP_PORT = 5000;

/** Serial baud rate `meshcoreConfigFromSource` falls back to. */
export const DEFAULT_MESHCORE_BAUD_RATE = 115200;

export type MeshCoreEnvDeviceType = 'companion' | 'repeater';

/** Parsed MESHCORE_* first-boot vars. */
export interface MeshCoreDefaultEnv {
  /**
   * `'tcp'` when MESHCORE_TCP_HOST is set, `'usb'` when only
   * MESHCORE_SERIAL_PORT is set, `null` when neither is. `'usb'` matches what
   * the Add Source form saves for a serial path.
   */
  transport: 'tcp' | 'usb' | null;
  tcpHost: string | null;
  tcpPort: number;
  tcpPortProvided: boolean;
  serialPort: string | null;
  baudRate: number;
  baudRateProvided: boolean;
  deviceType: MeshCoreEnvDeviceType;
  deviceTypeProvided: boolean;
  virtualNode: VirtualNodeEnvConfig;
}

function parsePort(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  warn: (msg: string) => void,
): { value: number; provided: boolean } {
  const raw = (env[name] ?? '').trim();
  if (!raw) return { value: fallback, provided: false };
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    warn(`⚠️  Invalid ${name} value: "${env[name]}". Expected an integer from 1 to 65535. Using ${fallback}.`);
    return { value: fallback, provided: false };
  }
  return { value: n, provided: true };
}

/**
 * Parse the MESHCORE_* first-boot vars.
 *
 * - MESHCORE_TCP_HOST (+ MESHCORE_TCP_PORT, default 5000) -> TCP.
 * - MESHCORE_SERIAL_PORT (+ MESHCORE_BAUD_RATE, default 115200) -> serial.
 * - Both set: TCP wins, with a warning. A TCP host needs no device mapping
 *   into the container, so it is the one more likely to work as given.
 * - MESHCORE_DEVICE_TYPE: `companion` (default) or `repeater`; anything else
 *   warns and falls back to companion.
 * - MESHCORE_ENABLE_VIRTUAL_NODE / MESHCORE_VIRTUAL_NODE_PORT: same rules as
 *   the Meshtastic pair, default port 5000.
 *
 * Pure apart from `warn`, so the migrations can call it on `process.env`
 * without logging the same warnings twice.
 */
export function parseMeshCoreDefaultEnv(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = () => {},
): MeshCoreDefaultEnv {
  const tcpHost = (env.MESHCORE_TCP_HOST ?? '').trim() || null;
  const serialPort = (env.MESHCORE_SERIAL_PORT ?? '').trim() || null;
  const tcpPort = parsePort(env, 'MESHCORE_TCP_PORT', DEFAULT_MESHCORE_TCP_PORT, warn);

  const rawBaud = (env.MESHCORE_BAUD_RATE ?? '').trim();
  let baudRate = DEFAULT_MESHCORE_BAUD_RATE;
  let baudRateProvided = false;
  if (rawBaud) {
    const n = /^\d+$/.test(rawBaud) ? Number(rawBaud) : NaN;
    if (!Number.isInteger(n) || n < 1) {
      warn(`⚠️  Invalid MESHCORE_BAUD_RATE value: "${env.MESHCORE_BAUD_RATE}". Expected a positive integer. Using ${DEFAULT_MESHCORE_BAUD_RATE}.`);
    } else {
      baudRate = n;
      baudRateProvided = true;
    }
  }

  // 3.x called this MESHCORE_FIRMWARE_TYPE; old compose files may still carry it.
  if ((env.MESHCORE_FIRMWARE_TYPE ?? '').trim() && !(env.MESHCORE_DEVICE_TYPE ?? '').trim()) {
    warn('⚠️  MESHCORE_FIRMWARE_TYPE is the old 3.x name and is ignored. Use MESHCORE_DEVICE_TYPE (companion or repeater).');
  }
  const rawType = (env.MESHCORE_DEVICE_TYPE ?? '').trim().toLowerCase();
  const deviceTypeProvided = rawType.length > 0;
  let deviceType: MeshCoreEnvDeviceType = 'companion';
  if (rawType === 'repeater') {
    deviceType = 'repeater';
  } else if (deviceTypeProvided && rawType !== 'companion') {
    warn(`⚠️  Invalid MESHCORE_DEVICE_TYPE value: "${env.MESHCORE_DEVICE_TYPE}". Expected companion or repeater. Using companion.`);
  }

  const virtualNode = parseMeshCoreVirtualNodeEnv(env, warn);

  let transport: MeshCoreDefaultEnv['transport'] = null;
  if (tcpHost && serialPort) {
    warn('⚠️  Both MESHCORE_TCP_HOST and MESHCORE_SERIAL_PORT are set. Using TCP; MESHCORE_SERIAL_PORT is ignored.');
    transport = 'tcp';
  } else if (tcpHost) {
    transport = 'tcp';
  } else if (serialPort) {
    transport = 'usb';
  } else if (
    tcpPort.provided || baudRateProvided || deviceTypeProvided ||
    virtualNode.enabledProvided || virtualNode.portProvided
  ) {
    warn('⚠️  MeshCore env vars are set but neither MESHCORE_TCP_HOST nor MESHCORE_SERIAL_PORT is. No MeshCore source will be created.');
  }

  return {
    transport,
    tcpHost,
    tcpPort: tcpPort.value,
    tcpPortProvided: tcpPort.provided,
    serialPort,
    baudRate,
    baudRateProvided,
    deviceType,
    deviceTypeProvided,
    virtualNode,
  };
}
