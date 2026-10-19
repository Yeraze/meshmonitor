import { describe, it, expect } from 'vitest';
import {
  REDACTED,
  redactCliCommand,
  redactCliReply,
  extractCliSecret,
  isSecretReadCommand,
} from './meshcoreCliRedact.js';

describe('redactCliCommand (#5892)', () => {
  it.each([
    ['password hunter2', `password ${REDACTED}`],
    ['PASSWORD hunter2', `PASSWORD ${REDACTED}`],
    ['password  two words', `password ${REDACTED}`],
    ['passwd hunter2', `passwd ${REDACTED}`],
    ['login hunter2', `login ${REDACTED}`],
    ['set guest.password guestpw', `set guest.password ${REDACTED}`],
    ['set admin.password adminpw', `set admin.password ${REDACTED}`],
    ['set password adminpw', `set password ${REDACTED}`],
    ['SET Guest.Password guestpw', `SET Guest.Password ${REDACTED}`],
    ['set prv.key 0123456789abcdef', `set prv.key ${REDACTED}`],
    ['set bridge.secret s3cret', `set bridge.secret ${REDACTED}`],
    ['set wifi.password p@ss word', `set wifi.password ${REDACTED}`],
    ['set wifi.pwd p@ss', `set wifi.pwd ${REDACTED}`],
    ['set mqtt.psk abc', `set mqtt.psk ${REDACTED}`],
    ['set key abc', `set key ${REDACTED}`],
    ['  set guest.password x', `  set guest.password ${REDACTED}`],
  ])('masks %s', (input, expected) => {
    expect(redactCliCommand(input)).toBe(expected);
    expect(redactCliCommand(input)).not.toMatch(/hunter2|guestpw|adminpw|0123456789abcdef|s3cret|p@ss/);
  });

  it.each([
    'ver',
    'stats',
    'neighbors',
    'clock sync',
    'get guest.password',
    'get prv.key',
    'set name My Repeater',
    'set radio 869.525,250,11,5',
    'set tx 22',
    'set af 1',
    'set advert.interval 240',
    'set keyboard.layout us', // `keyboard.layout` is not a secret key
    'setperm 0123abcd 3',
    'password',
    'set guest.password',
    'reboot',
    '',
  ])('leaves %j alone', (input) => {
    expect(redactCliCommand(input)).toBe(input);
  });

  it('passes non-strings through', () => {
    expect(redactCliCommand(undefined as unknown as string)).toBeUndefined();
  });
});

describe('extractCliSecret', () => {
  it('returns the value a secret command carries', () => {
    expect(extractCliSecret('password hunter2')).toBe('hunter2');
    expect(extractCliSecret('set guest.password guestpw')).toBe('guestpw');
    expect(extractCliSecret('set prv.key abcd')).toBe('abcd');
  });
  it('returns null for everything else', () => {
    expect(extractCliSecret('set name foo')).toBeNull();
    expect(extractCliSecret('get prv.key')).toBeNull();
    expect(extractCliSecret('password')).toBeNull();
    expect(extractCliSecret('')).toBeNull();
  });
});

describe('isSecretReadCommand', () => {
  it.each(['get prv.key', 'get guest.password', 'GET admin.password', 'get wifi.pwd', 'get bridge.secret'])('%s reads a secret', (c) => {
    expect(isSecretReadCommand(c)).toBe(true);
  });
  it.each(['get name', 'get radio', 'get tx', 'set prv.key x', 'ver', 'get'])('%s does not', (c) => {
    expect(isSecretReadCommand(c)).toBe(false);
  });
});

describe('redactCliReply', () => {
  it('masks the value a secret read returns after the prompt', () => {
    expect(redactCliReply('get guest.password', '> guestpw')).toBe(`> ${REDACTED}`);
    expect(redactCliReply('get prv.key', '  > 0123abcd')).toBe(`  > ${REDACTED}`);
  });

  it('masks a secret read with no prompt', () => {
    expect(redactCliReply('get prv.key', '0123abcd')).toBe(REDACTED);
  });

  it('keeps an error reply to a secret read', () => {
    expect(redactCliReply('get prv.key', 'Error: unknown config')).toBe('Error: unknown config');
    expect(redactCliReply('get prv.key', '> ')).toBe('> ');
  });

  it('masks an echo of a written secret', () => {
    expect(redactCliReply('password hunter2', 'password now: hunter2')).toBe(`password now: ${REDACTED}`);
    expect(redactCliReply('set guest.password gpw', 'OK - gpw set; gpw')).toBe(`OK - ${REDACTED} set; ${REDACTED}`);
  });

  it('leaves ordinary replies alone', () => {
    expect(redactCliReply('ver', 'v1.9.0')).toBe('v1.9.0');
    expect(redactCliReply('set guest.password gpw', 'OK')).toBe('OK');
    expect(redactCliReply('get name', '> Hilltop')).toBe('> Hilltop');
  });

  it('handles null and empty', () => {
    expect(redactCliReply('ver', null)).toBeNull();
    expect(redactCliReply('ver', undefined)).toBeNull();
    expect(redactCliReply('get prv.key', '')).toBe('');
  });
});
