/**
 * MESHCORE_* first-boot env vars (#5874 follow-up): parsing, the MeshCore
 * config builder, and the shared default-source plan.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseMeshCoreDefaultEnv } from './meshcoreEnv.js';
import {
  buildDefaultMeshCoreSourceConfig,
  planDefaultSources,
  planDefaultSourcesFromEnv,
  DEFAULT_MESHCORE_SOURCE_NAME,
} from './defaultSourceConfig.js';

function parse(env: Record<string, string>) {
  const warn = vi.fn();
  const parsed = parseMeshCoreDefaultEnv(env as NodeJS.ProcessEnv, warn);
  return { parsed, warn, warnings: warn.mock.calls.map((c) => c[0] as string) };
}

describe('parseMeshCoreDefaultEnv', () => {
  it('neither host nor serial: no transport, no warnings', () => {
    const { parsed, warn } = parse({});
    expect(parsed.transport).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('TCP host with default port 5000', () => {
    const { parsed, warn } = parse({ MESHCORE_TCP_HOST: ' 192.0.2.10 ' });
    expect(parsed).toMatchObject({ transport: 'tcp', tcpHost: '192.0.2.10', tcpPort: 5000, tcpPortProvided: false });
    expect(parsed.deviceType).toBe('companion');
    expect(warn).not.toHaveBeenCalled();
  });

  it('TCP host with explicit port', () => {
    const { parsed } = parse({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_TCP_PORT: '4403' });
    expect(parsed).toMatchObject({ transport: 'tcp', tcpPort: 4403, tcpPortProvided: true });
  });

  it('serial port uses transport usb (what the form saves) with baud 115200', () => {
    const { parsed } = parse({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0' });
    expect(parsed).toMatchObject({ transport: 'usb', serialPort: '/dev/ttyUSB0', baudRate: 115200, baudRateProvided: false });
  });

  it('serial port with explicit baud rate', () => {
    const { parsed } = parse({ MESHCORE_SERIAL_PORT: '/dev/ttyACM0', MESHCORE_BAUD_RATE: '9600' });
    expect(parsed).toMatchObject({ baudRate: 9600, baudRateProvided: true });
  });

  it('both host and serial: warns and uses TCP', () => {
    const { parsed, warnings } = parse({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_SERIAL_PORT: '/dev/ttyUSB0' });
    expect(parsed.transport).toBe('tcp');
    expect(warnings.some((w) => w.includes('Using TCP'))).toBe(true);
  });

  it('bad device type warns and falls back to companion', () => {
    const { parsed, warnings } = parse({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_DEVICE_TYPE: 'roomserver' });
    expect(parsed.deviceType).toBe('companion');
    expect(warnings.some((w) => w.includes('Invalid MESHCORE_DEVICE_TYPE'))).toBe(true);
  });

  it('the 3.x MESHCORE_FIRMWARE_TYPE name warns and is ignored', () => {
    const { parsed, warnings } = parse({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0', MESHCORE_FIRMWARE_TYPE: 'repeater' });
    expect(parsed.deviceType).toBe('companion');
    expect(warnings.some((w) => w.includes('MESHCORE_FIRMWARE_TYPE'))).toBe(true);
  });

  it('repeater device type is accepted, case-insensitive', () => {
    const { parsed, warn } = parse({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0', MESHCORE_DEVICE_TYPE: 'Repeater' });
    expect(parsed.deviceType).toBe('repeater');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['0', '70000', 'abc', '50.5'])('bad MESHCORE_TCP_PORT %s warns and uses 5000', (bad) => {
    const { parsed, warnings } = parse({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_TCP_PORT: bad });
    expect(parsed.tcpPort).toBe(5000);
    expect(parsed.tcpPortProvided).toBe(false);
    expect(warnings.some((w) => w.includes('Invalid MESHCORE_TCP_PORT'))).toBe(true);
  });

  it.each(['0', 'fast', '-1'])('bad MESHCORE_BAUD_RATE %s warns and uses 115200', (bad) => {
    const { parsed, warnings } = parse({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0', MESHCORE_BAUD_RATE: bad });
    expect(parsed.baudRate).toBe(115200);
    expect(warnings.some((w) => w.includes('Invalid MESHCORE_BAUD_RATE'))).toBe(true);
  });

  it('extra vars without host or serial warn that no source is made', () => {
    const { parsed, warnings } = parse({ MESHCORE_TCP_PORT: '5000', MESHCORE_ENABLE_VIRTUAL_NODE: 'true' });
    expect(parsed.transport).toBeNull();
    expect(warnings.some((w) => w.includes('No MeshCore source will be created'))).toBe(true);
  });

  describe('Virtual Node vars', () => {
    it('enable alone uses port 5000', () => {
      const { parsed } = parse({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_ENABLE_VIRTUAL_NODE: 'true' });
      expect(parsed.virtualNode).toMatchObject({ enabled: true, port: 5000 });
    });

    it('enable + port', () => {
      const { parsed } = parse({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_ENABLE_VIRTUAL_NODE: 'yes', MESHCORE_VIRTUAL_NODE_PORT: '5050' });
      expect(parsed.virtualNode).toMatchObject({ enabled: true, port: 5050, portProvided: true });
    });

    it('port without enable warns and stays off', () => {
      const { parsed, warnings } = parse({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_VIRTUAL_NODE_PORT: '5050' });
      expect(parsed.virtualNode.enabled).toBe(false);
      expect(warnings.some((w) => w.includes('MESHCORE_VIRTUAL_NODE_PORT is set but MESHCORE_ENABLE_VIRTUAL_NODE is not'))).toBe(true);
    });

    it('invalid port warns and turns the Virtual Node off', () => {
      const { parsed, warnings } = parse({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_ENABLE_VIRTUAL_NODE: 'true', MESHCORE_VIRTUAL_NODE_PORT: '99999' });
      expect(parsed.virtualNode.enabled).toBe(false);
      expect(warnings.some((w) => w.includes('Invalid MESHCORE_VIRTUAL_NODE_PORT'))).toBe(true);
    });

    it('does not read the Meshtastic ENABLE_VIRTUAL_NODE', () => {
      const { parsed } = parse({ MESHCORE_TCP_HOST: 'mc.lan', ENABLE_VIRTUAL_NODE: 'true' });
      expect(parsed.virtualNode.enabled).toBe(false);
    });
  });
});

describe('buildDefaultMeshCoreSourceConfig', () => {
  const cfg = (env: Record<string, string>, opts: { meshtasticVirtualNodePort?: number | null } = {}) => {
    const warn = vi.fn();
    const config = buildDefaultMeshCoreSourceConfig(parseMeshCoreDefaultEnv(env as NodeJS.ProcessEnv), { ...opts, warn });
    return { config, warnings: warn.mock.calls.map((c) => c[0] as string) };
  };

  it('returns null when nothing is set', () => {
    expect(cfg({}).config).toBeNull();
  });

  it('TCP companion matches the Add Source form shape, heartbeat 30', () => {
    expect(cfg({ MESHCORE_TCP_HOST: '192.0.2.10' }).config).toEqual({
      transport: 'tcp',
      tcpHost: '192.0.2.10',
      tcpPort: 5000,
      deviceType: 'companion',
      autoConnect: true,
      heartbeatIntervalSeconds: 30,
    });
  });

  it('serial companion stores port under `port`, no baud unless given', () => {
    expect(cfg({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0' }).config).toEqual({
      transport: 'usb',
      port: '/dev/ttyUSB0',
      deviceType: 'companion',
      autoConnect: true,
      heartbeatIntervalSeconds: 30,
    });
    expect(cfg({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0', MESHCORE_BAUD_RATE: '57600' }).config?.baudRate).toBe(57600);
  });

  it('serial repeater: no heartbeat (opt-in, like the form)', () => {
    expect(cfg({ MESHCORE_SERIAL_PORT: '/dev/ttyUSB0', MESHCORE_DEVICE_TYPE: 'repeater' }).config).toEqual({
      transport: 'usb',
      port: '/dev/ttyUSB0',
      deviceType: 'repeater',
      autoConnect: true,
    });
  });

  it('repeater over TCP warns and creates nothing', () => {
    const { config, warnings } = cfg({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_DEVICE_TYPE: 'repeater' });
    expect(config).toBeNull();
    expect(warnings.some((w) => w.includes('needs MESHCORE_SERIAL_PORT'))).toBe(true);
  });

  it('companion Virtual Node has every allow* flag off', () => {
    const { config } = cfg({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_ENABLE_VIRTUAL_NODE: 'true' });
    expect(config?.virtualNode).toEqual({
      enabled: true,
      port: 5000,
      allowAdminCommands: false,
      allowPkiExport: false,
      allowPkiImport: false,
    });
  });

  it('repeater Virtual Node warns and is dropped', () => {
    const { config, warnings } = cfg({
      MESHCORE_SERIAL_PORT: '/dev/ttyUSB0',
      MESHCORE_DEVICE_TYPE: 'repeater',
      MESHCORE_ENABLE_VIRTUAL_NODE: 'true',
    });
    expect(config).not.toBeNull();
    expect(config?.virtualNode).toBeUndefined();
    expect(warnings.some((w) => w.includes('needs a Companion'))).toBe(true);
  });

  it('Virtual Node port equal to the Meshtastic one warns and is dropped', () => {
    const { config, warnings } = cfg(
      { MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_ENABLE_VIRTUAL_NODE: 'true', MESHCORE_VIRTUAL_NODE_PORT: '4404' },
      { meshtasticVirtualNodePort: 4404 },
    );
    expect(config?.virtualNode).toBeUndefined();
    expect(warnings.some((w) => w.includes('same port as the Meshtastic Virtual Node'))).toBe(true);
  });

  it('different ports keep both Virtual Nodes', () => {
    const { config } = cfg(
      { MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_ENABLE_VIRTUAL_NODE: 'true' },
      { meshtasticVirtualNodePort: 4404 },
    );
    expect(config?.virtualNode?.port).toBe(5000);
  });
});

describe('planDefaultSourcesFromEnv (migration 050 path)', () => {
  const plan = (env: Record<string, string>) => planDefaultSourcesFromEnv(env as NodeJS.ProcessEnv);

  it('neither: the disabled Meshtastic placeholder, as before', () => {
    const rows = plan({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Default', type: 'meshtastic_tcp', enabled: false });
    expect(rows[0].config).toEqual({ host: 'meshtastic.local', port: 4403 });
  });

  it('Meshtastic only: enabled Default, unchanged', () => {
    const rows = plan({ MESHTASTIC_NODE_IP: '192.0.2.1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Default', type: 'meshtastic_tcp', enabled: true });
  });

  it('MeshCore only: one MeshCore source, no Meshtastic placeholder', () => {
    const rows = plan({ MESHCORE_TCP_HOST: '192.0.2.10' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: DEFAULT_MESHCORE_SOURCE_NAME, type: 'meshcore', enabled: true });
  });

  it('both: Meshtastic first, then MeshCore', () => {
    const rows = plan({ MESHTASTIC_NODE_IP: '192.0.2.1', MESHCORE_TCP_HOST: '192.0.2.10' });
    expect(rows.map((r) => r.type)).toEqual(['meshtastic_tcp', 'meshcore']);
  });

  it('MeshCore vars that build nothing (repeater over TCP) keep the placeholder', () => {
    const rows = plan({ MESHCORE_TCP_HOST: 'mc.lan', MESHCORE_DEVICE_TYPE: 'repeater' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'meshtastic_tcp', enabled: false });
  });

  it('both Virtual Nodes on the same port: Meshtastic keeps it, MeshCore drops it', () => {
    const rows = plan({
      MESHTASTIC_NODE_IP: '192.0.2.1',
      ENABLE_VIRTUAL_NODE: 'true',
      VIRTUAL_NODE_PORT: '5000',
      MESHCORE_TCP_HOST: '192.0.2.10',
      MESHCORE_ENABLE_VIRTUAL_NODE: 'true',
    });
    expect((rows[0].config as any).virtualNode.port).toBe(5000);
    expect((rows[1].config as any).virtualNode).toBeUndefined();
  });

  it('Meshtastic VN without its host does not block the MeshCore VN port', () => {
    const rows = plan({
      ENABLE_VIRTUAL_NODE: 'true',
      VIRTUAL_NODE_PORT: '5000',
      MESHCORE_TCP_HOST: '192.0.2.10',
      MESHCORE_ENABLE_VIRTUAL_NODE: 'true',
    });
    expect(rows).toHaveLength(1);
    expect((rows[0].config as any).virtualNode.port).toBe(5000);
  });
});

describe('planDefaultSources (bootstrapSources path)', () => {
  it('no placeholder when nothing is set', () => {
    const rows = planDefaultSources({
      meshtastic: { host: '192.168.1.100', port: 4403, hostProvided: false, virtualNode: { enabled: false, port: 4404 } },
      meshcore: parseMeshCoreDefaultEnv({}),
      createPlaceholder: false,
    });
    expect(rows).toEqual([]);
  });

  it('warns when ENABLE_VIRTUAL_NODE is set with only MeshCore configured', () => {
    const warn = vi.fn();
    planDefaultSources({
      meshtastic: { host: '192.168.1.100', port: 4403, hostProvided: false, virtualNode: { enabled: true, port: 4404 } },
      meshcore: parseMeshCoreDefaultEnv({ MESHCORE_TCP_HOST: 'mc.lan' }),
      createPlaceholder: true,
      warn,
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('MESHCORE_ENABLE_VIRTUAL_NODE'))).toBe(true);
  });
});
