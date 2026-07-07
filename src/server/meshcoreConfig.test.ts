/**
 * Tests for meshcoreConfig.ts — the config-conversion helpers moved out of
 * meshcoreRegistry.ts as part of WP1 of the one-registry refactor (#3962 Ph2).
 *
 * Cases ported verbatim from meshcoreRegistry.test.ts `meshcoreConfigFromSource`
 * suite; the originals will be removed in WP4.
 */
import { describe, it, expect } from 'vitest';
import { meshcoreConfigFromSource, virtualNodeConfigFromSource, DEFAULT_VIRTUAL_NODE_PORT } from './meshcoreConfig.js';
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

  it('passes heartbeatIntervalSeconds through on the SERIAL path', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({
        config: { transport: 'usb', port: '/dev/ttyACM0', deviceType: 'companion', heartbeatIntervalSeconds: 30 },
      }),
    );
    expect(cfg?.heartbeatIntervalSeconds).toBe(30);
  });

  it('passes heartbeatIntervalSeconds through on the TCP path', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({
        config: { transport: 'tcp', tcpHost: '10.0.0.5', deviceType: 'companion', heartbeatIntervalSeconds: 45 },
      }),
    );
    expect(cfg?.heartbeatIntervalSeconds).toBe(45);
  });

  it('leaves heartbeatIntervalSeconds undefined when not configured', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'usb', port: '/dev/ttyACM0', deviceType: 'companion' } }),
    );
    expect(cfg?.heartbeatIntervalSeconds).toBeUndefined();
  });

  it('maps repeater device type correctly', () => {
    const cfg = meshcoreConfigFromSource(
      fakeSource({ config: { transport: 'usb', port: '/dev/ttyUSB0', deviceType: 'repeater' } }),
    );
    expect(cfg?.firmwareType).toBe('repeater');
  });
});

describe('virtualNodeConfigFromSource', () => {
  it('returns undefined when virtualNode is not configured', () => {
    expect(virtualNodeConfigFromSource({})).toBeUndefined();
  });

  it('returns undefined when enabled is false', () => {
    expect(virtualNodeConfigFromSource({ virtualNode: { enabled: false, port: 5001 } })).toBeUndefined();
  });

  it('returns the config when enabled is true', () => {
    const vn = virtualNodeConfigFromSource({ virtualNode: { enabled: true, port: 5001, allowAdminCommands: true } });
    expect(vn).toEqual({ enabled: true, port: 5001, allowAdminCommands: true });
  });

  it(`falls back to DEFAULT_VIRTUAL_NODE_PORT (${DEFAULT_VIRTUAL_NODE_PORT}) when port is missing`, () => {
    const vn = virtualNodeConfigFromSource({ virtualNode: { enabled: true } });
    expect(vn?.port).toBe(DEFAULT_VIRTUAL_NODE_PORT);
  });

  it(`falls back to DEFAULT_VIRTUAL_NODE_PORT when port is 0`, () => {
    const vn = virtualNodeConfigFromSource({ virtualNode: { enabled: true, port: 0 } });
    expect(vn?.port).toBe(DEFAULT_VIRTUAL_NODE_PORT);
  });

  it('defaults allowAdminCommands to false when absent', () => {
    const vn = virtualNodeConfigFromSource({ virtualNode: { enabled: true, port: 5001 } });
    expect(vn?.allowAdminCommands).toBe(false);
  });
});
