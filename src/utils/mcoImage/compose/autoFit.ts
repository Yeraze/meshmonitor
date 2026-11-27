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

export type AutoFitPhase = 'searching' | 'refining' | 'done';

export interface AutoFitWinner {
  result: CandidateResult;
  /** Shortest text known for this encoding. */
  text: string;
  bytes: number;
  /** Level that produced `text`. */
  level: McoLevel;
  fits: boolean;
}

/** Pure state machine for D4. No timers, no workers, no I/O. */
export interface AutoFitPlan {
  /** Jobs that may start now (each is marked in flight). Empty when waiting on results or finished. */
  next(): AutoFitJob[];
  accept(jobId: number, result: CandidateResult): void;
  /** A job failed or timed out: keep what we have. */
  fail(jobId: number): void;
  winners(): { im3?: AutoFitWinner; im4?: AutoFitWinner };
  phase(): AutoFitPhase;
}

export function planAutoFit(_cfg: AutoFitConfig): AutoFitPlan {
  throw new Error('not implemented');
}
