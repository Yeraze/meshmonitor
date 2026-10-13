/**
 * Shared harness for the manager reaction suites (#5759): a MeshCoreManager on
 * the real `:memory:` database with a stub radio, plus feed/wait helpers.
 * Nothing here transmits: `sendBridgeCommand` only records.
 */
import { vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, type MeshCoreMessage } from '../meshcoreManager.js';
import databaseService from '../../services/database.js';
import { dataEventEmitter } from '../services/dataEventEmitter.js';
import { invalidatePendingReactions } from '../services/meshcoreReactionIngest.js';

export const SELF_KEY = 'ee'.repeat(32);
export const SELF_NAME = 'Me';
export const PEER_KEY = 'ab'.repeat(32);
export const SEC = 1_704_067_200;
export const THUMBS = '\u{1F44D}';

export interface BridgeCall { cmd: string; params: Record<string, unknown> }

export interface ManagerInternals {
  deviceType: MeshCoreDeviceType;
  connected: boolean;
  localNode: { publicKey: string; name: string } | null;
  receiveOnly: boolean;
  messages: MeshCoreMessage[];
  sendBridgeCommand: (cmd: string, params: Record<string, unknown>) => Promise<unknown>;
  handleBridgeEvent: (e: { event_type: string; data: Record<string, unknown> }) => void;
  checkAutoResponder: (...a: unknown[]) => Promise<void>;
  checkForwarding: (...a: unknown[]) => Promise<void>;
  checkAutoAcknowledge: (...a: unknown[]) => Promise<void>;
}

let counter = 0;
export const newSourceId = (): string => `rx-src-${Date.now().toString(36)}-${++counter}`;

export function makeManager(sourceId: string): { m: MeshCoreManager; i: ManagerInternals; calls: BridgeCall[] } {
  invalidatePendingReactions(sourceId);
  const m = new MeshCoreManager(sourceId);
  const i = m as unknown as ManagerInternals;
  i.deviceType = MeshCoreDeviceType.COMPANION;
  i.connected = true;
  i.localNode = { publicKey: SELF_KEY, name: SELF_NAME };
  const calls: BridgeCall[] = [];
  i.sendBridgeCommand = async (cmd, params) => {
    calls.push({ cmd, params });
    return { id: '1', success: true, data: {} };
  };
  return { m, i, calls };
}

export function emitterSpies() {
  return {
    message: vi.spyOn(dataEventEmitter, 'emitMeshCoreMessage').mockImplementation(() => undefined),
    resolved: vi.spyOn(dataEventEmitter, 'emitMeshCoreReactionResolved').mockImplementation(() => undefined),
    deleted: vi.spyOn(dataEventEmitter, 'emitMeshCoreMessagesDeleted').mockImplementation(() => undefined),
  };
}

export const rows = (sourceId: string) => databaseService.meshcore.getRecentMessages(100, sourceId);

export async function settle(): Promise<void> {
  for (let n = 0; n < 30; n++) await new Promise(r => setImmediate(r));
}

export function channelEvent(text: string, sec: number = SEC, channelIdx = 0) {
  return { event_type: 'channel_message', data: { text, channel_idx: channelIdx, sender_timestamp: sec, snr: 1 } };
}

export function dmEvent(text: string, sec: number = SEC, from: string = PEER_KEY.slice(0, 12)) {
  return { event_type: 'contact_message', data: { text, pubkey_prefix: from, sender_timestamp: sec, snr: 1 } };
}
