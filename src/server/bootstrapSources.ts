/**
 * bootstrapSources — extracted startup source-loading seam.
 *
 * Extracted from the anonymous `setTimeout(async () => {…})` block in
 * server.ts (originally L375-520) to create a testable seam. See WP1 of
 * issue #3962 Phase 2.
 *
 * WP3 (this file): Uniform construction — ALL meshtastic_tcp sources
 * (including the first) are now constructed via `makeMeshtastic(id, cfg)`.
 * The legacy `configureSource(fallbackManager)` path (S2/S3) is removed.
 * `registry.setPrimaryMeshtasticSource(id)` designates the first TCP source.
 * S4 env-IP fallback (`fallbackManager.connect()`) is KEPT (Q1 resolved:
 * preserve for all-MeshCore/all-disabled-tcp installs).
 *
 * Behavior-preservation table (all rows hold after WP3):
 *  - Runtime IP/port overrides are cleared on every boot (S10).
 *  - When sourceCount===0 and env.meshtasticNodeIp is truthy → auto-create
 *    a DB row named "Default" (type meshtastic_tcp). NOTE: env.meshtasticNodeIp
 *    always has a value (defaults to '192.168.1.100') so the Default row is
 *    always created on a fresh install even when no explicit IP was configured
 *    — this "always-truthy quirk" is pinned by test scenario #2.
 *  - When source rows exist, env is ignored for source creation.
 *  - Sources are sorted: mqtt_broker(0) < meshtastic_tcp/meshcore(1) < mqtt_bridge(2).
 *  - ALL meshtastic_tcp sources: constructed via makeMeshtastic() uniformly.
 *  - First tcp source is designated primary via registry.setPrimaryMeshtasticSource().
 *  - autoConnect===false → skip that source for auto-connect.
 *  - No tcp source configured after loop → fallbackManager.connect() called (S4).
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger.js';
import { applyManagerSettings } from './applyManagerSettings.js';
import { meshcoreConfigFromSource, ensureMeshCoreManagerStarted } from './meshcoreConfig.js';
import { buildMqttManagerForSource } from './routes/sourceRoutes.js';
import type { SourceManagerRegistry } from './sourceManagerRegistry.js';
import type { MeshtasticManager, MeshtasticMqttLink } from './meshtasticManager.js';
import type { VirtualNodeConfig } from './virtualNodeServer.js';
import type { Source, CreateSourceInput } from '../db/repositories/sources.js';

/**
 * Structural subset of databaseService required by bootstrapSources.
 * Narrower than `typeof databaseService` so tests can pass a lightweight stub.
 */
export interface BootstrapDb {
  settings: {
    setSetting(key: string, value: string): Promise<void>;
    getSetting(key: string): Promise<string | null>;
    getSettingForSource(sourceId: string | null | undefined, key: string): Promise<string | null>;
  };
  sources: {
    getSourceCount(): Promise<number>;
    createSource(input: CreateSourceInput): Promise<Source>;
    getAllSources(): Promise<Source[]>;
    getEnabledSources(): Promise<Source[]>;
    assignNullSourceIds(sourceId: string): Promise<void>;
  };
}

/** Config shape passed to MeshtasticManager constructor. */
export interface MeshtasticSourceConfig {
  host?: string;
  port?: number;
  heartbeatIntervalSeconds?: number;
  virtualNode?: VirtualNodeConfig;
  mqttLink?: MeshtasticMqttLink;
  passiveMode?: boolean;
  passiveResyncStaleMs?: number | null;
}

/**
 * Structural view of a meshtastic_tcp source row's JSON config — the fields
 * the startup loop reads. Mirrors the inline `source.config as any` reads the
 * pre-extraction code did, without the `any`.
 */
interface TcpSourceRowConfig extends MeshtasticSourceConfig {
  autoConnect?: boolean;
}

export interface BootstrapDeps {
  /**
   * Database facade (or structural stub in tests). Only the settings and
   * sources sub-services are called.
   */
  db: BootstrapDb;
  /**
   * Resolved environment config. Only meshtasticNodeIp and meshtasticTcpPort
   * are read.
   */
  env: { meshtasticNodeIp: string; meshtasticTcpPort: number };
  /** Registry that started managers are registered into. */
  registry: SourceManagerRegistry;
  /**
   * Factory for ALL tcp source managers (including the first).
   * Default at the server.ts call site: `(id, cfg) => new MeshtasticManager(id, cfg)`.
   * WP3: used uniformly for every meshtastic_tcp source.
   */
  makeMeshtastic: (id: string, cfg: MeshtasticSourceConfig) => MeshtasticManager;
  /**
   * The legacy singleton / unconfigured fallback instance.
   * Used ONLY for S4: env-IP fallback connect when no tcp source auto-connects
   * (all-MeshCore / all-disabled-tcp / autoConnect:false installs).
   * Q1 resolved: keep (behavior-preserving for those deployment shapes).
   */
  fallbackManager: MeshtasticManager;
}

/**
 * Bootstrap all enabled sources from the database, auto-creating a Default
 * source from env config when none exist.
 *
 * Covers the block previously at server.ts L375-520. Extracted to enable
 * the startup pin-test matrix (§5 of the task-2.3 spec).
 *
 * Does NOT initialize backup/duplicate-key/security-digest/solar/news
 * schedulers — those remain in the setTimeout caller in server.ts.
 */
export async function bootstrapSources(deps: BootstrapDeps): Promise<void> {
  // Clear any runtime IP/port overrides from previous sessions.
  // These are temporary settings that should reset on container restart (S10).
  await deps.db.settings.setSetting('meshtasticNodeIpOverride', '');
  await deps.db.settings.setSetting('meshtasticTcpPortOverride', '');

  // Auto-create default source if none exist.
  // NOTE: env.meshtasticNodeIp is always truthy (defaults to '192.168.1.100'
  // when MESHTASTIC_NODE_IP is not set), so a Default source is created on
  // every fresh install. This quirk is intentional and pinned by test #2.
  const sourceCount = await deps.db.sources.getSourceCount();
  if (sourceCount === 0) {
    if (deps.env.meshtasticNodeIp) {
      await deps.db.sources.createSource({
        id: uuidv4(),
        name: 'Default',
        type: 'meshtastic_tcp',
        config: { host: deps.env.meshtasticNodeIp, port: deps.env.meshtasticTcpPort },
        enabled: true,
      });
      logger.info(`📡 Auto-created default source from environment config`);
    }
  }

  // Assign legacy NULL sourceId rows to the oldest source (Phase 2 data migration).
  // Safe to run every startup — updates 0 rows after the first run.
  const allSources = await deps.db.sources.getAllSources();
  if (allSources.length > 0) {
    await deps.db.sources.assignNullSourceIds(allSources[0].id);
    logger.debug(`Assigned NULL sourceId rows to default source ${allSources[0].id}`);
  }

  // Start all enabled sources via the registry.
  // Sort so mqtt_broker sources start before mqtt_bridge sources — bridges
  // resolve their parent broker via the registry, and while they can attach
  // later via the deferred 'manager-started' event, starting in order keeps
  // the happy path race-free.
  const enabledSourcesRaw = await deps.db.sources.getEnabledSources();
  const typeStartOrder = (t: string) =>
    t === 'mqtt_broker' ? 0 : t === 'mqtt_bridge' ? 2 : 1;
  const enabledSources = [...enabledSourcesRaw].sort(
    (a, b) => typeStartOrder(a.type) - typeStartOrder(b.type),
  );
  let firstTcpSourceConfigured = false;

  for (const source of enabledSources) {
    if (source.type === 'mqtt_broker' || source.type === 'mqtt_bridge') {
      try {
        const manager = buildMqttManagerForSource(
          source.id,
          source.name,
          source.type,
          source.config,
        );
        await deps.registry.addManager(manager);
        logger.info(`Started MQTT ${source.type} source ${source.id} (${source.name})`);
      } catch (err) {
        logger.error(`Failed to start MQTT source ${source.id} (${source.name}):`, err);
      }
      continue;
    }

    if (source.type === 'meshcore') {
      // Slice 1 of multi-source MeshCore: spin up a per-source manager and
      // connect it. Companion-USB only — other transports will be wired in
      // slice 2. MeshCore managers are added to the global sourceManagerRegistry
      // inside ensureMeshCoreManagerStarted (current behavior).
      const cfg = source.config as { autoConnect?: boolean };
      if (cfg?.autoConnect === false) {
        logger.info(`Skipping auto-connect for MeshCore source ${source.id} (${source.name}) — autoConnect disabled`);
        continue;
      }

      try {
        const mcConfig = meshcoreConfigFromSource(source);
        if (!mcConfig) {
          logger.warn(`MeshCore source ${source.id} (${source.name}) has incomplete config; skipping auto-connect`);
          continue;
        }
        await ensureMeshCoreManagerStarted(source, mcConfig);
      } catch (err) {
        logger.error(`Failed to start MeshCore source ${source.id} (${source.name}); continuing with other sources:`, err);
      }
      continue;
    }

    if (source.type === 'meshtastic_tcp') {
      const cfg = source.config as TcpSourceRowConfig;

      // Respect per-source autoConnect flag — when explicitly false the source
      // is enabled but must be connected manually via the UI.
      if (cfg?.autoConnect === false) {
        logger.info(`Skipping auto-connect for source ${source.id} (${source.name}) — autoConnect disabled`);
        continue;
      }

      try {
        // WP3: uniform construction — every meshtastic_tcp source uses makeMeshtastic().
        // The legacy configureSource(fallbackManager) path (S2/S3) is removed.
        const manager = deps.makeMeshtastic(source.id, {
          host: cfg.host,
          port: cfg.port,
          heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
          virtualNode: cfg.virtualNode,
          mqttLink: cfg.mqttLink,
          passiveMode: cfg.passiveMode,
          passiveResyncStaleMs: cfg.passiveResyncStaleMs,
        });
        await applyManagerSettings(manager, source.id, deps.db);
        await deps.registry.addManager(manager);
        if (!firstTcpSourceConfigured) {
          // Designate the first-started tcp source as the primary so the live
          // Proxy alias (export default in meshtasticManager.ts) and legacy
          // consumers resolve to the correct manager instance.
          deps.registry.setPrimaryMeshtasticSource(source.id);
          firstTcpSourceConfigured = true;
          logger.debug(`Started source manager as primary: ${source.id}`);
        }
      } catch (err) {
        // Don't let one failed source block others from registering.
        // The manager's internal retry logic will reconnect when reachable.
        logger.error(`Failed to start source ${source.id} (${source.name}); continuing with other sources:`, err);
      }
      continue;
    }

    // Unknown source type — most likely a leftover row from a deprecated type.
    logger.warn(
      `Source ${source.id} (${source.name}) has unknown type "${source.type}" — no manager will be started. Delete the source if it is no longer needed.`,
    );
  }

  if (!firstTcpSourceConfigured) {
    // S4: No TCP sources auto-connected. Fall back to the legacy singleton
    // with env-var config. This covers all-MeshCore, all-disabled-tcp, and
    // autoConnect:false installs. Disposition (open Q1): keep unless explicitly
    // decided to drop in WP3 (recommendation: keep, it's the behavior-preserving choice).
    await deps.fallbackManager.connect();
    logger.debug('Meshtastic manager connected (legacy mode, no sources configured)');
  } else {
    logger.debug(`Started ${enabledSources.length} source manager(s)`);
  }
}
