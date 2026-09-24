/**
 * Unit tests for `src/utils/coverage.ts` shared helpers (Coverage Report
 * epic #5277, Phase 1 WP1). See COVERAGE_P1_SPEC.md §5 Decisions D1-D4 for
 * the rationale each test is guarding.
 */
import { describe, it, expect } from 'vitest';
import {
  COVERAGE_MQTT_ENABLED_SETTING,
  isCoverageMqttFlagOn,
  clampCoverageRetentionDays,
  COVERAGE_RETENTION_DEFAULT_DAYS,
  COVERAGE_MAX_RX_AGE_SEC,
  isStaleCoverageRxTime,
  computeMeshtasticHopsAway,
  meshtasticPathKey,
  nodeNumToId,
  groupReceptionsIntoFixes,
  COVERAGE_RSSI_BANDS,
  type CoverageReceptionLike,
} from './coverage.js';

describe('clampCoverageRetentionDays', () => {
  it('falls back to the default for undefined', () => {
    expect(clampCoverageRetentionDays(undefined)).toBe(COVERAGE_RETENTION_DEFAULT_DAYS);
  });

  it('falls back to the default for null (WP3 #5277: getSettingAsync returns null, not undefined, for an unset key)', () => {
    expect(clampCoverageRetentionDays(null)).toBe(COVERAGE_RETENTION_DEFAULT_DAYS);
  });

  it('falls back to the default for a non-numeric string', () => {
    expect(clampCoverageRetentionDays('abc')).toBe(COVERAGE_RETENTION_DEFAULT_DAYS);
  });

  it('clamps 0 up to the minimum (1)', () => {
    expect(clampCoverageRetentionDays(0)).toBe(1);
  });

  it('passes through 1 unchanged', () => {
    expect(clampCoverageRetentionDays(1)).toBe(1);
  });

  it('passes through 7 unchanged', () => {
    expect(clampCoverageRetentionDays(7)).toBe(7);
  });

  it('passes through 90 unchanged', () => {
    expect(clampCoverageRetentionDays(90)).toBe(90);
  });

  it('clamps 500 down to the maximum (90)', () => {
    expect(clampCoverageRetentionDays(500)).toBe(90);
  });

  it('parses a numeric string', () => {
    expect(clampCoverageRetentionDays('14')).toBe(14);
  });
});

describe('computeMeshtasticHopsAway', () => {
  it('normal case: hopStart 3, hopLimit 1 gives 2', () => {
    expect(computeMeshtasticHopsAway({ hopStart: 3, hopLimit: 1, hasBitfield: false })).toBe(2);
  });

  it('0/0 with a bitfield gives 0 (true zero-hop)', () => {
    expect(computeMeshtasticHopsAway({ hopStart: 0, hopLimit: 0, hasBitfield: true })).toBe(0);
  });

  it('0/0 with no bitfield gives null (pre-2.3 firmware, hop_start unset)', () => {
    expect(computeMeshtasticHopsAway({ hopStart: 0, hopLimit: 0, hasBitfield: false })).toBeNull();
  });

  it('hopStart 0 with hopLimit > 0 gives null', () => {
    expect(computeMeshtasticHopsAway({ hopStart: 0, hopLimit: 3, hasBitfield: true })).toBeNull();
  });

  it('hopLimit > hopStart gives null', () => {
    expect(computeMeshtasticHopsAway({ hopStart: 1, hopLimit: 3, hasBitfield: true })).toBeNull();
  });

  it('hopStart === hopLimit (still traveling at full budget) gives 0', () => {
    expect(computeMeshtasticHopsAway({ hopStart: 3, hopLimit: 3, hasBitfield: false })).toBe(0);
  });

  it('null hopStart gives null', () => {
    expect(computeMeshtasticHopsAway({ hopStart: null, hopLimit: 1, hasBitfield: true })).toBeNull();
  });

  it('null hopLimit with hopStart > 0 gives null', () => {
    expect(computeMeshtasticHopsAway({ hopStart: 3, hopLimit: null, hasBitfield: true })).toBeNull();
  });

  it('both null gives null', () => {
    expect(computeMeshtasticHopsAway({ hopStart: null, hopLimit: null, hasBitfield: true })).toBeNull();
  });
});

describe('meshtasticPathKey', () => {
  it('is never empty for null/undefined inputs', () => {
    expect(meshtasticPathKey(null, null)).toBe('r-:h-');
    expect(meshtasticPathKey(undefined, undefined)).toBe('r-:h-');
  });

  it('relayNode 0 gives r0 (the normal key for zero-hop)', () => {
    expect(meshtasticPathKey(0, 0)).toBe('r0:h0');
  });

  it('renders a normal relay + hops pair', () => {
    expect(meshtasticPathKey(0xa3, 2)).toBe('r163:h2');
  });
});

describe('nodeNumToId', () => {
  it('formats a node number as !xxxxxxxx', () => {
    expect(nodeNumToId(0xaabbccdd)).toBe('!aabbccdd');
  });

  it('pads small node numbers to 8 hex digits', () => {
    expect(nodeNumToId(0x1)).toBe('!00000001');
  });
});

describe('isStaleCoverageRxTime', () => {
  const NOW_MS = 1_760_000_000_000; // ~2025
  const NOW_SEC = Math.floor(NOW_MS / 1000);

  it('is not stale exactly at the 600s boundary', () => {
    expect(isStaleCoverageRxTime(NOW_SEC - COVERAGE_MAX_RX_AGE_SEC, NOW_MS)).toBe(false);
  });

  it('is stale just past the 600s boundary', () => {
    expect(isStaleCoverageRxTime(NOW_SEC - COVERAGE_MAX_RX_AGE_SEC - 1, NOW_MS)).toBe(true);
  });

  it('is not stale for a fresh rxTime', () => {
    expect(isStaleCoverageRxTime(NOW_SEC, NOW_MS)).toBe(false);
  });

  it('an implausible (boot-relative) rxTime is never stale', () => {
    expect(isStaleCoverageRxTime(1234, NOW_MS)).toBe(false);
  });

  it('an absent rxTime is never stale', () => {
    expect(isStaleCoverageRxTime(null, NOW_MS)).toBe(false);
    expect(isStaleCoverageRxTime(undefined, NOW_MS)).toBe(false);
  });

  it('a non-finite rxTime is never stale', () => {
    expect(isStaleCoverageRxTime(NaN, NOW_MS)).toBe(false);
  });
});

describe('COVERAGE_RSSI_BANDS', () => {
  it('defines the documented thresholds', () => {
    expect(COVERAGE_RSSI_BANDS.excellent).toBe(-90);
    expect(COVERAGE_RSSI_BANDS.good).toBe(-105);
    expect(COVERAGE_RSSI_BANDS.fair).toBe(-115);
  });
});

describe('groupReceptionsIntoFixes', () => {
  interface Row extends CoverageReceptionLike {
    receiverId: string;
  }

  function row(overrides: Partial<Row>): Row {
    return {
      senderId: '!bbbbbbbb',
      packetKey: '100',
      receiverId: '!aaaaaaaa',
      latitude: 40.0,
      longitude: -105.0,
      receivedAt: 1000,
      snr: null,
      rssi: null,
      ...overrides,
    };
  }

  it('groups by ${senderId}|${packetKey}', () => {
    const rows: Row[] = [
      row({ senderId: 'a', packetKey: '1', receiverId: 'r1' }),
      row({ senderId: 'a', packetKey: '1', receiverId: 'r2' }),
      row({ senderId: 'a', packetKey: '2', receiverId: 'r1' }),
      row({ senderId: 'b', packetKey: '1', receiverId: 'r1' }),
    ];
    const fixes = groupReceptionsIntoFixes(rows);
    expect(fixes).toHaveLength(3);
    const ab1 = fixes.find((f) => f.senderId === 'a' && f.packetKey === '1');
    expect(ab1?.receptions).toHaveLength(2);
  });

  it('takes fix lat/lon/receivedAt from the newest row in the group', () => {
    const rows: Row[] = [
      row({ receiverId: 'r1', latitude: 1, longitude: 1, receivedAt: 1000 }),
      row({ receiverId: 'r2', latitude: 2, longitude: 2, receivedAt: 5000 }),
    ];
    const [fix] = groupReceptionsIntoFixes(rows);
    expect(fix.latitude).toBe(2);
    expect(fix.longitude).toBe(2);
    expect(fix.receivedAt).toBe(5000);
  });

  it('bestSnr/bestRssi are the max across all receptions regardless of metric', () => {
    const rows: Row[] = [
      row({ receiverId: 'r1', snr: 2, rssi: -100 }),
      row({ receiverId: 'r2', snr: 9, rssi: -70 }),
      row({ receiverId: 'r3', snr: 5, rssi: -90 }),
    ];
    const [fix] = groupReceptionsIntoFixes(rows, 'rssi');
    expect(fix.bestSnr).toBe(9);
    expect(fix.bestRssi).toBe(-70);
  });

  it('sorts receptions by the active metric descending, with nulls last', () => {
    const rows: Row[] = [
      row({ receiverId: 'r1', snr: 2 }),
      row({ receiverId: 'r2', snr: null }),
      row({ receiverId: 'r3', snr: 9 }),
    ];
    const [fix] = groupReceptionsIntoFixes(rows, 'snr');
    expect(fix.receptions.map((r) => r.receiverId)).toEqual(['r3', 'r1', 'r2']);
  });

  it('defaults to sorting by snr when no metric is given', () => {
    const rows: Row[] = [
      row({ receiverId: 'r1', snr: 1, rssi: -50 }),
      row({ receiverId: 'r2', snr: 9, rssi: -90 }),
    ];
    const [fix] = groupReceptionsIntoFixes(rows);
    expect(fix.receptions.map((r) => r.receiverId)).toEqual(['r2', 'r1']);
  });

  it('returns [] for an empty input', () => {
    expect(groupReceptionsIntoFixes([])).toEqual([]);
  });
});

describe('isCoverageMqttFlagOn', () => {
  it('is on only for "1" and "true"', () => {
    expect(COVERAGE_MQTT_ENABLED_SETTING).toBe('coverage_mqtt_enabled');
    expect(isCoverageMqttFlagOn('1')).toBe(true);
    expect(isCoverageMqttFlagOn('true')).toBe(true);
  });

  it('is off for anything else, including unset', () => {
    for (const raw of [null, undefined, '', '0', 'false', 'yes', 'TRUE']) {
      expect(isCoverageMqttFlagOn(raw)).toBe(false);
    }
  });
});
