import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import databaseService from '../../services/database.js';
import { requirePermission, optionalAuth } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { MeshtasticManager } from '../meshtasticManager.js';
import { meshcoreConfigFromSource, ensureMeshCoreManagerStarted } from '../meshcoreConfig.js';
import { MeshCoreManager } from '../meshcoreManager.js';
import { isMeshCoreManager, isMeshtasticManager } from '../sourceManagerTypes.js';
import { loRaCenterFrequencyMhz, REGION_SHORT_NAME } from '../../utils/loraFrequency.js';
import { MqttBrokerManager, type MqttBrokerSourceConfig } from '../mqttBrokerManager.js';
import { MqttBridgeManager, type MqttBridgeSourceConfig } from '../mqttBridgeManager.js';
import waypointRoutes from './waypoints.js';
import { PortNum } from '../constants/meshtastic.js';
import {
  buildSourceNodes,
  buildSourceChannels,
  buildSourceTraceroutes,
  buildSourceNeighborInfo,
  buildSourceDashboard,
} from '../services/sourceDashboardData.js';
import { getSourcePkiKeyStore, isPkiDmDecryptionGloballyEnabled } from '../services/sourcePkiKeyStore.js';
import { mqttGeoSweepService, type GeoSweepStatsSink } from '../services/mqttGeoSweepService.js';
import type { MqttFilterConfig } from '../mqttPacketFilter.js';

const router = Router();

// Linear-time trailing-slash strip. Replaces `.replace(/\/+$/, '')` which
// CodeQL flags as polynomial-ReDoS on user-controlled input (js/polynomial-redos).
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--;
  return end === s.length ? s : s.slice(0, end);
}

// Validate virtualNode config nested inside a source config blob.
// Returns null on success, or { status, error } on failure.
// Exported for unit testing the source-type gate (#3535).
export async function validateVirtualNodeConfig(
  type: string,
  config: any,
  excludeSourceId?: string
): Promise<{ status: number; error: string } | null> {
  const vn = config?.virtualNode;
  if (vn === undefined || vn === null) return null;
  if (type !== 'meshtastic_tcp' && type !== 'meshcore') {
    return { status: 400, error: 'virtualNode config is only supported on meshtastic_tcp and meshcore sources' };
  }
  if (vn.enabled !== true) return null;
  const port = vn.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: 400, error: 'virtualNode.port must be an integer between 1 and 65535' };
  }
  const all = await databaseService.sources.getAllSources();
  for (const s of all) {
    if (s.id === excludeSourceId) continue;
    const otherVn = (s.config as any)?.virtualNode;
    if (otherVn?.enabled === true && otherVn.port === port) {
      return { status: 409, error: `virtualNode.port ${port} is already in use by source "${s.name}"` };
    }
  }
  return null;
}

// Build the right ISourceManager for a stored Source row. Used by both the
// HTTP create path and the startup wiring in server.ts.
export function buildMqttManagerForSource(
  id: string,
  name: string,
  type: 'mqtt_broker' | 'mqtt_bridge',
  config: Record<string, unknown>,
) {
  if (type === 'mqtt_broker') {
    return new MqttBrokerManager(id, name, config as unknown as MqttBrokerSourceConfig);
  }
  return new MqttBridgeManager(id, name, config as unknown as MqttBridgeSourceConfig);
}

/**
 * Validate the optional downlink/uplink topic-rewrite fields on an
 * mqtt_bridge config (#3166).
 *
 * Rules:
 * - Each rule (if present) must be an object with non-empty string
 *   `from` and `to` fields. Trailing whitespace and slashes are
 *   meaningful here only when both fields end up empty post-trim (the
 *   runtime helper normalizes trailing slashes itself).
 * - MQTT wildcards `+` and `#` are rejected — the rule is a literal
 *   prefix replacement.
 * - `from === to` is rejected (no-op config).
 * - Rewrites only apply when the bridge is attached to a parent broker
 *   (downlink republish has nowhere to go without one, and uplink fires
 *   off the parent broker's `local-packet` event). When the bridge is
 *   standalone (no `brokerSourceId`), rewrite fields are rejected so
 *   the user doesn't ship a setting that will silently do nothing.
 *
 * Returns an error message string if invalid, or null if OK.
 */
const MQTT_BRIDGE_MODES = ['bidirectional', 'publish_only', 'subscribe_only'] as const;
const MQTT_BRIDGE_FORWARDING_MODES = ['per_gateway', 'single'] as const;

/**
 * Validate the optional `mode` field on an mqtt_bridge config. Absent
 * (undefined) is allowed and the manager defaults to `bidirectional`.
 */
function validateMqttBridgeMode(config: Record<string, any>): string | null {
  const mode = config?.mode;
  if (mode === undefined || mode === null) return null;
  if (!MQTT_BRIDGE_MODES.includes(mode)) {
    return `mqtt_bridge mode must be one of ${MQTT_BRIDGE_MODES.join(', ')}`;
  }
  return null;
}

/**
 * Validate the optional `forwardingMode` field on an mqtt_bridge config.
 * Absent (undefined) defaults to `per_gateway`.
 */
function validateMqttBridgeForwardingMode(config: Record<string, any>): string | null {
  const value = config?.forwardingMode;
  if (value === undefined || value === null) return null;
  if (!MQTT_BRIDGE_FORWARDING_MODES.includes(value)) {
    return `mqtt_bridge forwardingMode must be one of ${MQTT_BRIDGE_FORWARDING_MODES.join(', ')}`;
  }
  return null;
}

/**
 * Validate the optional `ignoreOkToMqtt` override on an mqtt_bridge
 * config. Absent (undefined) defaults to false (honor the bit).
 */
function validateMqttBridgeIgnoreOkToMqtt(config: Record<string, any>): string | null {
  const value = config?.ignoreOkToMqtt;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    return 'mqtt_bridge ignoreOkToMqtt must be a boolean';
  }
  return null;
}

function validateMqttBridgeRewrites(config: Record<string, any>): string | null {
  const isAttached =
    typeof config.brokerSourceId === 'string' && config.brokerSourceId.trim() !== '';
  const checkOne = (label: string, rule: unknown): string | null => {
    if (rule === undefined || rule === null) return null;
    if (typeof rule !== 'object' || Array.isArray(rule)) {
      return `${label} must be an object with from and to string fields`;
    }
    if (!isAttached) {
      return `${label} requires a parent broker — standalone bridges cannot rewrite topics`;
    }
    const r = rule as { from?: unknown; to?: unknown };
    if (typeof r.from !== 'string' || typeof r.to !== 'string') {
      return `${label}.from and ${label}.to must be strings`;
    }
    const from = stripTrailingSlashes(r.from.trim());
    const to = stripTrailingSlashes(r.to.trim());
    if (!from || !to) {
      return `${label}.from and ${label}.to must be non-empty`;
    }
    if (/[+#]/.test(from) || /[+#]/.test(to)) {
      return `${label} must not contain MQTT wildcards (+, #) — rewrites are literal prefix replacement`;
    }
    if (from === to) {
      return `${label}.from and ${label}.to must differ`;
    }
    return null;
  };
  return (
    checkOne('downlinkTopicRewrite', config.downlinkTopicRewrite) ??
    checkOne('uplinkTopicRewrite', config.uplinkTopicRewrite)
  );
}

// Restore credentials the edit UI intentionally omitted from the save
// payload. The source-edit form clears the password field on load (the GET
// endpoint strips it for non-admins) and drops the field from the PUT body
// when the user did not type a new one, expecting the server to round-trip
// the stored value. Without this merge, editing an unrelated field (e.g.
// the geofence bounding box) writes back a config with no password and
// wipes the saved credential.
function preserveSourceCredentials(
  type: string,
  existingConfig: Record<string, unknown> | undefined,
  incomingConfig: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incomingConfig };
  if (type === 'mqtt_broker') {
    const existingAuth = (existingConfig as any)?.auth;
    const incomingAuth = (incomingConfig as any)?.auth;
    if (
      existingAuth?.password &&
      incomingAuth && typeof incomingAuth === 'object' &&
      (incomingAuth.password === undefined || incomingAuth.password === '')
    ) {
      merged.auth = { ...incomingAuth, password: existingAuth.password };
    }
  } else if (type === 'mqtt_bridge') {
    const existingUpstream = (existingConfig as any)?.upstream;
    const incomingUpstream = (incomingConfig as any)?.upstream;
    if (
      existingUpstream?.password &&
      incomingUpstream && typeof incomingUpstream === 'object' &&
      (incomingUpstream.password === undefined || incomingUpstream.password === '')
    ) {
      merged.upstream = { ...incomingUpstream, password: existingUpstream.password };
    }
  }
  return merged;
}

// MM-SEC-8: shared credential strip applied to source records leaving the
// HTTP boundary. The `mqtt` and `meshcore` source types carry connection
// credentials in their `config` blob; both the list and singular GET
// endpoints must remove them for non-admin callers. Admins receive the
// full record so the existing source-edit UI continues to round-trip
// values (the form re-posts the same blob it loaded).
function stripSourceSecrets<T extends { config?: unknown } | null | undefined>(
  source: T,
  isAdmin: boolean,
): T {
  if (!source || isAdmin) return source;
  const cfg = (source.config as any) ?? {};
  const { password, apiKey, ...rest } = cfg;
  void password;
  void apiKey;
  // mqtt_broker and mqtt_bridge nest their credentials inside sub-objects.
  // Clone-and-redact rather than passing through so non-admins never see the
  // password in plaintext.
  if (rest.auth && typeof rest.auth === 'object') {
    rest.auth = { ...rest.auth, password: undefined };
  }
  if (rest.upstream && typeof rest.upstream === 'object') {
    rest.upstream = { ...rest.upstream, password: undefined };
  }
  return { ...source, config: rest };
}

// Public, non-secret per-source radio summary attached to GET /api/sources
// below (#4111 P3 WP-1). Center frequency / region is inherently public RF
// information — it is broadcast over the air and printed on every node's
// config screen — so exposing it on the already-public sources list carries
// no secret. This is the ONE additive backend field for the Terrain Link
// Profile tool's per-source frequency auto-detection; see
// docs/internal/dev-notes/LINK_PROFILE_POLISH_SPEC.md §0.1 for the full
// rationale (rejected alternative: gated per-endpoint fetches).
interface SourceRadioSummary {
  frequencyMhz: number | null;
  /** Meshtastic only. */
  regionName?: string;
  /** Meshtastic only — drives RX-sensitivity auto-seed. */
  modemPreset?: number;
}

// Wrapped in try/catch so a manager that throws from getCurrentConfig()/
// localNode access can never break the sources list (returns null instead).
function computeSourceRadioSummary(sourceId: string): SourceRadioSummary | null {
  try {
    const mgr = sourceManagerRegistry.getManager(sourceId);
    if (!mgr) return null;
    if (isMeshtasticManager(mgr)) {
      const lora = mgr.getCurrentConfig()?.deviceConfig?.lora;
      if (!lora) return null;
      const region = Number(lora.region ?? 0);
      const frequencyMhz = loRaCenterFrequencyMhz(
        region,
        Number(lora.channelNum ?? 0),
        Number(lora.overrideFrequency ?? 0),
        Number(lora.frequencyOffset ?? 0),
        Number(lora.bandwidth ?? 250),
        undefined,
        Number(lora.modemPreset ?? 0),
      );
      return {
        frequencyMhz,
        regionName: REGION_SHORT_NAME[region],
        modemPreset: Number(lora.modemPreset ?? 0),
      };
    }
    if (isMeshCoreManager(mgr)) {
      // localNode is a private field on MeshCoreManager — use the public
      // accessor rather than reaching into it directly.
      const freq = mgr.getLocalNode()?.radioFreq;
      return { frequencyMhz: typeof freq === 'number' && Number.isFinite(freq) ? freq : null };
    }
    return null; // MQTT / bridge sources have no local radio.
  } catch (error) {
    logger.debug(`Error computing radio summary for source ${sourceId}:`, error);
    return null;
  }
}

// List all sources — public so the landing page can redirect unauthenticated users
// to the single-source view (or show the login button on the source list page).
// Sensitive config fields are not exposed.
router.get('/', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const sources = await databaseService.sources.getAllSources();
    const isAdmin = req.user?.isAdmin === true;
    // Project to public-safe metadata, then run through the shared
    // credential strip so admins still receive `password`/`apiKey`
    // (needed for the source-edit UI round-trip) and everyone else
    // does not.
    const projected = sources.map(s => stripSourceSecrets({
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      config: s.config,
      radio: computeSourceRadioSummary(s.id),
    }, isAdmin));
    res.json(projected);
  } catch (error) {
    logger.error('Error listing sources:', error);
    res.status(500).json({ error: 'Failed to list sources' });
  }
});

// Reorder the source list (issue #3338).
//
// Admin-gated (`sources:write`): the order is global, shared by every viewer,
// so it sits alongside Add/Edit/Delete in the same permission tier. Body is
// `{ order: string[] }` — a complete permutation of all current source IDs.
// Declared before `/:id` so the literal path is not captured as an id param.
router.post('/reorder', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order) || !order.every((id) => typeof id === 'string')) {
      return res.status(400).json({ error: 'order must be an array of source IDs' });
    }
    const sources = await databaseService.sources.reorderSources(order);
    const isAdmin = req.user?.isAdmin === true;
    const projected = sources.map(s => stripSourceSecrets({
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      config: s.config,
    }, isAdmin));
    res.json(projected);
  } catch (error: any) {
    // reorderSources throws on a non-permutation payload — surface as 400.
    logger.error('Error reordering sources:', error);
    res.status(400).json({ error: error?.message ?? 'Failed to reorder sources' });
  }
});

// Get single source
//
// MM-SEC-8: pass the row through the same `stripSourceSecrets` helper as the
// list endpoint above. `sources:read` covers source metadata (name, type,
// enabled, etc.); credentials embedded in the `config` blob are admin-only,
// matching the MM-SEC-1 pattern for `GET /api/settings`.
router.get('/:id', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    const isAdmin = req.user?.isAdmin === true;
    res.json(stripSourceSecrets(source, isAdmin));
  } catch (error) {
    logger.error('Error fetching source:', error);
    res.status(500).json({ error: 'Failed to fetch source' });
  }
});

// Create source
router.post('/', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, type, config, enabled } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name is required and must be a string' });
    }
    if (!['meshtastic_tcp', 'mqtt_broker', 'mqtt_bridge', 'meshcore'].includes(type)) {
      return res.status(400).json({ error: 'type must be meshtastic_tcp, mqtt_broker, mqtt_bridge, or meshcore' });
    }

    // mqtt_bridge may optionally attach to a parent mqtt_broker. When
    // brokerSourceId is omitted (or empty), the bridge runs standalone:
    // an upstream-only MQTT client suitable for monitoring a remote
    // broker or for serving as a client-proxy target via a
    // meshtastic_tcp source's `mqttLink` (issue #3134). When provided,
    // it must reference a real mqtt_broker so downlink republish and
    // uplink listening can wire up.
    if (type === 'mqtt_bridge') {
      const parentId = config?.brokerSourceId;
      if (parentId !== undefined && parentId !== null && parentId !== '') {
        if (typeof parentId !== 'string') {
          return res.status(400).json({ error: 'mqtt_bridge config.brokerSourceId must be a string when provided' });
        }
        const parent = await databaseService.sources.getSource(parentId);
        if (!parent || parent.type !== 'mqtt_broker') {
          return res.status(400).json({ error: `mqtt_bridge brokerSourceId ${parentId} does not reference an mqtt_broker source` });
        }
      }
      const rewriteError = validateMqttBridgeRewrites(config ?? {});
      if (rewriteError) {
        return res.status(400).json({ error: rewriteError });
      }
      const modeError = validateMqttBridgeMode(config ?? {});
      if (modeError) {
        return res.status(400).json({ error: modeError });
      }
      const forwardingModeError = validateMqttBridgeForwardingMode(config ?? {});
      if (forwardingModeError) {
        return res.status(400).json({ error: forwardingModeError });
      }
      const ignoreOkErr = validateMqttBridgeIgnoreOkToMqtt(config ?? {});
      if (ignoreOkErr) {
        return res.status(400).json({ error: ignoreOkErr });
      }
    }
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config is required and must be an object' });
    }

    const vnErr = await validateVirtualNodeConfig(type, config);
    if (vnErr) {
      return res.status(vnErr.status).json({ error: vnErr.error });
    }

    // Prevent duplicate host:port combinations
    if (type === 'meshtastic_tcp' && config.host && config.port) {
      const existing = await databaseService.sources.getAllSources();
      const duplicate = existing.find((s) => {
        const cfg = s.config as any;
        return cfg?.host === config.host && cfg?.port === config.port;
      });
      if (duplicate) {
        return res.status(409).json({
          error: `A source already exists with host ${config.host}:${config.port} ("${duplicate.name}")`,
        });
      }
    }

    const source = await databaseService.sources.createSource({
      id: uuidv4(),
      name: name.trim(),
      type,
      config,
      enabled: enabled !== false,
      createdBy: req.user?.id,
    });

    // Start manager if source is enabled and autoConnect is not explicitly false.
    // autoConnect=false means the source is registered but won't start monitoring
    // until a user explicitly clicks Connect (issue #2773).
    const cfgForStart = source.config as any;
    if (source.enabled && source.type === 'meshtastic_tcp' && cfgForStart?.autoConnect !== false) {
      try {
        const manager = new MeshtasticManager(source.id, {
          host: cfgForStart.host,
          port: cfgForStart.port,
          heartbeatIntervalSeconds: cfgForStart.heartbeatIntervalSeconds,
          virtualNode: cfgForStart.virtualNode,
          mqttLink: cfgForStart.mqttLink,
          passiveMode: cfgForStart.passiveMode === true,
          passiveResyncStaleMs: typeof cfgForStart.passiveResyncStaleMs === 'number' ? cfgForStart.passiveResyncStaleMs : null,
        });
        await sourceManagerRegistry.addManager(manager);
      } catch (err) {
        logger.warn(`Could not start manager for new source ${source.id}:`, err);
      }
    } else if (source.enabled && source.type === 'meshcore' && cfgForStart?.autoConnect !== false) {
      try {
        const mcConfig = meshcoreConfigFromSource(source);
        if (mcConfig) {
          await ensureMeshCoreManagerStarted(source, mcConfig);
        } else {
          logger.warn(`MeshCore source ${source.id} created with incomplete config`);
        }
      } catch (err) {
        logger.warn(`Could not start MeshCore manager for new source ${source.id}:`, err);
      }
    } else if (source.enabled && (source.type === 'mqtt_broker' || source.type === 'mqtt_bridge')) {
      try {
        const manager = buildMqttManagerForSource(
          source.id,
          source.name,
          source.type,
          source.config,
        );
        await sourceManagerRegistry.addManager(manager);
      } catch (err) {
        logger.warn(`Could not start MQTT manager for new source ${source.id}:`, err);
      }
    }

    res.status(201).json(source);
  } catch (error) {
    logger.error('Error creating source:', error);
    res.status(500).json({ error: 'Failed to create source' });
  }
});

// Update source
router.put('/:id', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, config, enabled } = req.body;
    const existing = await databaseService.sources.getSource(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Source not found' });
    }

    const updates: any = {};
    if (name !== undefined) updates.name = name.trim();
    if (config !== undefined) {
      updates.config = preserveSourceCredentials(
        existing.type,
        existing.config as Record<string, unknown> | undefined,
        config,
      );
    }
    if (enabled !== undefined) updates.enabled = enabled;

    // Validate VN config if config is being updated
    if (config !== undefined) {
      const vnErr = await validateVirtualNodeConfig(existing.type, config, existing.id);
      if (vnErr) {
        return res.status(vnErr.status).json({ error: vnErr.error });
      }

      // Validate mqtt_bridge topic rewrites (#3166) against the incoming
      // config — preserveSourceCredentials only round-trips passwords, so
      // the rewrite fields and the brokerSourceId in `config` reflect the
      // post-save state.
      if (existing.type === 'mqtt_bridge') {
        const rewriteError = validateMqttBridgeRewrites(config);
        if (rewriteError) {
          return res.status(400).json({ error: rewriteError });
        }
        const modeError = validateMqttBridgeMode(config);
        if (modeError) {
          return res.status(400).json({ error: modeError });
        }
        const forwardingModeError = validateMqttBridgeForwardingMode(config);
        if (forwardingModeError) {
          return res.status(400).json({ error: forwardingModeError });
        }
        const ignoreOkErr = validateMqttBridgeIgnoreOkToMqtt(config);
        if (ignoreOkErr) {
          return res.status(400).json({ error: ignoreOkErr });
        }
      }

      // Prevent duplicate host:port combinations (exclude self)
      if (existing.type === 'meshtastic_tcp' && config.host && config.port) {
        const allSources = await databaseService.sources.getAllSources();
        const duplicate = allSources.find((s) => {
          if (s.id === req.params.id) return false;
          const cfg = s.config as any;
          return cfg?.host === config.host && cfg?.port === config.port;
        });
        if (duplicate) {
          return res.status(409).json({
            error: `A source already exists with host ${config.host}:${config.port} ("${duplicate.name}")`,
          });
        }
      }
    }

    const source = await databaseService.sources.updateSource(req.params.id, updates);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // Propagate name change to the live MeshCore manager so getStatus() stays
    // fresh without requiring a restart (#3962 WP3b — open question 5).
    if (name !== undefined) {
      const liveMgr = sourceManagerRegistry.getManager(source.id);
      if (liveMgr && isMeshCoreManager(liveMgr)) {
        liveMgr.setSourceName(source.name);
      }
    }

    // Handle enable/disable transitions
    const wasEnabled = existing.enabled;
    const isNowEnabled = source.enabled;
    const oldAutoConnect = (existing.config as any)?.autoConnect !== false;
    const newAutoConnect = (source.config as any)?.autoConnect !== false;

    if (!wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp' && newAutoConnect) {
      // Newly enabled and autoConnect on: start manager if not already running.
      // When autoConnect is false, the source stays enabled but idle until the
      // user explicitly clicks Connect (issue #2773).
      if (!sourceManagerRegistry.getManager(source.id)) {
        try {
          const cfg = source.config as any;
          const manager = new MeshtasticManager(source.id, {
            host: cfg.host,
            port: cfg.port,
            heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
            virtualNode: cfg.virtualNode,
            mqttLink: cfg.mqttLink,
            passiveMode: cfg.passiveMode === true,
            passiveResyncStaleMs: typeof cfg.passiveResyncStaleMs === 'number' ? cfg.passiveResyncStaleMs : null,
          });
          await sourceManagerRegistry.addManager(manager);
        } catch (err) {
          logger.warn(`Could not start manager for source ${source.id}:`, err);
        }
      }
    } else if (!wasEnabled && isNowEnabled && source.type === 'meshcore' && newAutoConnect) {
      // Newly enabled MeshCore source with autoConnect on — register in the
      // unified sourceManagerRegistry via the create-or-connect recipe.
      try {
        const mcConfig = meshcoreConfigFromSource(source);
        if (mcConfig) {
          await ensureMeshCoreManagerStarted(source, mcConfig);
        } else {
          logger.warn(`MeshCore source ${source.id} enabled with incomplete config`);
        }
      } catch (err) {
        logger.warn(`Could not start MeshCore manager for source ${source.id}:`, err);
      }
    } else if (wasEnabled && !isNowEnabled) {
      // Newly disabled: stop manager in the unified registry (no-op when not registered).
      await sourceManagerRegistry.removeManager(source.id);
    } else if (wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp' && oldAutoConnect && !newAutoConnect) {
      // autoConnect just turned off — stop the running manager. The source
      // stays enabled so the user can manually reconnect.
      await sourceManagerRegistry.removeManager(source.id);
    } else if (wasEnabled && isNowEnabled && source.type === 'meshcore' && oldAutoConnect && !newAutoConnect) {
      // MeshCore autoConnect just turned off — remove the manager. The
      // source stays enabled so the user can manually reconnect.
      await sourceManagerRegistry.removeManager(source.id);
    } else if (wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp' && !oldAutoConnect && newAutoConnect) {
      // autoConnect just turned on — start the manager if not already running.
      if (!sourceManagerRegistry.getManager(source.id)) {
        try {
          const cfg = source.config as any;
          const manager = new MeshtasticManager(source.id, {
            host: cfg.host,
            port: cfg.port,
            heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
            virtualNode: cfg.virtualNode,
            mqttLink: cfg.mqttLink,
            passiveMode: cfg.passiveMode === true,
            passiveResyncStaleMs: typeof cfg.passiveResyncStaleMs === 'number' ? cfg.passiveResyncStaleMs : null,
          });
          await sourceManagerRegistry.addManager(manager);
        } catch (err) {
          logger.warn(`Could not start manager for source ${source.id}:`, err);
        }
      }
    } else if (wasEnabled && isNowEnabled && source.type === 'meshcore' && !oldAutoConnect && newAutoConnect) {
      // MeshCore autoConnect just turned on — create-or-connect.
      try {
        const mcConfig = meshcoreConfigFromSource(source);
        if (mcConfig) {
          await ensureMeshCoreManagerStarted(source, mcConfig);
        } else {
          logger.warn(`MeshCore source ${source.id} has incomplete config; not auto-connecting`);
        }
      } catch (err) {
        logger.warn(`Could not start MeshCore manager for source ${source.id}:`, err);
      }
    } else if (wasEnabled && isNowEnabled && source.type === 'meshtastic_tcp' && config !== undefined) {
      // Still enabled, config possibly changed. Detect what changed and act.
      const oldCfg = (existing.config as any) || {};
      const newCfg = (source.config as any) || {};
      const transportChanged =
        oldCfg.host !== newCfg.host ||
        oldCfg.port !== newCfg.port ||
        // Heartbeat changes require a restart because the interval is baked
        // into the transport at construct-time (issue 2609).
        (oldCfg.heartbeatIntervalSeconds ?? 0) !== (newCfg.heartbeatIntervalSeconds ?? 0) ||
        // Passive Mode (#3122) toggles reconnect/disconnect behavior baked into
        // the running manager. Restart so the new policy takes effect cleanly.
        (oldCfg.passiveMode === true) !== (newCfg.passiveMode === true) ||
        // Passive resync staleness window is read at construction time (and
        // by configureSource) — change it → bounce the manager so the next
        // reconnect uses the new threshold.
        (typeof oldCfg.passiveResyncStaleMs === 'number' ? oldCfg.passiveResyncStaleMs : null) !==
          (typeof newCfg.passiveResyncStaleMs === 'number' ? newCfg.passiveResyncStaleMs : null);
      const oldVn = JSON.stringify(oldCfg.virtualNode ?? null);
      const newVn = JSON.stringify(newCfg.virtualNode ?? null);
      const vnChanged = oldVn !== newVn;
      const oldLink = JSON.stringify(oldCfg.mqttLink ?? null);
      const newLink = JSON.stringify(newCfg.mqttLink ?? null);
      const linkChanged = oldLink !== newLink;

      if (transportChanged) {
        // Full restart — upstream TCP target or heartbeat config changed.
        try {
          await sourceManagerRegistry.removeManager(source.id);
          const manager = new MeshtasticManager(source.id, {
            host: newCfg.host,
            port: newCfg.port,
            heartbeatIntervalSeconds: newCfg.heartbeatIntervalSeconds,
            virtualNode: newCfg.virtualNode,
            mqttLink: newCfg.mqttLink,
            passiveMode: newCfg.passiveMode === true,
            passiveResyncStaleMs: typeof newCfg.passiveResyncStaleMs === 'number' ? newCfg.passiveResyncStaleMs : null,
          });
          await sourceManagerRegistry.addManager(manager);
        } catch (err) {
          logger.warn(`Could not restart manager for source ${source.id}:`, err);
        }
      } else if (vnChanged) {
        // Hot-swap only the virtual node sub-feature.
        try {
          await sourceManagerRegistry.reconfigureVirtualNode(source.id, newCfg.virtualNode);
        } catch (err) {
          logger.warn(`Could not hot-swap virtual node for source ${source.id}:`, err);
        }
      } else if (linkChanged) {
        // Hot-swap only the MQTT proxy link (issue #3003 follow-up). The
        // upstream transport stays up; the manager rebinds its broker
        // listener without dropping the device connection.
        const mgr = sourceManagerRegistry.getManager(source.id) as MeshtasticManager | undefined;
        if (mgr && typeof mgr.reconfigureMqttLink === 'function') {
          try {
            await mgr.reconfigureMqttLink(newCfg.mqttLink);
          } catch (err) {
            logger.warn(`Could not hot-swap MQTT link for source ${source.id}:`, err);
          }
        }
      }
    } else if (!wasEnabled && isNowEnabled && (source.type === 'mqtt_broker' || source.type === 'mqtt_bridge')) {
      // Newly enabled MQTT source — register and start the manager.
      if (!sourceManagerRegistry.getManager(source.id)) {
        try {
          const manager = buildMqttManagerForSource(source.id, source.name, source.type, source.config);
          await sourceManagerRegistry.addManager(manager);
        } catch (err) {
          logger.warn(`Could not start MQTT manager for source ${source.id}:`, err);
        }
      }
    } else if (wasEnabled && isNowEnabled && (source.type === 'mqtt_broker' || source.type === 'mqtt_bridge') && config !== undefined) {
      // MQTT source config changed while enabled — full restart, since the
      // listener port / upstream URL / filter set are all baked in at start.
      try {
        await sourceManagerRegistry.removeManager(source.id);
        const manager = buildMqttManagerForSource(source.id, source.name, source.type, source.config);
        await sourceManagerRegistry.addManager(manager);
      } catch (err) {
        logger.warn(`Could not restart MQTT manager for source ${source.id}:`, err);
      }

      // Config-change geo sweep (MQTT Geo-Ignore epic, Phase 3, WP3).
      // The bridge's own start() sweep above (buildMqttManagerForSource →
      // addManager) always runs with lift:false — it has no old bbox to diff
      // against. When the geo bbox itself changed, run an explicit LIFT+ADD
      // sweep here so nodes the new bbox no longer excludes reappear
      // immediately instead of waiting for their next POSITION packet.
      if (source.type === 'mqtt_bridge') {
        const oldGeo =
          (existing.config as { downlinkFilters?: MqttFilterConfig }).downlinkFilters?.geo ?? null;
        const newGeo =
          (source.config as { downlinkFilters?: MqttFilterConfig }).downlinkFilters?.geo ?? null;
        // Field-by-field comparison — immune to JSON key-order differences
        // between the stored config and the request body (a false "changed"
        // would only cost a no-op sweep, but there's no reason to pay it).
        const bboxField = (g: MqttFilterConfig['geo'] | null, k: 'minLat' | 'maxLat' | 'minLng' | 'maxLng') =>
          typeof g?.[k] === 'number' ? g[k] : null;
        const geoChanged = (['minLat', 'maxLat', 'minLng', 'maxLng'] as const).some(
          (k) => bboxField(oldGeo, k) !== bboxField(newGeo, k),
        );
        if (geoChanged) {
          const mgr = sourceManagerRegistry.getManager(source.id);
          const sink: GeoSweepStatsSink | undefined =
            mgr && 'recordGeoSweepStats' in mgr ? (mgr as unknown as GeoSweepStatsSink) : undefined;
          // Connect-independent DB convergence with lift:true — the ONLY path
          // allowed to lift geo-ignores (it alone knows the bbox changed). Bbox
          // removal/any change readmits geo-ignored nodes; still-outside ones
          // self-correct on their next POSITION via the realtime path. The
          // restarted manager's own start() sweep (lift:false) is an idempotent
          // add-pass repeat, serialized by the service's per-source guard.
          try {
            await mqttGeoSweepService.runSweep(source.id, newGeo ?? undefined, { lift: true, sink });
          } catch (err) {
            logger.warn(`Geo sweep after config change failed for source ${source.id}:`, err);
          }
        }
      }
    } else if (wasEnabled && isNowEnabled && source.type === 'meshcore' && newAutoConnect && config !== undefined) {
      // MeshCore source config changed while enabled and autoConnect on —
      // the connect config is baked in at connect-time, so any change means
      // remove the old manager and register a fresh one with the updated config.
      try {
        const mcConfig = meshcoreConfigFromSource(source);
        if (mcConfig) {
          await sourceManagerRegistry.removeManager(source.id);
          await ensureMeshCoreManagerStarted(source, mcConfig);
        } else {
          logger.warn(`MeshCore source ${source.id} updated to incomplete config`);
        }
      } catch (err) {
        logger.warn(`Could not restart MeshCore manager for source ${source.id}:`, err);
      }
    }

    res.json(source);
  } catch (error) {
    logger.error('Error updating source:', error);
    res.status(500).json({ error: 'Failed to update source' });
  }
});

// Delete source
router.delete('/:id', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const target = await databaseService.sources.getSource(req.params.id);
    if (target?.type === 'mqtt_broker') {
      // Detach dependent mqtt_bridge sources rather than blocking deletion
      // (issue #3134). Standalone bridges are valid: they ingest upstream
      // traffic and can still serve as proxy targets for a meshtastic_tcp
      // source's `mqttLink`.
      const all = await databaseService.sources.getAllSources();
      const dependents = all.filter(
        (s) => s.type === 'mqtt_bridge' && (s.config as any)?.brokerSourceId === req.params.id,
      );
      for (const dep of dependents) {
        const newCfg = { ...(dep.config as Record<string, unknown>) };
        delete newCfg.brokerSourceId;
        await databaseService.sources.updateSource(dep.id, { config: newCfg });
        if (dep.enabled) {
          try {
            await sourceManagerRegistry.removeManager(dep.id);
            const manager = buildMqttManagerForSource(dep.id, dep.name, dep.type as 'mqtt_bridge', newCfg);
            await sourceManagerRegistry.addManager(manager);
          } catch (err) {
            logger.warn(`Could not restart bridge ${dep.id} after detaching from deleted broker ${req.params.id}:`, err);
          }
        }
      }
    }

    // Stop the manager before deleting. All source types are in the unified
    // sourceManagerRegistry, and removeManager is a no-op when not registered.
    await sourceManagerRegistry.removeManager(req.params.id);

    const deleted = await databaseService.sources.deleteSource(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Source not found' });
    }

    // #4137: deleteSource only removes the `sources` row — it does not cascade
    // to `nodes` (or messages/telemetry/etc). Left behind, those orphaned node
    // rows keep contributing a stale hideFromMap (and other flags) to the
    // unified merge forever, with no UI path left to clean them up since the
    // owning source no longer exists. Best-effort: don't fail the delete
    // request if this cleanup has a problem.
    try {
      await databaseService.purgeAllNodesAsync(req.params.id);
    } catch (purgeError) {
      logger.warn(`Failed to purge nodes for deleted source ${req.params.id}:`, purgeError);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting source:', error);
    res.status(500).json({ error: 'Failed to delete source' });
  }
});

// Get source status (connection state from registry)
//
// Includes a `nodeCount` field so the dashboard sidebar can show how many nodes
// each source has heard without having to fetch every source's full node list
// (the sidebar polls /status for every source on a 15s interval, but the
// expensive /nodes endpoint is only fetched for the *selected* source).
// `optionalAuth` (not requirePermission) so anonymous viewers see live
// connection state — same approach as /api/unified/sources-status. The
// sidebar badge is operational signal, not user-scoped data, and gating it
// caused anonymous users to see "Connecting"/"Idle" forever (issue #2883).
// Node counts remain permission-scoped: only included when the caller has
// `nodes:read` for this source, mirroring the unified endpoint.
router.get('/:id/status', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    const manager = sourceManagerRegistry.getManager(req.params.id);
    let status: any;
    if (manager) {
      if (isMeshCoreManager(manager)) {
        // Pass the live source name so the status reflects any renames without
        // requiring a manager restart.
        status = manager.getStatus(source.name);
      } else {
        status = manager.getStatus();
      }
    } else {
      status = {
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        connected: false,
      };
    }

    const user = (req as any).user;
    const isAdmin = user?.isAdmin ?? false;
    const canReadNodes = isAdmin || (user
      ? await databaseService.checkPermissionAsync(user.id, 'nodes', 'read', source.id)
      : false);

    if (!canReadNodes) {
      return res.json(status);
    }

    // Cheap COUNT(*) queries — never throw on empty source.
    // `activeNodeCount` is the count of nodes heard in the last 2h, used by
    // the sidebar's node-activity badge (issue #2883). Kept parallel with
    // the total count so source status fans out in a single round-trip.
    // MeshCore contacts live in the per-source MeshCoreManager, not the
    // shared `nodes` table, so count from getAllNodes() instead.
    let nodeCount: number;
    let activeNodeCount: number;
    if (source.type === 'meshcore') {
      // MeshCore contacts live in the manager's in-memory store, not the shared
      // `nodes` table, so count from getAllNodes() on the narrowed manager.
      const mcManager = manager && isMeshCoreManager(manager) ? manager : undefined;
      if (mcManager) {
        const all = await mcManager.getAllNodes();
        nodeCount = all.length;
        const cutoffMs = Date.now() - 7_200_000;
        const localHasLastHeard = mcManager.getLocalNode()?.lastHeard != null;
        activeNodeCount = all.filter((n, i) => {
          // localNode (index 0 when present) has no lastHeard at creation but
          // is "active" while the manager is connected.
          if (i === 0 && mcManager.getLocalNode() && !localHasLastHeard) return true;
          return typeof n.lastHeard === 'number' && n.lastHeard >= cutoffMs;
        }).length;
      } else {
        nodeCount = 0;
        activeNodeCount = 0;
      }
    } else {
      [nodeCount, activeNodeCount] = await Promise.all([
        databaseService.nodes.getNodeCount(source.id).catch(() => 0),
        databaseService.nodes.getActiveNodeCount(source.id).catch(() => 0),
      ]);
      // The /:id/nodes endpoint injects the manager's local node into the
      // returned list whenever it isn't persisted for this source — most
      // visibly the MQTT broker's synthetic gateway node, which never lands
      // in the `nodes` table. getNodeCount() (a plain COUNT(*)) doesn't see
      // that injected node, so the sidebar badge would read one lower than
      // the node list the user sees when the source is selected. Worse, the
      // dashboard uses the live list length for the *selected* source but
      // this polled count for the rest, so the badge flickered (e.g. 11↔12)
      // purely on selection state (issue #3354). Mirror the injection here so
      // the count matches the list and stays stable regardless of selection.
      const localNodeInfo = manager?.getLocalNodeInfo?.();
      if (localNodeInfo?.nodeNum) {
        const inSource = await databaseService.nodes
          .getNode(localNodeInfo.nodeNum, source.id)
          .catch(() => null);
        if (!inSource) {
          nodeCount += 1;
          // /nodes synthesizes the injected local node with lastHeard=now, so
          // it counts as "active" whenever the source link is up.
          if (status?.connected) activeNodeCount += 1;
        }
      }
    }
    res.json({ ...status, nodeCount, activeNodeCount });
  } catch (error) {
    logger.error('Error fetching source status:', error);
    res.status(500).json({ error: 'Failed to fetch source status' });
  }
});

// ============ PER-SOURCE DATA ENDPOINTS ============
// These scope all queries to the given source, forming the backend for Phase 4 frontend.

// ---- PKI direct-message decryption (issue #3441) ----
// Per-source opt-in: when enabled, MeshMonitor stores the source's local-node
// X25519 private key (encrypted) and decrypts PKI DMs addressed to that node —
// including ones relayed still-encrypted via MQTT — so they surface in the
// unified view. Gated by per-source `configuration` permission.

// GET /api/sources/:id/pki-dm/status
router.get('/:id/pki-dm/status', requirePermission('configuration', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    const enabled = (await databaseService.settings.getSettingForSource(source.id, 'pkiDmDecryptionEnabled')) === 'true';
    const globallyEnabled = await isPkiDmDecryptionGloballyEnabled();
    const store = getSourcePkiKeyStore();
    const keyStored = await store.hasStored(source.id);
    res.json({ enabled, globallyEnabled, keyStored, canStore: store.capability.canStore, reason: store.capability.reason ?? null });
  } catch (error) {
    logger.error('[API] PKI DM status error:', error);
    res.status(500).json({ error: 'Failed to get PKI DM decryption status' });
  }
});

// POST /api/sources/:id/pki-dm  body: { enabled: boolean }
router.post('/:id/pki-dm', requirePermission('configuration', 'write', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (source.type === 'meshcore') {
      return res.status(400).json({ error: 'PKI DM decryption applies to Meshtastic sources only' });
    }
    const enabled = req.body?.enabled === true;
    const store = getSourcePkiKeyStore();
    if (enabled && !(await isPkiDmDecryptionGloballyEnabled())) {
      return res.status(400).json({ error: 'PKI DM decryption is disabled globally — enable it in Settings first' });
    }
    if (enabled && !store.capability.canStore) {
      return res.status(400).json({ error: store.capability.reason || 'Cannot store PKI keys: SESSION_SECRET is not configured' });
    }
    await databaseService.settings.setSourceSetting(source.id, 'pkiDmDecryptionEnabled', enabled ? 'true' : 'false');
    if (enabled) {
      // Extract the key now if the source is connected; otherwise it happens on
      // the next configComplete.
      const mgr = sourceManagerRegistry.getManager(source.id);
      if (mgr instanceof MeshtasticManager) {
        await mgr.maybeExtractAndStorePkiKey();
      }
    } else {
      // Forget the stored key so decryption stops immediately.
      await store.clear(source.id);
    }
    const keyStored = await store.hasStored(source.id);
    res.json({ success: true, enabled, keyStored });
  } catch (error) {
    logger.error('[API] PKI DM toggle error:', error);
    res.status(500).json({ error: 'Failed to update PKI DM decryption' });
  }
});

// GET /api/sources/:id/nodes — all nodes for a source
// Uses nodes:read permission (not sources:read) so anonymous users with channel viewOnMap
// permissions can access node data for map display, filtered by their channel permissions.
router.get('/:id/nodes', requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const user = (req as any).user ?? null;
    const withOverride = await buildSourceNodes(source, user);
    res.json(withOverride);
  } catch (error) {
    logger.error('Error fetching nodes for source:', error);
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

// GET /api/sources/:id/messages?limit=100&offset=0 — messages for a source
router.get('/:id/messages', requirePermission('messages', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    // Exclude traceroute responses from the per-source UI feed. The client
    // filters them out anyway (they render from the `traceroutes` table);
    // letting them occupy slots in the capped window evicts real DMs
    // (issue #2741).
    const messages = await databaseService.messages.getMessages(limit, offset, source.id, [PortNum.TRACEROUTE_APP]);
    res.json(messages);
  } catch (error) {
    logger.error('Error fetching messages for source:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// GET /api/sources/:id/channels — channels for a source
//
// MM-SEC-7: same root cause as MM-SEC-2 — `getAllChannels(sourceId)` returns
// the raw `psk` column for every slot, and the gate `messages:read` is
// unrelated to channel cryptographic material. Apply the MM-SEC-2 pattern:
// optionalAuth + per-row `channel_${id}:read` gate scoped to this source +
// `transformChannel` projection so the raw PSK never reaches the response.
router.get('/:id/channels', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const user = (req as any).user ?? null;
    const projected = await buildSourceChannels(source, user);
    res.json(projected);
  } catch (error) {
    logger.error('Error fetching channels for source:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// GET /api/sources/:id/traceroutes?limit=50 — traceroutes for a source
router.get('/:id/traceroutes', requirePermission('traceroute', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const user = (req as any).user ?? null;
    const masked = await buildSourceTraceroutes(source, user, limit);
    res.json(masked);
  } catch (error) {
    logger.error('Error fetching traceroutes for source:', error);
    res.status(500).json({ error: 'Failed to fetch traceroutes' });
  }
});

// GET /api/sources/:id/neighbor-info — enriched neighbor info scoped to a source
router.get('/:id/neighbor-info', requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const neighborUser = (req as any).user ?? null;
    const enrichedNeighborInfo = await buildSourceNeighborInfo(source, neighborUser);
    res.json(enrichedNeighborInfo);
  } catch (error) {
    logger.error('Error fetching neighbor info for source:', error);
    res.status(500).json({ error: 'Failed to fetch neighbor info' });
  }
});

// GET /api/sources/:id/dashboard — bundled read of a source's nodes,
// traceroutes, neighbor-info and channels in ONE response.
//
// The dashboard used to fire these as four separate GETs per source on every
// 15s poll (4×N requests for N sources), exhausting the API rate limiter on
// multi-source setups and hammering low-powered / heavily-utilized servers
// (#3735). Bundling collapses that to one request per source. optionalAuth +
// the per-dataset permission gating inside buildSourceDashboard mirror the
// individual endpoints' access rules (a dataset the caller can't read comes
// back as [] rather than 403-ing the whole bundle).
router.get('/:id/dashboard', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    const user = (req as any).user ?? null;
    const payload = await buildSourceDashboard(source, user);
    res.json(payload);
  } catch (error) {
    logger.error('Error fetching dashboard data for source:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// POST /api/sources/:id/connect — manually start the manager for a source.
// Used when autoConnect is disabled (issue #2773) so a user can bring the
// source online on demand without changing persisted config.
router.post('/:id/connect', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (!source.enabled) {
      return res.status(409).json({ error: 'Source is disabled; enable it first' });
    }
    if (source.type !== 'meshtastic_tcp' && source.type !== 'meshcore') {
      return res.status(400).json({ error: 'Manual connect is only supported for meshtastic_tcp and meshcore sources' });
    }
    if (source.type === 'meshcore') {
      const existingMgr = sourceManagerRegistry.getManager(source.id);
      const existingMc = existingMgr && isMeshCoreManager(existingMgr) ? existingMgr : undefined;
      if (existingMc?.isConnected()) {
        return res.json({ success: true, alreadyRunning: true });
      }
      const mcConfig = meshcoreConfigFromSource(source);
      if (!mcConfig) {
        return res.status(400).json({ error: 'MeshCore source has incomplete config' });
      }
      if (!existingMc) {
        // No manager yet — create and register (addManager calls start() → connect).
        const mc = new MeshCoreManager(source.id, source.name);
        mc.configure(mcConfig);
        await sourceManagerRegistry.addManager(mc);
      } else {
        // Manager exists but is disconnected — reconnect with fresh config.
        await existingMc.connect(mcConfig);
      }
      return res.json({ success: true });
    }
    if (sourceManagerRegistry.getManager(source.id)) {
      return res.json({ success: true, alreadyRunning: true });
    }
    const cfg = source.config as any;
    const manager = new MeshtasticManager(source.id, {
      host: cfg.host,
      port: cfg.port,
      heartbeatIntervalSeconds: cfg.heartbeatIntervalSeconds,
      virtualNode: cfg.virtualNode,
      mqttLink: cfg.mqttLink,
      passiveMode: cfg.passiveMode === true,
      passiveResyncStaleMs: typeof cfg.passiveResyncStaleMs === 'number' ? cfg.passiveResyncStaleMs : null,
    });
    await sourceManagerRegistry.addManager(manager);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error connecting source:', err);
    res.status(500).json({ error: 'Failed to connect source' });
  }
});

// POST /api/sources/:id/disconnect — manually stop the manager without disabling
// the source. Paired with /connect for autoConnect=false workflows.
router.post('/:id/disconnect', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (source.type === 'meshcore') {
      const existingMgr = sourceManagerRegistry.getManager(source.id);
      const existingMc = existingMgr && isMeshCoreManager(existingMgr) ? existingMgr : undefined;
      if (!existingMc?.isConnected()) {
        return res.json({ success: true, alreadyStopped: true });
      }
      // Tear down the device link but KEEP the manager registered. Removing it
      // from the registry leaves the source unaddressable: every /meshcore/*
      // route is behind a guard that 404s ("No MeshCore manager for source")
      // when the manager is absent, so the page's status/read polling errors
      // out and the source can't be driven again without a restart. A plain
      // disconnect() stops the link, VN server, heartbeat and schedulers while
      // leaving the manager in place for a clean reconnect via /connect.
      await existingMc.disconnect();
      return res.json({ success: true });
    }
    if (!sourceManagerRegistry.getManager(source.id)) {
      return res.json({ success: true, alreadyStopped: true });
    }
    await sourceManagerRegistry.removeManager(source.id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Error disconnecting source:', err);
    res.status(500).json({ error: 'Failed to disconnect source' });
  }
});

// POST /api/sources/:id/resync — operator-initiated full config refresh
// (#3122 follow-up). Forces a single want_config_id even when Passive Mode
// would otherwise skip it for cache-freshness. Returns the manual-resync
// state (inFlight + cooldownExpiresAt) so the UI button renders correctly.
//
// Status codes:
//   200 — resync started, inFlight=true, cooldownExpiresAt populated
//   404 — source not found
//   400 — source type doesn't support resync (only meshtastic_tcp)
//   409 — another resync is in flight OR cooldown still active OR not connected
//
// Errors carry the same JSON shape as a success so the UI can keep its
// disabled/cooldown timer state in sync with the server's reality without
// special-casing the response shape.
router.post('/:id/resync', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (source.type !== 'meshtastic_tcp') {
      return res.status(400).json({ error: 'Manual resync is only supported on meshtastic_tcp sources' });
    }
    const mgr = sourceManagerRegistry.getManager(source.id) as MeshtasticManager | undefined;
    if (!mgr || typeof mgr.requestManualResync !== 'function') {
      return res.status(409).json({ error: 'Source manager is not running', reason: 'not-connected' });
    }
    const result = await mgr.requestManualResync();
    const status = result.started ? 200 : 409;
    return res.status(status).json(result);
  } catch (err) {
    logger.error('Error triggering manual resync:', err);
    res.status(500).json({ error: 'Failed to trigger manual resync' });
  }
});

// GET /api/sources/:id/resync — query the current manual-resync state
// (inFlight + cooldownExpiresAt). Used by the UI to poll while a resync
// is running so the button enables/disables in real time.
router.get('/:id/resync', requirePermission('sources', 'read'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (source.type !== 'meshtastic_tcp') {
      return res.json({ inFlight: false, cooldownExpiresAt: 0 });
    }
    const mgr = sourceManagerRegistry.getManager(source.id) as MeshtasticManager | undefined;
    if (!mgr || typeof mgr.getManualResyncState !== 'function') {
      return res.json({ inFlight: false, cooldownExpiresAt: 0 });
    }
    res.json(mgr.getManualResyncState());
  } catch (err) {
    logger.error('Error fetching manual resync state:', err);
    res.status(500).json({ error: 'Failed to fetch manual resync state' });
  }
});

// POST /api/sources/:id/prune-outside-roi — surgical cleanup of node rows
// whose last-known position is outside the bridge's geo bbox. Only valid for
// mqtt_bridge sources that have downlinkFilters.geo configured. Forward-only
// ingestion is already gated by MqttPacketFilter.postFilterPosition, so this
// endpoint exists to clean up rows that were ingested *before* the current
// bbox was set (or with a wider previous bbox).
//
// The bridge republishes downlink packets into its parent mqtt_broker source,
// so the same out-of-ROI nodes typically exist under both sourceIds. Prune
// the broker too — otherwise users see the "cleaned" nodes reappear the
// moment they switch the sidebar to the broker.
router.post('/:id/prune-outside-roi', requirePermission('sources', 'write'), async (req: Request, res: Response) => {
  try {
    const source = await databaseService.sources.getSource(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (source.type !== 'mqtt_bridge') {
      return res.status(400).json({ error: 'Prune outside ROI is only supported on mqtt_bridge sources' });
    }
    const bridgeConfig = source.config as any;
    const geo = bridgeConfig?.downlinkFilters?.geo;
    const bounds = {
      minLat: typeof geo?.minLat === 'number' ? geo.minLat : undefined,
      maxLat: typeof geo?.maxLat === 'number' ? geo.maxLat : undefined,
      minLng: typeof geo?.minLng === 'number' ? geo.minLng : undefined,
      maxLng: typeof geo?.maxLng === 'number' ? geo.maxLng : undefined,
    };
    if (
      bounds.minLat === undefined &&
      bounds.maxLat === undefined &&
      bounds.minLng === undefined &&
      bounds.maxLng === undefined
    ) {
      return res.status(400).json({ error: 'This bridge has no geo bounding box configured' });
    }
    const bridgeCount = await databaseService.pruneNodesOutsideBboxAsync(source.id, bounds);
    logger.info(`Pruned ${bridgeCount} node(s) outside ROI for source ${source.id} (${source.name})`);

    let brokerCount = 0;
    let prunedBrokerSourceId: string | null = null;
    const brokerSourceId = typeof bridgeConfig?.brokerSourceId === 'string' ? bridgeConfig.brokerSourceId : null;
    if (brokerSourceId && brokerSourceId !== source.id) {
      const broker = await databaseService.sources.getSource(brokerSourceId);
      if (broker && broker.type === 'mqtt_broker') {
        brokerCount = await databaseService.pruneNodesOutsideBboxAsync(broker.id, bounds);
        prunedBrokerSourceId = broker.id;
        logger.info(`Pruned ${brokerCount} node(s) outside ROI for parent broker ${broker.id} (${broker.name})`);
      } else if (!broker) {
        logger.warn(`Bridge ${source.id} references missing brokerSourceId=${brokerSourceId}; skipping parent prune`);
      }
    }

    res.json({
      success: true,
      count: bridgeCount + brokerCount,
      sourceId: source.id,
      bridgeCount,
      brokerCount,
      brokerSourceId: prunedBrokerSourceId,
    });
  } catch (err) {
    logger.error('Error pruning nodes outside ROI:', err);
    res.status(500).json({ error: 'Failed to prune nodes' });
  }
});

// Waypoints sub-router. Each handler runs `requirePermission('waypoints', …)`
// scoped to the path's `:id` parameter.
router.use('/:id/waypoints', waypointRoutes);

export default router;
