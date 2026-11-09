/**
 * Adapter registry: `getBackupAdapter(protocol)`.
 */
import type { BackupProtocol, DeviceConfigBackupAdapter } from './types.js';
import { meshtasticBackupAdapter } from './meshtastic.js';
import { meshcoreBackupAdapter } from './meshcore.js';

export * from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- adapters are keyed by protocol; managers differ per protocol
const ADAPTERS: Partial<Record<BackupProtocol, DeviceConfigBackupAdapter<any, any>>> = {
  meshtastic: meshtasticBackupAdapter,
  meshcore: meshcoreBackupAdapter,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export function getBackupAdapter(protocol: BackupProtocol): DeviceConfigBackupAdapter<any, any> {
  const adapter = ADAPTERS[protocol];
  if (!adapter) throw new Error(`No backup adapter for protocol "${protocol}"`);
  return adapter;
}
