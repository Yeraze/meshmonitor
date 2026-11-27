import { describe, expect, it } from 'vitest';
import { COLOR_LADDER, GRAY_LADDER, SIZE_LADDER, profileColours, score } from './profiles.js';
import { MAX_PROBES_PER_PALETTE, planAutoFit, type AutoFitConfig, type AutoFitJob, type AutoFitPlan } from './autoFit.js';
import type { CandidateResult } from './types.js';

type Model = (job: AutoFitJob, w: number, h: number) => { im3: number; im4: number };

/** Fake cost: bytes = 6 + 0.04 * w * h * log2(colours); IM4 is 7 chars longer. */
const linear =
  (highSaving: (job: AutoFitJob, n: number) => number = () => 0): Model =>
  (job, w, h) => {
    const n = Math.ceil(6 + 0.04 * score(w, h, job.candidate.profile));
    const m = job.level === 'high' ? n - highSaving(job, n) : n;
    return { im3: m, im4: m + 7 };
  };

function run(
  cfg: AutoFitConfig,
  model: Model,
  opts: { square?: boolean; failIf?: (job: AutoFitJob) => boolean } = {},
): { plan: AutoFitPlan; jobs: AutoFitJob[] } {
  const plan = planAutoFit(cfg);
  const jobs: AutoFitJob[] = [];
  const queue: AutoFitJob[] = [...plan.next()];
  for (let guard = 0; guard < 500; guard++) {
    const job = queue.shift();
    if (!job) {
      const more = plan.next();
      if (more.length === 0) break;
      queue.push(...more);
      continue;
    }
    jobs.push(job);
    if (opts.failIf?.(job)) {
      plan.fail(job.jobId);
    } else {
      const w = job.candidate.longest;
      const h = opts.square === false ? Math.max(1, Math.round(w / 2)) : w;
      const b = model(job, w, h);
      const r: CandidateResult = {
        w,
        h,
        profile: job.candidate.profile,
        dither: false,
        level: job.level,
        im3Text: `im3:${'a'.repeat(b.im3 - 4)}`,
        im4Text: `im4:${'b'.repeat(b.im4 - 4)}`,
        im3Bytes: b.im3,
        im4Bytes: b.im4,
        ms: 1,
      };
      plan.accept(job.jobId, r);
    }
    queue.push(...plan.next());
  }
  return { plan, jobs };
}

/** Brute-force best (score, area) among all ladder sizes that fit under a monotone model. */
function brute(cfg: AutoFitConfig, model: Model, enc: 'im3' | 'im4') {
  const ladder = SIZE_LADDER.filter((s) => s <= Math.min(128, cfg.srcLongest * 4));
  let best: { profile: number; w: number } | undefined;
  let bestKey = [-1, -1];
  for (const profile of cfg.gray ? GRAY_LADDER : COLOR_LADDER) {
    for (const w of ladder) {
      const b = model({ jobId: 0, level: 'normal', candidate: { longest: w, profile, dither: false } }, w, w)[enc];
      if (b > cfg.limit) continue;
      const key = [score(w, w, profile), w * w];
      if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
        best = { profile, w };
        bestKey = key;
      }
    }
  }
  return best;
}

const cfg = (limit: number, extra: Partial<AutoFitConfig> = {}): AutoFitConfig => ({ srcLongest: 512, gray: false, limit, ...extra });

describe('planAutoFit', () => {
  it.each([127, 158, 200])('picks the brute-force winner per encoding at limit %i', (limit) => {
    const c = cfg(limit);
    const { plan } = run(c, linear());
    const w = plan.winners();
    for (const enc of ['im3', 'im4'] as const) {
      const exp = brute(c, linear(), enc);
      const got = w[enc];
      expect(got).toBeDefined();
      expect(got?.result.profile).toBe(exp?.profile);
      expect(got?.result.w).toBe(exp?.w);
      expect(got?.bytes).toBeLessThanOrEqual(limit);
    }
    expect(plan.phase()).toBe('done');
  });

  it('lets IM4 land below IM3 and never above', () => {
    const { plan } = run(cfg(158), linear());
    const w = plan.winners();
    expect(w.im3 && w.im4).toBeTruthy();
    const k = (x: NonNullable<typeof w.im3>) => score(x.result.w, x.result.h, x.result.profile);
    expect(k(w.im4!)).toBeLessThanOrEqual(k(w.im3!));
  });

  it('probes each palette at most 6 times, never repeats a job, and prunes', () => {
    const { jobs } = run(cfg(158), linear());
    const seen = new Set<string>();
    const perProfile = new Map<number, number>();
    for (const j of jobs.filter((x) => x.level === 'normal')) {
      const key = `${j.candidate.longest}|${j.candidate.profile}|${j.candidate.dither}|${j.level}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      perProfile.set(j.candidate.profile, (perProfile.get(j.candidate.profile) ?? 0) + 1);
    }
    for (const n of perProfile.values()) expect(n).toBeLessThanOrEqual(MAX_PROBES_PER_PALETTE);
    expect(perProfile.size).toBe(COLOR_LADDER.length);
    expect(Math.min(...perProfile.values())).toBeLessThan(Math.max(...perProfile.values()));
    expect(jobs.filter((x) => x.level === 'normal').length).toBeLessThan(COLOR_LADDER.length * MAX_PROBES_PER_PALETTE);
  });

  it('survives a non-monotone cost step', () => {
    const lumpy: Model = (job, w, h) => {
      const b = linear()(job, w, h);
      const bump = w === 28 || w === 56 ? 25 : 0;
      return { im3: b.im3 + bump, im4: b.im4 + bump };
    };
    const { plan, jobs } = run(cfg(158), lumpy);
    expect(plan.winners().im3).toBeDefined();
    expect(plan.winners().im3!.bytes).toBeLessThanOrEqual(158);
    expect(jobs.filter((j) => j.level === 'normal').length).toBeLessThanOrEqual(COLOR_LADDER.length * MAX_PROBES_PER_PALETTE);
  });

  it('reports nothing when no size fits', () => {
    const { plan, jobs } = run(cfg(5), linear());
    expect(plan.winners()).toEqual({ im3: undefined, im4: undefined });
    expect(plan.phase()).toBe('done');
    expect(jobs.some((j) => j.level === 'high')).toBe(false);
  });

  it('uses the grey ladder for a grey source', () => {
    const { jobs } = run(cfg(158, { gray: true }), linear());
    const used = new Set(jobs.map((j) => j.candidate.profile));
    for (const p of used) expect(GRAY_LADDER).toContain(p);
    expect(used.has(GRAY_LADDER[0])).toBe(true);
  });

  it('never goes past 4x the source size', () => {
    const { jobs } = run(cfg(200, { srcLongest: 10 }), linear());
    expect(Math.max(...jobs.map((j) => j.candidate.longest))).toBeLessThanOrEqual(40);
  });

  it('never dithers', () => {
    const { jobs } = run(cfg(158), linear());
    expect(jobs.every((j) => !j.candidate.dither)).toBe(true);
  });

  describe('High refinement', () => {
    it('asks for at most 2 High jobs per encoding and shares identical ones', () => {
      const { jobs } = run(cfg(158), linear(() => 2));
      const highs = jobs.filter((j) => j.level === 'high');
      expect(highs.length).toBeGreaterThan(0);
      expect(highs.length).toBeLessThanOrEqual(4);
      expect(new Set(highs.map((j) => `${j.candidate.longest}|${j.candidate.profile}`)).size).toBe(highs.length);
    });

    it('keeps the shorter text: High 1 byte longer loses to Normal', () => {
      const { plan } = run(cfg(158), linear(() => -1));
      const w = plan.winners();
      expect(w.im3?.level).toBe('normal');
      expect(w.im4?.level).toBe('normal');
    });

    it('uses the High text when it is shorter', () => {
      const normal = run(cfg(158), linear()).plan.winners();
      const { plan } = run(cfg(158), linear(() => 1));
      const w = plan.winners();
      for (const enc of ['im3', 'im4'] as const) {
        if (w[enc]?.level === 'high') expect(w[enc]!.bytes).toBeLessThan(normal[enc]!.bytes + 1);
        expect(w[enc]!.bytes).toBeLessThanOrEqual(158);
      }
    });

    it('promotes the step up only when its High text fits', () => {
      // Normal one step up is slightly over the limit; High saves enough to fit.
      const base = run(cfg(158), linear()).plan.winners();
      const baseW = base.im3!.result.w;
      const stepFits = run(cfg(158), linear((_j, n) => (n > 158 && n <= 158 * 1.1 ? n - 158 : 0))).plan.winners();
      expect(stepFits.im3!.result.w).toBeGreaterThanOrEqual(baseW);
      const stepMisses = run(cfg(158), linear(() => 0)).plan.winners();
      expect(stepMisses.im3!.result.w).toBe(baseW);
      // and: when the step-up exists and High fits, the winner is a High result
      if (stepFits.im3!.result.w > baseW) expect(stepFits.im3!.level).toBe('high');
    });

    it('keeps the Normal result when a High job fails or times out', () => {
      const { plan } = run(cfg(158), linear(() => 3), { failIf: (j) => j.level === 'high' });
      const w = plan.winners();
      expect(w.im3?.level).toBe('normal');
      expect(w.im3?.bytes).toBeLessThanOrEqual(158);
      expect(plan.phase()).toBe('done');
    });
  });

  it('ignores unknown and repeated job ids', () => {
    const plan = planAutoFit(cfg(158));
    const jobs = plan.next();
    const r = (j: AutoFitJob): CandidateResult => ({
      w: j.candidate.longest, h: j.candidate.longest, profile: j.candidate.profile, dither: false, level: 'normal',
      im3Text: 'im3:xxxxxxxx', im4Text: 'im4:xxxxxxxx', im3Bytes: 12, im4Bytes: 12, ms: 1,
    });
    plan.accept(9999, r(jobs[0]));
    plan.fail(9999);
    plan.accept(jobs[0].jobId, r(jobs[0]));
    const before = JSON.stringify(plan.winners());
    plan.accept(jobs[0].jobId, { ...r(jobs[0]), im3Bytes: 1, im4Bytes: 1 });
    expect(JSON.stringify(plan.winners())).toBe(before);
    expect(profileColours(jobs[0].candidate.profile)).toBeGreaterThan(1);
  });

  it('a failed Normal probe counts as not fitting', () => {
    const { plan } = run(cfg(158), linear(), { failIf: (j) => j.level === 'normal' && j.candidate.longest >= 40 });
    const w = plan.winners();
    expect(w.im3).toBeDefined();
    expect(w.im3!.result.w).toBeLessThan(40);
  });
});
