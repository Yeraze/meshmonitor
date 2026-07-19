/**
 * Tests for the no-index config gate parsing/caching (issue #4202).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getNoIndexEnabled,
  setNoIndexEnabled,
  parseNoIndexEnabled,
  __resetNoIndexEnabledForTest,
} from './robotsConfig.js';

afterEach(() => {
  __resetNoIndexEnabledForTest();
});

describe('parseNoIndexEnabled', () => {
  it('defaults OFF for absent/empty values', () => {
    expect(parseNoIndexEnabled(null)).toBe(false);
    expect(parseNoIndexEnabled(undefined)).toBe(false);
    expect(parseNoIndexEnabled('')).toBe(false);
  });

  it('only enables on explicit truthy string', () => {
    expect(parseNoIndexEnabled('1')).toBe(true);
    expect(parseNoIndexEnabled('true')).toBe(true);
    expect(parseNoIndexEnabled('0')).toBe(false);
    expect(parseNoIndexEnabled('false')).toBe(false);
    expect(parseNoIndexEnabled('yes')).toBe(false);
  });
});

describe('get/setNoIndexEnabled', () => {
  it('defaults to false', () => {
    expect(getNoIndexEnabled()).toBe(false);
  });

  it('round-trips the cached flag', () => {
    setNoIndexEnabled(true);
    expect(getNoIndexEnabled()).toBe(true);
    setNoIndexEnabled(false);
    expect(getNoIndexEnabled()).toBe(false);
  });
});
