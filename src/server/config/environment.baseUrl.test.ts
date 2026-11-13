/**
 * BASE_URL Environment Configuration Tests
 *
 * Drives the real loadEnvironmentConfig() with process.env.BASE_URL set, and
 * checks the normalised value plus the baseUrlProvided flag. Replaces the old
 * src/server/baseurl.test.ts, which tested a copy of this logic (#6379).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadEnvironmentConfig } from './environment.js';
import { logger } from '../../utils/logger.js';

function load(value: string | undefined) {
  if (value === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = value;
  }
  const config = loadEnvironmentConfig();
  return { baseUrl: config.baseUrl, provided: config.baseUrlProvided };
}

describe('BASE_URL Environment Configuration', () => {
  const original = process.env.BASE_URL;

  afterEach(() => {
    if (original !== undefined) {
      process.env.BASE_URL = original;
    } else {
      delete process.env.BASE_URL;
    }
    vi.restoreAllMocks();
  });

  describe('empty and root paths', () => {
    it('is empty and not provided when BASE_URL is unset', () => {
      expect(load(undefined)).toEqual({ baseUrl: '', provided: false });
    });

    it('is empty but provided when BASE_URL is an empty string', () => {
      expect(load('')).toEqual({ baseUrl: '', provided: true });
    });

    it('treats a single slash as the root (empty)', () => {
      expect(load('/')).toEqual({ baseUrl: '', provided: true });
    });
  });

  describe('normalisation', () => {
    it('keeps a valid single-segment path', () => {
      expect(load('/meshmonitor')).toEqual({ baseUrl: '/meshmonitor', provided: true });
    });

    it('adds a missing leading slash', () => {
      expect(load('meshmonitor').baseUrl).toBe('/meshmonitor');
    });

    it('removes a trailing slash', () => {
      expect(load('/meshmonitor/').baseUrl).toBe('/meshmonitor');
    });

    it('adds the leading slash and removes the trailing slash together', () => {
      expect(load('mesh/monitor/').baseUrl).toBe('/mesh/monitor');
    });

    it('keeps multi-segment paths', () => {
      expect(load('/a/b').baseUrl).toBe('/a/b');
      expect(load('/org/team/mesh-monitor_2').baseUrl).toBe('/org/team/mesh-monitor_2');
    });
  });

  describe('path traversal is rejected and falls back to the default', () => {
    it.each([
      ['/../etc'],
      ['/mesh/../admin'],
      ['../mesh'],
      ['/mesh/..'],
      ['/mesh/..\\admin'],
      ['..'],
    ])('rejects %s', (value) => {
      const errorSpy = vi.spyOn(logger, 'error');
      expect(load(value)).toEqual({ baseUrl: '', provided: false });
      expect(errorSpy).toHaveBeenCalled();
    });

    it('does not treat a dotted name as traversal', () => {
      expect(load('/v1..2').baseUrl).toBe('/v1..2');
    });
  });

  describe('segment character check', () => {
    it('warns about, but keeps, a segment with special characters', () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      expect(load('/mesh monitor')).toEqual({ baseUrl: '/mesh monitor', provided: true });
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('invalid characters'))).toBe(true);
    });

    it('does not warn about letters, digits, hyphens and underscores', () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      load('/Mesh-Monitor_01');
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('invalid characters'))).toBe(false);
    });
  });
});
