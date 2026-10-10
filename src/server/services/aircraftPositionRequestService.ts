/**
 * Ask a newly flagged aircraft for its position (#5704).
 *
 * A node on a slow broadcast interval gives a likely-aircraft trail of one or
 * two points before it flies out of range. When the per-source setting
 * `aircraftPositionRequestsEnabled` is on, the false→true likely-aircraft
 * transition (`node:aircraft`, emitted only for live positions, never for the
 * startup backfill) starts a short sequence of position requests to that node
 * through the classifying source: t = 0, 2 and 4 minutes.
 *
 * Mesh impact (CLAUDE.md checklist):
 * - Each request is one packet, relayed up to the hop limit, plus the node's
 *   reply. Firmware `PositionModule` skips a reply when it sent one in the last
 *   3 minutes, so the t = 2 min request may get none; t = 4 min clears it.
 * - At most {@link MAX_SEQUENCES_PER_HOUR} sequences per source per rolling
 *   hour (≤ 6 requests). The start times are stored per source in settings,
 *   so neither a restart nor a settings save resets the cap.
 * - A sequence in flight lives in memory only. A restart drops it; nothing
 *   resumes or fires on boot. A node already flagged at startup never fires.
 * - The node's reply is a position, which is classified again, but only a
 *   false→true transition starts a sequence, so a reply cannot start another.
 * - Off by default; Meshtastic radio sources only (an MQTT source cannot send).
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { dataEventEmitter, type DataEvent, type NodeAircraftData } from './dataEventEmitter.js';
import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshtasticManager } from '../sourceManagerTypes.js';

/** Delays of each request after the transition. */
export const REQUEST_OFFSETS_MS = [0, 2 * 60_000, 4 * 60_000] as const;
/** Sequences allowed per source in any rolling hour (maintainer decision). */
export const MAX_SEQUENCES_PER_HOUR = 2;
const HOUR_MS = 60 * 60_000;
export const SETTING_ENABLED = 'aircraftPositionRequestsEnabled';
export const SETTING_STARTS = 'aircraftPositionRequestStarts';

/** Source types whose manager can transmit a Meshtastic position request. */
const RADIO_SOURCE_TYPES: ReadonlySet<string> = new Set(['meshtastic_tcp']);

export interface PositionRequestTarget {
  isConnected: boolean;
  getLocalNodeInfo(): { nodeNum: number } | null;
  sendPositionRequest(destination: number, channel?: number, options?: { origin?: 'automation' | 'manual' }): Promise<unknown>;
}

export interface AircraftPositionRequestDeps {
  getSourceType(sourceId: string): Promise<string | null>;
  getSourceSetting(sourceId: string, key: string): Promise<string | null>;
  setSourceSetting(sourceId: string, key: string, value: string): Promise<void>;
  /** Current likely-aircraft flag and channel of the node on this source. */
  getNode(nodeNum: number, sourceId: string): Promise<{ likelyAircraft?: boolean | null; channel?: number | null; isIgnored?: boolean | null } | null>;
  getManager(sourceId: string): PositionRequestTarget | null;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

function defaultDeps(): AircraftPositionRequestDeps {
  return {
    getSourceType: async (sourceId) => (await databaseService.sources.getSource(sourceId))?.type ?? null,
    getSourceSetting: (sourceId, key) => databaseService.settings.getSettingForSource(sourceId, key),
    setSourceSetting: (sourceId, key, value) => databaseService.settings.setSourceSetting(sourceId, key, value),
    getNode: (nodeNum, sourceId) => databaseService.nodes.getNode(nodeNum, sourceId),
    getManager: (sourceId) => {
      const m = sourceManagerRegistry.getManager(sourceId);
      return m && isMeshtasticManager(m) ? (m as unknown as PositionRequestTarget) : null;
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** Parse the stored start times, keeping only those inside the last hour. */
export function recentStarts(raw: string | null, now: number): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(Number).filter((t) => Number.isFinite(t) && t > now - HOUR_MS && t <= now);
  } catch {
    return [];
  }
}

export class AircraftPositionRequestService {
  /** In-flight sequences by `${sourceId}:${nodeNum}`, holding pending timers. */
  private readonly inFlight = new Map<string, unknown[]>();
  /** Serialises the cap check-and-stamp per source. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly deps: AircraftPositionRequestDeps = defaultDeps()) {}

  /** Handle a false→true likely-aircraft transition. Never throws. */
  async onAircraftTransition(sourceId: string | undefined, nodeNum: number): Promise<void> {
    if (!sourceId) return;
    try {
      if ((await this.deps.getSourceSetting(sourceId, SETTING_ENABLED)) !== 'true') return;
      const type = await this.deps.getSourceType(sourceId);
      if (!type || !RADIO_SOURCE_TYPES.has(type)) return;
      const manager = this.deps.getManager(sourceId);
      if (!manager) return;
      if (manager.getLocalNodeInfo()?.nodeNum === nodeNum) return;
      const key = `${sourceId}:${nodeNum}`;
      if (this.inFlight.has(key)) return;
      if (!(await this.claimSlot(sourceId))) {
        logger.debug(`✈️ Aircraft position requests: not asking !${nodeNum.toString(16)} on ${sourceId}: ${MAX_SEQUENCES_PER_HOUR} aircraft already asked in the last hour`);
        return;
      }
      const timers: unknown[] = [];
      this.inFlight.set(key, timers);
      REQUEST_OFFSETS_MS.forEach((offset, i) => {
        const last = i === REQUEST_OFFSETS_MS.length - 1;
        timers.push(this.deps.setTimer(() => { void this.sendOne(sourceId, nodeNum, i + 1, last); }, offset));
      });
    } catch (error) {
      logger.warn(`Aircraft position requests failed to start for ${nodeNum} on ${sourceId}:`, error);
    }
  }

  /** Check the persisted rolling-hour cap and stamp this sequence if allowed. */
  private async claimSlot(sourceId: string): Promise<boolean> {
    const previous = this.locks.get(sourceId) ?? Promise.resolve();
    let allowed = false;
    const run = previous.then(async () => {
      const now = this.deps.now();
      const starts = recentStarts(await this.deps.getSourceSetting(sourceId, SETTING_STARTS), now);
      if (starts.length >= MAX_SEQUENCES_PER_HOUR) return;
      starts.push(now);
      await this.deps.setSourceSetting(sourceId, SETTING_STARTS, JSON.stringify(starts));
      allowed = true;
    });
    this.locks.set(sourceId, run.catch(() => undefined));
    await run;
    return allowed;
  }

  private async sendOne(sourceId: string, nodeNum: number, n: number, last: boolean): Promise<void> {
    const key = `${sourceId}:${nodeNum}`;
    try {
      if (!this.inFlight.has(key)) return;
      const node = await this.deps.getNode(nodeNum, sourceId);
      // Landed, aged out, deleted or ignored since the transition: stop asking.
      if (!node || node.likelyAircraft !== true || node.isIgnored) {
        this.cancel(key);
        return;
      }
      const manager = this.deps.getManager(sourceId);
      if (!manager || !manager.isConnected) {
        this.cancel(key);
        return;
      }
      await manager.sendPositionRequest(nodeNum, Number(node.channel ?? 0) || 0, { origin: 'automation' });
      logger.info(`✈️ Asked likely aircraft !${nodeNum.toString(16).padStart(8, '0')} for its position on ${sourceId} (${n}/${REQUEST_OFFSETS_MS.length})`);
    } catch (error) {
      // TX disabled, receive-only or a send failure: give up on this aircraft.
      logger.debug(`Aircraft position request ${n} to ${nodeNum} on ${sourceId} not sent:`, error);
      this.cancel(key);
      return;
    }
    if (last) this.inFlight.delete(key);
  }

  private cancel(key: string): void {
    const timers = this.inFlight.get(key);
    if (!timers) return;
    for (const t of timers) this.deps.clearTimer(t);
    this.inFlight.delete(key);
  }

  /** Test/shutdown helper: drop every pending request. */
  stopAll(): void {
    for (const key of [...this.inFlight.keys()]) this.cancel(key);
  }
}

export const aircraftPositionRequestService = new AircraftPositionRequestService();

let started = false;

/** Subscribe to the likely-aircraft transition. Idempotent. */
export function startAircraftPositionRequests(): void {
  if (started) return;
  started = true;
  dataEventEmitter.on('data', (event: DataEvent) => {
    if (event.type !== 'node:aircraft') return;
    const data = event.data as NodeAircraftData;
    void aircraftPositionRequestService.onAircraftTransition(event.sourceId, data.nodeNum);
  });
  logger.debug('[Aircraft] position requests subscribed to likely-aircraft transitions');
}
