/**
 * Shared `filterNameRegex` save-time validation for the auto-traceroute and
 * remote-LocalStats node-filter endpoints (#3934).
 *
 * `filterNameRegex` is validated with RE2 (`compileUserRegex`), which — unlike
 * the browser's native `RegExp` the client validates with — rejects lookaround
 * and backreferences (`(?=`, `(?<=`, `(?!`, `(?<!`, `\1`, …). Without the guard
 * here, an install that previously persisted such a pattern is permanently
 * stuck: the settings form re-POSTs the stored regex on every save, so the whole
 * request 400s and the user can't even toggle the filter/automation OFF (the
 * same failure mode #3806 fixed for auto-ack, never ported to these endpoints).
 *
 * We therefore only hard-validate when the regex will actually be applied (the
 * automation AND its regex sub-filter are enabled) OR the incoming pattern
 * differs from the stored one. Disabling the automation/filter — or re-saving an
 * unchanged bad pattern — is always allowed, so the section can be recovered.
 * The ReDoS length/complexity caps ride along on the same condition.
 */
import { compileUserRegex } from '../../utils/safeRegex.js';

// Length cap + catastrophic-backtracking pattern check (ReDoS guard).
const REDOS_PATTERN = /(\.\*){2,}|(\+.*\+)|(\*.*\*)|(\{[0-9]{3,}\})|(\{[0-9]+,\})/;
const MAX_REGEX_LENGTH = 200;

export interface FilterNameRegexOptions {
  /** The regex will actually be applied after this save (automation && regex sub-filter both enabled). */
  willBeApplied: boolean;
  /** The currently-persisted pattern, to detect an unchanged re-save. */
  storedRegex: string;
}

/**
 * Validate an incoming `filterNameRegex` for a save.
 * @returns the pattern to persist, or an `error` string (caller → HTTP 400).
 */
export function validateFilterNameRegexOnSave(
  incoming: string,
  opts: FilterNameRegexOptions,
): { regex: string } | { error: string } {
  const changed = incoming !== opts.storedRegex;
  if (opts.willBeApplied || changed) {
    if (incoming.length > MAX_REGEX_LENGTH) {
      return { error: `filterNameRegex too long (max ${MAX_REGEX_LENGTH} characters).` };
    }
    if (REDOS_PATTERN.test(incoming)) {
      return { error: 'filterNameRegex too complex or may cause performance issues.' };
    }
    try {
      compileUserRegex(incoming);
    } catch {
      return { error: 'Invalid filterNameRegex value. Must be a valid regular expression.' };
    }
  }
  return { regex: incoming };
}
