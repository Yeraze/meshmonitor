/**
 * #4173 review N5: the MeshCore route guards answer a source with no running
 * manager with `code: 'SOURCE_NOT_CONNECTED'`, so the client can show a
 * "not connected" state instead of the raw message. Status and message are
 * unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const h = vi.hoisted(() => ({ getManager: vi.fn() }));
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: h.getManager },
}));

import { meshcoreRouteGuard, anyMeshCoreRouteGuard } from './meshcoreRouteShared.js';

function call(guard: typeof meshcoreRouteGuard, id: string) {
  const req = { params: { id } } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { locals: {}, status } as unknown as Response;
  const next = vi.fn();
  guard(req, res, next);
  return { status, json, next };
}

describe('MeshCore route guards — no manager (#4173 N5)', () => {
  beforeEach(() => h.getManager.mockReset());

  it.each([
    ['meshcoreRouteGuard', meshcoreRouteGuard],
    ['anyMeshCoreRouteGuard', anyMeshCoreRouteGuard],
  ])('%s: 404 SOURCE_NOT_CONNECTED when nothing is registered', (_name, guard) => {
    h.getManager.mockReturnValue(undefined);
    const { status, json, next } = call(guard, 'src-x');
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: 'No MeshCore manager for source src-x',
      code: 'SOURCE_NOT_CONNECTED',
    });
  });

  it('a non-MeshCore manager is not reported as "not connected"', () => {
    h.getManager.mockReturnValue({ sourceType: 'meshtastic_tcp' });
    const { status, json } = call(meshcoreRouteGuard, 'mt-1');
    expect(status).toHaveBeenCalledWith(404);
    expect(json.mock.calls[0][0].code).toBeUndefined();
  });
});
