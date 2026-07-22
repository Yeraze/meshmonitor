import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';

const env = getEnvironmentConfig();

/**
 * Resolve the connection host/port for an `/api/poll` or `/api/config` caller
 * scoped to a particular sourceId. Returns the active source's `config.host`
 * and `config.port` when the source is `meshtastic_tcp`, the env default when
 * no sourceId was supplied (legacy single-source callers), and `null` host
 * when the source is non-TCP (BLE/serial/virtual/MQTT/meshcore) — those
 * cannot be reached via the OTA CLI's `--host` argument and the firmware UI
 * must not present them as a flash target. See issue #2981.
 *
 * Extracted verbatim from server.ts (was a local function, L2768) as part of
 * #3502 — shared by pollRoutes and configRoutes.
 */
export async function resolveSourceConnectionConfig(
  sourceId: string | undefined
): Promise<{
  host: string | null;
  port: number | null;
  sourceType: string | null;
  isEnvDefault: boolean;
}> {
  if (!sourceId) {
    return {
      host: env.meshtasticNodeIp,
      port: env.meshtasticTcpPort,
      sourceType: null,
      isEnvDefault: true,
    };
  }
  try {
    const source = await databaseService.sources.getSource(sourceId);
    if (!source) {
      return {
        host: env.meshtasticNodeIp,
        port: env.meshtasticTcpPort,
        sourceType: null,
        isEnvDefault: true,
      };
    }
    if (source.type === 'meshtastic_tcp') {
      const cfg = (source.config ?? {}) as { host?: string; port?: number };
      return {
        host: cfg.host || null,
        port: cfg.port ?? env.meshtasticTcpPort,
        sourceType: source.type,
        isEnvDefault: false,
      };
    }
    // Non-TCP sources (mqtt, meshcore, BLE/serial via future managers) can't
    // be flashed over IP — surface a null host so the UI disables OTA rather
    // than silently shipping the env default.
    return { host: null, port: null, sourceType: source.type, isEnvDefault: false };
  } catch (error) {
    logger.error(`Failed to resolve source connection config for ${sourceId}:`, error);
    return {
      host: env.meshtasticNodeIp,
      port: env.meshtasticTcpPort,
      sourceType: null,
      isEnvDefault: true,
    };
  }
}
