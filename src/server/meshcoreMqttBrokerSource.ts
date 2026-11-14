/**
 * Lifecycle helpers for the embedded MeshCore MQTT broker source (#6197),
 * shared by the source routes (create / save / connect) and the boot loop.
 */
import databaseService from '../services/database.js';
import type { Source } from '../db/repositories/sources.js';
import { sourceManagerRegistry, type SourceManagerRegistry } from './sourceManagerRegistry.js';
import { MeshCoreMqttBrokerManager } from './meshcoreMqttBrokerManager.js';
import { validateMeshCoreBrokerConfig } from './services/meshcoreMqttBrokerConfig.js';

/** Build and register a broker manager. Returns false when the config is unusable. */
export async function startMeshCoreMqttBrokerManager(
  source: Pick<Source, 'id' | 'name' | 'config'>,
  registry: SourceManagerRegistry = sourceManagerRegistry,
): Promise<boolean> {
  if (validateMeshCoreBrokerConfig(source.config) !== null) return false;
  const manager = new MeshCoreMqttBrokerManager(source.id, source.name, source.config);
  // addManager() calls start(); a listen failure is logged there and leaves the
  // manager registered (and not listening) so the source card can show why.
  await registry.addManager(manager);
  return true;
}

/** Stop any running manager for this source, then start a fresh one. */
export async function restartMeshCoreMqttBrokerManager(
  source: Pick<Source, 'id' | 'name' | 'config'>,
): Promise<boolean> {
  await sourceManagerRegistry.removeManager(source.id);
  return startMeshCoreMqttBrokerManager(source);
}

function listenerPortOf(source: Source): number | null {
  if (source.type !== 'mqtt_broker' && source.type !== 'meshcore_mqtt_broker') return null;
  const port = (source.config as { listener?: { port?: unknown } } | null)?.listener?.port;
  return typeof port === 'number' ? port : null;
}

/**
 * Another embedded broker (Meshtastic or MeshCore) already configured on this
 * port, or null. Two listeners on one port cannot both bind.
 */
export async function findBrokerPortConflict(port: number, excludeSourceId?: string): Promise<Source | null> {
  const all = await databaseService.sources.getAllSources();
  return all.find((s) => s.id !== excludeSourceId && listenerPortOf(s) === port) ?? null;
}
