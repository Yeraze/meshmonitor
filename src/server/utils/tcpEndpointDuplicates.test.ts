import { describe, it, expect, vi } from 'vitest';
import {
  tcpEndpointKey,
  findDuplicateTcpEndpoints,
  warnOnDuplicateTcpEndpoints,
} from './tcpEndpointDuplicates.js';

const tcp = (id: string, config: unknown, enabled = true) => ({
  id, name: `S-${id}`, type: 'meshtastic_tcp', enabled, config,
});

describe('tcpEndpointDuplicates (#5974)', () => {
  it('normalises host case, whitespace, trailing dot and port type', () => {
    expect(tcpEndpointKey({ host: ' Node.Local. ', port: '4403' })).toBe('node.local:4403');
    expect(tcpEndpointKey({ host: '10.0.0.1' })).toBe('10.0.0.1:4403');
    expect(tcpEndpointKey({ host: '' })).toBeNull();
    expect(tcpEndpointKey(null)).toBeNull();
  });

  it('groups enabled meshtastic_tcp sources on one endpoint', () => {
    const groups = findDuplicateTcpEndpoints([
      tcp('a', { host: '10.0.0.1', port: 4403 }),
      tcp('b', { host: '10.0.0.1', port: '4403' }),
      tcp('c', { host: '10.0.0.2', port: 4403 }),
      tcp('d', { host: '10.0.0.1', port: 4403 }, false),
      { id: 'e', name: 'MC', type: 'meshcore', enabled: true, config: { host: '10.0.0.1', port: 4403 } },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].endpoint).toBe('10.0.0.1:4403');
    expect(groups[0].sources.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('different ports on one host are not duplicates', () => {
    expect(findDuplicateTcpEndpoints([
      tcp('a', { host: '10.0.0.1', port: 4403 }),
      tcp('b', { host: '10.0.0.1', port: 4404 }),
    ])).toEqual([]);
  });

  it('warns once per group', () => {
    const warn = vi.fn();
    const n = warnOnDuplicateTcpEndpoints([
      tcp('a', { host: 'x', port: 1 }),
      tcp('b', { host: 'x', port: 1 }),
      tcp('c', { host: 'y', port: 1 }),
      tcp('d', { host: 'y', port: 1 }),
    ], warn);
    expect(n).toBe(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('"S-a", "S-b"');
  });
});
