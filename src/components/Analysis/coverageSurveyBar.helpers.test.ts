import { describe, it, expect } from 'vitest';
import {
  defaultSurveyName,
  mapSurveyErrorMessage,
  parseIntervalSecInput,
  sortSurveysNewestFirst,
} from './coverageSurveyBar.helpers';
import { ApiError } from '../../services/api';
import type { CoverageSurveyDto } from '../../types/coverage';

const t = ((key: string, fallback?: string) => fallback ?? key) as any;

describe('coverageSurveyBar.helpers', () => {
  describe('defaultSurveyName', () => {
    it('prefixes the sender label to the local date/time', () => {
      const nowMs = new Date('2026-09-25T15:04:00Z').getTime();
      const name = defaultSurveyName('Car-01', nowMs);
      expect(name.startsWith('Car-01 ')).toBe(true);
      expect(name.length).toBeGreaterThan('Car-01 '.length);
    });
  });

  describe('mapSurveyErrorMessage', () => {
    it('maps every documented survey error code (spec §2b.5)', () => {
      const codes = [
        'SURVEY_ALREADY_LIVE',
        'SURVEY_LIMIT_REACHED',
        'SENDER_NOT_VISIBLE',
        'FORBIDDEN',
        'SURVEY_NOT_FOUND',
        'SURVEY_NOT_LIVE',
        'INVALID_RECEIVERS',
        'INVALID_SURVEY',
      ];
      for (const code of codes) {
        const err = new ApiError('boom', 400, { code });
        const message = mapSurveyErrorMessage(t, err);
        expect(message).not.toBe('boom');
        expect(message.length).toBeGreaterThan(0);
      }
    });

    it('falls back to the raw error message for an unrecognised code', () => {
      const err = new ApiError('some server message', 500, { code: 'SOMETHING_ELSE' });
      expect(mapSurveyErrorMessage(t, err)).toBe('some server message');
    });

    it('falls back to the raw error message for a non-ApiError', () => {
      const err = new Error('network down');
      expect(mapSurveyErrorMessage(t, err)).toBe('network down');
    });
  });

  describe('parseIntervalSecInput', () => {
    it('blank input clears the interval (null)', () => {
      expect(parseIntervalSecInput('')).toBeNull();
      expect(parseIntervalSecInput('   ')).toBeNull();
    });

    it('a valid positive integer parses through', () => {
      expect(parseIntervalSecInput('30')).toBe(30);
      expect(parseIntervalSecInput(' 900 ')).toBe(900);
    });

    it('non-numeric, zero, negative, or fractional input is invalid (undefined)', () => {
      expect(parseIntervalSecInput('abc')).toBeUndefined();
      expect(parseIntervalSecInput('0')).toBeUndefined();
      expect(parseIntervalSecInput('-5')).toBeUndefined();
      expect(parseIntervalSecInput('12.5')).toBeUndefined();
    });
  });

  describe('sortSurveysNewestFirst', () => {
    function makeSurvey(id: string, startAt: number): CoverageSurveyDto {
      return {
        id, name: id, senderId: '!aaaaaaaa', startAt, endAt: null, receivers: null,
        intervalSec: null, notes: null, createdAt: startAt, updatedAt: startAt,
        effectiveEndAt: startAt, isLive: true, canEdit: true, createdByMe: true,
      };
    }

    it('sorts by startAt descending without mutating the input', () => {
      const input = [makeSurvey('a', 100), makeSurvey('b', 300), makeSurvey('c', 200)];
      const sorted = sortSurveysNewestFirst(input);
      expect(sorted.map((s) => s.id)).toEqual(['b', 'c', 'a']);
      expect(input.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    });
  });
});
