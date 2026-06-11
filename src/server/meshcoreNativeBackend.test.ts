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
  formatOutPath,
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
const TxtTypes = { Plain: 0, CliData: 1, SignedPlain: 2 };

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
    // Wire-format units: freq in kHz, bw in Hz. 915525 kHz == 915.525 MHz, 62500 Hz == 62.5 kHz.
    radioFreq: 915525,
    radioBw: 62500,
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

  // Channels — meshcore.js Connection.getChannels iterates until the device
  // errors. Our mock just returns a programmable array.
  public channelsResponse: Array<{ channelIdx: number; name: string; secret: Uint8Array }> = [];
  public setChannelCalls: Array<{ idx: number; name: string; secret: Uint8Array }> = [];
  public deleteChannelCalls: number[] = [];
  async getChannels() {
    return this.channelsResponse;
  }
  async setChannel(idx: number, name: string, secret: Uint8Array) {
    this.setChannelCalls.push({ idx, name, secret });
  }
  async deleteChannel(idx: number) {
    this.deleteChannelCalls.push(idx);
  }

  public resetPathCalls: Uint8Array[] = [];
  async resetPath(pubKey: Uint8Array) {
    this.resetPathCalls.push(pubKey);
  }

  public shareContactCalls: Uint8Array[] = [];
  async shareContact(pubKey: Uint8Array) {
    this.shareContactCalls.push(pubKey);
  }

  public setContactPathCalls: Array<{ contact: any; path: Uint8Array }> = [];
  async setContactPath(contact: any, path: Uint8Array) {
    this.setContactPathCalls.push({ contact, path });
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
      TxtTypes,
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
    // Library yields wire-format kHz/Hz; the backend must normalize to MHz/kHz
    // so the rest of MeshMonitor (UI presets, validation) sees consistent units.
    expect(resp.data?.radio_freq).toBe(915.525);
    expect(resp.data?.radio_bw).toBe(62.5);
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

  it('routes SignedPlain (txtType=2) as room_message', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    const events: any[] = [];
    backend.on('event', (e) => events.push(e));
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;

    // SignedPlain: 4-byte author prefix (binary) + text body
    const authorPrefix = String.fromCharCode(0xab, 0xcd, 0x12, 0x34);
    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]),
      pathLen: 2,
      txtType: 2, // SignedPlain
      senderTimestamp: 1700000099,
      text: authorPrefix + 'Hello from room!',
    });

    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('room_message');
    expect(events[0].data.room_pubkey_prefix).toBe('010203040506');
    expect(events[0].data.author_pubkey_prefix).toBe('abcd1234');
    expect(events[0].data.text).toBe('Hello from room!');
    expect(events[0].data.sender_timestamp).toBe(1700000099);
  });

  it('routes CliData (txtType=1) as cli_reply', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    const events: any[] = [];
    backend.on('event', (e) => events.push(e));
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;

    conn.emit(ResponseCodes.ContactMsgRecv, {
      pubKeyPrefix: Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]),
      pathLen: 1,
      txtType: 1, // CliData
      senderTimestamp: 1700000100,
      text: 'ver 1.2.3',
    });

    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('cli_reply');
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

  it('device_query: splits NUL-separated remainder into model + version', async () => {
    // Newer Meshcore firmware packs the model name and a firmware-version
    // string as NUL-terminated segments into the DeviceInfo frame remainder.
    // The upstream meshcore.js library decodes the whole remainder as one
    // UTF-8 string, so we have to split it ourselves — otherwise the Info
    // panel's Model row shows "<model><NUL><version>" with unprintable boxes.
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    conn.deviceQueryResponse = {
      firmwareVer: 4,
      firmware_build_date: '01 Jan 2026',
      manufacturerModel: 'Heltec V3\u0000v1.7.0\u0000',
    };

    const resp = await backend.sendCommand('device_query', {});
    expect(resp.success).toBe(true);
    expect(resp.data).toEqual({
      'fw ver': 4,
      fw_build: '01 Jan 2026',
      model: 'Heltec V3',
      ver: 'v1.7.0',
    });
  });

  it('device_query: handles plain model with no trailing version string', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    conn.deviceQueryResponse = {
      firmwareVer: 3,
      firmware_build_date: '12 Mar 2025',
      manufacturerModel: 'RAK4631',
    };

    const resp = await backend.sendCommand('device_query', {});
    expect(resp.success).toBe(true);
    expect(resp.data).toEqual({
      'fw ver': 3,
      fw_build: '12 Mar 2025',
      model: 'RAK4631',
      ver: undefined,
    });
  });

  it('device_query: empty manufacturerModel falls back to empty model + undefined ver', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    conn.deviceQueryResponse = {
      firmwareVer: 2,
      firmware_build_date: '01 Jan 2024',
      manufacturerModel: '',
    };

    const resp = await backend.sendCommand('device_query', {});
    expect(resp.success).toBe(true);
    expect(resp.data.model).toBe('');
    expect(resp.data.ver).toBeUndefined();
  });

  it('device_query: manufacturerModel that is only NUL padding yields empty model', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    conn.deviceQueryResponse = {
      firmwareVer: 5,
      firmware_build_date: '01 May 2026',
      manufacturerModel: '\u0000\u0000\u0000',
    };

    const resp = await backend.sendCommand('device_query', {});
    expect(resp.success).toBe(true);
    expect(resp.data.model).toBe('');
    expect(resp.data.ver).toBeUndefined();
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

  // Regression: issue #3352 — MeshCore's wire protocol expects fixed-point
  // microdegrees (deg × 1e6). Passing raw decimal degrees to setAdvertLatLong
  // (which writes via DataView.setInt32) truncated to the integer degree, saving
  // coordinates ~6 decimal places off.
  it('set_coords converts decimal degrees to fixed-point microdegrees before sending to device', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;

    const resp = await backend.sendCommand('set_coords', { lat: 40.712776, lon: -74.005974 });
    expect(resp.success).toBe(true);

    // Device must receive microdegrees, NOT the truncated integer degree (40, -74).
    expect(conn.setAdvertLatLongCalls).toHaveLength(1);
    expect(conn.setAdvertLatLongCalls[0]).toEqual([40712776, -74005974]);

    // Cache mirrors the same fixed-point values so the UI and device agree.
    const selfResp = await backend.sendCommand('get_self_info', {});
    expect(selfResp.data?.latitude).toBeCloseTo(40.712776, 5);
    expect(selfResp.data?.longitude).toBeCloseTo(-74.005974, 5);
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

  // ---------- radio commands ----------

  it('set_radio scales MHz/kHz floats to wire-format kHz/Hz integers', async () => {
    // Regression for issue #3048: the meshcore.js wire protocol writes radioFreq
    // as a uint32 in kHz and radioBw as a uint32 in Hz. Passing the UI's MHz/kHz
    // floats raw to writeUInt32LE truncates them and the device rejects the frame,
    // so the user sees a "Failed to update radio params" toast.
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;

    const resp = await backend.sendCommand('set_radio', {
      freq: 910.525,
      bw: 62.5,
      sf: 7,
      cr: 5,
    });
    expect(resp.success).toBe(true);
    expect(conn.setRadioParamsCalls).toEqual([[910525, 62500, 7, 5]]);

    // The bridge-shaped get_self_info readback should keep UI units (MHz/kHz).
    const after = await backend.sendCommand('get_self_info', {});
    expect(after.data?.radio_freq).toBe(910.525);
    expect(after.data?.radio_bw).toBe(62.5);
    expect(after.data?.radio_sf).toBe(7);
    expect(after.data?.radio_cr).toBe(5);
  });

  // ---------- channel commands ----------

  it('get_channels maps meshcore.js rows to snake_case bridge shape with hex secret', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    conn.channelsResponse = [
      {
        channelIdx: 0,
        name: 'Public',
        secret: Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]),
      },
      {
        channelIdx: 1,
        name: 'Private',
        secret: new Uint8Array(16),
      },
    ];

    const resp = await backend.sendCommand('get_channels', {});
    expect(resp.success).toBe(true);
    expect(resp.data).toEqual([
      { channel_idx: 0, name: 'Public', secret_hex: 'aabbccddeeff00112233445566778899' },
      { channel_idx: 1, name: 'Private', secret_hex: '00'.repeat(16) },
    ]);
  });

  it('set_channel passes idx + name + decoded 16-byte secret to the connection', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;

    const resp = await backend.sendCommand('set_channel', {
      idx: 2,
      name: 'New',
      secret_hex: 'aabbccddeeff00112233445566778899',
    });
    expect(resp.success).toBe(true);
    expect(conn.setChannelCalls).toHaveLength(1);
    expect(conn.setChannelCalls[0].idx).toBe(2);
    expect(conn.setChannelCalls[0].name).toBe('New');
    expect(conn.setChannelCalls[0].secret.length).toBe(16);
    expect(Array.from(conn.setChannelCalls[0].secret).map((b) => b.toString(16).padStart(2, '0')).join(''))
      .toBe('aabbccddeeff00112233445566778899');
  });

  it('set_channel rejects a non-16-byte secret', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();

    const resp = await backend.sendCommand('set_channel', {
      idx: 0,
      name: 'TooShort',
      secret_hex: 'aabb', // 1 byte, not 16
    });
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/must be 16 bytes/);
  });

  it('set_channel rejects an out-of-range index', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();

    const resp = await backend.sendCommand('set_channel', {
      idx: 999,
      name: 'OutOfRange',
      secret_hex: '00'.repeat(16),
    });
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/Invalid channel index/);
  });

  it('delete_channel passes idx to the connection', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;

    const resp = await backend.sendCommand('delete_channel', { idx: 4 });
    expect(resp.success).toBe(true);
    expect(conn.deleteChannelCalls).toEqual([4]);
  });

  it('get_contacts surfaces out_path and path_len from meshcore.js', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    const pubKey = new Uint8Array(32);
    pubKey[0] = 0xaa; pubKey[1] = 0xbb;
    const outPath = new Uint8Array(64);
    outPath[0] = 0xa3; outPath[1] = 0x7f; outPath[2] = 0x02;
    conn.contactsResponse = [
      {
        publicKey: pubKey, type: AdvType.Chat, advName: 'Bob',
        outPath, outPathLen: 3,
        advLat: 0, advLon: 0, lastAdvert: 1700000000,
      },
      // Unknown path: firmware sentinel 0xFF arrives as -1 over meshcore.js Int8 read.
      {
        publicKey: pubKey, type: AdvType.Chat, advName: 'Alice',
        outPath: new Uint8Array(64), outPathLen: -1,
        advLat: 0, advLon: 0, lastAdvert: 1700000001,
      },
      // Zero-hop direct neighbour.
      {
        publicKey: pubKey, type: AdvType.Chat, advName: 'Self',
        outPath: new Uint8Array(64), outPathLen: 0,
        advLat: 0, advLon: 0, lastAdvert: 1700000002,
      },
    ];

    const resp = await backend.sendCommand('get_contacts', {});
    expect(resp.success).toBe(true);
    expect(Array.isArray(resp.data)).toBe(true);
    expect(resp.data).toHaveLength(3);
    expect(resp.data[0]).toEqual(expect.objectContaining({ out_path: 'a3,7f,02', path_len: 3 }));
    expect(resp.data[1]).toEqual(expect.objectContaining({ out_path: null, path_len: null }));
    expect(resp.data[2]).toEqual(expect.objectContaining({ out_path: '', path_len: 0 }));
  });

  it('get_contacts decodes 2-byte hash paths correctly (issue #3421)', async () => {
    // Firmware with PATH_HASH_SIZE=2 stores outPathLen as a packed byte:
    // top 2 bits = hash_size-1 (0x01 for 2 bytes), bottom 6 bits = hop count.
    // 4 hops with 2-byte hashes: (1 << 6) | 4 = 0x44 = 68.
    // Before the fix, this was treated as 68 byte-count with 1-byte hashes,
    // reading all 64 bytes and producing 8 non-zero hops instead of 4.
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    const pubKey = new Uint8Array(32);
    pubKey[0] = 0xcc;
    const outPath = new Uint8Array(64);
    // 4 hops × 2 bytes: 8542 8960 8940 8920
    outPath[0] = 0x85; outPath[1] = 0x42;
    outPath[2] = 0x89; outPath[3] = 0x60;
    outPath[4] = 0x89; outPath[5] = 0x40;
    outPath[6] = 0x89; outPath[7] = 0x20;
    conn.contactsResponse = [{
      publicKey: pubKey, type: AdvType.Chat, advName: 'Carol',
      outPath, outPathLen: 68, // packed: (1 << 6) | 4 = 68
      advLat: 0, advLon: 0, lastAdvert: 1700000000,
    }];

    const resp = await backend.sendCommand('get_contacts', {});
    expect(resp.success).toBe(true);
    expect(resp.data[0]).toEqual(expect.objectContaining({
      out_path: '8542,8960,8940,8920',
      path_len: 4,
    }));
  });

  it('reset_path forwards the resolved pubkey to the connection', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    const targetBytes = new Uint8Array(32);
    targetBytes[0] = 0xde; targetBytes[1] = 0xad; targetBytes[2] = 0xbe; targetBytes[3] = 0xef;
    conn.contactsResponse = [{ publicKey: targetBytes, type: AdvType.Chat, advName: 'Bob' }];

    const resp = await backend.sendCommand('reset_path', { public_key: 'deadbeef' });
    expect(resp.success).toBe(true);
    expect(conn.resetPathCalls).toHaveLength(1);
    expect(Array.from(conn.resetPathCalls[0]).slice(0, 4)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('reset_path returns an error when the contact cannot be resolved', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();

    const resp = await backend.sendCommand('reset_path', { public_key: 'cafebabe' });
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/Reset-path target not found/);
  });

  it('share_contact forwards the resolved pubkey to the connection', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    const targetBytes = new Uint8Array(32);
    targetBytes[0] = 0xfe; targetBytes[1] = 0xed; targetBytes[2] = 0xfa; targetBytes[3] = 0xce;
    conn.contactsResponse = [{ publicKey: targetBytes, type: AdvType.Chat, advName: 'Carol' }];

    const resp = await backend.sendCommand('share_contact', { public_key: 'feedface' });
    expect(resp.success).toBe(true);
    expect(conn.shareContactCalls).toHaveLength(1);
    expect(Array.from(conn.shareContactCalls[0]).slice(0, 4)).toEqual([0xfe, 0xed, 0xfa, 0xce]);
  });

  it('share_contact returns an error when the contact cannot be resolved', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();

    const resp = await backend.sendCommand('share_contact', { public_key: 'cafebabe' });
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/Share-contact target not found/);
  });

  it('set_out_path forwards the resolved contact and path bytes to setContactPath', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    const targetBytes = new Uint8Array(32);
    targetBytes[0] = 0xab; targetBytes[1] = 0xcd; targetBytes[2] = 0xef; targetBytes[3] = 0x01;
    // setContactPath needs the full contact object so it can preserve
    // type/flags/name/advert timestamp/lat/lon — verify it's the one
    // returned by getContacts(), not a synthesised stub.
    const fullContact = {
      publicKey: targetBytes,
      type: AdvType.Chat,
      flags: 0,
      outPathLen: 0xff,
      outPath: new Uint8Array(64),
      advName: 'Bob',
      lastAdvert: 1700000000,
      advLat: 10_000_000,
      advLon: 20_000_000,
      lastMod: 1700000000,
    };
    conn.contactsResponse = [fullContact];

    const pathBytes = Uint8Array.from([0xa3, 0x7f, 0x02]);
    const resp = await backend.sendCommand('set_out_path', {
      public_key: 'abcdef01' + '0'.repeat(56),
      out_path: pathBytes,
    });

    expect(resp.success).toBe(true);
    expect(conn.setContactPathCalls).toHaveLength(1);
    expect(conn.setContactPathCalls[0].contact).toBe(fullContact);
    expect(Array.from(conn.setContactPathCalls[0].path)).toEqual([0xa3, 0x7f, 0x02]);
  });

  it('set_out_path rejects oversize paths (>64 bytes)', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    const targetBytes = new Uint8Array(32);
    targetBytes[0] = 0xab;
    conn.contactsResponse = [{ publicKey: targetBytes, type: AdvType.Chat, advName: 'Bob' }];

    const tooLong = new Uint8Array(65);
    const resp = await backend.sendCommand('set_out_path', {
      public_key: 'ab' + '0'.repeat(62),
      out_path: tooLong,
    });
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/out_path too long/);
    expect(conn.setContactPathCalls).toHaveLength(0);
  });

  it('set_out_path returns an error when the contact is missing from the device list', async () => {
    const backend = new MeshCoreNativeBackend('src-1', {
      connectionType: 'serial',
      serialPort: '/dev/ttyUSB0',
    });
    await backend.connect();
    const conn = lastInstanceRef.current as MockConnection;
    // Backend can resolve the pubkey from the 64-char hex form even
    // without a contact match — but setContactPath needs the full
    // contact object, so the second lookup against getContacts() should
    // produce the "not in device contact list" error.
    conn.contactsResponse = [];

    const resp = await backend.sendCommand('set_out_path', {
      public_key: 'a'.repeat(64),
      out_path: Uint8Array.from([0x01]),
    });
    expect(resp.success).toBe(false);
    expect(resp.error).toMatch(/Set-out-path target not in device contact list/);
  });
});

describe('formatOutPath', () => {
  it('returns nulls for the OUT_PATH_UNKNOWN sentinel (0xFF or -1)', () => {
    expect(formatOutPath(new Uint8Array(64), 0xff)).toEqual({ outPathHex: null, pathLen: null });
    expect(formatOutPath(new Uint8Array(64), -1)).toEqual({ outPathHex: null, pathLen: null });
    expect(formatOutPath(undefined, undefined)).toEqual({ outPathHex: null, pathLen: null });
  });

  it('renders zero-hop direct as empty string with pathLen=0', () => {
    expect(formatOutPath(new Uint8Array(64), 0)).toEqual({ outPathHex: '', pathLen: 0 });
  });

  it('renders multi-hop path as comma-separated hex truncated to outPathLen', () => {
    const buf = new Uint8Array(64);
    buf[0] = 0xa3; buf[1] = 0x7f; buf[2] = 0x02; buf[3] = 0x10;
    expect(formatOutPath(buf, 3)).toEqual({ outPathHex: 'a3,7f,02', pathLen: 3 });
  });

  it('filters out 0x00 padding bytes and reports the real hop count (issue #3149)', () => {
    // Firmware sometimes reports outPathLen=64 with only a couple of real hops
    // and the rest of the buffer zero-padded. The displayed path should only
    // contain the real hops.
    const buf = new Uint8Array(64);
    buf[0] = 0xad; buf[1] = 0xb0;
    expect(formatOutPath(buf, 64)).toEqual({ outPathHex: 'ad,b0', pathLen: 2 });
  });

  it('strips interior 0x00 bytes from the hex chain', () => {
    const buf = new Uint8Array(64);
    buf[0] = 0xa3; buf[1] = 0x00; buf[2] = 0x7f; buf[3] = 0x00; buf[4] = 0x02;
    expect(formatOutPath(buf, 5)).toEqual({ outPathHex: 'a3,7f,02', pathLen: 3 });
  });

  it('returns empty string when every reported byte is 0x00 padding', () => {
    expect(formatOutPath(new Uint8Array(64), 8)).toEqual({ outPathHex: '', pathLen: 0 });
  });

  it('groups bytes into 2-byte hops when hopHashBytes=2', () => {
    const buf = new Uint8Array(64);
    buf[0] = 0xad; buf[1] = 0xb0; buf[2] = 0x12; buf[3] = 0x34;
    expect(formatOutPath(buf, 4, 2)).toEqual({ outPathHex: 'adb0,1234', pathLen: 2 });
  });

  it('groups bytes into 3-byte hops when hopHashBytes=3', () => {
    const buf = new Uint8Array(64);
    buf[0] = 0xad; buf[1] = 0xb0; buf[2] = 0x12; buf[3] = 0x34; buf[4] = 0x56; buf[5] = 0x78;
    expect(formatOutPath(buf, 6, 3)).toEqual({ outPathHex: 'adb012,345678', pathLen: 2 });
  });

  it('skips entirely-zero hop chunks at 2-byte width', () => {
    const buf = new Uint8Array(64);
    // Real hop at offset 0; zero-padded slot at offset 2; real hop at offset 4.
    buf[0] = 0xad; buf[1] = 0xb0; buf[4] = 0x12; buf[5] = 0x34;
    expect(formatOutPath(buf, 6, 2)).toEqual({ outPathHex: 'adb0,1234', pathLen: 2 });
  });

  it('preserves interior 0x00 bytes inside a wider hop chunk', () => {
    // 2-byte hop "ad00" is NOT all-zero — must be kept, not stripped.
    const buf = new Uint8Array(64);
    buf[0] = 0xad; buf[1] = 0x00; buf[2] = 0x00; buf[3] = 0xb0;
    expect(formatOutPath(buf, 4, 2)).toEqual({ outPathHex: 'ad00,00b0', pathLen: 2 });
  });

  it('discards a trailing partial hop that does not fit hopHashBytes', () => {
    const buf = new Uint8Array(64);
    buf[0] = 0xad; buf[1] = 0xb0; buf[2] = 0x12;  // 3 bytes, but hop width is 2
    expect(formatOutPath(buf, 3, 2)).toEqual({ outPathHex: 'adb0', pathLen: 1 });
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
