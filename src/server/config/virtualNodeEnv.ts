/**
 * ENABLE_VIRTUAL_NODE / VIRTUAL_NODE_PORT parsing (#5874).
 *
 * Dependency-free so `environment.ts`, `bootstrapSources.ts` and the
 * migrations can all share it.
 */

/**
 * Historical Meshtastic Virtual Node port (v3's VIRTUAL_NODE_PORT default).
 */
export const DEFAULT_MESHTASTIC_VIRTUAL_NODE_PORT = 4404;

/** First-boot Virtual Node settings from ENABLE_VIRTUAL_NODE / VIRTUAL_NODE_PORT (#5874). */
export interface VirtualNodeEnvConfig {
  enabled: boolean;
  enabledProvided: boolean;
  port: number;
  portProvided: boolean;
}

/**
 * Parse ENABLE_VIRTUAL_NODE + VIRTUAL_NODE_PORT (#5874).
 *
 * These only seed the Default source when it is first created; the source's
 * stored config owns the values after that. A port alone does not enable the
 * Virtual Node. A bad port turns both vars off with a warning rather than
 * failing boot.
 *
 * Pure apart from `warn`, so the migrations can call it on `process.env`
 * without logging the same warnings a second time.
 */
export function parseVirtualNodeEnv(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = () => {}
): VirtualNodeEnvConfig {
  const rawEnable = (env.ENABLE_VIRTUAL_NODE ?? '').trim().toLowerCase();
  const rawPort = (env.VIRTUAL_NODE_PORT ?? '').trim();
  const enabledProvided = rawEnable.length > 0;

  let enabled = false;
  if (['true', '1', 'yes'].includes(rawEnable)) {
    enabled = true;
  } else if (enabledProvided && !['false', '0', 'no'].includes(rawEnable)) {
    warn(`⚠️  Invalid ENABLE_VIRTUAL_NODE value: "${env.ENABLE_VIRTUAL_NODE}". Expected true/false. Virtual Node stays off.`);
  }

  const portProvided = rawPort.length > 0;
  if (!portProvided) {
    return { enabled, enabledProvided, port: DEFAULT_MESHTASTIC_VIRTUAL_NODE_PORT, portProvided };
  }

  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warn(`⚠️  Invalid VIRTUAL_NODE_PORT value: "${env.VIRTUAL_NODE_PORT}". Expected an integer from 1 to 65535. Ignoring the Virtual Node env vars.`);
    return { enabled: false, enabledProvided, port: DEFAULT_MESHTASTIC_VIRTUAL_NODE_PORT, portProvided: false };
  }
  if (!enabledProvided) {
    warn('⚠️  VIRTUAL_NODE_PORT is set but ENABLE_VIRTUAL_NODE is not. Set ENABLE_VIRTUAL_NODE=true to turn the Virtual Node on.');
  }
  return { enabled, enabledProvided, port, portProvided };
}
