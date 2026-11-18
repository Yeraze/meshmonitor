import { describe, expect, it } from 'vitest';
import { GEOM, scanHeaders, scanJson } from './publicInstanceAudit.js';

// A CSRF token that happens to hold the altMT sentinel's digits (CI flake).
const TOKEN = `ab${GEOM.altMT}cd`.padEnd(64, 'e');

describe('publicInstanceAudit scanners skip random per-request values', () => {
  it('does not flag a CSRF token that contains a sentinel by chance', () => {
    expect(scanJson({ csrfToken: TOKEN })).toEqual([]);
  });

  it('still flags the same digits in any other field', () => {
    const hits = scanJson({ altitude: GEOM.altMT, note: TOKEN });
    expect(hits.map((h) => h.path).sort()).toEqual(['$.altitude', '$.note']);
  });

  it('does not flag set-cookie or etag values, but scans other headers', () => {
    const hits = scanHeaders({
      'set-cookie': [`sid=s%3A${TOKEN}`],
      etag: `W/"${TOKEN}"`,
      'x-alt': String(GEOM.altMT),
    });
    expect(hits.map((h) => h.path)).toEqual(['header:x-alt']);
  });
});
