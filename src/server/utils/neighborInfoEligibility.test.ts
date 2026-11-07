import { describe, it, expect } from 'vitest';
import { tracerouteShowsDirectPath } from './neighborInfoEligibility.js';

describe('tracerouteShowsDirectPath (#6151)', () => {
  it('is true for a direct 2-node trace (no intermediate hops either way)', () => {
    expect(tracerouteShowsDirectPath([{ route: '[]', routeBack: '[]' }])).toBe(true);
  });

  it('treats a one-way reply (null routeBack) as still direct', () => {
    expect(tracerouteShowsDirectPath([{ route: '[]', routeBack: null }])).toBe(true);
  });

  it('is false when the forward path has intermediate hops', () => {
    expect(tracerouteShowsDirectPath([{ route: '[123456]', routeBack: '[]' }])).toBe(false);
  });

  it('is false when the return path has intermediate hops', () => {
    expect(tracerouteShowsDirectPath([{ route: '[]', routeBack: '[789]' }])).toBe(false);
  });

  it('skips a pending/unanswered row and reads the next answered one', () => {
    // Newest first: a pending request sits above the completed direct trace.
    expect(tracerouteShowsDirectPath([
      { route: null, routeBack: null },
      { route: '[]', routeBack: '[]' },
    ])).toBe(true);
  });

  it('lets the newest answered trace win — a later multi-hop overrides an older direct', () => {
    expect(tracerouteShowsDirectPath([
      { route: '[111, 222]', routeBack: '[]' }, // newest: node moved away
      { route: '[]', routeBack: '[]' },         // older: was direct
    ])).toBe(false);
  });

  it('is false for no traceroutes at all', () => {
    expect(tracerouteShowsDirectPath([])).toBe(false);
  });

  it('is false when all rows are pending', () => {
    expect(tracerouteShowsDirectPath([{ route: null, routeBack: null }])).toBe(false);
  });

  it('ignores malformed JSON without throwing', () => {
    expect(tracerouteShowsDirectPath([{ route: 'not json', routeBack: '[]' }])).toBe(false);
  });
});
