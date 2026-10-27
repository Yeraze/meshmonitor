/**
 * Config for the default sources MeshMonitor creates on first boot (#5874):
 * the "Default" Meshtastic TCP source and, from the MESHCORE_* vars, a
 * "Default MeshCore" source.
 *
 * Two code paths can create that row: migration 050 (via
 * `_legacyDefaultSource.ts`, the one that fires on a fresh install) and the
 * empty-table branch in `bootstrapSources.ts`. Both build the config here so
 * they cannot drift.
 *
 * Env vars only shape the row when it is created. After that the stored
 * config owns the values, and no later boot rewrites them.
 */
import type { VirtualNodeConfig } from '../virtualNodeServer.js';
import { parseVirtualNodeEnv, type VirtualNodeEnvConfig } from './virtualNodeEnv.js';
import {
  parseMeshCoreDefaultEnv,
  type MeshCoreDefaultEnv,
  type MeshCoreEnvDeviceType,
} from './meshcoreEnv.js';

// A type alias (not an interface) so it fits `Record<string, unknown>`,
// the shape `createSource` takes.
export type DefaultMeshtasticSourceConfig = {
  host: string;
  port: number;
  virtualNode?: VirtualNodeConfig;
};

export interface DefaultMeshtasticSourceInput {
  host: string;
  port: number;
  /** True when MESHTASTIC_NODE_IP named a real host (not the placeholder). */
  hostProvided: boolean;
  virtualNode: Pick<VirtualNodeEnvConfig, 'enabled' | 'port'>;
  warn?: (msg: string) => void;
}

/**
 * Build the Default source's config blob. Adds a `virtualNode` block only
 * when ENABLE_VIRTUAL_NODE is on AND MESHTASTIC_NODE_IP was given: without a
 * host the Default source is created disabled, so a Virtual Node on it would
 * never listen.
 *
 * `allowAdminCommands` is always false. The Virtual Node port has no login,
 * so anyone who can reach it could send admin commands to the node. Turning
 * that on stays a deliberate choice in the UI.
 */
export function buildDefaultMeshtasticSourceConfig(
  input: DefaultMeshtasticSourceInput,
): DefaultMeshtasticSourceConfig {
  const config: DefaultMeshtasticSourceConfig = { host: input.host, port: input.port };
  if (!input.virtualNode.enabled) return config;
  if (!input.hostProvided) {
    input.warn?.(
      '⚠️  ENABLE_VIRTUAL_NODE is set but MESHTASTIC_NODE_IP is not. The Default source is created disabled, so no Virtual Node was added. Set MESHTASTIC_NODE_IP, or turn the Virtual Node on in the UI.',
    );
    return config;
  }
  config.virtualNode = {
    enabled: true,
    port: input.virtualNode.port,
    allowAdminCommands: false,
  };
  return config;
}

/** MESHTASTIC_NODE_IP / port as the migrations read them. */
function meshtasticHostFromEnv(env: NodeJS.ProcessEnv): { host: string; port: number; hostProvided: boolean } {
  const envHost = env.MESHTASTIC_NODE_IP?.trim() ?? '';
  const hostProvided = envHost.length > 0;
  // Placeholder for the disabled Default row; nothing ever connects to it.
  const host = hostProvided ? envHost : 'meshtastic.local';
  // MESHTASTIC_NODE_PORT wins over MESHTASTIC_TCP_PORT, as in environment.ts.
  const rawPort = env.MESHTASTIC_NODE_PORT ?? env.MESHTASTIC_TCP_PORT ?? '4403';
  const port = parseInt(rawPort, 10) || 4403;
  return { host, port, hostProvided };
}

/**
 * Same as {@link buildDefaultMeshtasticSourceConfig}, reading straight from
 * `process.env`. The migrations use this: they run before (and apart from)
 * the cached environment config.
 */
export function buildDefaultMeshtasticSourceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn?: (msg: string) => void,
): { config: DefaultMeshtasticSourceConfig; hostProvided: boolean } {
  const { host, port, hostProvided } = meshtasticHostFromEnv(env);
  return {
    config: buildDefaultMeshtasticSourceConfig({
      host,
      port,
      hostProvided,
      virtualNode: parseVirtualNodeEnv(env),
      warn,
    }),
    hostProvided,
  };
}

// ---------------------------------------------------------------------------
// MeshCore default source (#5874 follow-up)
// ---------------------------------------------------------------------------

/** Name of the MeshCore source the MESHCORE_* vars create. */
export const DEFAULT_MESHCORE_SOURCE_NAME = 'Default MeshCore';

/**
 * Heartbeat the Add Source form pre-fills for a Companion. A Repeater gets 0
 * (off), because its serial probe is opt-in (#5563), and the form then omits
 * the field.
 */
const COMPANION_HEARTBEAT_SECONDS = 30;

// A type alias (not an interface) so it fits `Record<string, unknown>`.
export type DefaultMeshCoreSourceConfig = {
  transport: 'tcp' | 'usb';
  tcpHost?: string;
  tcpPort?: number;
  port?: string;
  baudRate?: number;
  deviceType: MeshCoreEnvDeviceType;
  autoConnect: true;
  heartbeatIntervalSeconds?: number;
  virtualNode?: {
    enabled: true;
    port: number;
    allowAdminCommands: false;
    allowPkiExport: false;
    allowPkiImport: false;
  };
};

/**
 * Build the MeshCore default source's config blob from the parsed MESHCORE_*
 * vars, or null when no MeshCore source should be created.
 *
 * The shape matches what the Add Source form saves (`transport: 'usb'` +
 * `port` for a serial path; `transport: 'tcp'` + `tcpHost`/`tcpPort`), so the
 * source behaves exactly as if it was added in the UI.
 *
 * - A Repeater over TCP is not supported (the manager drives a Repeater only
 *   over its serial console), so that combination warns and returns null.
 * - Only a Companion gets a Virtual Node: the Virtual Node speaks the
 *   Companion protocol to the MeshCore app, which a Repeater cannot back.
 * - A Virtual Node port equal to the Meshtastic Default's Virtual Node port
 *   would fail to bind, so that warns and drops the MeshCore Virtual Node.
 * - `allowAdminCommands`, `allowPkiExport` and `allowPkiImport` are always
 *   false. The Virtual Node port has no login; turning any of them on stays
 *   a deliberate choice in the UI.
 */
export function buildDefaultMeshCoreSourceConfig(
  parsed: MeshCoreDefaultEnv,
  opts: { meshtasticVirtualNodePort?: number | null; warn?: (msg: string) => void } = {},
): DefaultMeshCoreSourceConfig | null {
  const warn = opts.warn ?? (() => {});
  if (!parsed.transport) return null;

  const isRepeater = parsed.deviceType === 'repeater';
  if (isRepeater && parsed.transport === 'tcp') {
    warn(
      '⚠️  MESHCORE_DEVICE_TYPE=repeater needs MESHCORE_SERIAL_PORT; MeshMonitor drives a Repeater only over serial. No MeshCore source was created.',
    );
    return null;
  }

  const config: DefaultMeshCoreSourceConfig =
    parsed.transport === 'tcp'
      ? {
          transport: 'tcp',
          tcpHost: parsed.tcpHost!,
          tcpPort: parsed.tcpPort,
          deviceType: parsed.deviceType,
          autoConnect: true,
        }
      : {
          transport: 'usb',
          port: parsed.serialPort!,
          // The form never writes a baud rate; the manager uses 115200. Only
          // store one the operator asked for.
          ...(parsed.baudRateProvided ? { baudRate: parsed.baudRate } : {}),
          deviceType: parsed.deviceType,
          autoConnect: true,
        };
  if (!isRepeater) config.heartbeatIntervalSeconds = COMPANION_HEARTBEAT_SECONDS;

  if (!parsed.virtualNode.enabled) return config;
  if (isRepeater) {
    warn(
      '⚠️  MESHCORE_ENABLE_VIRTUAL_NODE is set but the MeshCore device is a Repeater. The Virtual Node needs a Companion, so none was added.',
    );
    return config;
  }
  if (opts.meshtasticVirtualNodePort != null && opts.meshtasticVirtualNodePort === parsed.virtualNode.port) {
    warn(
      `⚠️  MESHCORE_VIRTUAL_NODE_PORT (${parsed.virtualNode.port}) is the same port as the Meshtastic Virtual Node. The MeshCore Virtual Node was not added; pick another port.`,
    );
    return config;
  }
  config.virtualNode = {
    enabled: true,
    port: parsed.virtualNode.port,
    allowAdminCommands: false,
    allowPkiExport: false,
    allowPkiImport: false,
  };
  return config;
}

/** One source row the first-boot logic wants created. */
export interface DefaultSourcePlanRow {
  name: string;
  type: 'meshtastic_tcp' | 'meshcore';
  config: DefaultMeshtasticSourceConfig | DefaultMeshCoreSourceConfig;
  enabled: boolean;
}

export interface DefaultSourcePlanInput {
  meshtastic: Omit<DefaultMeshtasticSourceInput, 'warn'>;
  meshcore: MeshCoreDefaultEnv;
  /**
   * Create the disabled Meshtastic placeholder when MESHTASTIC_NODE_IP is not
   * set and no MeshCore source is planned. Migration 050 does (since
   * discussion #2604); bootstrapSources does not (#5237).
   */
  createPlaceholder: boolean;
  warn?: (msg: string) => void;
}

/**
 * Decide which default sources a fresh install gets. Shared by migration 050
 * and the empty-table branch of bootstrapSources, so they cannot drift.
 *
 * - MESHTASTIC_NODE_IP set: an enabled Meshtastic "Default", as before.
 * - MESHTASTIC_NODE_IP unset, MeshCore source planned: no Meshtastic row.
 * - MESHTASTIC_NODE_IP unset, no MeshCore source: the disabled placeholder
 *   when `createPlaceholder`, else nothing.
 * - MESHCORE_TCP_HOST / MESHCORE_SERIAL_PORT: a "Default MeshCore" row.
 *
 * Rows come back Meshtastic first, so the oldest row (the one legacy-data
 * backfills pick) stays the Meshtastic one when both exist.
 */
export function planDefaultSources(input: DefaultSourcePlanInput): DefaultSourcePlanRow[] {
  const warn = input.warn ?? (() => {});
  const mt = input.meshtastic;
  const meshtasticVnPort = mt.hostProvided && mt.virtualNode.enabled ? mt.virtualNode.port : null;
  const meshcoreConfig = buildDefaultMeshCoreSourceConfig(input.meshcore, {
    meshtasticVirtualNodePort: meshtasticVnPort,
    warn,
  });

  const rows: DefaultSourcePlanRow[] = [];
  if (mt.hostProvided || (!meshcoreConfig && input.createPlaceholder)) {
    rows.push({
      name: 'Default',
      type: 'meshtastic_tcp',
      config: buildDefaultMeshtasticSourceConfig({ ...mt, warn }),
      enabled: mt.hostProvided,
    });
  } else if (mt.virtualNode.enabled) {
    warn(
      '⚠️  ENABLE_VIRTUAL_NODE is set but MESHTASTIC_NODE_IP is not, so no Meshtastic Default source was created and the Virtual Node env vars were ignored. For the MeshCore source use MESHCORE_ENABLE_VIRTUAL_NODE.',
    );
  }
  if (meshcoreConfig) {
    rows.push({
      name: DEFAULT_MESHCORE_SOURCE_NAME,
      type: 'meshcore',
      config: meshcoreConfig,
      enabled: true,
    });
  }
  return rows;
}

/**
 * {@link planDefaultSources} straight from `process.env`, for the migrations.
 * Parse warnings are not repeated here (environment.ts logs them); only the
 * builders' warnings reach `warn`.
 */
export function planDefaultSourcesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn?: (msg: string) => void,
): DefaultSourcePlanRow[] {
  const { host, port, hostProvided } = meshtasticHostFromEnv(env);
  return planDefaultSources({
    meshtastic: { host, port, hostProvided, virtualNode: parseVirtualNodeEnv(env) },
    meshcore: parseMeshCoreDefaultEnv(env),
    createPlaceholder: true,
    warn,
  });
}
