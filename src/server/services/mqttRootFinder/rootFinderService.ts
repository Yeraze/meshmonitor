/**
 * Job registry for root samples (#6287).
 *
 * In memory by design: a restart drops in-flight samples, which is harmless
 * because nothing touches the mesh. The only timer is the sampler's own.
 * Finished jobs are swept lazily on the next call, so no timer is added here.
 *
 * Caps (maintainer decisions on #6287):
 *   - 1 active sample per user
 *   - 1 active sample per broker endpoint
 *   - 2 active samples instance-wide
 *   - 2 minute cooldown per user after a sample ends
 *   - finished jobs stay readable for 5 minutes
 */

import { randomUUID } from 'crypto';
import { getDirectory, type MqttRootDirectory } from './directory.js';
import {
  buildCommunity,
  buildLadder,
  rankHeard,
  type CommunityRow,
  type LadderRow,
  type LatLon,
  type Place,
  type RankedHeard,
} from './ladder.js';
import { meshtasticRootAdapter } from './meshtasticRootAdapter.js';
import {
  RootSampler,
  SAMPLE_DURATION_MS,
  type RootSamplerOptions,
  type SamplerErrorCode,
  type SamplerStatus,
} from './rootSampler.js';

export const MAX_ACTIVE_PER_USER = 1;
export const MAX_ACTIVE_PER_ENDPOINT = 1;
export const MAX_ACTIVE_GLOBAL = 2;
export const USER_COOLDOWN_MS = 2 * 60_000;
export const FINISHED_RETENTION_MS = 5 * 60_000;

export class RootFinderBusyError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'RootFinderBusyError';
  }
}

export interface StartSampleParams {
  userId: number;
  /** `host:port:tls`, lower case. */
  endpointKey: string;
  broker: { url: string; username?: string; password?: string };
  regionRoot: string;
  /** Server-side location. Used only for ranking; never returned. */
  userPos?: LatLon;
  place?: Place;
}

/** What `GET /samples/:id` returns. No coordinates, no credentials, no raw errors. */
export interface SampleView {
  status: SamplerStatus;
  elapsedMs: number;
  durationMs: number;
  regionFloor: boolean;
  hasLocation: boolean;
  ladder: LadderRow[];
  community: CommunityRow[];
  heard: RankedHeard[];
  error?: SamplerErrorCode;
}

interface Job {
  id: string;
  userId: number;
  endpointKey: string;
  regionRoot: string;
  userPos?: LatLon;
  place?: Place;
  sampler: RootSampler;
  endedAt: number | null;
}

export interface RootFinderServiceOptions {
  now?: () => number;
  directory?: MqttRootDirectory;
  createSampler?: (opts: RootSamplerOptions) => RootSampler;
}

const isActive = (s: SamplerStatus) => s === 'connecting' || s === 'sampling';

export class RootFinderService {
  private readonly jobs = new Map<string, Job>();
  private readonly lastEnd = new Map<number, number>();
  private readonly now: () => number;
  private readonly directory: MqttRootDirectory;
  private readonly createSampler: (opts: RootSamplerOptions) => RootSampler;

  constructor(opts: RootFinderServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.directory = opts.directory ?? getDirectory();
    this.createSampler = opts.createSampler ?? ((o) => new RootSampler(o));
  }

  /** Mark ended jobs, drop old ones, drop expired cooldowns. */
  private sweep(): void {
    const t = this.now();
    for (const [id, job] of this.jobs) {
      if (job.endedAt === null && !isActive(job.sampler.getStatus())) {
        // The sampler's own end time, so a late poll does not stretch the cooldown.
        job.endedAt = job.sampler.getEndedAt() ?? t;
        this.lastEnd.set(job.userId, job.endedAt);
      }
      if (job.endedAt !== null && t - job.endedAt > FINISHED_RETENTION_MS) this.jobs.delete(id);
    }
    for (const [userId, at] of this.lastEnd) {
      if (t - at >= USER_COOLDOWN_MS) this.lastEnd.delete(userId);
    }
  }

  private active(): Job[] {
    return [...this.jobs.values()].filter((j) => isActive(j.sampler.getStatus()));
  }

  /** Start a sample, or throw {@link RootFinderBusyError}. */
  start(params: StartSampleParams): { sampleId: string; durationMs: number } {
    this.sweep();
    const t = this.now();
    const active = this.active();

    const mine = active.filter((j) => j.userId === params.userId);
    if (mine.length >= MAX_ACTIVE_PER_USER) {
      throw new RootFinderBusyError('You already have a topic search running.', this.remainingSeconds(mine[0]));
    }
    const endedAt = this.lastEnd.get(params.userId);
    if (endedAt !== undefined && t - endedAt < USER_COOLDOWN_MS) {
      throw new RootFinderBusyError(
        'Wait a moment before searching again.',
        Math.ceil((USER_COOLDOWN_MS - (t - endedAt)) / 1000),
      );
    }
    const sameEndpoint = active.filter((j) => j.endpointKey === params.endpointKey);
    if (sameEndpoint.length >= MAX_ACTIVE_PER_ENDPOINT) {
      throw new RootFinderBusyError(
        'A search is already running against that broker.',
        this.remainingSeconds(sameEndpoint[0]),
      );
    }
    if (active.length >= MAX_ACTIVE_GLOBAL) {
      throw new RootFinderBusyError(
        'Too many topic searches are running. Try again shortly.',
        Math.min(...active.map((j) => this.remainingSeconds(j))),
      );
    }

    const sampler = this.createSampler({
      broker: params.broker,
      regionRoot: params.regionRoot,
      adapter: meshtasticRootAdapter,
    });
    const job: Job = {
      id: randomUUID(),
      userId: params.userId,
      endpointKey: params.endpointKey,
      regionRoot: params.regionRoot,
      userPos: params.userPos,
      place: params.place,
      sampler,
      endedAt: null,
    };
    this.jobs.set(job.id, job);
    void sampler.start();
    return { sampleId: job.id, durationMs: sampler.snapshot().durationMs || SAMPLE_DURATION_MS };
  }

  private remainingSeconds(job: Job): number {
    const snap = job.sampler.snapshot();
    return Math.max(1, Math.ceil((snap.durationMs - snap.elapsedMs) / 1000));
  }

  /** A job's view. Only the user who started it may read it. */
  get(userId: number, id: string): SampleView | null {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId) return null;
    const snap = job.sampler.snapshot();
    const common = {
      regionRoot: job.regionRoot,
      heard: snap.heard,
      place: job.place,
      directory: this.directory,
    };
    const ladder = buildLadder(common);
    const community = buildCommunity({ ...common, userPos: job.userPos });
    const ranked = rankHeard({ ...common, userPos: job.userPos });
    return {
      status: snap.status,
      elapsedMs: snap.elapsedMs,
      durationMs: snap.durationMs,
      regionFloor: snap.regionFloor,
      hasLocation: !!job.userPos || !!job.place,
      ladder,
      community,
      heard: ranked,
      ...(snap.error ? { error: snap.error } : {}),
    };
  }

  /** Cancel a job. Returns false when the id is unknown or not the user's. */
  async cancel(userId: number, id: string): Promise<boolean> {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId) return false;
    await job.sampler.cancel();
    this.sweep();
    return true;
  }

  /** Test seam. */
  size(): number {
    return this.jobs.size;
  }
}

export const rootFinderService = new RootFinderService();
