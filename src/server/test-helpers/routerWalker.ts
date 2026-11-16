/**
 * Test-only route enumeration for the public-instance sentinel audit (#5156).
 *
 * Express 5 (`router@2`) layers do not store the path a sub-router was mounted
 * at, so `installRouterUseRecorder()` patches `Router.prototype.use` to tag each
 * layer it appends with its path. `walkRoutes()` then flattens a router tree
 * into one entry per (method, full path). It fails closed: a sub-router with no
 * recorded path, or a RegExp path, throws instead of being skipped.
 *
 * Install the recorder BEFORE importing any router module, and import those
 * modules dynamically. Vitest's per-file module isolation contains the patch.
 */
import express, { type Router } from 'express';

const MOUNT_PATH = Symbol.for('meshmonitor.test.mountPath');

type MountPath = string | RegExp | Array<string | RegExp>;

interface TaggedLayer {
  handle: unknown;
  route?: {
    path: unknown;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
  [MOUNT_PATH]?: MountPath;
}

type RouterLike = { stack: TaggedLayer[]; use: (...args: unknown[]) => unknown };

let installed = false;

/** Patch `Router.prototype.use` once so appended layers remember their mount path. */
export function installRouterUseRecorder(): void {
  if (installed) return;
  installed = true;
  // `express.Router()` instances inherit from a Router instance, which inherits
  // from `Router.prototype`. Walk up to the object that owns `use`.
  let proto: object | null = Object.getPrototypeOf(express.Router());
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'use')) proto = Object.getPrototypeOf(proto);
  if (!proto) throw new Error('installRouterUseRecorder: Router.prototype.use not found');
  const target = proto as { use: (this: RouterLike, ...args: unknown[]) => unknown };
  const original = target.use;
  target.use = function recordedUse(this: RouterLike, ...args: unknown[]): unknown {
    const before = this.stack.length;
    const result = original.apply(this, args);
    const first = args[0];
    const path: MountPath = typeof first === 'function' ? '/' : (first as MountPath);
    for (let i = before; i < this.stack.length; i++) this.stack[i][MOUNT_PATH] = path;
    return result;
  };
}

export interface WalkedRoute {
  /** Upper-case HTTP method (`ALL` for `router.all`). */
  method: string;
  /** Full path including the prefix, e.g. `/api/sources/:id/meshcore/nodes`. */
  path: string;
  /** Handlers on the route, in order. */
  handlers: unknown[];
}

export const routeKey = (r: Pick<WalkedRoute, 'method' | 'path'>): string => `${r.method} ${r.path}`;

function join(prefix: string, segment: string): string {
  const seg = segment === '/' ? '' : segment;
  const joined = `${prefix}${seg}`.replace(/\/{2,}/g, '/');
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
}

function pathsOf(raw: unknown, where: string): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((p) => {
    if (typeof p !== 'string') throw new Error(`walkRoutes: non-string path (${String(p)}) at ${where}`);
    return p;
  });
}

/**
 * Flatten `router` into routes. Mounts whose path starts with `/v1` (relative
 * to the `prefix`) are skipped: the v1 API authenticates with tokens and the
 * redaction middleware bypasses it.
 */
export function walkRoutes(router: Router, prefix: string, skipPrefixes: string[] = ['/api/v1']): WalkedRoute[] {
  const out: WalkedRoute[] = [];
  const stack = (router as unknown as { stack: TaggedLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const methods = Object.keys(route.methods)
        .filter((m) => route.methods[m])
        .map((m) => (m === '_all' ? 'ALL' : m.toUpperCase()));
      for (const p of pathsOf(route.path, prefix)) {
        const full = join(prefix, p);
        for (const method of methods) out.push({ method, path: full, handlers: route.stack.map((l) => l.handle) });
      }
      continue;
    }
    const sub = layer.handle as { stack?: TaggedLayer[] };
    if (!Array.isArray(sub?.stack)) continue; // plain middleware
    const mount = layer[MOUNT_PATH];
    if (mount === undefined) throw new Error(`walkRoutes: sub-router under ${prefix} has no recorded mount path`);
    for (const p of pathsOf(mount, prefix)) {
      const full = join(prefix, p);
      if (skipPrefixes.some((s) => full === s || full.startsWith(`${s}/`))) continue;
      out.push(...walkRoutes(sub as unknown as Router, full, skipPrefixes));
    }
  }
  return out;
}
