/**
 * `meshcoreRouteGuard` behaviour for a MeshCore MQTT ingest source (#5040).
 *
 * The whole `/api/sources/:id/meshcore/*` router is device surface — connection
 * lifecycle, local-node status, contacts, advert, remote admin. A
 * `meshcore_mqtt` source has no device, so the guard must refuse it rather than
 * let a handler call `getLocalNode()` and render an empty device page.
 *
 * That refusal is already structural: the guard narrows with
 * `isMeshCoreManager()`, which excludes `meshcore_mqtt` by construction. These
 * tests pin that behaviour so a future predicate change can't silently open the
 * device routes to a radio-less source, and check the message actually says
 * what happened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const managers = new Map<string, { sourceId: string; sourceType: string }>();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => managers.get(id),
  },
}));

import { meshcoreRouteGuard } from './meshcoreRouteShared.js';

function runGuard(sourceId: string | undefined) {
  const req = { params: sourceId === undefined ? {} : { id: sourceId } } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status, locals: {} } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  meshcoreRouteGuard(req, res, next);
  return { status, json, next, res };
}

beforeEach(() => {
  managers.clear();
});

describe('meshcoreRouteGuard — MeshCore MQTT ingest sources (#5040)', () => {
  it('refuses a meshcore_mqtt source: these routes need a device', () => {
    managers.set('src-mqtt', { sourceId: 'src-mqtt', sourceType: 'meshcore_mqtt' });
    const { status, json, next } = runGuard('src-mqtt');

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
    );
  });

  it('says the source is an MQTT ingest source rather than claiming none exists', () => {
    // The manager IS registered — reporting "No MeshCore manager" would send an
    // operator hunting for a registration bug that isn't there.
    managers.set('src-mqtt', { sourceId: 'src-mqtt', sourceType: 'meshcore_mqtt' });
    const { json } = runGuard('src-mqtt');

    const body = json.mock.calls[0][0] as { error: string };
    expect(body.error).toMatch(/MQTT ingest source/i);
    expect(body.error).toMatch(/no device/i);
    expect(body.error).not.toMatch(/No MeshCore manager/i);
  });

  it('still admits a device-backed meshcore source', () => {
    managers.set('src-device', { sourceId: 'src-device', sourceType: 'meshcore' });
    const { status, next, res } = runGuard('src-device');

    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect((res.locals as Record<string, unknown>).meshcoreManager).toBeDefined();
  });

  it('keeps the original message for a genuinely unregistered source', () => {
    const { json } = runGuard('src-missing');
    const body = json.mock.calls[0][0] as { error: string };
    expect(body.error).toMatch(/No MeshCore manager/i);
  });

  it('keeps the original message for a non-MeshCore source type', () => {
    managers.set('src-tcp', { sourceId: 'src-tcp', sourceType: 'meshtastic_tcp' });
    const { json } = runGuard('src-tcp');
    const body = json.mock.calls[0][0] as { error: string };
    expect(body.error).toMatch(/No MeshCore manager/i);
  });
});
