import { EventEmitter } from 'events';
import type { Source } from '../db/repositories/sources.js';
import { logger } from '../utils/logger.js';

/**
 * Status of a managed source
 */
export interface SourceStatus {
  sourceId: string;
  sourceName: string;
  sourceType: Source['type'];
  connected: boolean;
  nodeNum?: number;
  nodeId?: string;
}

/**
 * Interface that all source managers must implement
 */
export interface ISourceManager {
  readonly sourceId: string;
  readonly sourceType: Source['type'];
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): SourceStatus;
  getLocalNodeInfo(): { nodeNum: number; nodeId: string; longName: string; shortName: string; hwModel?: number; firmwareVersion?: string; rebootCount?: number; isLocked?: boolean } | null;
}

/**
 * Registry that manages the lifecycle of source manager instances.
 * Replaces the singleton pattern — each source gets its own manager.
 */
export class SourceManagerRegistry extends EventEmitter {
  private managers: Map<string, ISourceManager> = new Map();

  async addManager(manager: ISourceManager): Promise<void> {
    if (this.managers.has(manager.sourceId)) {
      throw new Error(`Source manager already registered: ${manager.sourceId}`);
    }
    this.managers.set(manager.sourceId, manager);
    logger.info(`Registered source manager: ${manager.sourceId} (${manager.sourceType})`);

    try {
      await manager.start();
      this.emit('manager-started', manager);
    } catch (error) {
      logger.error(`Failed to start source manager ${manager.sourceId}:`, error);
    }
  }

  async removeManager(sourceId: string): Promise<void> {
    const manager = this.managers.get(sourceId);
    if (!manager) return;

    try {
      await manager.stop();
    } catch (error) {
      logger.error(`Error stopping source manager ${sourceId}:`, error);
    }
    this.managers.delete(sourceId);
    this.emit('manager-stopped', manager);
    logger.info(`Removed source manager: ${sourceId}`);
  }

  getManager(sourceId: string): ISourceManager | undefined {
    return this.managers.get(sourceId);
  }

  /**
   * Hot-swap the virtual node configuration of a meshtastic_tcp manager without
   * restarting its upstream transport. Returns true if a swap happened, false
   * if the manager does not exist or does not support VN reconfiguration.
   */
  async reconfigureVirtualNode(sourceId: string, vnConfig: any): Promise<boolean> {
    const manager = this.managers.get(sourceId) as any;
    if (!manager || typeof manager.reconfigureVirtualNode !== 'function') {
      return false;
    }
    try {
      await manager.reconfigureVirtualNode(vnConfig);
      logger.info(`Hot-swapped virtual node config for source ${sourceId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to reconfigure virtual node for source ${sourceId}:`, error);
      throw error;
    }
  }

  getAllManagers(): ISourceManager[] {
    return Array.from(this.managers.values());
  }

  getAllStatuses(): SourceStatus[] {
    return this.getAllManagers().map(m => m.getStatus());
  }

  async stopAll(): Promise<void> {
    const promises = Array.from(this.managers.keys()).map(id => this.removeManager(id));
    await Promise.allSettled(promises);
    logger.info('All source managers stopped');
  }

  get size(): number {
    return this.managers.size;
  }
}

export const sourceManagerRegistry = new SourceManagerRegistry();
