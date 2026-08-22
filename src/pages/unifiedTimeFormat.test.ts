/**
 * #4869: the reception-details "Heard" column must show second-level precision,
 * while the message-card time stays at minute precision.
 */
import { describe, it, expect } from 'vitest';
import { formatTime, formatTimeWithSeconds } from './unifiedTimeFormat';

// 2026-08-21T18:32:09 local — a non-zero seconds value so the distinction shows.
const ts = new Date(2026, 7, 21, 18, 32, 9).getTime();

describe('unified messages time formatting (#4869)', () => {
  it('formatTimeWithSeconds includes an HH:MM:SS group', () => {
    expect(formatTimeWithSeconds(ts)).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it('formatTime stays at minute precision (no seconds group)', () => {
    expect(formatTime(ts)).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it('the Heard column formatter carries the extra second-level detail', () => {
    expect(formatTimeWithSeconds(ts).length).toBeGreaterThan(formatTime(ts).length);
  });
});
