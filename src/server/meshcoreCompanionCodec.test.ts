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
  encodeEndOfContacts,
  encodeNoMoreMessages,
  packTelemetryMode,
  pubKeyHexToBytes,
  degreesToFixed,
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
