/**
 * Meshtastic firmware version parsing / comparison.
 *
 * CANONICAL, BROWSER-SAFE HELPER. This is the single implementation of
 * firmware version parsing in the codebase; `MeshtasticManager.parseFirmwareVersion()`
 * delegates here rather than reimplementing it.
 *
 * DO NOT ADD A NODE-ONLY IMPORT (`fs`, `path`, `os`, `crypto`, a database
 * module, a logger that reaches for one, …). Being importable from the browser
 * bundle is the entire reason this module exists as a separate file: the
 * pre-existing `compareVersions` in `src/server/utils/systemInfo.ts` cannot be
 * shared with the frontend precisely because that module imports `fs`. Keep
 * this file dependency-free and pure.
 *
 * `compareVersions` in `src/server/utils/systemInfo.ts` is deliberately NOT
 * folded in here — it is a different operation (a general N-segment
 * MeshMonitor *app* release comparator returning -1/0/1, which splits on
 * `[-.]` so `4.16.0-rc2` compares equal to `4.16.0`, and which throws on a
 * non-string by design; `rules.test.ts` depends on that throw).
 *
 * Firmware version strings look like `2.8.0.abcdef` (four segments, the last
 * being a short git hash), sometimes `2.7.11`, sometimes with a pre-release
 * suffix such as `2.8.0-rc1` or `2.8.0.abcdef-beta`. Only the numeric
 * major/minor/patch are meaningful for a feature gate, so everything after the
 * third numeric segment is ignored.
 *
 * FAIL-OPEN CONTRACT: an unparseable, empty, or missing version returns `null`
 * from `parseFirmwareVersion` and `false` from `isFirmwareAtLeast`. Callers
 * gating a user-facing "your node may be misconfigured" notice MUST treat
 * "unknown version" as "say nothing" — a false accusation is worse than silence.
 */

export interface ParsedFirmwareVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse the leading `major.minor[.patch]` out of a firmware version string.
 * Returns `null` when there is no leading numeric major version.
 */
export function parseFirmwareVersion(raw: string | null | undefined): ParsedFirmwareVersion | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^v/i, '');
  // Anchored: "abc2.8.0" is not a version. Minor/patch are optional so a bare
  // "3" parses as 3.0.0.
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(trimmed);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch };
}

/**
 * True when an already-parsed version is >= major.minor.patch.
 * False when `parsed` is `null` (fail open — see module docs).
 *
 * Split out from `isFirmwareAtLeast` so callers that parse with a different
 * (stricter) front end can still share the ordering logic — see
 * `MeshtasticManager.firmwareVersionAtLeast()`.
 */
export function isParsedFirmwareAtLeast(
  parsed: ParsedFirmwareVersion | null,
  major: number,
  minor = 0,
  patch = 0,
): boolean {
  if (!parsed) return false;
  if (parsed.major !== major) return parsed.major > major;
  if (parsed.minor !== minor) return parsed.minor > minor;
  return parsed.patch >= patch;
}

/**
 * True when `raw` parses to a firmware version >= major.minor.patch.
 * False when `raw` is missing or unparseable (fail open — see module docs).
 */
export function isFirmwareAtLeast(
  raw: string | null | undefined,
  major: number,
  minor = 0,
  patch = 0,
): boolean {
  return isParsedFirmwareAtLeast(parseFirmwareVersion(raw), major, minor, patch);
}
