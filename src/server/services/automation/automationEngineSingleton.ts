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
import { AutomationEngineService } from './automationEngineService.js';
import { VariableResolver } from './variableResolver.js';
import { createMeshActionDeps } from './meshActionDeps.js';
import { createMeshNodeDataProvider } from './meshNodeData.js';

let engine: AutomationEngineService | null = null;
let subscribed = false;

export function getAutomationEngine(): AutomationEngineService | null {
  return engine;
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
  });
  await engine.load();
  subscribe();
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

    case 'node:updated': {
      const { nodeNum, node } = event.data as { nodeNum: number; node: Record<string, unknown> };
      // Discovered vs updated detection (isNew) is deferred to a later phase; fire
      // as nodeUpdated with the changed field keys.
      await e.onNode('trigger.nodeUpdated', nodeNum, Object.keys(node ?? {}), sourceId);
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
