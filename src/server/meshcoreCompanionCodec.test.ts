import { describe, it, expect } from 'vitest';
// Round-trip fidelity check: feed OUR encoder output into meshcore.js's OWN
// decoders and assert it reads back what we put in. This is the cheap, deviceless
// guarantee that our wire layout matches the firmware the app expects.
import { Connection, Constants } from '@liamcottle/meshcore.js';
import {
  CommandCodes,
  ResponseCodes,
  FRAME_APP_TO_NODE,
  FRAME_NODE_TO_APP,
  parseAppFrames,
  decodeCommand,
  frameNodeToApp,
  encodeSelfInfo,
  encodeCurrTime,
  encodeDeviceInfo,
  encodeContactsStart,
  encodeContact,
  encodeEndOfContacts,
  encodeChannelInfo,
  encodeBatteryVoltage,
  encodeContactMsgRecv,
  encodeChannelMsgRecv,
  encodeSent,
  encodeSendConfirmed,
  encodeNoMoreMessages,
  packTelemetryMode,
  pubKeyHexToBytes,
  hexToBytes,
  degreesToFixed,
  fixedToDegrees,
  wireFreqToMhz,
  wireBwToKhz,
  parseSetAdvertName,
  parseSetRadioParams,
  parseSetTxPower,
  parseSetAdvertLatLon,
  parseSetChannel,
  toEpochSeconds,
  type SelfInfoWire,
} from './meshcoreCompanionCodec.js';

/** Decode one of our response payloads via meshcore.js and return the event object. */
function decodeWithMeshcore(responseCode: number, payload: Buffer): Promise<any> {
  return new Promise((resolve) => {
    const conn: any = new (Connection as any)();
    conn.once(responseCode, (event: any) => resolve(event));
    // onFrameReceived expects the frame payload (response code byte first).
    conn.onFrameReceived(new Uint8Array(payload));
  });
}

/** Build a synthetic app→node command frame for parser tests. */
function frameAppToNode(payload: Uint8Array): Buffer {
  const header = Buffer.alloc(3);
  header[0] = FRAME_APP_TO_NODE;
  header.writeUInt16LE(payload.length, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

const SAMPLE_PUBKEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

describe('meshcoreCompanionCodec — constants stay in sync with meshcore.js', () => {
  it('command/response codes match the library', () => {
    expect(CommandCodes.AppStart).toBe(Constants.CommandCodes.AppStart);
    expect(CommandCodes.GetContacts).toBe(Constants.CommandCodes.GetContacts);
    expect(CommandCodes.SyncNextMessage).toBe(Constants.CommandCodes.SyncNextMessage);
    expect(ResponseCodes.SelfInfo).toBe(Constants.ResponseCodes.SelfInfo);
    expect(ResponseCodes.CurrTime).toBe(Constants.ResponseCodes.CurrTime);
    expect(ResponseCodes.DeviceInfo).toBe(Constants.ResponseCodes.DeviceInfo);
    expect(ResponseCodes.NoMoreMessages).toBe(Constants.ResponseCodes.NoMoreMessages);
  });
});

describe('meshcoreCompanionCodec — encoders round-trip through meshcore.js decoders', () => {
  it('SelfInfo decodes back to the same identity + radio params', async () => {
    const wire: SelfInfoWire = {
      type: Constants.AdvType.Chat,
      txPower: 22,
      maxTxPower: 30,
      publicKey: pubKeyHexToBytes(SAMPLE_PUBKEY),
      advLat: degreesToFixed(29.7604),
      advLon: degreesToFixed(-95.3698),
      multiAcks: 0,
      advLocPolicy: Constants.AdvLocPolicy.Share,
      telemetryMode: packTelemetryMode(1, 2, 1),
      manualAddContacts: 0,
      radioFreq: 917375, // wire kHz == 917.375 MHz
      radioBw: 250000, // wire Hz == 250 kHz
      radioSf: 11,
      radioCr: 5,
      name: 'MeshMonitor VNode',
    };

    const decoded = await decodeWithMeshcore(ResponseCodes.SelfInfo, encodeSelfInfo(wire));

    expect(decoded.type).toBe(wire.type);
    expect(decoded.txPower).toBe(22);
    expect(decoded.maxTxPower).toBe(30);
    expect(Buffer.from(decoded.publicKey).toString('hex')).toBe(SAMPLE_PUBKEY);
    expect(decoded.advLat).toBe(degreesToFixed(29.7604));
    expect(decoded.advLon).toBe(degreesToFixed(-95.3698));
    expect(decoded.advLocPolicy).toBe(Constants.AdvLocPolicy.Share);
    expect(decoded.telemetryModeBase).toBe(1);
    expect(decoded.telemetryModeLoc).toBe(2);
    expect(decoded.telemetryModeEnv).toBe(1);
    expect(decoded.radioFreq).toBe(917375);
    expect(decoded.radioBw).toBe(250000);
    expect(decoded.radioSf).toBe(11);
    expect(decoded.radioCr).toBe(5);
    expect(decoded.name).toBe('MeshMonitor VNode');
  });

  it('CurrTime decodes to the same epoch seconds', async () => {
    const epoch = 1_750_000_000;
    const decoded = await decodeWithMeshcore(ResponseCodes.CurrTime, encodeCurrTime(epoch));
    expect(decoded.epochSecs).toBe(epoch);
  });

  it('DeviceInfo decodes firmware version, build date and model', async () => {
    const decoded = await decodeWithMeshcore(
      ResponseCodes.DeviceInfo,
      encodeDeviceInfo({ firmwareVer: 7, firmwareBuildDate: '19 Feb 2025', manufacturerModel: 'MeshMonitor Virtual Node' }),
    );
    expect(decoded.firmwareVer).toBe(7);
    expect(decoded.firmware_build_date).toBe('19 Feb 2025');
    expect(decoded.manufacturerModel).toBe('MeshMonitor Virtual Node');
  });

  it('ContactsStart decodes the announced count', async () => {
    const decoded = await decodeWithMeshcore(ResponseCodes.ContactsStart, encodeContactsStart(0));
    expect(decoded.count).toBe(0);
  });

  it('EndOfContacts decodes mostRecentLastmod', async () => {
    const decoded = await decodeWithMeshcore(ResponseCodes.EndOfContacts, encodeEndOfContacts(0));
    expect(decoded.mostRecentLastmod).toBe(0);
  });

  it('NoMoreMessages is a bare response code', () => {
    const payload = encodeNoMoreMessages();
    expect(payload).toHaveLength(1);
    expect(payload[0]).toBe(ResponseCodes.NoMoreMessages);
  });

  it('Contact decodes back to the same key, name, path and position', async () => {
    const decoded = await decodeWithMeshcore(ResponseCodes.Contact, encodeContact({
      publicKey: pubKeyHexToBytes(SAMPLE_PUBKEY),
      type: Constants.AdvType.Chat,
      flags: 0,
      outPathLen: 3,
      outPath: hexToBytes('a37f02'),
      advName: 'Repeater North',
      lastAdvert: 1_750_000_000,
      advLat: degreesToFixed(40.1),
      advLon: degreesToFixed(-105.2),
      lastMod: 1_750_000_500,
    }));

    expect(Buffer.from(decoded.publicKey).toString('hex')).toBe(SAMPLE_PUBKEY);
    expect(decoded.type).toBe(Constants.AdvType.Chat);
    expect(decoded.outPathLen).toBe(3);
    expect(Buffer.from(decoded.outPath).subarray(0, 3).toString('hex')).toBe('a37f02');
    expect(decoded.advName).toBe('Repeater North');
    expect(decoded.lastAdvert).toBe(1_750_000_000);
    expect(decoded.advLat).toBe(degreesToFixed(40.1));
    expect(decoded.advLon).toBe(degreesToFixed(-105.2));
    expect(decoded.lastMod).toBe(1_750_000_500);
  });

  it('Contact encodes OUT_PATH_UNKNOWN (-1) for an unknown route', async () => {
    const decoded = await decodeWithMeshcore(ResponseCodes.Contact, encodeContact({
      publicKey: pubKeyHexToBytes(SAMPLE_PUBKEY),
      type: 1, flags: 0, outPathLen: -1, outPath: Buffer.alloc(0),
      advName: 'X', lastAdvert: 0, advLat: 0, advLon: 0, lastMod: 0,
    }));
    expect(decoded.outPathLen).toBe(-1);
  });

  it('ChannelInfo decodes index, name and 16-byte secret', async () => {
    const secret = Buffer.from('0123456789abcdef0123456789abcdef', 'hex'); // 16 bytes
    const decoded = await decodeWithMeshcore(ResponseCodes.ChannelInfo, encodeChannelInfo(0, 'Public', secret));
    expect(decoded.channelIdx).toBe(0);
    expect(decoded.name).toBe('Public');
    expect(Buffer.from(decoded.secret).toString('hex')).toBe('0123456789abcdef0123456789abcdef');
  });

  it('BatteryVoltage decodes millivolts', async () => {
    const decoded = await decodeWithMeshcore(ResponseCodes.BatteryVoltage, encodeBatteryVoltage(4100));
    expect(decoded.batteryMilliVolts).toBe(4100);
  });

  it('ContactMsgRecv decodes prefix, type, timestamp and text', async () => {
    const decoded = await decodeWithMeshcore(ResponseCodes.ContactMsgRecv, encodeContactMsgRecv({
      pubKeyPrefix: hexToBytes(SAMPLE_PUBKEY).subarray(0, 6),
      pathLen: 0xff,
      txtType: 0,
      senderTimestamp: 1_750_000_000,
      text: 'hello there',
    }));
    expect(Buffer.from(decoded.pubKeyPrefix).toString('hex')).toBe(SAMPLE_PUBKEY.slice(0, 12));
    expect(decoded.pathLen).toBe(0xff);
    expect(decoded.senderTimestamp).toBe(1_750_000_000);
    expect(decoded.text).toBe('hello there');
  });

  it('Sent decodes result, expectedAckCrc and estTimeout', async () => {
    const decoded = await decodeWithMeshcore(ResponseCodes.Sent, encodeSent(0, 0xdeadbeef, 8000));
    expect(decoded.result).toBe(0);
    expect(decoded.expectedAckCrc).toBe(0xdeadbeef);
    expect(decoded.estTimeout).toBe(8000);
  });

  it('SendConfirmed(0x82) decodes ackCode and roundTrip (#3869)', async () => {
    // Round-trips through meshcore.js's own onSendConfirmedPush decoder, proving
    // the byte layout matches what a real companion app expects.
    const decoded = await decodeWithMeshcore(0x82, encodeSendConfirmed(0xdeadbeef, 1500));
    expect(decoded.ackCode).toBe(0xdeadbeef);
    expect(decoded.roundTrip).toBe(1500);
  });

  it('ChannelMsgRecv decodes channel index and text', async () => {
    const decoded = await decodeWithMeshcore(ResponseCodes.ChannelMsgRecv, encodeChannelMsgRecv({
      channelIdx: 0,
      pathLen: 0xff,
      txtType: 0,
      senderTimestamp: 1_750_000_000,
      text: 'Alice: hi all',
    }));
    expect(decoded.channelIdx).toBe(0);
    expect(decoded.text).toBe('Alice: hi all');
  });
});

describe('meshcoreCompanionCodec — timestamp normalization', () => {
  it('passes through epoch seconds and downscales milliseconds', () => {
    expect(toEpochSeconds(1_750_000_000)).toBe(1_750_000_000);
    expect(toEpochSeconds(1_750_000_000_000)).toBe(1_750_000_000);
    expect(toEpochSeconds(0)).toBe(0);
    expect(toEpochSeconds(undefined)).toBe(0);
  });
});

describe('meshcoreCompanionCodec — framing + command decode', () => {
  it('frameNodeToApp prefixes the 0x3e header with little-endian length', () => {
    const framed = frameNodeToApp(Buffer.from([0x05, 0xaa, 0xbb]));
    expect(framed[0]).toBe(FRAME_NODE_TO_APP);
    expect(framed.readUInt16LE(1)).toBe(3);
    expect(framed.subarray(3)).toEqual(Buffer.from([0x05, 0xaa, 0xbb]));
  });

  it('parseAppFrames extracts whole frames and retains a trailing partial', () => {
    const a = frameAppToNode(Buffer.from([CommandCodes.GetDeviceTime]));
    const b = frameAppToNode(Buffer.from([CommandCodes.SyncNextMessage]));
    const partial = b.subarray(0, 2); // first 2 bytes of a 4-byte frame
    const { commands, rest } = parseAppFrames(Buffer.concat([a, b, partial]));

    expect(commands.map((c) => c.code)).toEqual([CommandCodes.GetDeviceTime, CommandCodes.SyncNextMessage]);
    expect(rest).toEqual(partial);
  });

  it('parseAppFrames resyncs past a garbage byte', () => {
    const good = frameAppToNode(Buffer.from([CommandCodes.GetDeviceTime]));
    const { commands } = parseAppFrames(Buffer.concat([Buffer.from([0x00]), good]));
    expect(commands.map((c) => c.code)).toEqual([CommandCodes.GetDeviceTime]);
  });

  it('decodeCommand parses an AppStart body the way meshcore.js encodes it', () => {
    // meshcore.js AppStart: [code][appVer:1][reserved:6][appName]
    const body = Buffer.concat([
      Buffer.from([CommandCodes.AppStart, 1]),
      Buffer.alloc(6),
      Buffer.from('mc-app', 'utf8'),
    ]);
    const parsed = decodeCommand(body);
    expect(parsed.code).toBe(CommandCodes.AppStart);
    expect(parsed.appVer).toBe(1);
    expect(parsed.appName).toBe('mc-app');
  });

  it('decodeCommand parses a DeviceQuery target version', () => {
    const parsed = decodeCommand(Buffer.from([CommandCodes.DeviceQuery, 1]));
    expect(parsed.code).toBe(CommandCodes.DeviceQuery);
    expect(parsed.appTargetVer).toBe(1);
  });
});

// ─────────────── config-command parsers (issue #3904) ───────────────
// These parse the app→node config frames the meshcore-flutter app sends so the
// Virtual Node can forward them to the physical node. Strongest guarantee: feed
// meshcore.js's OWN command builders through our parser and assert we read back
// what the app put in. meshcore.js builders hand `sendToRadioFrame` the raw
// payload (command-code byte first) — exactly what our parsers accept.
async function buildCommandBytes(
  fn: (conn: any) => Promise<void>,
): Promise<Buffer> {
  const conn: any = new (Connection as any)();
  let captured: Buffer | null = null;
  conn.sendToRadioFrame = (bytes: Uint8Array) => {
    captured = Buffer.from(bytes);
    return Promise.resolve();
  };
  await fn(conn);
  if (!captured) throw new Error('no frame captured');
  return captured;
}

describe('config-command parsers (#3904)', () => {
  it('fixedToDegrees inverts degreesToFixed', () => {
    expect(fixedToDegrees(degreesToFixed(29.7604))).toBeCloseTo(29.7604, 6);
    expect(fixedToDegrees(degreesToFixed(-95.3698))).toBeCloseTo(-95.3698, 6);
    expect(fixedToDegrees(0)).toBe(0);
  });

  it('wire freq/bw converters invert the encode-side helpers', () => {
    expect(wireFreqToMhz(917375)).toBeCloseTo(917.375, 6); // kHz → MHz
    expect(wireBwToKhz(250000)).toBeCloseTo(250, 6); // Hz → kHz
  });

  it('parses SetAdvertName from meshcore.js builder output', async () => {
    const bytes = await buildCommandBytes((c) => c.sendCommandSetAdvertName('Node XYZ'));
    expect(bytes[0]).toBe(CommandCodes.SetAdvertName);
    expect(parseSetAdvertName(bytes)).toEqual({ name: 'Node XYZ' });
  });

  it('accepts a bare SetAdvertName (no name bytes) as an empty "clear name"', () => {
    // Intentionally lenient — a name-less frame yields '' rather than throwing.
    expect(parseSetAdvertName(Buffer.from([CommandCodes.SetAdvertName]))).toEqual({ name: '' });
  });

  it('parses SetRadioParams into manager units (MHz / kHz)', async () => {
    // meshcore.js writes freq/bw as raw u32 wire units (kHz / Hz).
    const bytes = await buildCommandBytes((c) => c.sendCommandSetRadioParams(917375, 250000, 11, 5));
    expect(bytes[0]).toBe(CommandCodes.SetRadioParams);
    const p = parseSetRadioParams(bytes);
    expect(p.freq).toBeCloseTo(917.375, 6);
    expect(p.bw).toBeCloseTo(250, 6);
    expect(p.sf).toBe(11);
    expect(p.cr).toBe(5);
  });

  it('parses SetTxPower', async () => {
    const bytes = await buildCommandBytes((c) => c.sendCommandSetTxPower(22));
    expect(bytes[0]).toBe(CommandCodes.SetTxPower);
    expect(parseSetTxPower(bytes)).toEqual({ power: 22 });
  });

  it('parses SetAdvertLatLon back to decimal degrees', async () => {
    const bytes = await buildCommandBytes((c) =>
      c.sendCommandSetAdvertLatLon(degreesToFixed(29.7604), degreesToFixed(-95.3698)),
    );
    expect(bytes[0]).toBe(CommandCodes.SetAdvertLatLon);
    const p = parseSetAdvertLatLon(bytes);
    expect(p.lat).toBeCloseTo(29.7604, 6);
    expect(p.lon).toBeCloseTo(-95.3698, 6);
  });

  it('parses SetChannel (idx, name, 16-byte secret → hex)', async () => {
    const secret = new Uint8Array(16).map((_, i) => i + 1);
    const bytes = await buildCommandBytes((c) => c.sendCommandSetChannel(2, 'gauntlet', secret));
    expect(bytes[0]).toBe(CommandCodes.SetChannel);
    const p = parseSetChannel(bytes);
    expect(p.idx).toBe(2);
    expect(p.name).toBe('gauntlet');
    expect(p.secretHex).toBe('0102030405060708090a0b0c0d0e0f10');
  });

  it('throws on short/garbage payloads so the dispatcher can reply Err', () => {
    // parseSetAdvertName is intentionally absent here — it has no min-length
    // guard (an empty name is valid; see the "clear name" test above).
    expect(() => parseSetRadioParams(Buffer.from([CommandCodes.SetRadioParams, 1, 2]))).toThrow();
    expect(() => parseSetTxPower(Buffer.from([CommandCodes.SetTxPower]))).toThrow();
    expect(() => parseSetAdvertLatLon(Buffer.from([CommandCodes.SetAdvertLatLon, 0, 0]))).toThrow();
    expect(() => parseSetChannel(Buffer.from([CommandCodes.SetChannel, 0]))).toThrow();
  });
});
