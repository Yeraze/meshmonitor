import { describe, it, expect } from 'vitest';
import { compareStatus } from './firmwareFleet.js';

describe('compareStatus (#4943)', () => {
  it('flags an older install', () => {
    expect(compareStatus('2.7.15.abc', '2.7.18')).toEqual({ status: 'update_available', reason: null });
  });
  it('treats the same major.minor.patch as up to date, build suffix aside', () => {
    expect(compareStatus('2.7.18.aabbcc', '2.7.18')).toEqual({ status: 'up_to_date', reason: null });
    expect(compareStatus('v1.19.0', '1.18.0')).toEqual({ status: 'up_to_date', reason: null });
  });
  it('is unknown, with a reason, whenever it cannot tell', () => {
    expect(compareStatus(null, '1.18.0')).toEqual({ status: 'unknown', reason: 'no_version' });
    expect(compareStatus('1.17.0', null)).toEqual({ status: 'unknown', reason: 'no_release' });
    expect(compareStatus(null, null)).toEqual({ status: 'unknown', reason: 'no_version' });
    expect(compareStatus('custom-build', '1.18.0')).toEqual({ status: 'unknown', reason: 'unparseable_version' });
  });
});
