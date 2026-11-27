import { describe, it, expect } from 'vitest';
import { createMcoEncodePool, PoolCancelledError, type WorkerLike } from './mcoEncodePool.js';
import type { Candidate, CandidateResult, EncodeRequest, RgbaImage } from '../../../utils/mcoImage/compose/types.js';

class FakeWorker implements WorkerLike {
  sent: EncodeRequest[] = [];
  terminated = false;
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  postMessage(m: EncodeRequest) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  encodes() {
    return this.sent.filter((m) => m.type === 'encode');
  }
  reply(jobId: number) {
    const req = this.encodes().find((m) => m.type === 'encode' && m.jobId === jobId);
    if (!req || req.type !== 'encode') throw new Error('no job');
    const result = { im3Text: 'im3:a', im4Text: 'im4:a', im3Bytes: 5, im4Bytes: 5 } as CandidateResult;
    this.onmessage?.({ data: { type: 'result', gen: req.gen, jobId, candidate: req.candidate, level: req.level, result } });
  }
}

const src: RgbaImage = { width: 1, height: 1, rgba: new Uint8ClampedArray(4) };
const cand: Candidate = { longest: 16, profile: 2, dither: false };
const job = (jobId: number, level: 'normal' | 'high' = 'normal') => ({ jobId, candidate: cand, level });

function setup(size = 2) {
  const workers: FakeWorker[] = [];
  const pool = createMcoEncodePool({
    size,
    workerFactory: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  pool.setSource(src);
  return { pool, workers };
}

describe('mcoEncodePool', () => {
  it('spreads jobs over idle workers and sends the source once per worker', async () => {
    const { pool, workers } = setup();
    const a = pool.run(1, job(1));
    const b = pool.run(1, job(2));
    const c = pool.run(1, job(3));
    expect(workers).toHaveLength(2);
    expect(workers[0].encodes()).toHaveLength(1);
    expect(workers[1].encodes()).toHaveLength(1);
    workers[0].reply(1);
    await a;
    // third job queued until a worker frees up, then reuses its already-set source
    expect(workers[0].encodes()).toHaveLength(2);
    workers[1].reply(2);
    workers[0].reply(3);
    await Promise.all([b, c]);
    for (const w of workers) expect(w.sent.filter((m) => m.type === 'setSource')).toHaveLength(1);
  });

  it('cancelGeneration drops queued jobs and terminates a busy High worker', async () => {
    const { pool, workers } = setup(1);
    const high = pool.run(1, job(1, 'high'));
    const queued = pool.run(1, job(2));
    pool.cancelGeneration(1);
    await expect(high).rejects.toBeInstanceOf(PoolCancelledError);
    await expect(queued).rejects.toBeInstanceOf(PoolCancelledError);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2); // respawned
  });

  it('cancelGeneration lets a running Normal job finish without terminating', async () => {
    const { pool, workers } = setup(1);
    const p = pool.run(1, job(1));
    pool.cancelGeneration(1);
    await expect(p).rejects.toBeInstanceOf(PoolCancelledError);
    expect(workers[0].terminated).toBe(false);
    workers[0].reply(1);
    const next = pool.run(2, job(2));
    expect(workers[0].encodes()).toHaveLength(2);
    workers[0].reply(2);
    await next;
  });

  it('cancelJob terminates the worker of a running job', async () => {
    const { pool, workers } = setup(1);
    const p = pool.run(1, job(1, 'high'));
    pool.cancelJob(1);
    await expect(p).rejects.toBeInstanceOf(PoolCancelledError);
    expect(workers[0].terminated).toBe(true);
  });

  it('rejects with the worker error message', async () => {
    const { pool, workers } = setup(1);
    const p = pool.run(1, job(1));
    workers[0].onmessage?.({ data: { type: 'error', gen: 1, jobId: 1, candidate: cand, level: 'normal', message: 'boom' } });
    await expect(p).rejects.toThrow('boom');
  });

  it('dispose terminates every worker and rejects pending work', async () => {
    const { pool, workers } = setup(2);
    const a = pool.run(1, job(1));
    const b = pool.run(1, job(2));
    const c = pool.run(1, job(3));
    pool.dispose();
    for (const p of [a, b, c]) await expect(p).rejects.toBeInstanceOf(PoolCancelledError);
    for (const w of workers) expect(w.terminated).toBe(true);
    await expect(pool.run(2, job(4))).rejects.toBeInstanceOf(PoolCancelledError);
  });
});
