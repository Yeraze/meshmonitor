import { describe, it, expect } from 'vitest';
import { buildCoverageReportPath, parseCoverageDeepLink } from './coverageDeepLink.js';

describe('buildCoverageReportPath', () => {
  it('always includes report=coverage', () => {
    expect(buildCoverageReportPath({})).toBe('/reports?report=coverage');
  });

  it('includes sender (lower-cased) and range when given', () => {
    const path = buildCoverageReportPath({ sender: '!AABBCCDD', range: '24h' });
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('report')).toBe('coverage');
    expect(params.get('sender')).toBe('!aabbccdd');
    expect(params.get('range')).toBe('24h');
  });

  it('includes survey when given', () => {
    const path = buildCoverageReportPath({ survey: '11111111-2222-3333-4444-555555555555' });
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('survey')).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('omits fields that are undefined', () => {
    const path = buildCoverageReportPath({ sender: '!aabbccdd' });
    expect(path).not.toContain('range=');
    expect(path).not.toContain('survey=');
  });
});

describe('parseCoverageDeepLink', () => {
  it('returns null when report is not "coverage"', () => {
    expect(parseCoverageDeepLink(new URLSearchParams('report=other&sender=!aabbccdd'))).toBeNull();
    expect(parseCoverageDeepLink(new URLSearchParams(''))).toBeNull();
  });

  it('round-trips a Meshtastic sender + range through build/parse', () => {
    const path = buildCoverageReportPath({ sender: '!aabbccdd', range: '6h' });
    const parsed = parseCoverageDeepLink(new URLSearchParams(path.split('?')[1]));
    expect(parsed).toEqual({ sender: '!aabbccdd', range: '6h' });
  });

  it('round-trips a MeshCore sender (64-hex pubkey)', () => {
    const pubkey = 'a'.repeat(64);
    const path = buildCoverageReportPath({ sender: pubkey, range: '1h' });
    const parsed = parseCoverageDeepLink(new URLSearchParams(path.split('?')[1]));
    expect(parsed).toEqual({ sender: pubkey, range: '1h' });
  });

  it('round-trips a survey id', () => {
    const surveyId = '11111111-2222-3333-4444-555555555555';
    const path = buildCoverageReportPath({ survey: surveyId });
    const parsed = parseCoverageDeepLink(new URLSearchParams(path.split('?')[1]));
    expect(parsed).toEqual({ survey: surveyId });
  });

  it('drops a malformed sender rather than passing it through', () => {
    const parsed = parseCoverageDeepLink(new URLSearchParams('report=coverage&sender=not-a-valid-id'));
    expect(parsed).toEqual({});
  });

  it('drops a Meshtastic-shaped sender with the wrong hex length', () => {
    const parsed = parseCoverageDeepLink(new URLSearchParams('report=coverage&sender=!aabbcc'));
    expect(parsed).toEqual({});
  });

  it('drops a range that is not a known preset (including "custom")', () => {
    expect(parseCoverageDeepLink(new URLSearchParams('report=coverage&range=custom'))).toEqual({});
    expect(parseCoverageDeepLink(new URLSearchParams('report=coverage&range=99d'))).toEqual({});
  });

  it('drops a malformed survey id', () => {
    const parsed = parseCoverageDeepLink(new URLSearchParams('report=coverage&survey=not-a-uuid'));
    expect(parsed).toEqual({});
  });

  it('lower-cases an upper-case sender before validating/storing it', () => {
    const parsed = parseCoverageDeepLink(new URLSearchParams('report=coverage&sender=!AABBCCDD'));
    expect(parsed).toEqual({ sender: '!aabbccdd' });
  });

  it('accepts every non-custom range preset id', () => {
    for (const range of ['1h', '6h', '24h', '3d', '7d']) {
      const parsed = parseCoverageDeepLink(new URLSearchParams(`report=coverage&range=${range}`));
      expect(parsed).toEqual({ range });
    }
  });

  it('ignores an unrelated report= value entirely, even with other coverage-shaped params present', () => {
    const parsed = parseCoverageDeepLink(new URLSearchParams('report=telemetry&sender=!aabbccdd&range=24h'));
    expect(parsed).toBeNull();
  });
});
