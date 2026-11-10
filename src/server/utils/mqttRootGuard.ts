/**
 * Server-side check of an MQTT root topic on save (#6338).
 *
 * Policy (maintainer decision): reject only when the root changes. A root
 * that is resent unchanged passes, so an unrelated edit (firmware replaces the
 * whole MQTT struct, so every save resends the root) still works on a node or
 * preset that already holds a bad root. An unknown previous value
 * (`prev === undefined`) counts as a change. Restores do not use this guard;
 * they stay verbatim and only log a warning.
 */
import type { Response } from 'express';
import { fail } from './apiResponse.js';
import { validateMqttRoot, MAX_ROOT_BYTES, type MqttRootErrorCode } from '../../utils/mqttRootTopic.js';

export type MqttRootGuardReason = MqttRootErrorCode | 'NOT_STRING' | 'EMPTY';

export interface MqttRootGuardError {
  code: 'INVALID_MQTT_ROOT';
  reason: MqttRootGuardReason;
  message: string;
}

/** English text, copied from en.json `mqtt_root_finder.validation.*`. */
export const MQTT_ROOT_REASON_MESSAGES: Record<MqttRootGuardReason, string> = {
  WHITESPACE: 'A root cannot contain spaces.',
  CONTROL: 'A root cannot contain control characters.',
  INVISIBLE: 'A root cannot contain invisible characters.',
  WILDCARD: 'A root cannot contain + or #.',
  SLASH: 'A root cannot start or end with / or have an empty part.',
  ENDS_WITH_2: 'A root cannot end in /2.',
  TOO_LONG: `A root can be at most ${MAX_ROOT_BYTES} bytes.`,
  NOT_STRING: 'A root must be text.',
  EMPTY: 'A root cannot be empty.',
};

function guardError(reason: MqttRootGuardReason): MqttRootGuardError {
  return { code: 'INVALID_MQTT_ROOT', reason, message: MQTT_ROOT_REASON_MESSAGES[reason] };
}

/**
 * Check a root about to be saved.
 *
 * @param next the root in the request (`undefined` = not sent, which is valid)
 * @param prev the root saved now, or `undefined` when unknown
 * @param opts.allowEmpty false where `''` is not a usable root (the embedded
 *   broker's topic prefix); defaults to true (`''` = firmware default on a device)
 * @returns null when the save may go ahead
 */
export function checkMqttRootSave(
  next: unknown,
  prev: unknown,
  opts: { allowEmpty?: boolean } = {},
): MqttRootGuardError | null {
  if (next === undefined) return null;
  if (typeof next !== 'string') return guardError('NOT_STRING');
  if (prev !== undefined && next === prev) return null;
  if (next === '') return opts.allowEmpty === false ? guardError('EMPTY') : null;
  const result = validateMqttRoot(next);
  return result.ok ? null : guardError(result.code);
}

/** Validate a root a restore writes verbatim; returns the reason when it is bad. */
export function restoredMqttRootProblem(root: unknown): MqttRootGuardReason | null {
  const err = checkMqttRootSave(root, undefined);
  return err ? err.reason : null;
}

/** Send the shared 400 for a refused root: `{ success:false, code:'INVALID_MQTT_ROOT', error, field, reason }`. */
export function failInvalidMqttRoot(res: Response, err: MqttRootGuardError, field: 'root' | 'rootTopic'): Response {
  return fail(res, 400, err.code, err.message, { field, reason: err.reason });
}
