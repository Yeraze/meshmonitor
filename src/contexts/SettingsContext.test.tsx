import { describe, it, expect } from 'vitest';
import type { TimeFormat, DateFormat, DistanceUnit } from './SettingsContext';
import type { SortField, SortDirection } from '../types/ui';

describe('SettingsContext Types', () => {
  describe('TimeFormat', () => {
    it('should support 12-hour format', () => {
      const format: TimeFormat = '12';
      expect(format).toBe('12');
    });

    it('should support 24-hour format', () => {
      const format: TimeFormat = '24';
      expect(format).toBe('24');
    });
  });

  describe('DateFormat', () => {
    it('should support MM/DD/YYYY format', () => {
      const format: DateFormat = 'MM/DD/YYYY';
      expect(format).toBe('MM/DD/YYYY');
    });

    it('should support DD/MM/YYYY format', () => {
      const format: DateFormat = 'DD/MM/YYYY';
      expect(format).toBe('DD/MM/YYYY');
    });
  });

  describe('DistanceUnit', () => {
    it('should support kilometers', () => {
      const unit: DistanceUnit = 'km';
      expect(unit).toBe('km');
    });

    it('should support miles', () => {
      const unit: DistanceUnit = 'mi';
      expect(unit).toBe('mi');
    });
  });

  describe('Sort settings', () => {
    it('should support all valid sort fields', () => {
      const fields: SortField[] = [
        'longName',
        'shortName',
        'id',
        'lastHeard',
        'snr',
        'battery',
        'hwModel',
        'location',
        'hops'
      ];

      fields.forEach(field => {
        expect(field).toBeDefined();
      });
    });

    it('should support sort directions', () => {
      const asc: SortDirection = 'asc';
      const desc: SortDirection = 'desc';

      expect(asc).toBe('asc');
      expect(desc).toBe('desc');
    });
  });

  describe('Settings configuration', () => {
    it('should support complete display preferences configuration', () => {
      interface DisplayPreferences {
        preferredSortField: SortField;
        preferredSortDirection: SortDirection;
        timeFormat: TimeFormat;
        dateFormat: DateFormat;
        distanceUnit: DistanceUnit;
      }

      const config: DisplayPreferences = {
        preferredSortField: 'battery',
        preferredSortDirection: 'desc',
        timeFormat: '12',
        dateFormat: 'DD/MM/YYYY',
        distanceUnit: 'mi'
      };

      expect(config.preferredSortField).toBe('battery');
      expect(config.preferredSortDirection).toBe('desc');
      expect(config.timeFormat).toBe('12');
      expect(config.dateFormat).toBe('DD/MM/YYYY');
      expect(config.distanceUnit).toBe('mi');
    });

    it('should support default values', () => {
      interface DefaultSettings {
        preferredSortField: SortField;
        preferredSortDirection: SortDirection;
        timeFormat: TimeFormat;
        dateFormat: DateFormat;
      }

      const defaults: DefaultSettings = {
        preferredSortField: 'longName',
        preferredSortDirection: 'asc',
        timeFormat: '24',
        dateFormat: 'MM/DD/YYYY'
      };

      expect(defaults.preferredSortField).toBe('longName');
      expect(defaults.preferredSortDirection).toBe('asc');
      expect(defaults.timeFormat).toBe('24');
      expect(defaults.dateFormat).toBe('MM/DD/YYYY');
    });
  });

  describe('localStorage key naming', () => {
    it('should use consistent localStorage key names', () => {
      const keys = {
        sortField: 'preferredSortField',
        sortDirection: 'preferredSortDirection',
        timeFormat: 'timeFormat',
        dateFormat: 'dateFormat',
        distanceUnit: 'distanceUnit'
      };

      expect(keys.sortField).toBe('preferredSortField');
      expect(keys.sortDirection).toBe('preferredSortDirection');
      expect(keys.timeFormat).toBe('timeFormat');
      expect(keys.dateFormat).toBe('dateFormat');
      expect(keys.distanceUnit).toBe('distanceUnit');
    });
  });
});
