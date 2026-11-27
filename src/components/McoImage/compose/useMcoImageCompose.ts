/**
 * Drives the MCOimg compose search (spec D4 + section H) over the encode-worker pool.
 * Auto mode runs `planAutoFit` (Normal search, then High refine). Manual mode runs one
 * Normal encode shown at once, then one High encode. Every input change bumps a
 * generation id; results from an older generation are dropped.
 */
import { useEffect, useRef, useState } from 'react';
import { planAutoFit, type AutoFitPlan, type AutoFitConfig, type AutoFitWinner } from '../../../utils/mcoImage/compose/autoFit.js';
import { isNearGray } from '../../../utils/mcoImage/compose/quantize.js';
import type { Candidate, CandidateResult, RgbaImage } from '../../../utils/mcoImage/compose/types.js';
import type { PaletteProfileId } from '../../../utils/mcoImage/v3/constants.js';
import { createMcoEncodePool, PoolCancelledError, type McoEncodePool } from './mcoEncodePool.js';

export type ComposeMode = 'auto' | 'manual';

export interface ManualSettings {
  /** Longest side in pixels. */
  size: number;
  profile: PaletteProfileId;
  dither: boolean;
}

export type EncodingStatus = 'idle' | 'searching' | 'optimizing' | 'ready' | 'nofit' | 'failed';

export interface EncodingView {
  status: EncodingStatus;
  text: string | null;
  bytes: number | null;
  w: number | null;
  h: number | null;
  profile: PaletteProfileId | null;
  fits: boolean;
}

export interface McoImageComposeState {
  im3: EncodingView;
  im4: EncodingView;
  /** A High job ran past its time cap; the Normal result stays. */
  highTimedOut: boolean;
}

export interface UseMcoImageComposeOptions {
  source: RgbaImage | null;
  limit: number;
  mode: ComposeMode;
  manual: ManualSettings;
  /** False while the dialog is closed: no pool, no jobs. */
  enabled: boolean;
  debounceMs?: number;
  highTimeoutMs?: number;
  /** Test seams. */
  poolFactory?: () => McoEncodePool;
  planFactory?: (cfg: AutoFitConfig) => AutoFitPlan;
}

export const MANUAL_DEBOUNCE_MS = 250;
export const HIGH_TIMEOUT_MS = 20_000;

const EMPTY_VIEW: EncodingView = { status: 'idle', text: null, bytes: null, w: null, h: null, profile: null, fits: false };
export const EMPTY_STATE: McoImageComposeState = { im3: EMPTY_VIEW, im4: EMPTY_VIEW, highTimedOut: false };

const PENDING_VIEW: EncodingView = { ...EMPTY_VIEW, status: 'searching' };

function viewFromWinner(
  w: AutoFitWinner | undefined,
  phase: 'searching' | 'refining' | 'done',
  failed: boolean,
  limit: number,
): EncodingView {
  if (!w) {
    if (phase !== 'done') return PENDING_VIEW;
    return { ...EMPTY_VIEW, status: failed ? 'failed' : 'nofit' };
  }
  const r = w.result;
  const base = { text: w.text, bytes: w.bytes, w: r.w, h: r.h, profile: r.profile, fits: w.bytes <= limit };
  if (!base.fits) return { ...base, status: phase === 'done' ? 'nofit' : 'searching' };
  return { ...base, status: phase === 'done' ? 'ready' : phase === 'refining' ? 'optimizing' : 'searching' };
}

function viewFromManual(
  r: CandidateResult,
  which: 'im3' | 'im4',
  limit: number,
  optimizing: boolean,
  prev: EncodingView | null,
): EncodingView {
  const text = which === 'im3' ? r.im3Text : r.im4Text;
  const bytes = which === 'im3' ? r.im3Bytes : r.im4Bytes;
  // Keep the shorter of the text we already show and the new one.
  if (prev && prev.text !== null && prev.bytes !== null && prev.bytes <= bytes) {
    return { ...prev, status: optimizing ? 'optimizing' : prev.fits ? 'ready' : 'nofit' };
  }
  const fits = bytes <= limit;
  return {
    status: optimizing ? (fits ? 'optimizing' : 'searching') : fits ? 'ready' : 'nofit',
    text,
    bytes,
    w: r.w,
    h: r.h,
    profile: r.profile,
    fits,
  };
}

export function useMcoImageCompose(opts: UseMcoImageComposeOptions): McoImageComposeState {
  const {
    source,
    limit,
    mode,
    enabled,
    debounceMs = MANUAL_DEBOUNCE_MS,
    highTimeoutMs = HIGH_TIMEOUT_MS,
    poolFactory,
    planFactory = planAutoFit,
  } = opts;
  const { size, profile, dither } = opts.manual;
  const [state, setState] = useState<McoImageComposeState>(EMPTY_STATE);
  const poolRef = useRef<McoEncodePool | null>(null);
  const genRef = useRef(0);
  const jobIdRef = useRef(0);
  const factoryRef = useRef(poolFactory);
  factoryRef.current = poolFactory;
  const planFactoryRef = useRef(planFactory);
  planFactoryRef.current = planFactory;

  // Pool lifetime = dialog open time.
  useEffect(() => {
    if (!enabled) return undefined;
    const pool = (factoryRef.current ?? createMcoEncodePool)();
    poolRef.current = pool;
    return () => {
      genRef.current += 1;
      pool.dispose();
      if (poolRef.current === pool) poolRef.current = null;
    };
  }, [enabled]);

  // One search per distinct input set.
  useEffect(() => {
    const pool = poolRef.current;
    if (!enabled || !pool || !source) {
      setState(EMPTY_STATE);
      return undefined;
    }
    const prevGen = genRef.current;
    const gen = prevGen + 1;
    genRef.current = gen;
    pool.cancelGeneration(prevGen);
    pool.setSource(source);
    const current = () => genRef.current === gen;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const nextJobId = () => (jobIdRef.current += 1);

    /** Run one job; a High job gets a wall-clock cap that cancels its worker. */
    const runJob = (job: { jobId: number; candidate: Candidate; level: 'normal' | 'high' }) => {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (job.level === 'high') {
        timer = setTimeout(() => {
          timedOut = true;
          timers.delete(timer as ReturnType<typeof setTimeout>);
          pool.cancelJob(job.jobId);
        }, highTimeoutMs);
        timers.add(timer);
      }
      const done = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timers.delete(timer);
        }
      };
      return pool.run(gen, job).then(
        (result) => {
          done();
          return { ok: true as const, result, timedOut };
        },
        (err: unknown) => {
          done();
          return { ok: false as const, cancelled: err instanceof PoolCancelledError, timedOut, err };
        },
      );
    };

    if (mode === 'auto') {
      setState({ im3: PENDING_VIEW, im4: PENDING_VIEW, highTimedOut: false });
      let plan: AutoFitPlan;
      try {
        plan = planFactoryRef.current({ srcLongest: Math.max(source.width, source.height), gray: isNearGray(source), limit });
      } catch {
        setState({ im3: { ...EMPTY_VIEW, status: 'failed' }, im4: { ...EMPTY_VIEW, status: 'failed' }, highTimedOut: false });
        return undefined;
      }
      let failures = 0;
      let highTimedOut = false;
      const publish = () => {
        const w = plan.winners();
        const phase = plan.phase();
        setState({
          im3: viewFromWinner(w.im3, phase, failures > 0, limit),
          im4: viewFromWinner(w.im4, phase, failures > 0, limit),
          highTimedOut,
        });
      };
      const pump = () => {
        if (!current()) return;
        for (const job of plan.next()) {
          void runJob(job).then((out) => {
            if (!current()) return;
            if (out.ok) plan.accept(job.jobId, out.result);
            else {
              if (out.timedOut) highTimedOut = true;
              else if (!out.cancelled) failures += 1;
              plan.fail(job.jobId);
            }
            publish();
            pump();
          });
        }
      };
      pump();
      publish();
    } else {
      setState({ im3: PENDING_VIEW, im4: PENDING_VIEW, highTimedOut: false });
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!current()) return;
        const candidate: Candidate = { longest: size, profile, dither };
        let im3: EncodingView | null = null;
        let im4: EncodingView | null = null;
        let highTimedOut = false;
        const fail = () => {
          if (!current()) return;
          if (!im3) setState({ im3: { ...EMPTY_VIEW, status: 'failed' }, im4: { ...EMPTY_VIEW, status: 'failed' }, highTimedOut });
        };
        void runJob({ jobId: nextJobId(), candidate, level: 'normal' }).then((out) => {
          if (!current()) return;
          if (!out.ok) {
            fail();
            return;
          }
          im3 = viewFromManual(out.result, 'im3', limit, true, null);
          im4 = viewFromManual(out.result, 'im4', limit, true, null);
          setState({ im3, im4, highTimedOut });
          void runJob({ jobId: nextJobId(), candidate, level: 'high' }).then((hi) => {
            if (!current()) return;
            if (hi.ok) {
              im3 = viewFromManual(hi.result, 'im3', limit, false, im3);
              im4 = viewFromManual(hi.result, 'im4', limit, false, im4);
            } else {
              highTimedOut = hi.timedOut;
              im3 = { ...(im3 as EncodingView), status: (im3 as EncodingView).fits ? 'ready' : 'nofit' };
              im4 = { ...(im4 as EncodingView), status: (im4 as EncodingView).fits ? 'ready' : 'nofit' };
            }
            setState({ im3, im4, highTimedOut });
          });
        });
      }, debounceMs);
      timers.add(timer);
    }

    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      if (genRef.current === gen) genRef.current = gen + 1;
      pool.cancelGeneration(gen);
    };
  }, [enabled, source, limit, mode, size, profile, dither, debounceMs, highTimeoutMs]);

  return state;
}
