/**
 * Recorded MeshCore repeater CLI reply strings (firmware 81dbae59, #6255).
 * `local` is the serial form (`  -> ` prefix); `remote` is the same reply as a
 * remote-admin response carries it (no prefix).
 */
export type FixtureKind = 'ok' | 'error' | 'unknown' | 'value';

export interface RepeaterReplyFixture {
  name: string;
  local: string;
  remote: string;
  kind: FixtureKind;
  /** Expected `value` for kind 'value'. */
  value?: string;
}

const PUB = 'ab'.repeat(32);

function f(name: string, text: string, kind: FixtureKind, value?: string): RepeaterReplyFixture {
  return { name, local: `  -> ${text}`, remote: text, kind, value };
}

export const REPEATER_REPLY_FIXTURES: RepeaterReplyFixture[] = [
  f('get advert.interval', '> 60', 'value', '60'),
  f('get repeat', '> on', 'value', 'on'),
  f('get empty guest password', '> ', 'value', ''),
  f('set ok', 'OK', 'ok'),
  f('set repeat off', 'OK - repeat is now OFF', 'ok'),
  f('time ok', 'OK - clock set: 14:05 - 2/10/2026 UTC', 'ok'),
  f('clear stats', '(OK - stats reset)', 'ok'),
  f('flood interval range', 'Error: interval range is 3-168 hours', 'error'),
  f('flood interval range old fw', 'Error: interval range is 3-48 hours', 'error'),
  f('af range', 'ERROR: af must be 0-9', 'error'),
  f('flood max', 'Error, max 64', 'error'),
  f('rxdelay', 'Error, must be 0-20', 'error'),
  f('clock backwards', '(ERR: clock cannot go backwards)', 'error'),
  f('bad key', 'Error, bad key', 'error'),
  f('bad key old fw', 'Error, invalid key', 'error'),
  f('unknown verb', '??: foo', 'unknown'),
  f('unknown config', 'unknown config: foo', 'unknown'),
  f('unknown command', 'Unknown command', 'unknown'),
  f('key restore new fw', `OK, reboot to apply! New pubkey: ${PUB}`, 'ok'),
  f('lowercase ok', 'ok', 'ok'),
  f('lowercase error', 'error', 'error'),
  // Secret echo: classified ok, but the classified text must never repeat it.
  f('admin password echo', 'password now: hunter2', 'ok'),
];

export const FIXTURE_NEW_PUBKEY = PUB;
