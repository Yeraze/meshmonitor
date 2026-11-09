/**
 * P8a #6257 WP1 — Companion commands on the native backend: BLE PIN (37),
 * factory reset (51), multi_acks (SetOtherParams byte 5), and the shared
 * SetOtherParams writer that keeps the raw manual_add_contacts byte.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { MeshCoreNativeBackend, __setMeshCoreModule } from './meshcoreNativeBackend.js';
import { SERIAL_ONLY_BRIDGE_COMMANDS, isRfBridgeCommand } from './constants/meshcoreTx.js';

const ResponseCodes = { Ok: 0, Err: 1, SelfInfo: 5, Sent: 6 };
const PushCodes = { Advert: 0x80, PathUpdated: 0x81, MsgWaiting: 0x83, NewAdvert: 0x8a, StatusResponse: 0x84 };

class FrameMock extends EventEmitter {
  public frames: number[][] = [];
  /** 'ok' | 'err' | 'none' (silence) | 'disconnect' */
  public reply: 'ok' | 'err' | 'none' | 'disconnect' = 'ok';
  /** Does the firmware keep byte 5 of SetOtherParams? (false = v1.7.3 behaviour) */
  public keepsMultiAcks = true;
  public selfInfo: any = {
    type: 1, txPower: 22, maxTxPower: 22,
    publicKey: Uint8Array.from(new Array(32).fill(0)),
    advLat: 0, advLon: 0,
    manualAddContacts: 0b0000_0110, // bit 0 clear, per-type auto-add bits set
    telemetryModeBase: 1, telemetryModeLoc: 2, telemetryModeEnv: 0,
    advLocPolicy: 1,
    multiAcks: 0,
    radioFreq: 915525, radioBw: 62500, radioSf: 11, radioCr: 5,
    name: 'TestNode',
  };
  async connect() { setTimeout(() => this.emit(ResponseCodes.SelfInfo, this.selfInfo), 1); }
  async close() {}
  async getSelfInfo() { return { ...this.selfInfo }; }
  sendToRadioFrame(bytes: Uint8Array) {
    const f = Array.from(bytes);
    this.frames.push(f);
    if (f[0] === 38) {
      this.selfInfo.manualAddContacts = f[1];
      if (f.length >= 5 && this.keepsMultiAcks) this.selfInfo.multiAcks = f[4];
    }
    setTimeout(() => {
      if (this.reply === 'ok') this.emit(ResponseCodes.Ok, {});
      else if (this.reply === 'err') this.emit(ResponseCodes.Err, {});
      else if (this.reply === 'disconnect') this.emit('disconnected');
    }, 1);
  }
}

function install(): { current: FrameMock | null } {
  const ref: { current: FrameMock | null } = { current: null };
  class Tracked extends FrameMock {
    constructor(_p: string) { super(); ref.current = this; }
  }
  __setMeshCoreModule({
    NodeJSSerialConnection: Tracked as any,
    TCPConnection: Tracked as any,
    Constants: { ResponseCodes, PushCodes } as any,
  });
  return ref;
}

async function make() {
  const b = new MeshCoreNativeBackend('src-1', { connectionType: 'serial', serialPort: '/dev/ttyUSB0' });
  await b.connect();
  return b;
}

describe('MeshCoreNativeBackend Companion commands (P8a #6257)', () => {
  let ref: { current: FrameMock | null };
  beforeEach(() => { ref = install(); });
  afterEach(() => { __setMeshCoreModule(null); });

  it('classifies the new commands as serial-only (allowed in receive-only)', () => {
    for (const c of ['set_device_pin', 'factory_reset', 'set_multi_acks']) {
      expect(SERIAL_ONLY_BRIDGE_COMMANDS.has(c)).toBe(true);
      expect(isRfBridgeCommand(c)).toBe(false);
    }
  });

  describe('set_device_pin', () => {
    it('sends [37][u32 LE pin]', async () => {
      const b = await make();
      const r = await b.sendCommand('set_device_pin', { pin: 123456 });
      expect(r.success).toBe(true);
      expect(ref.current!.frames).toEqual([[37, 0x40, 0xe2, 0x01, 0x00]]);
    });
    it('accepts 0 (firmware default)', async () => {
      const b = await make();
      expect((await b.sendCommand('set_device_pin', { pin: 0 })).success).toBe(true);
      expect(ref.current!.frames).toEqual([[37, 0, 0, 0, 0]]);
    });
    it.each([123, 99999, 1000000, 1234567, 1.5])('rejects %s without sending', async (pin) => {
      const b = await make();
      expect((await b.sendCommand('set_device_pin', { pin })).success).toBe(false);
      expect(ref.current!.frames).toEqual([]);
    });
    it('fails when the device answers ERR', async () => {
      const b = await make();
      ref.current!.reply = 'err';
      const r = await b.sendCommand('set_device_pin', { pin: 123456 });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/rejected the BLE PIN/);
    });
  });

  describe('factory_reset', () => {
    const FRAME = [51, 0x72, 0x65, 0x73, 0x65, 0x74];
    it('sends [51]"reset" and resolves on OK', async () => {
      const b = await make();
      const r = await b.sendCommand('factory_reset', {});
      expect(r).toMatchObject({ success: true, data: { how: 'ok' } });
      expect(ref.current!.frames).toEqual([FRAME]);
    });
    it('resolves when the device disconnects instead of answering', async () => {
      const b = await make();
      ref.current!.reply = 'disconnect';
      const r = await b.sendCommand('factory_reset', {});
      expect(r).toMatchObject({ success: true, data: { how: 'disconnected' } });
    });
    it('resolves after 3 s of silence', async () => {
      const b = await make();
      ref.current!.reply = 'none';
      const t0 = Date.now();
      const r = await b.sendCommand('factory_reset', {});
      expect(r).toMatchObject({ success: true, data: { how: 'silence' } });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    }, 10_000);
    it('fails on ERR', async () => {
      const b = await make();
      ref.current!.reply = 'err';
      const r = await b.sendCommand('factory_reset', {});
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/rejected the factory reset/);
    });
  });

  describe('SetOtherParams writer', () => {
    it('set_multi_acks sends a 5-byte frame, keeping the raw manual byte and telemetry', async () => {
      const b = await make();
      const r = await b.sendCommand('set_multi_acks', { value: 1 });
      expect(r).toMatchObject({ success: true, data: { multi_acks: 1, requested: 1 } });
      // manual 0b110 kept, telemetry 1|2<<2 = 9, advLoc 1, multi_acks 1
      expect(ref.current!.frames).toEqual([[38, 0b0000_0110, 9, 1, 1]]);
    });
    it('set_multi_acks reports the readback when the firmware ignores byte 5', async () => {
      const b = await make();
      ref.current!.keepsMultiAcks = false;
      const r = await b.sendCommand('set_multi_acks', { value: 1 });
      expect(r.success).toBe(true);
      expect((r.data as any).multi_acks).toBe(0);
    });
    it('set_multi_acks rejects out-of-range values', async () => {
      const b = await make();
      expect((await b.sendCommand('set_multi_acks', { value: 300 })).success).toBe(false);
      expect(ref.current!.frames).toEqual([]);
    });
    it('set_auto_add_contacts keeps the high manual bits and sends 4 bytes', async () => {
      const b = await make();
      ref.current!.selfInfo.manualAddContacts = 0b0000_1110;
      const r = await b.sendCommand('set_auto_add_contacts', { enabled: false });
      expect(r.success).toBe(true);
      expect(ref.current!.frames).toEqual([[38, 0b0000_1111, 9, 1]]);
    });
    it('set_other_params writes only bit 0 itself and keeps the per-type bits', async () => {
      const b = await make();
      ref.current!.selfInfo.manualAddContacts = 0b0000_1110;
      const r = await b.sendCommand('set_other_params', {
        manualAddContacts: 1, telemetryModeBase: 2, telemetryModeLoc: 1, telemetryModeEnv: 0, advLocPolicy: 1,
      });
      expect(r.success).toBe(true);
      expect(ref.current!.frames).toEqual([[38, 0b0000_1111, 2 | (1 << 2), 1]]);
      const clear = await b.sendCommand('set_other_params', {
        manualAddContacts: 0, telemetryModeBase: 0, telemetryModeLoc: 0, telemetryModeEnv: 0, advLocPolicy: 0,
      });
      expect(clear.success).toBe(true);
      expect(ref.current!.frames[1]).toEqual([38, 0b0000_1110, 0, 0]);
    });
    it('a 4-byte frame never carries multi_acks', async () => {
      const b = await make();
      await b.sendCommand('set_auto_add_contacts', { enabled: true });
      expect(ref.current!.frames[0]).toHaveLength(4);
    });

    describe('set_other_params_raw (P16 #6285 restore)', () => {
      it('is serial-only (allowed in receive-only)', () => {
        expect(SERIAL_ONLY_BRIDGE_COMMANDS.has('set_other_params_raw')).toBe(true);
        expect(isRfBridgeCommand('set_other_params_raw')).toBe(false);
      });
      it('writes byte 1 verbatim (high bits kept) as a 4-byte frame without multi_acks', async () => {
        const b = await make();
        const r = await b.sendCommand('set_other_params_raw', {
          manualAddContactsRaw: 0b0001_1110, telemetryModeBase: 2, telemetryModeLoc: 1, telemetryModeEnv: 0, advLocPolicy: 3,
        });
        expect(r).toMatchObject({ success: true, data: { multi_acks: null } });
        expect(ref.current!.frames).toEqual([[38, 0b0001_1110, 2 | (1 << 2), 3]]);
      });
      it('ignores the device\'s current manual byte (unlike set_other_params)', async () => {
        const b = await make();
        ref.current!.selfInfo.manualAddContacts = 0b1111_0000;
        await b.sendCommand('set_other_params_raw', {
          manualAddContactsRaw: 0b0000_0001, telemetryModeBase: 0, telemetryModeLoc: 0, telemetryModeEnv: 0, advLocPolicy: 0,
        });
        expect(ref.current!.frames[0]).toEqual([38, 0b0000_0001, 0, 0]);
      });
      it('adds the 5th byte only when multiAcks is given, and reads it back', async () => {
        const b = await make();
        const r = await b.sendCommand('set_other_params_raw', {
          manualAddContactsRaw: 6, telemetryModeBase: 1, telemetryModeLoc: 2, telemetryModeEnv: 0, advLocPolicy: 1, multiAcks: 1,
        });
        expect(ref.current!.frames).toEqual([[38, 6, 9, 1, 1]]);
        expect(r).toMatchObject({ success: true, data: { multi_acks: 1 } });
      });
      it('reports the readback when the firmware ignores byte 5', async () => {
        const b = await make();
        ref.current!.keepsMultiAcks = false;
        const r = await b.sendCommand('set_other_params_raw', {
          manualAddContactsRaw: 6, telemetryModeBase: 1, telemetryModeLoc: 2, telemetryModeEnv: 0, advLocPolicy: 1, multiAcks: 1,
        });
        expect((r.data as { multi_acks: number }).multi_acks).toBe(0);
      });
      it.each([2, 255, -1, 1.5])('rejects multiAcks %s without sending', async (multiAcks) => {
        const b = await make();
        const r = await b.sendCommand('set_other_params_raw', {
          manualAddContactsRaw: 6, telemetryModeBase: 0, telemetryModeLoc: 0, telemetryModeEnv: 0, advLocPolicy: 0, multiAcks,
        });
        expect(r.success).toBe(false);
        expect(ref.current!.frames).toEqual([]);
      });
      it.each([256, -1, 1.5])('rejects manual byte %s without sending', async (manualAddContactsRaw) => {
        const b = await make();
        const r = await b.sendCommand('set_other_params_raw', {
          manualAddContactsRaw, telemetryModeBase: 0, telemetryModeLoc: 0, telemetryModeEnv: 0, advLocPolicy: 0,
        });
        expect(r.success).toBe(false);
        expect(ref.current!.frames).toEqual([]);
      });
    });
  });
});
