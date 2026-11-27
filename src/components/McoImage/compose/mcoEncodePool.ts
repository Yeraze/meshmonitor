/**
 * Small pool of MCOimg encode workers (spec D4/D5). Parallelises across candidates, never
 * inside one encode. Tests replace the worker factory; nothing here touches the DOM.
 */
import type {
  Candidate,
  CandidateResult,
  EncodeRequest,
  EncodeResponse,
  McoLevel,
  RgbaImage,
} from '../../../utils/mcoImage/compose/types.js';

export interface WorkerLike {
  postMessage(msg: EncodeRequest): void;
  terminate(): void;
  onmessage: ((e: { data: EncodeResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface PoolJob {
  jobId: number;
  candidate: Candidate;
  level: McoLevel;
}

export class PoolCancelledError extends Error {
  constructor() {
    super('MCOimg encode job cancelled');
    this.name = 'PoolCancelledError';
  }
}

export interface McoEncodePool {
  setSource(source: RgbaImage): void;
  /** Queue a job. Rejects with `PoolCancelledError` when cancelled, or `Error` when the worker fails. */
  run(gen: number, job: PoolJob): Promise<CandidateResult>;
  /** Cancel one job: a queued job is dropped, a running one has its worker terminated and respawned. */
  cancelJob(jobId: number): void;
  /**
   * Cancel every job of a generation. Queued jobs are dropped; a running High job loses its
   * worker (respawned); a running Normal job is short and finishes, its result is discarded.
   */
  cancelGeneration(gen: number): void;
  dispose(): void;
}

export interface PoolOptions {
  size?: number;
  workerFactory?: () => WorkerLike;
}

/** Real worker: a Vite module worker resolved relative to this chunk, so BASE_URL subpaths work. */
export function createMcoEncodeWorker(): WorkerLike {
  return new Worker(new URL('../../../utils/mcoImage/compose/mcoEncode.worker.ts', import.meta.url), {
    type: 'module',
    name: 'mco-encode',
  }) as unknown as WorkerLike;
}

export function defaultPoolSize(): number {
  const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.min(3, Math.max(1, hc - 1));
}

interface Slot {
  worker: WorkerLike;
  /** Version of the source this worker holds. */
  sourceVersion: number;
  current: Task | null;
}

interface Task {
  gen: number;
  job: PoolJob;
  resolve(r: CandidateResult): void;
  reject(e: Error): void;
  /** Rejected already (cancelled); the slot is only waiting for the worker to answer. */
  settled: boolean;
}

export function createMcoEncodePool(opts: PoolOptions = {}): McoEncodePool {
  const size = Math.max(1, opts.size ?? defaultPoolSize());
  const factory = opts.workerFactory ?? createMcoEncodeWorker;
  let source: RgbaImage | null = null;
  let sourceVersion = 0;
  let disposed = false;
  const queue: Task[] = [];
  const slots: Slot[] = [];

  function spawn(slot: Slot): void {
    const worker = factory();
    slot.worker = worker;
    slot.sourceVersion = -1;
    slot.current = null;
    worker.onmessage = (e) => onMessage(slot, worker, e.data);
    worker.onerror = () => onFailure(slot, worker);
  }

  function ensureSlots(): void {
    while (slots.length < size) {
      const slot = { worker: null as unknown as WorkerLike, sourceVersion: -1, current: null } as Slot;
      spawn(slot);
      slots.push(slot);
    }
  }

  function dispatch(): void {
    if (disposed || !source) return;
    ensureSlots();
    for (const slot of slots) {
      if (slot.current || queue.length === 0) continue;
      const task = queue.shift() as Task;
      if (slot.sourceVersion !== sourceVersion) {
        slot.worker.postMessage({ type: 'setSource', source });
        slot.sourceVersion = sourceVersion;
      }
      slot.current = task;
      slot.worker.postMessage({
        type: 'encode',
        gen: task.gen,
        jobId: task.job.jobId,
        candidate: task.job.candidate,
        level: task.job.level,
      });
    }
  }

  function onMessage(slot: Slot, worker: WorkerLike, msg: EncodeResponse): void {
    if (slot.worker !== worker || msg.type === 'sourceSet') return;
    const task = slot.current;
    if (!task || task.job.jobId !== msg.jobId) return;
    slot.current = null;
    if (!task.settled) {
      task.settled = true;
      if (msg.type === 'result') task.resolve(msg.result);
      else task.reject(new Error(msg.message));
    }
    dispatch();
  }

  function onFailure(slot: Slot, worker: WorkerLike): void {
    if (slot.worker !== worker) return;
    const task = slot.current;
    worker.terminate();
    spawn(slot);
    if (task && !task.settled) {
      task.settled = true;
      task.reject(new Error('MCOimg encode worker failed'));
    }
    dispatch();
  }

  function killRunning(slot: Slot): void {
    const task = slot.current;
    slot.worker.terminate();
    spawn(slot);
    if (task && !task.settled) {
      task.settled = true;
      task.reject(new PoolCancelledError());
    }
  }

  return {
    setSource(next) {
      source = next;
      sourceVersion += 1;
    },
    run(gen, job) {
      if (disposed) return Promise.reject(new PoolCancelledError());
      return new Promise<CandidateResult>((resolve, reject) => {
        queue.push({ gen, job, resolve, reject, settled: false });
        dispatch();
      });
    },
    cancelJob(jobId) {
      const qi = queue.findIndex((t) => t.job.jobId === jobId);
      if (qi >= 0) {
        const [task] = queue.splice(qi, 1);
        task.reject(new PoolCancelledError());
        return;
      }
      const slot = slots.find((s) => s.current?.job.jobId === jobId);
      if (slot) {
        killRunning(slot);
        dispatch();
      }
    },
    cancelGeneration(gen) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].gen !== gen) continue;
        const [task] = queue.splice(i, 1);
        task.reject(new PoolCancelledError());
      }
      for (const slot of slots) {
        const task = slot.current;
        if (!task || task.gen !== gen || task.settled) continue;
        if (task.job.level === 'high') killRunning(slot);
        else {
          task.settled = true;
          task.reject(new PoolCancelledError());
        }
      }
      dispatch();
    },
    dispose() {
      disposed = true;
      for (const task of queue.splice(0)) task.reject(new PoolCancelledError());
      for (const slot of slots) {
        const task = slot.current;
        slot.worker.terminate();
        if (task && !task.settled) {
          task.settled = true;
          task.reject(new PoolCancelledError());
        }
        slot.current = null;
      }
      slots.length = 0;
    },
  };
}
