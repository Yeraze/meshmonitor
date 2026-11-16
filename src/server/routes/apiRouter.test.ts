import { describe, it, expect, vi } from 'vitest';
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

  it('only mounts /debug/ip when debug routes are enabled', () => {
    const has = (r: Router) =>
      r.stack.some((l: { route?: { path?: string } }) => l.route?.path === '/debug/ip');
    expect(has(createApiRouter(deps(true)))).toBe(true);
    expect(has(createApiRouter(deps(false)))).toBe(false);
  });

  it('keeps the mount order unchanged', () => {
    // router@2: a router's prototype is a Router instance; the methods live one level up.
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router())) as Record<string, (...a: unknown[]) => unknown>;
    const origUse = proto.use;
    const origGet = proto.get;
    const calls: string[] = [];
    const record = (kind: string, args: unknown[]) => {
      const first = args[0];
      calls.push(`${kind}('${typeof first === 'string' ? first : '<handler>'}'`);
    };
    proto.use = function (this: unknown, ...args: unknown[]) {
      record('use', args);
      return origUse.apply(this, args);
    };
    proto.get = function (this: unknown, ...args: unknown[]) {
      record('get', args);
      return origGet.apply(this, args);
    };
    try {
      createApiRouter(deps(true));
    } finally {
      proto.use = origUse;
      proto.get = origGet;
    }
    // Expected list recorded from server.ts before the extraction.
    expect(calls).toEqual([
      "use('<handler>'",
      "get('/csrf-token'",
      "use('/health'",
      "get('/debug/ip'",
      "use('/auth/passkey'",
      "use('/auth'",
      "use('/token'",
      "use('/mfa'",
      "use('/v1'",
      "use('/users'",
      "use('/audit'",
      "use('/channel-database'",
      "use('/security'",
      "use('/packets'",
      "use('/solar'",
      "use('/news'",
      "use('/messages'",
      "use('/translate'",
      "use('/read-state'",
      "use('/sources/:id/meshcore'",
      "use('/meshcore/cli-history'",
      "use('/sources/:id/meshtastic'",
      "use('/sources/:id/mqtt/packets'",
      "use('/sources/:id/mqtt/native'",
      "use('/sources/:id/forwarding'",
      "use('/sources/:id/atak'",
      "use('/sources/:id/beacon-offers'",
      "use('/sources/:id/survey'",
      "use('/sources/:id/direct-rf-contacts'",
      "use('/rf'",
      "use('/sources/:id/reticulum'",
      "use('/'",
      "use('/'",
      "use('/tile-server'",
      "use('/settings'",
      "use('/node-name-sanitizer'",
      "use('/config'",
      "use('/user'",
      "use('/admin'",
      "use('/embed-profiles'",
      "use('/firmware'",
      "use('/sources'",
      "use('/unified'",
      "use('/analysis/mesh-issues'",
      "use('/analysis/coverage'",
      "use('/analysis/cross-source-links'",
      "use('/analysis'",
      "use('/aircraft'",
      "use('/assets'",
      "use('/elevation'",
      "use('/gnss'",
      "use('/geojson'",
      "use('/privacy/admin'",
      "use('/map-styles'",
      "use('/cleanup'",
      "use('/maintenance'",
      "use('/themes'",
      "use('/purge'",
      "use('/traceroutes'",
      "use('/route-segments'",
      "use('/neighbor-info'",
      "use('/ignored-nodes'",
      "use('/announce'",
      "use('/backup'",
      "use('/system/backup'",
      "use('/push'",
      "use('/apprise'",
      "use('/connection'",
      "use('/automations/convert'",
      "use('/automations'",
      "use('/'",
      "use('/'",
      "use('/'",
      "use('/'",
      "use('/'",
      "use('/'",
      "use('/'",
      "use('/'",
      "use('/channels'",
      "use('/'",
      "use('/'",
      "use('/'",
      "use('/'",
      "use('/mqtt-broker-presets'",
      "use('/mqtt/root-finder'",
      "use('/ducting'",
    ]);
    expect(vi.isMockFunction(proto.use)).toBe(false);
  });
});
