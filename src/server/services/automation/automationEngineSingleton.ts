/**
 * Automation Engine singleton + event wiring (#3653, §4).
 *
 * Holds the process-wide AutomationEngineService, lets routes trigger a reload
 * after CRUD, and subscribes the engine to the dataEventEmitter so it fires on
 * live mesh traffic. All event handling is wrapped — an automation error must
 * never disturb the event bus.
 */
import { logger } from '../../../utils/logger.js';
import databaseService from '../../../services/database.js';
import { dataEventEmitter, type DataEvent } from '../dataEventEmitter.js';
import type { DbMessage, DbTelemetry } from '../../../services/database.js';
import type { MeshCoreMessage } from '../../meshcoreManager.js';
import type { ReticulumMessageRow } from '../../../db/repositories/reticulum.js';
import { AutomationEngineService } from './automationEngineService.js';
import { VariableResolver } from './variableResolver.js';
import { createMeshActionDeps } from './meshActionDeps.js';
import { createMeshNodeDataProvider } from './meshNodeData.js';
import { estimateHomeFromNodeHistory } from './leftHomeFromHistory.js';

let engine: AutomationEngineService | null = null;
let subscribed = false;
/** Last version we raised an `upgrade-available` event for (dedupe across polls). */
let lastUpgradeNotified: string | null = null;

export function getAutomationEngine(): AutomationEngineService | null {
  return engine;
}

/**
 * Raise the `upgrade-available` system event when a newer MeshMonitor release is
 * detected. Called from the version-check route. Deduped by version so repeated
 * polls (the route caches ~5 min) only fire automations once per new version.
 */
export async function notifyUpgradeAvailable(info: {
  latestVersion: string;
  currentVersion: string;
  releaseUrl?: string;
  releaseName?: string;
}): Promise<void> {
  if (!engine) return;
  if (!info.latestVersion || info.latestVersion === lastUpgradeNotified) return;
  lastUpgradeNotified = info.latestVersion;
  try {
    await engine.onSystem('upgrade-available', null, null, undefined, {
      latestVersion: info.latestVersion,
      currentVersion: info.currentVersion,
      releaseUrl: info.releaseUrl,
      releaseName: info.releaseName,
    });
  } catch (e: any) {
    logger.error(`[AutomationEngine] upgrade-available trigger error: ${e?.message}`);
  }
}

/** Reload enabled automations into the engine (called after CRUD). No-op if not started. */
export async function reloadAutomations(): Promise<void> {
  if (engine) await engine.load();
}

/**
 * Initialise the engine with real deps, load automations, and subscribe to the
 * event bus. Safe to call once during server bootstrap (after the database is
 * ready). Idempotent.
 */
export async function startAutomationEngine(): Promise<void> {
  if (engine) return;
  if (!databaseService.automationsRepo || !databaseService.automationVariablesRepo) {
    logger.warn('[AutomationEngine] database not ready; engine not started');
    return;
  }
  const varResolver = new VariableResolver(databaseService.automationVariablesRepo);
  engine = new AutomationEngineService({
    automationsRepo: databaseService.automationsRepo,
    varResolver,
    deps: createMeshActionDeps(),
    data: createMeshNodeDataProvider(),
    homeAnchorsRepo: databaseService.automationHomeAnchorsRepo,
    estimateHomeFromHistory: async (nodeNum, thresholdMeters) => {
      const est = await estimateHomeFromNodeHistory(nodeNum, thresholdMeters);
      return est ? { latitude: est.latitude, longitude: est.longitude } : null;
    },
  });
  await engine.load();
  subscribe();
  // Staleness is packet ABSENCE, so it needs a timer, not an event (#4558 Phase A).
  engine.startStaleTicker();
  // Battery decline is a slow trend derived from telemetry history — polled on a
  // slower timer, no event to react to (#4558 Phase E).
  engine.startBatteryTrendTicker();
  logger.info('[AutomationEngine] started');
  // Fire the system-start event so `trigger.system` (event: bootup) automations run.
  engine.onSystem('bootup', null, null).catch((e) => logger.error(`[AutomationEngine] bootup trigger error: ${e?.message}`));
}

function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  dataEventEmitter.on('data', (event: DataEvent) => {
    handleEvent(event).catch((e) =>
      logger.error(`[AutomationEngine] event handler error: ${e?.message}`),
    );
  });
}

async function handleEvent(event: DataEvent): Promise<void> {
  const e = engine;
  if (!e) return;
  const sourceId = event.sourceId ?? null;

  switch (event.type) {
    case 'message:new':
      await e.onMessage(event.data as DbMessage, sourceId);
      break;

    case 'meshcore:message':
      // MeshCore received messages were previously ignored by the engine (#3833).
      await e.onMeshCoreMessage(event.data as MeshCoreMessage, sourceId);
      break;

    case 'reticulum:message':
      // Only genuinely inbound LXMF messages reach here — ReticulumManager's
      // self-origin guard skips emitting this event entirely for our own
      // addressed messages (#3960 Phase 2 WP3, mirrors #3914).
      await e.onReticulumMessage(event.data as ReticulumMessageRow, sourceId);
      break;

    case 'node:updated': {
      const { nodeNum, node } = event.data as { nodeNum: number; node: Record<string, unknown> };
      const changed = Object.keys(node ?? {});
      // Discovered vs updated detection (isNew) is deferred to a later phase; fire
      // as nodeUpdated with the changed field keys.
      await e.onNode('trigger.nodeUpdated', nodeNum, changed, sourceId);
      // Hearing a node again is the fast recovery signal for trigger.nodeOnline
      // (#4558 Phase A) — the stale tick catches it as a fallback otherwise.
      await e.checkNodeOnline(nodeNum, sourceId);
      // Geofence + left-home checks only matter when position changed.
      if (changed.includes('latitude') || changed.includes('longitude')) {
        await e.checkGeofences(nodeNum, sourceId);
        await e.checkLeftHome(nodeNum, sourceId);
      }
      break;
    }

    case 'node:rebooted': {
      // Device Health (#4558 Phase B): the telemetry-save seam detected a node's
      // uptime reset. Fire trigger.nodeRebooted. Detection state lives in the DB
      // (the prior uptime row), not here, so this is a pure event forward.
      const data = event.data as { nodeNum: number | null; publicKey?: string | null; previousUptimeSeconds: number; uptimeSeconds: number };
      await e.onNodeRebooted(data.nodeNum, data.publicKey ?? null, data.previousUptimeSeconds, data.uptimeSeconds, sourceId);
      break;
    }

    case 'node:powerChanged': {
      // Device Health (#4558 Phase C): the telemetry-save seam detected a node's
      // batteryLevel cross the firmware powered threshold (> 100). Fire
      // trigger.nodePowerChanged. Detection state lives in the DB (the prior
      // batteryLevel row), not here, so this is a pure event forward.
      const data = event.data as { nodeNum: number | null; publicKey?: string | null; previousPowered: boolean; powered: boolean; batteryLevel: number };
      await e.onNodePowerChanged(data.nodeNum, data.publicKey ?? null, data.previousPowered, data.powered, data.batteryLevel, sourceId);
      break;
    }

    case 'node:mobility': {
      const data = event.data as {
        nodeNum: number;
        previous: number;
        current: number;
      };
      await e.checkBecameMobile(data.nodeNum, data.previous, data.current, sourceId);
      break;
    }

    case 'telemetry:batch': {
      const batch = event.data as Record<string, DbTelemetry[]>;
      for (const [nodeNumStr, readings] of Object.entries(batch)) {
        const nodeNum = Number(nodeNumStr);
        for (const r of readings) {
          await e.onTelemetry(nodeNum, r.telemetryType, r.value, r.unit, sourceId);
        }
      }
      break;
    }

    case 'meshbeacon:received': {
      const data = event.data as {
        nodeNum: number;
        message: string;
        offerChannelName?: string;
        offerRegion?: number;
        offerPreset?: number;
      };
      await e.onMeshBeacon(
        data.nodeNum,
        data.message ?? '',
        {
          channelName: data.offerChannelName,
          region: data.offerRegion,
          preset: data.offerPreset,
        },
        sourceId,
      );
      break;
    }

    case 'connection:status': {
      const data = event.data as { connected: boolean; nodeNum?: number; reason?: string };
      await e.onSystem(
        data.connected ? 'source-connected' : 'source-disconnected',
        sourceId,
        data.nodeNum ?? null,
        data.reason,
      );
      break;
    }

    default:
      break; // other event types are not automation triggers in Phase 1a
  }
}
