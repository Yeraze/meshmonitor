/**
 * Config for the "Default" Meshtastic TCP source that MeshMonitor creates on
 * first boot (#5874).
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

/**
 * Same as {@link buildDefaultMeshtasticSourceConfig}, reading straight from
 * `process.env`. The migrations use this: they run before (and apart from)
 * the cached environment config.
 */
export function buildDefaultMeshtasticSourceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  warn?: (msg: string) => void,
): { config: DefaultMeshtasticSourceConfig; hostProvided: boolean } {
  const envHost = env.MESHTASTIC_NODE_IP?.trim() ?? '';
  const hostProvided = envHost.length > 0;
  const host = hostProvided ? envHost : 'meshtastic.local';
  // MESHTASTIC_NODE_PORT wins over MESHTASTIC_TCP_PORT, as in environment.ts.
  const rawPort = env.MESHTASTIC_NODE_PORT ?? env.MESHTASTIC_TCP_PORT ?? '4403';
  const port = parseInt(rawPort, 10) || 4403;
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
