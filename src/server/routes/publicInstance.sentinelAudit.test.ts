/**
 * Public-instance mode (#5156, Phase 2): the sentinel audit.
 *
 * Seeds every store (Meshtastic, MeshCore, Reticulum, MQTT, embed) with values
 * that identify a person or a place, calls EVERY GET route the real `/api` and
 * `/api/embed` routers expose as an anonymous viewer with every toggle on, and
 * scans each response body and header for those values. A leak, a stale
 * exception, a missed route or a drop in coverage fails the run.
 *
 * Routes come from walking the real routers, not from a hand-kept list, so a
 * new route is called and scanned the day it is added.
 *
 * Managers are fakes. Outbound `fetch` is blocked. Nothing reaches a radio.
 * See docs/internal/dev-notes/PUBLIC_INSTANCE_MODE_EPIC.md.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';
import request from 'supertest';

import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { installRouterUseRecorder, walkRoutes, routeKey, type WalkedRoute } from '../test-helpers/routerWalker.js';
import {
  SENTINELS, selfCheckSentinels, scanJson, scanText, scanHeaders, defsForToggle,
  seedAll, grantAnonymousEverything, buildFakeManagers, recordedManagerCalls, resolveRoutePath, routeProtocol, queryVariants,
  SOURCES, type LeakHit, type ToggleName,
} from '../test-helpers/publicInstanceAudit.js';
import { isPublicInstanceRedaction, publicInstanceRedaction } from '../middleware/publicInstanceRedaction.js';
import { __setPublicInstanceConfigForTest, __resetPublicInstanceConfigForTest } from '../services/publicInstanceConfig.js';
import { PUBLIC_INSTANCE_HIDDEN_TEXT } from '../../utils/publicInstanceMode.js';
import type { RedactionConfig } from '../../utils/publicInstanceMode.js';
import {
  SKIP, EXPECT_ERROR, ROUTE_OVERRIDES, DATA_FLOOR, PROTOCOL_FLOORS,
} from './publicInstance.sentinelAudit.table.js';

// Capture each (raw, redacted) pair the middleware produces. The real redactor still runs.
const captured = vi.hoisted(() => ({ current: [] as Array<{ raw: string; redacted: string }> }));
vi.mock('../utils/publicInstanceRedactor.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/publicInstanceRedactor.js')>();
  return {
    ...real,
    redactPublicPayload: (body: unknown, cfg: RedactionConfig): unknown => {
      const out = real.redactPublicPayload(body, cfg);
      if (cfg.enabled) captured.current.push({ raw: JSON.stringify(body) ?? 'null', redacted: JSON.stringify(out) ?? 'null' });
      return out;
    },
  };
});
const realRedactor = await vi.importActual<typeof import('../utils/publicInstanceRedactor.js')>('../utils/publicInstanceRedactor.js');

const ALL_ON: RedactionConfig = { enabled: true, hideLongNames: true, hidePublicKeys: true, roundTimestamps: true, hideMessageText: true };
const TOGGLES: ToggleName[] = ['hideLongNames', 'hidePublicKeys', 'roundTimestamps', 'hideMessageText'];

type Outcome = 'data' | 'ok' | 'blocked' | 'denied' | 'notfound' | 'error' | 'skip' | 'unresolved';
const RANK: Record<Outcome, number> = { data: 7, ok: 6, blocked: 5, denied: 4, notfound: 3, error: 2, unresolved: 1, skip: 0 };

interface VariantResult {
  variant: string;
  url: string;
  status: number;
  outcome: Outcome;
  leaks: LeakHit[];
  raws: string[];
  redacteds: string[];
  storesInRaw: Set<string>;
  labelsInRaw: Set<string>;
  note?: string;
}
interface RouteResult {
  route: WalkedRoute;
  key: string;
  outcome: Outcome;
  variants: VariantResult[];
}

const serverSource = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');
const BINARY = /^(image|font|video|audio)\//;
const REQUEST_TIMEOUT_MS = 8000;

const ALLOWED_API_MOUNTS = new Set(['/api/scripts', '/api/privacy', '/api/embed', '/api'].flatMap((p) => [p, `$BASE${p}`]));

/**
 * First argument of every `app.<verb>(` call, up to its first top-level comma.
 * Returns the ones that mention `api` (any case) but are not an allow-listed mount.
 */
function offendingApiMounts(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bapp\.(?:use|get|post|put|patch|delete|all)\(/g)) {
    let depth = 0;
    let quote = '';
    let arg = '';
    for (let i = m.index + m[0].length; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === '\\') { arg += c + source[++i]; continue; }
        if (c === quote) quote = '';
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) break;
      arg += c;
    }
    const text = arg.trim();
    if (!/api/i.test(text)) continue;
    const literal = /^[`'"](.*)[`'"]$/s.exec(text)?.[1]?.replace('${BASE_URL}', '$BASE');
    if (literal === undefined || !ALLOWED_API_MOUNTS.has(literal)) out.push(text);
  }
  return out;
}

describe('public instance mode: sentinel audit', () => {
  let harness: RouteTestHarness;
  let tmpRoot: string;
  let originalDataDir: string | undefined;
  let walked: WalkedRoute[] = [];
  let getRoutes: WalkedRoute[] = [];
  let results: RouteResult[] = [];
  let apiRouter: Router;
  const leakLines = new Map<string, string[]>();
  const allLeakKeys = new Set<string>();

  const addLeak = (route: string, variant: string, hit: LeakHit): void => {
    const key = `${route}|${variant}|${hit.def.cls}|${hit.path}`;
    const line = `${route} | ${variant || '-'} | ${hit.def.cls} | ${hit.def.label} | ${hit.path} | ${hit.def.store}`;
    const lines = leakLines.get(key) ?? [];
    if (!lines.includes(line)) lines.push(line);
    leakLines.set(key, lines);
    allLeakKeys.add(key);
  };

  beforeAll(async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('outbound fetch blocked by the audit')));
    tmpRoot = mkdtempSync(join(tmpdir(), 'mm-audit-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpRoot;
    mkdirSync(join(tmpRoot, 'geojson'));
    mkdirSync(join(tmpRoot, 'styles'));

    installRouterUseRecorder();
    const { createApiRouter } = await import('./apiRouter.js');
    const { default: embedPublicRoutes } = await import('./embedPublicRoutes.js');
    const { createGeoJsonRouter } = await import('./geojsonRoutes.js');
    const { GeoJsonService } = await import('../services/geojsonService.js');
    const { createMapStyleRouter } = await import('./mapStyleRoutes.js');
    const { MapStyleService } = await import('../services/mapStyleService.js');

    apiRouter = createApiRouter({
      geojsonRouter: createGeoJsonRouter(new GeoJsonService(join(tmpRoot, 'geojson'))),
      mapStyleRouter: createMapStyleRouter(new MapStyleService(join(tmpRoot, 'styles'))),
      includeDebugRoutes: true,
    });

    harness = await createRouteTestApp({
      mount: (app) => {
        // As server.ts: the embed router sits before `/api`, behind a forced-anonymous redaction.
        app.use('/api/embed', publicInstanceRedaction({ forceAnonymous: true }), embedPublicRoutes);
        app.use('/api', apiRouter);
      },
    });

    walked = [...walkRoutes(apiRouter, '/api'), ...walkRoutes(embedPublicRoutes, '/api/embed')];
    getRoutes = walked.filter((r) => r.method === 'GET' || r.method === 'ALL');

    await seedAll(databaseService);
    await grantAnonymousEverything(databaseService, harness.anonymous.id);
    const fakes = await buildFakeManagers(databaseService);
    for (const [key, manager] of Object.entries(fakes)) {
      void key;
      await sourceManagerRegistry.addManager(manager as ISourceManager);
    }
    __setPublicInstanceConfigForTest(ALL_ON);

    const agent = request(harness.app);
    results = [];
    for (const route of getRoutes) {
      const key = routeKey(route);
      if (SKIP[key]) {
        results.push({ route, key, outcome: 'skip', variants: [] });
        continue;
      }
      const override = ROUTE_OVERRIDES[key];
      const resolved = override === undefined
        ? resolveRoutePath(route.path, { anonymousId: harness.anonymous.id })
        : { urls: Array.isArray(override) ? override : [override], unresolved: [] };
      if (resolved.unresolved.length > 0) {
        results.push({ route, key, outcome: 'unresolved', variants: [{ variant: '', url: route.path, status: 0, outcome: 'unresolved', leaks: [], raws: [], redacteds: [], storesInRaw: new Set(), labelsInRaw: new Set(), note: resolved.unresolved.join(',') }] });
        continue;
      }
      const variants = override === undefined ? queryVariants(route.path) : [''];
      const variantResults: VariantResult[] = [];
      for (const base of resolved.urls) {
        for (const variant of variants) {
          const url = `${base}${variant}`;
          captured.current = [];
          let status = 0;
          let outcome: Outcome;
          let note: string | undefined;
          let hits: LeakHit[] = [];
          try {
            const res = await Promise.race([
              agent.get(url).buffer(true).then((r) => r),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), REQUEST_TIMEOUT_MS)),
            ]);
            status = res.status;
            const contentType = String(res.headers['content-type'] ?? '');
            const text = typeof res.text === 'string' ? res.text : '';
            const bodyCode = (res.body as { code?: string } | undefined)?.code;
            if (status >= 500) outcome = 'error';
            else if (status === 403 && bodyCode === 'PUBLIC_INSTANCE_UNSUPPORTED_RESPONSE') outcome = 'blocked';
            else if (status === 401 || status === 403) outcome = 'denied';
            else if (status >= 400) outcome = 'notfound';
            else outcome = 'ok';
            if (outcome === 'error' || outcome === 'notfound' || outcome === 'denied') note = text.replace(/\s+/g, ' ').slice(0, 140);
            hits = scanHeaders(res.headers as Record<string, unknown>);
            if (!BINARY.test(contentType) && text) {
              if (/json/.test(contentType)) {
                try { hits.push(...scanJson(JSON.parse(text))); } catch { hits.push(...scanText(text, '<body>')); }
              } else {
                hits.push(...scanText(text, '<body>'));
              }
            }
          } catch (e) {
            outcome = 'error';
            note = e instanceof Error ? e.message : String(e);
          }
          const raws = captured.current.map((c) => c.raw);
          const redacteds = captured.current.map((c) => c.redacted);
          const rawHits = raws.flatMap((r) => scanText(r, '<raw>'));
          if (outcome === 'ok' && rawHits.length > 0) outcome = 'data';
          variantResults.push({
            variant, url, status, outcome, leaks: hits, raws, redacteds,
            storesInRaw: new Set(rawHits.map((h) => h.def.store)),
            labelsInRaw: new Set(rawHits.map((h) => h.def.label)),
            note,
          });
          for (const hit of hits) addLeak(key, variant, hit);
        }
      }
      const best = variantResults.reduce<Outcome>((acc, v) => (RANK[v.outcome] > RANK[acc] ? v.outcome : acc), 'skip');
      results.push({ route, key, outcome: EXPECT_ERROR[key] && best === 'error' ? 'ok' : best, variants: variantResults });
    }
  }, 180_000);

  afterAll(async () => {
    __resetPublicInstanceConfigForTest();
    vi.unstubAllGlobals();
    for (const id of Object.values(SOURCES)) await sourceManagerRegistry.removeManager(id).catch(() => {});
    await harness?.cleanup();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Guards ────────────────────────────────────────────────────────────────
  describe('guards', () => {
    it('server.ts builds the API router in apiRouter.ts and mounts nothing on it', () => {
      expect(serverSource).not.toMatch(/\bapiRouter\.(use|get|post|put|patch|delete)\(/);
    });

    it('the only /api mounts on the app are the audited ones', () => {
      expect(offendingApiMounts(serverSource)).toEqual([]);
    });

    it('the mount scan catches concatenated and variable paths', () => {
      expect(offendingApiMounts("app.use(BASE_URL + '/api', apiRouter);")).toHaveLength(1);
      expect(offendingApiMounts("app.use(apiBase, apiRouter);")).toHaveLength(1);
      expect(offendingApiMounts("app.post(`${BASE_URL}/api/x`, h);")).toHaveLength(1);
      expect(offendingApiMounts("app.use('/api/embed', publicInstanceRedaction(), r);")).toEqual([]);
      expect(offendingApiMounts("app.use(`${BASE_URL}/api`, apiLimiter, apiRouter);")).toEqual([]);
    });

    it('the embed mount runs the redaction middleware in forced-anonymous mode', () => {
      expect(serverSource).toContain('publicInstanceRedaction({ forceAnonymous: true }), embedPublicRoutes');
    });

    it('the redaction middleware is the first handler on the API router', () => {
      const first = (apiRouter as unknown as { stack: Array<{ handle: unknown }> }).stack[0];
      expect(isPublicInstanceRedaction(first.handle)).toBe(true);
    });

    it('the sentinels survive honest redaction', () => {
      expect(selfCheckSentinels()).toEqual([]);
    });
  });

  // ── Walk ──────────────────────────────────────────────────────────────────
  describe('walk', () => {
    it('enumerates routes', () => {
      expect(walked.length).toBeGreaterThan(300);
      expect(getRoutes.length).toBeGreaterThan(150);
    });

    it('has no stale exception entries', () => {
      const keys = new Set(getRoutes.map(routeKey));
      const stale = [
        ...Object.keys(SKIP).map((k) => `SKIP ${k}`),
        ...Object.keys(EXPECT_ERROR).map((k) => `EXPECT_ERROR ${k}`),
        ...Object.keys(ROUTE_OVERRIDES).map((k) => `ROUTE_OVERRIDES ${k}`),
      ].filter((entry) => !keys.has(entry.slice(entry.indexOf(' ') + 1)));
      expect(stale, 'exceptions that match no walked GET route').toEqual([]);
    });

    it('resolves every route parameter', () => {
      const lines = results.filter((r) => r.outcome === 'unresolved').map((r) => `  '${r.key}': '<url>',  // ${r.variants[0]?.note}`);
      expect(lines, `add ROUTE_OVERRIDES entries:\n${lines.join('\n')}`).toEqual([]);
    });

    it('has no unexpected 5xx or timeouts', () => {
      const bad = results.flatMap((r) => r.variants.filter((v) => v.outcome === 'error' && !EXPECT_ERROR[r.key]).map((v) => `  '${r.key}': '${v.status} ${v.url} ${(v.note ?? '').replace(/\s+/g, ' ').slice(0, 120)}'`));
      expect(bad, `unexpected errors; add to EXPECT_ERROR or SKIP:\n${bad.join('\n')}`).toEqual([]);
    });
  });

  // ── Coverage ──────────────────────────────────────────────────────────────
  describe('coverage', () => {
    const count = (o: Outcome): number => results.filter((r) => r.outcome === o).length;

    it('prints the coverage report', () => {
      if (process.env.AUDIT_RAW_FOR) {
        const re = new RegExp(process.env.AUDIT_RAW_FOR);
        const dump = results.filter((r) => re.test(r.key)).map((r) => ({ key: r.key, raw: r.variants[0]?.raws[0] ?? null }));
        writeFileSync('/tmp/aud/raw.json', JSON.stringify(dump, null, 1));
      }
      const unreached = new Set(SENTINELS.map((d) => d.label));
      for (const r of results) for (const v of r.variants) for (const l of v.labelsInRaw) unreached.delete(l);
      const byProto: Record<string, number> = {};
      for (const r of results.filter((x) => x.outcome === 'data')) byProto[routeProtocol(r.route.path)] = (byProto[routeProtocol(r.route.path)] ?? 0) + 1;
      const noData = results.filter((r) => r.outcome !== 'data' && r.outcome !== 'skip').map((r) => `${r.outcome.padEnd(8)} ${r.key}${r.outcome === 'notfound' || r.outcome === 'denied' ? `  <- ${r.variants.find((v) => v.note)?.note ?? ''}` : ''}`);
      const report = [
        `routes walked ${walked.length}, GET ${getRoutes.length}`,
        `data ${count('data')}  ok ${count('ok')}  blocked ${count('blocked')}  denied ${count('denied')}  404/400 ${count('notfound')}  error ${count('error')}  skip ${count('skip')}  unresolved ${count('unresolved')}`,
        `data by route family: ${JSON.stringify(byProto)}`,
        `data by sentinel store: ${JSON.stringify(Object.fromEntries(['MT', 'MC', 'RNS', 'MQTT'].map((st) => [st, results.filter((r) => r.outcome === 'data' && r.variants.some((v) => v.storesInRaw.has(st))).length])))}`,
        `manager calls recorded (never sent): ${[...new Set(recordedManagerCalls)].sort().join(', ') || 'none'}`,
        `sentinels never seen in any raw response (${unreached.size}): ${[...unreached].sort().join(', ')}`,
        `routes without data:\n${noData.join('\n')}`,
      ].join('\n');
      if (process.env.AUDIT_REPORT) writeFileSync(process.env.AUDIT_REPORT, report);
      console.log(report);
      expect(results.length).toBe(getRoutes.length);
    });

    it('meets the data floors', () => {
      const dataRoutes = results.filter((r) => r.outcome === 'data');
      expect(dataRoutes.length).toBeGreaterThanOrEqual(DATA_FLOOR);
      const per = (store: string): number => dataRoutes.filter((r) => r.variants.some((v) => v.storesInRaw.has(store))).length;
      const embed = dataRoutes.filter((r) => routeProtocol(r.route.path) === 'embed').length;
      for (const [store, floor] of Object.entries(PROTOCOL_FLOORS)) {
        const actual = store === 'embed' ? embed : per(store);
        expect(actual, `${store} data routes`).toBeGreaterThanOrEqual(floor);
      }
    });
  });

  // ── Leaks ─────────────────────────────────────────────────────────────────
  describe('leaks', () => {
    it('with every toggle on, no sentinel reaches an anonymous response ', () => {
      const found = [...allLeakKeys];
      const lines = found.flatMap((k) => leakLines.get(k) ?? [k]);
      if (process.env.AUDIT_LEAKS) writeFileSync(process.env.AUDIT_LEAKS, JSON.stringify(Object.fromEntries([...leakLines]), null, 1));
      expect(lines, `route | variant | class | sentinel | JSON path | store\n${lines.join('\n')}`).toEqual([]);
    });
  });

  // ── Toggle replay ─────────────────────────────────────────────────────────
  /** Replay every captured raw body with one toggle on. Records leaks into the shared maps; runs once. */
  let replayLines: string[] | null = null;
  const runReplay = (): string[] => {
    if (replayLines) return replayLines;
    const lines: string[] = [];
    const allOnKeys = new Set(allLeakKeys);
    for (const r of results) {
      for (const v of r.variants) {
        expect(v.raws.length, `${r.key} ${v.variant}: raws and redacteds out of step`).toBe(v.redacteds.length);
        for (const raw of v.raws) {
          const parsed: unknown = JSON.parse(raw);
          for (const toggle of TOGGLES) {
            const cfg: RedactionConfig = { enabled: true, hideLongNames: false, hidePublicKeys: false, roundTimestamps: false, hideMessageText: false, [toggle]: true };
            const out = realRedactor.redactPublicPayload(parsed, cfg);
            for (const hit of scanJson(out, defsForToggle(toggle))) {
              if (allOnKeys.has(`${r.key}|${v.variant}|${hit.def.cls}|${hit.path}`)) continue; // the all-on scan reports it
              const variant = `replay[${toggle}]${v.variant}`;
              const key = `${r.key}|${variant}|${hit.def.cls}|${hit.path}`;
              const line = `${r.key} | ${variant} | ${hit.def.cls} | ${hit.def.label} | ${hit.path} | ${hit.def.store}`;
              const existing = leakLines.get(key) ?? [];
              if (!existing.includes(line)) existing.push(line);
              leakLines.set(key, existing);
              allLeakKeys.add(key);
              lines.push(line);
            }
          }
        }
      }
    }
    if (process.env.AUDIT_LEAKS) writeFileSync(process.env.AUDIT_LEAKS, JSON.stringify(Object.fromEntries([...leakLines]), null, 1));
    replayLines = [...new Set(lines)];
    return replayLines;
  };

  describe('toggle replay', () => {
    it("with one toggle on, that toggle's class and the always-on classes stay out of every raw body", () => {
      const unique = runReplay();
      expect(unique, `route | variant | class | sentinel | JSON path | store\n${unique.join('\n')}`).toEqual([]);
    });
  });

  // ── Over-redaction report (prints, never fails) ───────────────────────────
  describe('over-redaction report', () => {
    it('lists values hidden that were not sentinels', () => {
      const textDefs = SENTINELS.filter((d) => d.cls === 'text');
      const nameDefs = SENTINELS.filter((d) => d.cls === 'longName');
      const found = new Map<string, number>();
      const walkPair = (raw: unknown, red: unknown, key: string, path: string, route: string): void => {
        if (typeof raw === 'string') {
          if (red === PUBLIC_INSTANCE_HIDDEN_TEXT && !textDefs.some((d) => d.re.test(raw))) {
            const k = `placeholder | ${route} | ${path}`;
            found.set(k, (found.get(k) ?? 0) + 1);
          } else if (red === null && /name/i.test(key) && !nameDefs.some((d) => d.re.test(raw))) {
            const k = `name nulled | ${route} | ${path}`;
            found.set(k, (found.get(k) ?? 0) + 1);
          }
          return;
        }
        if (Array.isArray(raw) && Array.isArray(red)) {
          raw.forEach((item, i) => walkPair(item, red[i], key, `${path}[]`, route));
          return;
        }
        if (raw && red && typeof raw === 'object' && typeof red === 'object') {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) walkPair(v, (red as Record<string, unknown>)[k], k, `${path}.${k}`, route);
        }
      };
      for (const r of results) {
        for (const v of r.variants) {
          v.raws.forEach((raw, i) => walkPair(JSON.parse(raw), JSON.parse(v.redacteds[i]), '', '$', r.key));
        }
      }
      const rows = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${k}${n > 1 ? ` (x${n})` : ''}`);
      const report = `over-redaction candidates (${rows.length}):\n${rows.join('\n')}`;
      if (process.env.AUDIT_OVERREDACT) writeFileSync(process.env.AUDIT_OVERREDACT, report);
      console.log(report.split('\n').slice(0, 40).join('\n'));
      // Report only: this test prints candidates for a human and never fails on them.
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});
