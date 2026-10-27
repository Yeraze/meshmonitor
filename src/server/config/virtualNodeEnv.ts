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
 * MeshCore Virtual Node default port. Mirrors `DEFAULT_VIRTUAL_NODE_PORT` in
 * `meshcoreConfig.ts`, kept here so this module stays dependency-free.
 */
export const DEFAULT_MESHCORE_VIRTUAL_NODE_PORT = 5000;

/** Which env var pair to read, and the port to fall back to. */
export interface VirtualNodeEnvVars {
  enableVar: string;
  portVar: string;
  defaultPort: number;
}

const MESHTASTIC_VN_VARS: VirtualNodeEnvVars = {
  enableVar: 'ENABLE_VIRTUAL_NODE',
  portVar: 'VIRTUAL_NODE_PORT',
  defaultPort: DEFAULT_MESHTASTIC_VIRTUAL_NODE_PORT,
};

const MESHCORE_VN_VARS: VirtualNodeEnvVars = {
  enableVar: 'MESHCORE_ENABLE_VIRTUAL_NODE',
  portVar: 'MESHCORE_VIRTUAL_NODE_PORT',
  defaultPort: DEFAULT_MESHCORE_VIRTUAL_NODE_PORT,
};

/**
 * Parse a Virtual Node enable/port env var pair (#5874).
 *
 * These only seed a default source when it is first created; the source's
 * stored config owns the values after that. A port alone does not enable the
 * Virtual Node. A bad port turns both vars off with a warning rather than
 * failing boot.
 *
 * Pure apart from `warn`, so the migrations can call it on `process.env`
 * without logging the same warnings a second time.
 */
export function parseVirtualNodeEnvVars(
  env: NodeJS.ProcessEnv,
  vars: VirtualNodeEnvVars,
  warn: (msg: string) => void = () => {}
): VirtualNodeEnvConfig {
  const { enableVar, portVar, defaultPort } = vars;
  const rawEnable = (env[enableVar] ?? '').trim().toLowerCase();
  const rawPort = (env[portVar] ?? '').trim();
  const enabledProvided = rawEnable.length > 0;

  let enabled = false;
  if (['true', '1', 'yes'].includes(rawEnable)) {
    enabled = true;
  } else if (enabledProvided && !['false', '0', 'no'].includes(rawEnable)) {
    warn(`⚠️  Invalid ${enableVar} value: "${env[enableVar]}". Expected true/false. Virtual Node stays off.`);
  }

  const portProvided = rawPort.length > 0;
  if (!portProvided) {
    return { enabled, enabledProvided, port: defaultPort, portProvided };
  }

  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warn(`⚠️  Invalid ${portVar} value: "${env[portVar]}". Expected an integer from 1 to 65535. Ignoring the Virtual Node env vars.`);
    return { enabled: false, enabledProvided, port: defaultPort, portProvided: false };
  }
  if (!enabledProvided) {
    warn(`⚠️  ${portVar} is set but ${enableVar} is not. Set ${enableVar}=true to turn the Virtual Node on.`);
  }
  return { enabled, enabledProvided, port, portProvided };
}

/** ENABLE_VIRTUAL_NODE + VIRTUAL_NODE_PORT, for the Meshtastic Default source. */
export function parseVirtualNodeEnv(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = () => {}
): VirtualNodeEnvConfig {
  return parseVirtualNodeEnvVars(env, MESHTASTIC_VN_VARS, warn);
}

/** MESHCORE_ENABLE_VIRTUAL_NODE + MESHCORE_VIRTUAL_NODE_PORT, for the MeshCore default source. */
export function parseMeshCoreVirtualNodeEnv(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = () => {}
): VirtualNodeEnvConfig {
  return parseVirtualNodeEnvVars(env, MESHCORE_VN_VARS, warn);
}
