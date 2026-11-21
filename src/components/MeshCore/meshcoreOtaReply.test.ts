import { describe, it, expect } from 'vitest';
import { parseOtaReply } from './meshcoreOtaReply';

describe('parseOtaReply (#4943)', () => {
  it('reads the ESP32 reply', () => {
    expect(parseOtaReply({ ok: true, reply: 'Started: http://192.168.4.1/update' })).toEqual({
      kind: 'esp32',
      url: 'http://192.168.4.1/update',
    });
  });
  it('reads the nRF52 reply', () => {
    expect(parseOtaReply({ ok: true, reply: 'OK - mac: c4:aa:01:02:03:fe' })).toEqual({ kind: 'nrf52', mac: 'C4:AA:01:02:03:FE' });
  });
  it('reads Error as a board without OTA', () => {
    expect(parseOtaReply({ ok: true, reply: 'Error' })).toEqual({ kind: 'unsupported' });
  });
  it('keeps any other reply as text', () => {
    expect(parseOtaReply({ ok: true, reply: 'OK' })).toEqual({ kind: 'other', text: 'OK' });
  });
  it('a timeout is its own case (OTA may still have started)', () => {
    expect(parseOtaReply({ ok: false, error: 'no reply', code: 'CLI_TIMEOUT' })).toEqual({ kind: 'timeout' });
    expect(parseOtaReply({ ok: false, error: 'Not logged in' })).toEqual({ kind: 'error', text: 'Not logged in' });
  });
});
