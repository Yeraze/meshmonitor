/**
 * Parsers for the Repeater serial CLI local-stats verbs (#5533).
 *
 * Reply strings are built exactly as the firmware prints them:
 *   - examples/simple_repeater/main.cpp:154      `Serial.print("  -> "); Serial.println(reply);`
 *   - src/helpers/StatsFormatHelper.h            formatCoreStats / formatRadioStats / formatPacketStats sprintf formats
 *   - src/helpers/CommonCLI.cpp:213-216          `clock`  → "%02d:%02d - %d/%d/%d UTC"
 *   - src/helpers/CommonCLI.cpp:272-275          `ver`    → "%s (Build: %s)", `board` → "%s"
 *   - src/helpers/CommonCLI.cpp:437-443          `stats-*` serial-only; else "Unknown command"
 */
import { describe, it, expect } from 'vitest';
import {
  parseRepeaterStatsCore,
  parseRepeaterStatsRadio,
  parseRepeaterStatsPackets,
  parseRepeaterClockReply,
  parseRepeaterVerReply,
  parseRepeaterBoardReply,
  repeaterReplyBody,
  mapStatsCore,
  mapStatsRadio,
  mapStatsPackets,
} from './meshcoreRepeaterStats.js';

// "{\"battery_mv\":%u,\"uptime_secs\":%u,\"errors\":%u,\"queue_len\":%u}"
const CORE = '  -> {"battery_mv":4120,"uptime_secs":86400,"errors":0,"queue_len":3}';
// "{\"noise_floor\":%d,\"last_rssi\":%d,\"last_snr\":%.2f,\"tx_air_secs\":%u,\"rx_air_secs\":%u}"
const RADIO = '  -> {"noise_floor":-112,"last_rssi":-87,"last_snr":-7.25,"tx_air_secs":312,"rx_air_secs":4521}';
// "{\"recv\":%u,\"sent\":%u,\"flood_tx\":%u,\"direct_tx\":%u,\"flood_rx\":%u,\"direct_rx\":%u,\"recv_errors\":%u}"
const PACKETS = '  -> {"recv":1520,"sent":340,"flood_tx":200,"direct_tx":140,"flood_rx":1100,"direct_rx":420,"recv_errors":12}';
const UNKNOWN = '  -> Unknown command';

describe('repeaterReplyBody', () => {
  it('returns the text after the -> marker', () => {
    expect(repeaterReplyBody('  -> hello')).toBe('hello');
  });
  it('returns null when there is no reply line', () => {
    expect(repeaterReplyBody('')).toBeNull();
    expect(repeaterReplyBody(undefined)).toBeNull();
  });
});

describe('parseRepeaterStatsCore', () => {
  it('maps every stats-core field', () => {
    expect(parseRepeaterStatsCore(CORE)).toEqual({ batteryMv: 4120, uptimeSecs: 86400, errors: 0, queueLen: 3 });
  });
  it('keeps a genuine 0 as 0', () => {
    expect(parseRepeaterStatsCore('  -> {"battery_mv":0,"uptime_secs":5,"errors":0,"queue_len":0}')?.batteryMv).toBe(0);
  });
  it('returns null for older firmware without the verb', () => {
    expect(parseRepeaterStatsCore(UNKNOWN)).toBeNull();
  });
  it('returns null for an empty (timed-out) reply', () => {
    expect(parseRepeaterStatsCore('')).toBeNull();
  });
});

describe('parseRepeaterStatsRadio', () => {
  it('maps every stats-radio field, including a negative float SNR', () => {
    expect(parseRepeaterStatsRadio(RADIO)).toEqual({
      noiseFloor: -112,
      lastRssi: -87,
      lastSnr: -7.25,
      txAirSecs: 312,
      rxAirSecs: 4521,
    });
  });
  it('leaves a field the board could not print undefined, never 0', () => {
    // A printf without float support can leave `%.2f` unrendered.
    const r = parseRepeaterStatsRadio('  -> {"noise_floor":-112,"last_rssi":-87,"last_snr":f,"tx_air_secs":3,"rx_air_secs":4}');
    expect(r?.lastSnr).toBeUndefined();
    expect(r?.noiseFloor).toBe(-112);
  });
  it('returns null on Unknown command', () => {
    expect(parseRepeaterStatsRadio(UNKNOWN)).toBeNull();
  });
});

describe('parseRepeaterStatsPackets', () => {
  it('maps every stats-packets field', () => {
    expect(parseRepeaterStatsPackets(PACKETS)).toEqual({
      recv: 1520,
      sent: 340,
      floodTx: 200,
      directTx: 140,
      floodRx: 1100,
      directRx: 420,
      recvErrors: 12,
    });
  });
  it('reports a missing recv_errors as null, like the companion path', () => {
    expect(parseRepeaterStatsPackets('  -> {"recv":1,"sent":2}')?.recvErrors).toBeNull();
  });
  it('returns null on Unknown command', () => {
    expect(parseRepeaterStatsPackets(UNKNOWN)).toBeNull();
  });
});

describe('shared mappers match the companion get_stats payload', () => {
  it('produce the same shape from the same snake_case keys', () => {
    expect(mapStatsCore({ battery_mv: 4120, uptime_secs: 86400, errors: 0, queue_len: 3 })).toEqual(parseRepeaterStatsCore(CORE));
    expect(mapStatsRadio({ noise_floor: -112, last_rssi: -87, last_snr: -7.25, tx_air_secs: 312, rx_air_secs: 4521 })).toEqual(
      parseRepeaterStatsRadio(RADIO),
    );
    expect(
      mapStatsPackets({ recv: 1520, sent: 340, flood_tx: 200, direct_tx: 140, flood_rx: 1100, direct_rx: 420, recv_errors: 12 }),
    ).toEqual(parseRepeaterStatsPackets(PACKETS));
  });
});

describe('parseRepeaterClockReply', () => {
  it('parses "HH:MM - d/m/yyyy UTC" to the start of that minute', () => {
    expect(parseRepeaterClockReply('  -> 14:05 - 2/10/2026 UTC')).toBe(Date.UTC(2026, 9, 2, 14, 5, 0) / 1000);
  });
  it('rejects a set-clock reply or junk', () => {
    expect(parseRepeaterClockReply('  -> OK - clock set: 14:05 - 2/10/2026 UTC')).toBeNull();
    expect(parseRepeaterClockReply(UNKNOWN)).toBeNull();
    expect(parseRepeaterClockReply('  -> 25:05 - 2/10/2026 UTC')).toBeNull();
  });
});

describe('parseRepeaterVerReply / parseRepeaterBoardReply', () => {
  it('splits version and build date', () => {
    expect(parseRepeaterVerReply('  -> v1.17.1 (Build: 14 Aug 2026)')).toEqual({ ver: 'v1.17.1', firmwareBuild: '14 Aug 2026' });
  });
  it('keeps a version with no build suffix', () => {
    expect(parseRepeaterVerReply('  -> v1.17.1')).toEqual({ ver: 'v1.17.1' });
  });
  it('returns the board name', () => {
    expect(parseRepeaterBoardReply('  -> Heltec V3')).toBe('Heltec V3');
  });
  it('returns null on Unknown command or no reply', () => {
    expect(parseRepeaterVerReply(UNKNOWN)).toBeNull();
    expect(parseRepeaterBoardReply('')).toBeNull();
  });
});
