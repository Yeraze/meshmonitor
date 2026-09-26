/**
 * Pure helpers for `CoverageSurveyBar.tsx` (#5277 P4b WP3,
 * COVERAGE_P4_SPEC.md §2b.7). Split out of the component file (no logic
 * beyond JSX wiring belongs in a `.tsx`), so these can be unit-tested
 * directly.
 */
import type { TFunction } from 'i18next';
import { ApiError } from '../../services/api';
import type { CoverageSurveyDto } from '../../types/coverage';

/** `"<sender name> <local date time>"` — the default name for a new survey
 *  (Start or Save-as), per spec §2b.7. `senderLabel` is whatever the caller
 *  already shows for the sender (name, or a formatted id when unnamed). */
export function defaultSurveyName(senderLabel: string, nowMs: number): string {
  return `${senderLabel} ${new Date(nowMs).toLocaleString()}`;
}

/**
 * Maps a survey API error to a translated message (spec §2b.5's error
 * codes). Falls back to the raw error message for anything unrecognised —
 * same idiom as `MqttViolationsReport.tsx`'s `mapErrorMessage`.
 */
export function mapSurveyErrorMessage(t: TFunction, error: unknown): string {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case 'SURVEY_ALREADY_LIVE':
      return t('analysis.coverage.survey_error_already_live', 'This sender already has a live survey running.');
    case 'SURVEY_LIMIT_REACHED':
      return t(
        'analysis.coverage.survey_error_limit_reached',
        'Survey limit reached — delete an old survey before starting a new one.',
      );
    case 'SENDER_NOT_VISIBLE':
      return t('analysis.coverage.survey_error_sender_not_visible', "You don't have access to this sender.");
    case 'FORBIDDEN':
      return t('analysis.coverage.survey_error_forbidden', 'Only the survey creator or an admin can do that.');
    case 'SURVEY_NOT_FOUND':
      return t('analysis.coverage.survey_error_not_found', 'That survey no longer exists.');
    case 'SURVEY_NOT_LIVE':
      return t('analysis.coverage.survey_error_not_live', 'That survey is not live.');
    case 'INVALID_RECEIVERS':
      return t(
        'analysis.coverage.survey_error_invalid_receivers',
        'The current receiver filter could not be saved with this survey.',
      );
    case 'INVALID_SURVEY':
      return t('analysis.coverage.survey_error_invalid', 'Check the survey name, window and interval.');
    default:
      return (error as Error)?.message ?? String(error);
  }
}

/** Parsed `intervalSec` form value: blank -> `null` (clear/unset), a bad
 *  number -> `undefined` (caller shows a validation error and blocks
 *  submit). A valid value is clamped by the server (15-3600s); this only
 *  screens out obviously-wrong client input (blank, non-numeric, negative). */
export function parseIntervalSecInput(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/** Options for the survey `SearchableSelect`, sorted newest-`startAt` first
 *  (matches `listSurveys()`'s server-side order, §2b.4). */
export function sortSurveysNewestFirst(surveys: CoverageSurveyDto[]): CoverageSurveyDto[] {
  return [...surveys].sort((a, b) => b.startAt - a.startAt);
}
