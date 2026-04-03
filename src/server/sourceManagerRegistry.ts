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
    logger.info(`Removed source manager: ${sourceId}`);
  }

  getManager(sourceId: string): ISourceManager | undefined {
    return this.managers.get(sourceId);
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
