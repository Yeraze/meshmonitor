/**
 * Builders for the one-shot device actions (#5614, #5615).
 *
 * The field NUMBERS are the contract with firmware, so each test reads the
 * raw wire tag instead of trusting a decode by name. #5614 in particular
 * named the wrong field: DFU is `enter_dfu_mode_request = 21`, not the
 * deprecated, ESP32-only `reboot_ota_seconds = 95`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import protobuf from 'protobufjs';
import protobufService from './protobufService.js';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

const ENTER_DFU_MODE_REQUEST = 21;
const FACTORY_RESET_DEVICE = 94;
const REBOOT_OTA_SECONDS = 95;
const SHUTDOWN_SECONDS = 98;
const FACTORY_RESET_CONFIG = 99;
const SESSION_PASSKEY = 101;

const VARINT = 0;

/** Top-level fields of an encoded message: number -> { wireType, value }. */
function wireFields(buf: Uint8Array): Map<number, { wireType: number; value: number | Uint8Array }> {
  const reader = protobuf.Reader.create(buf);
  const out = new Map<number, { wireType: number; value: number | Uint8Array }>();
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const wireType = tag & 7;
    const value = wireType === 2 ? reader.bytes() : reader.int32();
    out.set(tag >>> 3, { wireType, value });
  }
  return out;
}

describe('protobufService — one-shot device action builders', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('the pinned admin.proto still has the field numbers these tests assume', () => {
    const fields = getProtobufRoot()!.lookupType('meshtastic.AdminMessage').fields;
    expect(fields.enterDfuModeRequest.id).toBe(ENTER_DFU_MODE_REQUEST);
    expect(fields.enterDfuModeRequest.type).toBe('bool');
    expect(fields.shutdownSeconds.id).toBe(SHUTDOWN_SECONDS);
    expect(fields.shutdownSeconds.type).toBe('int32');
    expect(fields.factoryResetConfig.id).toBe(FACTORY_RESET_CONFIG);
    expect(fields.factoryResetConfig.type).toBe('int32');
    expect(fields.factoryResetDevice.id).toBe(FACTORY_RESET_DEVICE);
    expect(fields.factoryResetDevice.type).toBe('int32');
    expect(fields.sessionPasskey.id).toBe(SESSION_PASSKEY);
  });

  it('createEnterDfuModeMessage sets bool field 21 and nothing else', () => {
    const fields = wireFields(protobufService.createEnterDfuModeMessage());
    expect([...fields.keys()]).toEqual([ENTER_DFU_MODE_REQUEST]);
    expect(fields.get(ENTER_DFU_MODE_REQUEST)).toEqual({ wireType: VARINT, value: 1 });
    // Not the deprecated ESP32 OTA field the issue named.
    expect(fields.has(REBOOT_OTA_SECONDS)).toBe(false);
  });

  it('createShutdownMessage sets int32 field 98 to the delay', () => {
    const fields = wireFields(protobufService.createShutdownMessage(5));
    expect([...fields.keys()]).toEqual([SHUTDOWN_SECONDS]);
    expect(fields.get(SHUTDOWN_SECONDS)).toEqual({ wireType: VARINT, value: 5 });
  });

  it('createShutdownMessage still puts a zero delay on the wire', () => {
    // A oneof member has explicit presence: 0 must not vanish as a default,
    // or the node would get an AdminMessage with no command in it.
    const fields = wireFields(protobufService.createShutdownMessage(0));
    expect(fields.get(SHUTDOWN_SECONDS)).toEqual({ wireType: VARINT, value: 0 });
  });

  it('createFactoryResetConfigMessage sets int32 field 99, not 94', () => {
    const fields = wireFields(protobufService.createFactoryResetConfigMessage());
    expect([...fields.keys()]).toEqual([FACTORY_RESET_CONFIG]);
    expect(fields.get(FACTORY_RESET_CONFIG)).toEqual({ wireType: VARINT, value: 1 });
  });

  it('createFactoryResetDeviceMessage sets int32 field 94, not 99', () => {
    const fields = wireFields(protobufService.createFactoryResetDeviceMessage());
    expect([...fields.keys()]).toEqual([FACTORY_RESET_DEVICE]);
    expect(fields.get(FACTORY_RESET_DEVICE)).toEqual({ wireType: VARINT, value: 1 });
  });

  it.each([
    ['createEnterDfuModeMessage', ENTER_DFU_MODE_REQUEST, (k: Uint8Array) => protobufService.createEnterDfuModeMessage(k)],
    ['createShutdownMessage', SHUTDOWN_SECONDS, (k: Uint8Array) => protobufService.createShutdownMessage(5, k)],
    ['createFactoryResetConfigMessage', FACTORY_RESET_CONFIG, (k: Uint8Array) => protobufService.createFactoryResetConfigMessage(k)],
    ['createFactoryResetDeviceMessage', FACTORY_RESET_DEVICE, (k: Uint8Array) => protobufService.createFactoryResetDeviceMessage(k)],
  ] as const)('%s carries the session passkey beside its field', (_name, field, build) => {
    const passkey = new Uint8Array([9, 8, 7, 6]);
    const fields = wireFields(build(passkey));
    expect([...fields.keys()].sort((a, b) => a - b)).toEqual([field, SESSION_PASSKEY].sort((a, b) => a - b));
    expect(Buffer.from(fields.get(SESSION_PASSKEY)!.value as Uint8Array)).toEqual(Buffer.from(passkey));
  });
});
