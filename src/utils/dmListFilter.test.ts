import { describe, it, expect } from 'vitest';
import { passesDmFilter, type DmFilterSubject } from './dmListFilter';

const NOW = 1_700_000_000_000;
const base: DmFilterSubject = { unread: false, lastMessageTime: NOW - 1000, isFavorite: false, hasPosition: false, isInfrastructure: false };

describe('passesDmFilter', () => {
  it('passes everything for all and hops', () => {
    expect(passesDmFilter(base, 'all', NOW)).toBe(true);
    expect(passesDmFilter(base, 'hops', NOW)).toBe(true);
  });
  it('unread', () => {
    expect(passesDmFilter(base, 'unread', NOW)).toBe(false);
    expect(passesDmFilter({ ...base, unread: true }, 'unread', NOW)).toBe(true);
  });
  it('recent is within 24h', () => {
    expect(passesDmFilter(base, 'recent', NOW)).toBe(true);
    expect(passesDmFilter({ ...base, lastMessageTime: NOW - 25 * 3600 * 1000 }, 'recent', NOW)).toBe(false);
    expect(passesDmFilter({ ...base, lastMessageTime: 0 }, 'recent', NOW)).toBe(false);
  });
  it('favorites, withPosition, noInfra', () => {
    expect(passesDmFilter(base, 'favorites', NOW)).toBe(false);
    expect(passesDmFilter({ ...base, isFavorite: true }, 'favorites', NOW)).toBe(true);
    expect(passesDmFilter(base, 'withPosition', NOW)).toBe(false);
    expect(passesDmFilter({ ...base, hasPosition: true }, 'withPosition', NOW)).toBe(true);
    expect(passesDmFilter({ ...base, isInfrastructure: true }, 'noInfra', NOW)).toBe(false);
    expect(passesDmFilter(base, 'noInfra', NOW)).toBe(true);
  });
});
