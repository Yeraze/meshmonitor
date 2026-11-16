import { describe, it, expect } from 'vitest';
import express, { type Router } from 'express';
import { createApiRouter } from './apiRouter.js';
import { isPublicInstanceRedaction } from '../middleware/publicInstanceRedaction.js';

describe('createApiRouter', () => {
  const deps = (includeDebugRoutes: boolean) => ({
    geojsonRouter: express.Router(),
    mapStyleRouter: express.Router(),
    includeDebugRoutes,
  });

  it('mounts publicInstanceRedaction() first', () => {
    const router = createApiRouter(deps(false));
    expect(isPublicInstanceRedaction(router.stack[0].handle)).toBe(true);
  });

  it('keeps its mount blocks (a dropped block would shrink the stack)', () => {
    expect(createApiRouter(deps(false)).stack.length).toBeGreaterThanOrEqual(80);
  });

  it('only mounts /debug/ip when debug routes are enabled', () => {
    const has = (r: Router) =>
      r.stack.some((l: { route?: { path?: string } }) => l.route?.path === '/debug/ip');
    expect(has(createApiRouter(deps(true)))).toBe(true);
    expect(has(createApiRouter(deps(false)))).toBe(false);
  });
});
