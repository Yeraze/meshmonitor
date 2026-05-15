/**
 * MeshCoreManagerRegistry — lifecycle tests for the per-source factory.
 * Mirrors what `sourceManagerRegistry` does for Meshtastic TCP, but for
 * MeshCore. We exercise pure registry plumbing here; the actual device
 * connection logic in MeshCoreManager is out of scope for this slice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MeshCoreManagerRegistry, meshcoreConfigFromSource } from './meshcoreRegistry.js';
import { ConnectionType } from './meshcoreManager.js';
import type { Source } from '../db/repositories/sources.js';

function fakeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-a',
    name: 'A',
    type: 'meshcore',
    config: { transport: 'usb', port: '/dev/ttyACM0', deviceType: 'companion' },
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    createdBy: null,
    ...overrides,
  };
}

describe('MeshCoreManagerRegistry', () => {
  let registry: MeshCoreManagerRegistry;

  beforeEach(() => {
    registry = new MeshCoreManagerRegistry();
  });

  it('getOrCreate returns the same instance for the same source id', () => {
    const a = registry.getOrCreate(fakeSource({ id: 'a' }));
    const a2 = registry.getOrCreate(fakeSource({ id: 'a', name: 'A renamed' }));
    expect(a).toBe(a2);
    expect(a.sourceId).toBe('a');
  });

  it('getOrCreate yields independent instances per source id', () => {
    const a = registry.getOrCreate(fakeSource({ id: 'a' }));
    const b = registry.getOrCreate(fakeSource({ id: 'b' }));
    expect(a).not.toBe(b);
    expect(a.sourceId).toBe('a');
    expect(b.sourceId).toBe('b');
  });

  it('list returns every registered manager', () => {
    registry.getOrCreate(fakeSource({ id: 'a' }));
    registry.getOrCreate(fakeSource({ id: 'b' }));
    const ids = registry.list().map(m => m.sourceId).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('remove disconnects and forgets the manager', async () => {
    const m = registry.getOrCreate(fakeSource({ id: 'a' }));
    expect(registry.get('a')).toBe(m);
    await registry.remove('a');
    expect(registry.get('a')).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it('disconnectAll clears the registry', async () => {
    registry.getOrCreate(fakeSource({ id: 'a' }));
    registry.getOrCreate(fakeSource({ id: 'b' }));
    await registry.disconnectAll();
    expect(registry.list()).toHaveLength(0);
  });
});

describe('meshcoreConfigFromSource', () => {
  it('maps companion-USB source config to a SERIAL MeshCoreConfig', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'usb', port: '/dev/ttyACM0', deviceType: 'companion' } }),
    );
    expect(cfg).toEqual({
      connectionType: ConnectionType.SERIAL,
      serialPort: '/dev/ttyACM0',
      baudRate: 115200,
      firmwareType: 'companion',
    });
  });

  it('maps tcp source config when host is set', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'tcp', tcpHost: '10.0.0.5', tcpPort: 4404, deviceType: 'companion' } }),
    );
    expect(cfg).toEqual({
      connectionType: ConnectionType.TCP,
      tcpHost: '10.0.0.5',
      tcpPort: 4404,
      firmwareType: 'companion',
    });
  });

  it('defaults tcpPort to 4403 when omitted', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'tcp', tcpHost: '10.0.0.5', deviceType: 'companion' } }),
    );
    expect(cfg).toEqual({
      connectionType: ConnectionType.TCP,
      tcpHost: '10.0.0.5',
      tcpPort: 4403,
      firmwareType: 'companion',
    });
  });

  it('returns null for tcp transport without a host', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'tcp', tcpPort: 4403, deviceType: 'companion' } }),
    );
    expect(cfg).toBeNull();
  });

  it('returns null when companion-USB source has no port set (legacy seed default)', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'usb', port: '', deviceType: 'companion' } }),
    );
    expect(cfg).toBeNull();
  });
});
