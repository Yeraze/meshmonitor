/**
 * TAK team / role tables (#5613) against the pinned protobufs.
 *
 * `takConfig.ts` copies `enum Team` and `enum MemberRole` by hand because the
 * UI needs them without loading a .proto. This file is what keeps that copy
 * honest: every value, name and label is compared with
 * `protobufs/meshtastic/atak.proto`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TAK_ROLE_OPTIONS,
  TAK_TEAM_OPTIONS,
  normalizeTakConfig,
  takRoleName,
  takRoleToNumber,
  takTeamName,
  takTeamToNumber,
  validateTakConfigPayload,
} from './takConfig';

const protoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'protobufs', 'meshtastic');
const atakProto = readFileSync(join(protoDir, 'atak.proto'), 'utf8');
const moduleConfigProto = readFileSync(join(protoDir, 'module_config.proto'), 'utf8');
const adminProto = readFileSync(join(protoDir, 'admin.proto'), 'utf8');

/** `{ value, name, label }` for each entry of a top-level enum in atak.proto. */
function protoEnum(name: string) {
  const start = atakProto.indexOf(`\nenum ${name} {`);
  expect(start, `enum ${name} not found in atak.proto`).toBeGreaterThan(-1);
  const body = atakProto.slice(start, atakProto.indexOf('\n}', start));
  return Array.from(
    body.matchAll(/^\s*(\w+)\s*=\s*(\d+)\s*\[\(meshtastic\.enum_value_metadata\)\s*=\s*\{label:\s*"([^"]+)"\}\];/gm),
    (m) => ({ value: Number(m[2]), name: m[1], label: m[3] }),
  );
}

describe('takConfig — tables match the pinned protobufs', () => {
  it('TAK_TEAM_OPTIONS is enum Team, entry for entry', () => {
    const fromProto = protoEnum('Team');
    expect(fromProto.length).toBeGreaterThan(10); // guards the regex
    expect(TAK_TEAM_OPTIONS).toEqual(fromProto);
  });

  it('TAK_ROLE_OPTIONS is enum MemberRole, entry for entry', () => {
    const fromProto = protoEnum('MemberRole');
    expect(fromProto.length).toBeGreaterThan(5);
    expect(TAK_ROLE_OPTIONS).toEqual(fromProto);
  });

  it('TAKConfig is { Team team = 1; MemberRole role = 2 } at ModuleConfig oneof field 16', () => {
    expect(moduleConfigProto).toMatch(/TAKConfig tak = 16 \[\(meshtastic\.field_metadata\) = \{since_firmware: "2\.8\.0"\}\];/);
    const body = moduleConfigProto.slice(moduleConfigProto.indexOf('message TAKConfig {'));
    expect(body).toMatch(/Team team = 1 \[/);
    expect(body).toMatch(/MemberRole role = 2 \[/);
  });

  it('the admin module-config type is TAK_CONFIG = 15', () => {
    expect(adminProto).toMatch(/^\s*TAK_CONFIG = 15;/m);
  });
});

describe('takConfig — reading values', () => {
  it('reads numbers, proto names and digit strings', () => {
    expect(takTeamToNumber(5)).toBe(5);
    expect(takTeamToNumber('Red')).toBe(5);
    expect(takTeamToNumber('Dark_Blue')).toBe(8);
    expect(takTeamToNumber('8')).toBe(8);
    expect(takRoleToNumber(2)).toBe(2);
    expect(takRoleToNumber('TeamLead')).toBe(2);
    expect(takRoleToNumber('K9')).toBe(8);
  });

  it('absent or unknown input reads as the default (0)', () => {
    expect(takTeamToNumber(undefined)).toBe(0);
    expect(takTeamToNumber(null)).toBe(0);
    expect(takTeamToNumber(99)).toBe(0);
    expect(takTeamToNumber('Chartreuse')).toBe(0);
    expect(takRoleToNumber(-1)).toBe(0);
    // A DEVICE role name is not a TAK member role.
    expect(takRoleToNumber('ROUTER')).toBe(0);
  });

  it('names a number, and has no name for an unknown one', () => {
    expect(takTeamName(5)).toBe('Red');
    expect(takTeamName(0)).toBe('Unspecifed_Color');
    expect(takRoleName(2)).toBe('TeamLead');
    expect(takTeamName(99)).toBeUndefined();
    expect(takRoleName(99)).toBeUndefined();
  });

  it('normalizeTakConfig fills defaults for a missing config or missing fields', () => {
    expect(normalizeTakConfig(undefined)).toEqual({ team: 0, role: 0 });
    expect(normalizeTakConfig({})).toEqual({ team: 0, role: 0 });
    expect(normalizeTakConfig({ enabled: false })).toEqual({ team: 0, role: 0 });
    expect(normalizeTakConfig({ team: 'Green' })).toEqual({ team: 12, role: 0 });
    expect(normalizeTakConfig({ team: 3, role: 'Medic', extra: 1 })).toEqual({ team: 3, role: 5 });
  });
});

describe('takConfig — validateTakConfigPayload', () => {
  it('accepts every team and role the proto defines', () => {
    for (const team of TAK_TEAM_OPTIONS) {
      for (const role of TAK_ROLE_OPTIONS) {
        expect(validateTakConfigPayload({ team: team.value, role: role.value })).toBeNull();
      }
    }
  });

  it('accepts a partial config and proto names', () => {
    expect(validateTakConfigPayload({})).toBeNull();
    expect(validateTakConfigPayload({ team: 'Red' })).toBeNull();
    expect(validateTakConfigPayload({ role: 'HQ' })).toBeNull();
  });

  it.each([
    [{ team: 15 }, /team/],
    [{ team: -1 }, /team/],
    [{ team: 1.5 }, /team/],
    [{ team: 'Chartreuse' }, /team/],
    [{ team: true }, /team/],
    [{ role: 9 }, /role/],
    [{ role: 'ROUTER' }, /role/],
    [{ team: 5, role: {} }, /role/],
  ])('refuses %j', (config, message) => {
    expect(validateTakConfigPayload(config)).toMatch(message);
  });

  it.each([[null], [undefined], ['x'], [[1, 2]]])('refuses a non-object (%j)', (config) => {
    expect(validateTakConfigPayload(config)).toMatch(/object/);
  });
});
