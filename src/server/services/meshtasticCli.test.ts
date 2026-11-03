import { describe, it, expect } from 'vitest';
import {
  parseCliArgs,
  buildCliArgv,
  isDangerCommand,
  isValidMeshtasticNodeId,
  redactCliArgsForAudit,
  findReservedFlag,
  CliArgParseError,
  MAX_CLI_ARG_COUNT,
  REDACTED,
} from './meshtasticCli.js';

describe('parseCliArgs', () => {
  it('splits plain args on whitespace', () => {
    expect(parseCliArgs('--set device.role CLIENT')).toEqual(['--set', 'device.role', 'CLIENT']);
  });

  it('keeps a double-quoted value as one token', () => {
    expect(parseCliArgs('--set-owner "My Node Name"')).toEqual(['--set-owner', 'My Node Name']);
  });

  it('keeps a single-quoted value as one token', () => {
    expect(parseCliArgs("--set-owner 'My Node'")).toEqual(['--set-owner', 'My Node']);
  });

  it('treats shell metacharacters as literal tokens (no shell)', () => {
    expect(parseCliArgs('--set-owner "a; rm -rf / && echo $(whoami)"')).toEqual([
      '--set-owner',
      'a; rm -rf / && echo $(whoami)',
    ]);
  });

  it('honours backslash escaping outside quotes', () => {
    expect(parseCliArgs('--name a\\ b')).toEqual(['--name', 'a b']);
  });

  it('throws on an unterminated quote', () => {
    expect(() => parseCliArgs('--set-owner "unterminated')).toThrow(CliArgParseError);
  });

  it('throws on empty input', () => {
    expect(() => parseCliArgs('   ')).toThrow(CliArgParseError);
  });

  it('throws when too many args', () => {
    const many = Array.from({ length: MAX_CLI_ARG_COUNT + 1 }, (_, i) => `a${i}`).join(' ');
    expect(() => parseCliArgs(many)).toThrow(/Too many arguments/);
  });

  it('throws when the arg string is too long', () => {
    expect(() => parseCliArgs('x'.repeat(5000))).toThrow(/too long/i);
  });
});

describe('isDangerCommand', () => {
  it.each([
    '--reboot',
    '--reboot-ota',
    '--factory-reset',
    '--factory-reset-device',
    '--shutdown',
    'reboot',
    '--reboot 10',
    '--reset-nodedb',
    '--remove-node !aabbccdd',
    '--enter-dfu',
  ])('flags %s as destructive', (cmd) => {
    expect(isDangerCommand(cmd)).toBe(true);
  });

  it.each([
    '--info',
    '--set device.role CLIENT',
    '--get lora.region',
    '--nodes',
    '--get reboot.interval',
  ])('does not flag %s', (cmd) => {
    expect(isDangerCommand(cmd)).toBe(false);
  });
});

describe('findReservedFlag', () => {
  it.each(['--host', '--port', '--dest', '--host=1.2.3.4', '--DEST', '--port=4403'])(
    'rejects reserved flag %s',
    (flag) => {
      expect(findReservedFlag(['--info', flag, 'x'])).toBe(flag);
    },
  );
  it('returns null when no reserved flag is present', () => {
    expect(findReservedFlag(['--set', 'device.role', 'CLIENT'])).toBeNull();
    // A value that merely looks like a host is fine; only the flag itself is reserved.
    expect(findReservedFlag(['--set-owner', '--host-ish-name'])).toBeNull();
  });
});

describe('isValidMeshtasticNodeId', () => {
  it('accepts a valid !xxxxxxxx id', () => {
    expect(isValidMeshtasticNodeId('!aabbccdd')).toBe(true);
    expect(isValidMeshtasticNodeId('!AABBCCDD')).toBe(true);
  });
  it('rejects bad ids', () => {
    expect(isValidMeshtasticNodeId('aabbccdd')).toBe(false);
    expect(isValidMeshtasticNodeId('!xyz')).toBe(false);
    expect(isValidMeshtasticNodeId('!aabbccddee')).toBe(false);
    expect(isValidMeshtasticNodeId(42)).toBe(false);
  });
});

describe('buildCliArgv', () => {
  it('prepends host/port/dest ahead of user args', () => {
    expect(buildCliArgv({ host: '127.0.0.1', port: 4403 }, '!aabbccdd', ['--info'])).toEqual([
      '--host', '127.0.0.1', '--port', '4403', '--dest', '!aabbccdd', '--info',
    ]);
  });
});

describe('redactCliArgsForAudit', () => {
  it('masks a secret config value after --set', () => {
    expect(redactCliArgsForAudit(['--set', 'security.admin_key', 'SECRET=='])).toBe(`--set security.admin_key ${REDACTED}`);
  });
  it('masks a channel psk after --ch-set', () => {
    expect(redactCliArgsForAudit(['--ch-set', 'psk', 'base64key', '--ch-index', '0'])).toBe(
      `--ch-set psk ${REDACTED} --ch-index 0`,
    );
  });
  it('masks the value after --seturl', () => {
    expect(redactCliArgsForAudit(['--seturl', 'https://meshtastic.org/e/#abc'])).toBe(`--seturl ${REDACTED}`);
  });
  it('leaves non-secret args untouched', () => {
    expect(redactCliArgsForAudit(['--set', 'device.role', 'CLIENT'])).toBe('--set device.role CLIENT');
  });
});
