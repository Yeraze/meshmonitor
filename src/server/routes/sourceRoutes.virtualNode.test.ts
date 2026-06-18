import { describe, it, expect, vi, beforeEach } from 'vitest';

// validateVirtualNodeConfig consults the sources repo for port-collision
// checks; stub it so the type-gate assertions don't need a real DB.
const getAllSources = vi.fn();
vi.mock('../../services/database.js', () => ({
  default: { sources: { getAllSources: (...a: unknown[]) => getAllSources(...a) } },
}));

const { validateVirtualNodeConfig } = await import('./sourceRoutes.js');

describe('validateVirtualNodeConfig — source-type gate (#3535)', () => {
  beforeEach(() => {
    getAllSources.mockReset();
    getAllSources.mockResolvedValue([]);
  });

  it('returns null when there is no virtualNode block', async () => {
    expect(await validateVirtualNodeConfig('meshcore', {})).toBeNull();
    expect(await validateVirtualNodeConfig('mqtt_broker', { virtualNode: undefined })).toBeNull();
  });

  it('rejects virtualNode on unsupported source types', async () => {
    const result = await validateVirtualNodeConfig('mqtt_broker', { virtualNode: { enabled: true, port: 5000 } });
    expect(result).toEqual({ status: 400, error: expect.stringContaining('only supported') });
  });

  it('allows virtualNode on meshcore sources', async () => {
    const result = await validateVirtualNodeConfig('meshcore', { virtualNode: { enabled: true, port: 5000 } });
    expect(result).toBeNull();
  });

  it('allows virtualNode on meshtastic_tcp sources', async () => {
    const result = await validateVirtualNodeConfig('meshtastic_tcp', { virtualNode: { enabled: true, port: 5000 } });
    expect(result).toBeNull();
  });

  it('still validates the port range for meshcore', async () => {
    const result = await validateVirtualNodeConfig('meshcore', { virtualNode: { enabled: true, port: 70000 } });
    expect(result).toEqual({ status: 400, error: expect.stringContaining('port') });
  });

  it('detects a port collision against another enabled source', async () => {
    getAllSources.mockResolvedValue([
      { id: 'other', name: 'Other Node', config: { virtualNode: { enabled: true, port: 5000 } } },
    ]);
    const result = await validateVirtualNodeConfig('meshcore', { virtualNode: { enabled: true, port: 5000 } });
    expect(result).toEqual({ status: 409, error: expect.stringContaining('already in use') });
  });

  it('ignores the collision check for the source being edited (excludeSourceId)', async () => {
    getAllSources.mockResolvedValue([
      { id: 'self', name: 'Self', config: { virtualNode: { enabled: true, port: 5000 } } },
    ]);
    const result = await validateVirtualNodeConfig('meshcore', { virtualNode: { enabled: true, port: 5000 } }, 'self');
    expect(result).toBeNull();
  });
});
