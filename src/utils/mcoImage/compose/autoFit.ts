/**
 * Auto-fit planner (spec D4 with decisions H.1-H.3): Normal searches, High refines.
 * A pure state machine: no timers, no workers, no I/O. The caller runs the jobs it hands out
 * (in any order, in parallel) and reports each result with `accept` or `fail`.
 */
import type { PaletteProfileId } from '../v3/constants.js';
import { COLOR_LADDER, GRAY_LADDER, SIZE_LADDER, score } from './profiles.js';
import type { Candidate, CandidateResult, McoLevel } from './types.js';

export interface AutoFitConfig {
  /** Longest side of the decoded source, in pixels. */
  srcLongest: number;
  /** Near-grey source: use the grey ladder. */
  gray: boolean;
  /** Byte limit of the conversation. */
  limit: number;
}

export interface AutoFitJob {
  jobId: number;
  candidate: Candidate;
  level: McoLevel;
}

/** searching: Normal probes running. refining: High jobs running. done: nothing left to run. */
export type AutoFitPhase = 'searching' | 'refining' | 'done';

export interface AutoFitWinner {
  /** The result that supplies `text` (its w, h and profile describe the picture). */
  result: CandidateResult;
  /** Shortest text known for this encoding at this candidate. */
  text: string;
  bytes: number;
  /** Level that produced `text`. */
  level: McoLevel;
}

export interface AutoFitPlan {
  /** Jobs that may start now; each is marked in flight. Empty while waiting or when finished. */
  next(): AutoFitJob[];
  accept(jobId: number, result: CandidateResult): void;
  /** A job failed or timed out: keep what we have. Unknown job ids are ignored. */
  fail(jobId: number): void;
  /** Best fitting result per encoding so far (provisional until phase is 'done'). */
  winners(): { im3?: AutoFitWinner; im4?: AutoFitWinner };
  phase(): AutoFitPhase;
}

/** At most this many distinct sizes are probed per palette. */
export const MAX_PROBES_PER_PALETTE = 6;
/** A Normal text this close above the limit (ratio) earns a High attempt one step up. */
export const STEP_UP_SLACK = 1.1;
/** First probe size of every palette. */
const START_LONGEST = 32;

type Enc = 'im3' | 'im4';
const ENCS: readonly Enc[] = ['im3', 'im4'];

interface Probe {
  /** null: the job failed; counts as not fitting. */
  result: CandidateResult | null;
}

interface PaletteState {
  profile: PaletteProfileId;
  normal: Map<number, Probe>;
  /** Size indexes with a Normal job in flight (at most one). */
  inflight: number | null;
  done: boolean;
}

interface InflightJob {
  kind: 'normal' | 'high';
  paletteIndex: number;
  sizeIndex: number;
}

const bytesOf = (r: CandidateResult, enc: Enc): number => (enc === 'im3' ? r.im3Bytes : r.im4Bytes);
const textOf = (r: CandidateResult, enc: Enc): string => (enc === 'im3' ? r.im3Text : r.im4Text);

export function planAutoFit(cfg: AutoFitConfig): AutoFitPlan {
  const palettes: PaletteState[] = (cfg.gray ? GRAY_LADDER : COLOR_LADDER).map((profile) => ({
    profile,
    normal: new Map(),
    inflight: null,
    done: false,
  }));
  const maxLongest = Math.min(128, cfg.srcLongest * 4);
  const ladder = SIZE_LADDER.filter((s) => s <= maxLongest);
  if (ladder.length === 0) ladder.push(SIZE_LADDER[0]);
  const L = ladder.length;
  const startIndex = Math.min(L - 1, Math.max(0, ladder.indexOf(START_LONGEST) >= 0 ? ladder.indexOf(START_LONGEST) : L - 1));

  const inflight = new Map<number, InflightJob>();
  /** High results by `paletteIndex:sizeIndex`. */
  const high = new Map<string, CandidateResult>();
  const highKey = (pi: number, si: number): string => `${pi}:${si}`;
  let nextJobId = 1;
  let highPlanned = false;
  const highAsked = new Set<string>();

  const fits = (probe: Probe | undefined, enc: Enc): boolean =>
    !!probe && probe.result !== null && bytesOf(probe.result, enc) <= cfg.limit;

  /** Largest fitting index (or -1) and the nearest not-fitting index above it (or L). */
  const bracket = (p: PaletteState, enc: Enc): { lo: number; hi: number } => {
    let lo = -1;
    for (const [i, probe] of p.normal) if (fits(probe, enc) && i > lo) lo = i;
    let hi = L;
    for (const [i, probe] of p.normal) if (!fits(probe, enc) && i > lo && i < hi) hi = i;
    return { lo, hi };
  };

  const key = (profile: PaletteProfileId, si: number): [number, number] => {
    const s = ladder[si];
    // The size (w, h) is only known after a probe; the ladder gives the longest side, so a square
    // bound is used for pruning (an upper bound on the score for any aspect ratio).
    return [score(s, s, profile), s * s];
  };
  const keyOfResult = (r: CandidateResult): [number, number] => [score(r.w, r.h, r.profile), r.w * r.h];
  const better = (a: [number, number], b: [number, number]): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

  /** Best fitting Normal probe for an encoding. */
  const bestNormal = (enc: Enc): { pi: number; si: number; result: CandidateResult } | undefined => {
    let best: { pi: number; si: number; result: CandidateResult } | undefined;
    palettes.forEach((p, pi) => {
      for (const [si, probe] of p.normal) {
        if (!fits(probe, enc) || !probe.result) continue;
        if (!best || better(keyOfResult(probe.result), keyOfResult(best.result))) best = { pi, si, result: probe.result };
      }
    });
    return best;
  };

  const nextProbeIndex = (p: PaletteState): number | null => {
    if (p.normal.size === 0) return startIndex;
    if (p.normal.size >= MAX_PROBES_PER_PALETTE) return null;
    for (const enc of ENCS) {
      const { lo, hi } = bracket(p, enc);
      if (hi - lo > 1) return Math.floor((lo + hi) / 2);
    }
    return null;
  };

  const pruned = (p: PaletteState): boolean => {
    const b3 = bestNormal('im3');
    const b4 = bestNormal('im4');
    if (!b3 || !b4) return false;
    const threshold = better(keyOfResult(b3.result), keyOfResult(b4.result)) ? keyOfResult(b4.result) : keyOfResult(b3.result);
    let top = L - 1;
    for (const [si, probe] of p.normal) if (probe.result === null || (!fits(probe, 'im3') && !fits(probe, 'im4'))) top = Math.min(top, si - 1);
    if (top < 0) return true;
    return !better(key(p.profile, top), threshold);
  };

  const searchActive = (): boolean => palettes.some((p) => !p.done) || [...inflight.values()].some((j) => j.kind === 'normal');

  const planHigh = (): AutoFitJob[] => {
    const jobs: AutoFitJob[] = [];
    const add = (pi: number, si: number): void => {
      const k = highKey(pi, si);
      if (highAsked.has(k)) return;
      highAsked.add(k);
      const jobId = nextJobId++;
      inflight.set(jobId, { kind: 'high', paletteIndex: pi, sizeIndex: si });
      jobs.push({ jobId, candidate: { longest: ladder[si], profile: palettes[pi].profile, dither: false }, level: 'high' });
    };
    for (const enc of ENCS) {
      const win = bestNormal(enc);
      if (!win) continue;
      add(win.pi, win.si);
      const up = palettes[win.pi].normal.get(win.si + 1);
      if (up?.result) {
        const b = bytesOf(up.result, enc);
        if (b > cfg.limit && b <= cfg.limit * STEP_UP_SLACK) add(win.pi, win.si + 1);
      }
    }
    return jobs;
  };

  const winnerFor = (enc: Enc): AutoFitWinner | undefined => {
    const base = bestNormal(enc);
    if (!base) return undefined;
    // A High step-up that fits wins outright (it scores higher by construction).
    const up = high.get(highKey(base.pi, base.si + 1));
    if (up && bytesOf(up, enc) <= cfg.limit) {
      return { result: up, text: textOf(up, enc), bytes: bytesOf(up, enc), level: 'high' };
    }
    const hi = high.get(highKey(base.pi, base.si));
    if (hi && bytesOf(hi, enc) < bytesOf(base.result, enc)) {
      return { result: hi, text: textOf(hi, enc), bytes: bytesOf(hi, enc), level: 'high' };
    }
    return { result: base.result, text: textOf(base.result, enc), bytes: bytesOf(base.result, enc), level: 'normal' };
  };

  return {
    next(): AutoFitJob[] {
      const jobs: AutoFitJob[] = [];
      palettes.forEach((p, pi) => {
        if (p.done || p.inflight !== null) return;
        const si = nextProbeIndex(p);
        if (si === null || pruned(p)) {
          p.done = true;
          return;
        }
        p.inflight = si;
        const jobId = nextJobId++;
        inflight.set(jobId, { kind: 'normal', paletteIndex: pi, sizeIndex: si });
        jobs.push({ jobId, candidate: { longest: ladder[si], profile: p.profile, dither: false }, level: 'normal' });
      });
      // A palette may have finished just now; re-check once for a closed search.
      if (!searchActive() && !highPlanned) {
        highPlanned = true;
        jobs.push(...planHigh());
      }
      return jobs;
    },

    accept(jobId, result): void {
      const job = inflight.get(jobId);
      if (!job) return;
      inflight.delete(jobId);
      if (job.kind === 'normal') {
        const p = palettes[job.paletteIndex];
        p.inflight = null;
        p.normal.set(job.sizeIndex, { result });
      } else {
        high.set(highKey(job.paletteIndex, job.sizeIndex), result);
      }
    },

    fail(jobId): void {
      const job = inflight.get(jobId);
      if (!job) return;
      inflight.delete(jobId);
      if (job.kind === 'normal') {
        const p = palettes[job.paletteIndex];
        p.inflight = null;
        p.normal.set(job.sizeIndex, { result: null });
      }
    },

    winners(): { im3?: AutoFitWinner; im4?: AutoFitWinner } {
      return { im3: winnerFor('im3'), im4: winnerFor('im4') };
    },

    phase(): AutoFitPhase {
      if (!highPlanned) return 'searching';
      return inflight.size > 0 ? 'refining' : 'done';
    },
  };
}
