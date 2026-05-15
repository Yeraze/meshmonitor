/**
 * Tests for MeshCoreNativeBackend.
 *
 * Mocks meshcore.js so we exercise the bridge-shaped command/event surface
 * without needing actual hardware or the upstream npm package installed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  MeshCoreNativeBackend,
  __setMeshCoreModule,
} from './meshcoreNativeBackend.js';

// ---------------- mock meshcore.js ----------------

const ResponseCodes = {
  Ok: 0,
  Err: 1,
  ContactsStart: 2,
  Contact: 3,
  EndOfContacts: 4,
  SelfInfo: 5,
  Sent: 6,
  ContactMsgRecv: 7,
  ChannelMsgRecv: 8,
  CurrTime: 9,
  NoMoreMessages: 10,
  Stats: 24,
};
const PushCodes = {
  Advert: 0x80,
  PathUpdated: 0x81,
  MsgWaiting: 0x83,
  NewAdvert: 0x8a,
};
const StatsTypes = { Core: 0, Radio: 1, Packets: 2 };
const SelfAdvertTypes = { ZeroHop: 0, Flood: 1 };
const BinaryRequestTypes = { GetTelemetryData: 0x03 };
const AdvType = { None: 0, Chat: 1, Repeater: 2, Room: 3 };

/** Mock Connection that surfaces every method the backend touches. */
class MockConnection extends EventEmitter {
  public connectCalled = 0;
  public closeCalled = 0;
  public sentTextMessages: Array<{ key: Uint8Array; text: string }> = [];
  public sentChannelMessages: Array<{ channel: number; text: string }> = [];
  public sentAdverts: number[] = [];
  public setAdvertNameCalls: string[] = [];
  public setAdvertLatLongCalls: Array<[number, number]> = [];
  public setRadioParamsCalls: Array<[number, number, number, number]> = [];
  public setAdvertLocPolicyCalls: number[] = [];
  public setTelemetryModeBaseCalls: number[] = [];
  public setTelemetryModeLocCalls: number[] = [];
  public setTelemetryModeEnvCalls: number[] = [];
  public statsRequests: number[] = [];
  public binaryRequests: Array<{ key: Uint8Array; req: number[] }> = [];
  public syncNextMessageQueue: any[] = [];
  public deviceTimeResponse: { epochSecs: number } | null = { epochSecs: 1700000000 };
  public statsResponse: any = {
    type: StatsTypes.Core,
    data: { batteryMilliVolts: 4100, uptimeSecs: 12345, queueLen: 0 },
  };
  public deviceQueryResponse: any = {
    firmwareVer: 4,
    firmware_build_date: '01 Jan 2026',
    manufacturerModel: 'Heltec V3',
  };
  public contactsResponse: any[] = [];
  public loginResolveValue: any = { ok: true };
  public statusResolveValue: any = {
    batt_milli_volts: 4000,
    total_up_time_secs: 999,
  };
  public selfInfoEmitDelay = 5;

  /** Required: the backend imports SelfInfo via a once() listener and then
   *  calls connect(). Our mock fires SelfInfo on the next tick. */
  public selfInfoToEmit: any = {
    type: AdvType.Chat,
    txPower: 22,
    maxTxPower: 22,
    publicKey: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    advLat: 40_000_000,
    advLon: -75_000_000,
    manualAddContacts: 0,
    radioFreq: 915000000,
    radioBw: 250000,
    radioSf: 11,
    radioCr: 5,
    name: 'TestNode',
  };

  async connect() {
    this.connectCalled++;
    setTimeout(() => {
      this.emit(ResponseCodes.SelfInfo, this.selfInfoToEmit);
    }, this.selfInfoEmitDelay);
  }

  async close() {
    this.closeCalled++;
  }

  async sendTextMessage(key: Uint8Array, text: string) {
    this.sentTextMessages.push({ key, text });
    return { result: 0 };
  }

  async sendChannelTextMessage(channel: number, text: string) {
    this.sentChannelMessages.push({ channel, text });
  }

  async sendAdvert(type: number) {
    this.sentAdverts.push(type);
  }

  async setAdvertName(name: string) {
    this.setAdvertNameCalls.push(name);
  }

  async setAdvertLatLong(lat: number, lon: number) {
    this.setAdvertLatLongCalls.push([lat, lon]);
  }

  async setRadioParams(freq: number, bw: number, sf: number, cr: number) {
    this.setRadioParamsCalls.push([freq, bw, sf, cr]);
  }

  async setAdvertLocPolicy(policy: number) {
    this.setAdvertLocPolicyCalls.push(policy);
  }

  async setTelemetryModeBase(mode: number) {
    this.setTelemetryModeBaseCalls.push(mode);
  }

  async setTelemetryModeLoc(mode: number) {
    this.setTelemetryModeLocCalls.push(mode);
  }

  async setTelemetryModeEnv(mode: number) {
    this.setTelemetryModeEnvCalls.push(mode);
  }

  async getSelfInfo(_timeoutMs?: number) {
    return this.selfInfoToEmit;
  }

  async getContacts() {
    return this.contactsResponse;
  }

  async getStats(type: number) {
    this.statsRequests.push(type);
    return { ...this.statsResponse, type };
  }

  async getDeviceTime() {
    return this.deviceTimeResponse;
  }

  async deviceQuery() {
    return this.deviceQueryResponse;
  }

  async login() {
    return this.loginResolveValue;
  }

  async getStatus() {
    return this.statusResolveValue;
  }

  async sendBinaryRequest(_key: Uint8Array, req: number[]) {
    this.binaryRequests.push({ key: _key, req });
    // LPP-encoded voltage 4.10V on channel 1: [channel=1, type=116, 0x01, 0x9A] => 410/100 = 4.10
    return new Uint8Array([0x01, 0x74, 0x01, 0x9a]);
  }

  async syncNextMessage() {
    return this.syncNextMessageQueue.shift() ?? null;
  }
}

function installMockModule(MockConn: typeof MockConnection): MockConnection {
  const lastInstance: { current: MockConnection | null } = { current: null };

  class TrackedSerial extends MockConn {
    constructor(_path: string) {
      super();
      lastInstance.current = this;
    }
  }
  class TrackedTCP extends MockConn {
    constructor(_h: string, _p: number) {
      super();
      lastInstance.current = this;
    }
  }

  __setMeshCoreModule({
    NodeJSSerialConnection: TrackedSerial as any,
    TCPConnection: TrackedTCP as any,
    Constants: {
      ResponseCodes,
      PushCodes,
      StatsTypes,
      SelfAdvertTypes,
      BinaryRequestTypes,
      AdvType,
    } as any,
    CayenneLpp: {
      parse: (bytes: Uint8Array | number[]) => {
        // Simple stub: return a single record matching our test fixture.
        const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
        return [{ channel: arr[0], type: arr[1], value: 4.1 }];
      },
    } as any,
  });
  // Force the first new(...) to populate lastInstance — but we instead expose
  // a getter so the test can grab whichever was actually constructed.
  return lastInstance as unknown as MockConnection;
}

describe('MeshCoreNativeBackend', () => {
  let lastInstanceRef: { current: MockConnection | null };

  beforeEach(() => {
    lastInstanceRef = installMockModule(MockConnection) as any;
  });

  afterEach(() => {
    __setMeshCoreModule(null);
  });

  it('connects via serial and captures SelfInfo from AppStart', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
      baudRate: 115200,
    });
    await backend.connect();
    expect(backend.isConnected()).toBe(true);

    const resp = await backend.sendCommand('get_self_info', {});
    expect(resp.success).toBe(true);
    expect(resp.data?.name).toBe('TestNode');
    expect(resp.data?.public_key).toMatch(/^01020304/);
    expect(resp.data?.radio_freq).toBe(915000000);
    expect(resp.data?.latitude).toBeCloseTo(40, 4);
    expect(resp.data?.longitude).toBeCloseTo(-75, 4);

    await backend.disconnect();
    expect(backend.isConnected()).toBe(false);
  });

  it('connects via TCP', async () => {
    const backend = new MeshCoreNativeBackend('src-tcp', {
      connectionType: 'tcp',
      tcpHost: '192.168.1.10',
      tcpPort: 4403,
    });
    await backend.connect();
    expect(backend.isConnected()).toBe(true);
    await backend.disconnect();
  });

  it('rejects unknown commands as a bridge-shaped failure', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const resp = await backend.sendCommand('bogus_command', {});
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/Unknown native command/);
  });

  it('maps get_contacts to bridge-shaped contact rows', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    conn.contactsResponse = [
      {
        publicKey: Uint8Array.from([0xab, 0xcd, 0xef, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        type: AdvType.Chat,
        advName: 'Alice',
        advLat: 35_000_000,
        advLon: -120_000_000,
        lastAdvert: 1234567,
      },
    ];

    const resp = await backend.sendCommand('get_contacts', {});
    expect(resp.success).toBe(true);
    expect(resp.data).toEqual([
      expect.objectContaining({
        public_key: expect.stringMatching(/^abcdef/),
        adv_name: 'Alice',
        latitude: 35,
        longitude: -120,
      }),
    ]);
  });

  it('routes broadcast send_message to channel 0', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    const resp = await backend.sendCommand('send_message', { text: 'hello world' });
    expect(resp.success).toBe(true);
    expect(conn.sentChannelMessages).toEqual([{ channel: 0, text: 'hello world' }]);
  });

  it('routes DM send_message to the resolved contact pubkey', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    const targetBytes = Uint8Array.from([
      0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    conn.contactsResponse = [{ publicKey: targetBytes, type: AdvType.Chat, advName: 'Bob' }];

    const resp = await backend.sendCommand('send_message', { text: 'dm', to: 'deadbeef' });
    expect(resp.success).toBe(true);
    expect(conn.sentTextMessages).toHaveLength(1);
    expect(conn.sentTextMessages[0].text).toBe('dm');
  });

  it('translates push events into bridge-shaped events', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    const events: any[] = [];
    backend.on('event', (e) => events.push(e));
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;

    // ContactMsgRecv
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      pathLen: 1,
      txtType: 0,
      senderTimestamp: 1700000001,
      text: 'hi there',
    });
    // ChannelMsgRecv
    conn.emit(ResponseCodes.ChannelMsgRecv, {
      channelIdx: 0,
      pathLen: 0,
      txtType: 0,
      senderTimestamp: 1700000002,
      text: 'Alice: yo',
    });
    // PathUpdated
    conn.emit(PushCodes.PathUpdated, {
      publicKey: Uint8Array.from([
        0x11, 0x22, 0x33, 0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]),
    });
    // NewAdvert (manual-add mode)
    conn.emit(PushCodes.NewAdvert, {
      publicKey: Uint8Array.from([
        0xaa, 0xbb, 0xcc, 0xdd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]),
      type: AdvType.Chat,
      advName: 'Carol',
      advLat: 10_000_000,
      advLon: 20_000_000,
      lastAdvert: 555,
    });

    expect(events.map((e) => e.event_type)).toEqual([
      'contact_message',
      'channel_message',
      'contact_path_updated',
      'contact_added',
    ]);

    expect(events[0].data).toEqual(
      expect.objectContaining({
        pubkey_prefix: '010203040506',
        text: 'hi there',
        sender_timestamp: 1700000001,
      }),
    );
    expect(events[1].data).toEqual(
      expect.objectContaining({ channel_idx: 0, text: 'Alice: yo' }),
    );
    expect(events[2].data.public_key).toMatch(/^11223344/);
    expect(events[3].data).toEqual(
      expect.objectContaining({
        adv_name: 'Carol',
        latitude: 10,
        longitude: 20,
      }),
    );
  });

  it('maps get_stats to snake_case bridge shape', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const resp = await backend.sendCommand('get_stats', { type: 'core' });
    expect(resp.success).toBe(true);
    expect(resp.data).toEqual({ battery_mv: 4100, uptime_secs: 12345, queue_len: 0 });
  });

  it('maps get_device_time to { time }', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const resp = await backend.sendCommand('get_device_time', {});
    expect(resp.success).toBe(true);
    expect(resp.data).toEqual({ time: 1700000000 });
  });

  it('routes telemetry/advert-loc commands to fork helpers', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;

    const policyResp = await backend.sendCommand('set_advert_loc_policy', { policy: 1 });
    expect(policyResp.success).toBe(true);
    expect(conn.setAdvertLocPolicyCalls).toEqual([1]);

    const baseResp = await backend.sendCommand('set_telemetry_mode_base', { mode: 'always' });
    expect(baseResp.success).toBe(true);
    expect(conn.setTelemetryModeBaseCalls).toEqual([2]);

    const locResp = await backend.sendCommand('set_telemetry_mode_loc', { mode: 'device' });
    expect(locResp.success).toBe(true);
    expect(conn.setTelemetryModeLocCalls).toEqual([1]);

    const envResp = await backend.sendCommand('set_telemetry_mode_env', { mode: 'never' });
    expect(envResp.success).toBe(true);
    expect(conn.setTelemetryModeEnvCalls).toEqual([0]);
  });

  it('decodes request_telemetry response via CayenneLpp.parse', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    conn.contactsResponse = [
      {
        publicKey: Uint8Array.from([
          0x01, 0x02, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]),
        advName: 'Target',
        type: AdvType.Chat,
      },
    ];

    const resp = await backend.sendCommand('request_telemetry', { public_key: '01020304' });
    expect(resp.success).toBe(true);
    expect(Array.isArray(resp.data.records)).toBe(true);
    expect(resp.data.records[0]).toEqual({ channel: 1, type: 116, value: 4.1 });
  });

  it('times out long-running commands', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    // Hang getDeviceTime by replacing it.
    conn.getDeviceTime = () => new Promise(() => { /* never resolves */ });

    const resp = await backend.sendCommand('get_device_time', {}, 50);
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/timeout/i);
  });
});

// ---------------- Heartbeat tests (manager-level, also using the mock) ----------------

import { MeshCoreManager, ConnectionType } from './meshcoreManager.js';

describe('MeshCoreManager heartbeat (native backend)', () => {
  beforeEach(() => {
    installMockModule(MockConnection);
  });
  afterEach(() => {
    __setMeshCoreModule(null);
    vi.useRealTimers();
  });

  it('default-disabled heartbeat: no timer, no state churn', async () => {
    const mgr = new MeshCoreManager('hb-src');
    const ok = await mgr.connect({
      connectionType: ConnectionType.SERIAL,
      serialPort: '/dev/ttyUSB0',
      firmwareType: 'companion',
    });
    expect(ok).toBe(true);
    expect(mgr.getHeartbeatStatus().state).toBe('connected');
    // No interval scheduled — give it a tick and confirm nothing increments.
    await new Promise((r) => setTimeout(r, 20));
    expect(mgr.getHeartbeatStatus().consecutiveFailures).toBe(0);
    expect(mgr.getHeartbeatStatus().lastSuccessfulProbeAt).toBeNull();
    await mgr.disconnect();
  });

  it('successful probes reset failure counter and emit heartbeat_ok', async () => {
    const mgr = new MeshCoreManager('hb-src');
    const ok = await mgr.connect({
      connectionType: ConnectionType.SERIAL,
      serialPort: '/dev/ttyUSB0',
      firmwareType: 'companion',
      heartbeatIntervalSeconds: 1,
      heartbeatTimeoutMs: 500,
    });
    expect(ok).toBe(true);
    const okEvents: any[] = [];
    mgr.on('heartbeat_ok', (e) => okEvents.push(e));

    // Wait a bit longer than one interval.
    await new Promise((r) => setTimeout(r, 1200));
    expect(okEvents.length).toBeGreaterThanOrEqual(1);
    expect(mgr.getHeartbeatStatus().consecutiveFailures).toBe(0);
    expect(mgr.getHeartbeatStatus().lastSuccessfulProbeAt).not.toBeNull();
    await mgr.disconnect();
  });

  it('disconnect() during heartbeat-active state clears timers and reconnect intent', async () => {
    const mgr = new MeshCoreManager('hb-src');
    await mgr.connect({
      connectionType: ConnectionType.SERIAL,
      serialPort: '/dev/ttyUSB0',
      firmwareType: 'companion',
      heartbeatIntervalSeconds: 1,
    });
    await mgr.disconnect();
    expect(mgr.getHeartbeatStatus().state).toBe('disconnected');
  });
});
