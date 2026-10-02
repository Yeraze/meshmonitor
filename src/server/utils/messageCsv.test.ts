import { describe, it, expect } from 'vitest';
import {
  CSV_BOM,
  MESSAGE_EXPORT_COLUMNS,
  csvCell,
  csvRow,
  formatLocalTime,
  isValidTimeZone,
  messageExportHeader,
  messageExportLine,
  truncationMarkerLine,
} from './messageCsv.js';

describe('messageCsv (#5517)', () => {
  it('leaves plain text and numbers alone', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell(-97)).toBe('-97');
    expect(csvCell(5.25)).toBe('5.25');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });

  it('quotes commas, quotes and line breaks, doubling quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('guards formula triggers in text but never in numbers', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('-done')).toBe("'-done");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
    expect(csvCell(-12)).toBe('-12');
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('keeps emoji and non-ASCII intact', () => {
    expect(csvCell('👍 José — 東京')).toBe('👍 José — 東京');
  });

  it('ends every row with CRLF', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,\r\n');
    expect(messageExportHeader()).toBe(`${MESSAGE_EXPORT_COLUMNS.join(',')}\r\n`);
  });

  it('writes a row in column order', () => {
    const line = messageExportLine({
      timestamp_utc: '2026-10-03T14:00:00.000Z',
      local_time: '2026-10-03 10:00:00',
      network: 'Meshtastic',
      source: 'Base',
      channel: 'LongFast',
      sender_name: 'W1AW',
      sender_id: '!abcd1234',
      destination: 'broadcast',
      message: 'check-in, all ok',
      message_id: 42,
      rssi: -97,
      snr: 5.25,
      hops: 2,
    });
    expect(line).toBe('2026-10-03T14:00:00.000Z,2026-10-03 10:00:00,Meshtastic,Base,LongFast,W1AW,!abcd1234,broadcast,"check-in, all ok",42,-97,5.25,2\r\n');
  });

  it('exposes a UTF-8 BOM and a readable truncation marker', () => {
    expect(CSV_BOM).toBe('\uFEFF');
    expect(truncationMarkerLine(3)).toMatch(/^TRUNCATED: export stopped at 3 rows\..*\r\n$/);
  });

  it('formats local time per IANA zone and validates zones', () => {
    const ms = Date.UTC(2026, 9, 3, 14, 0, 5);
    expect(formatLocalTime(ms, 'UTC')).toBe('2026-10-03 14:00:05');
    expect(formatLocalTime(ms, 'America/New_York')).toBe('2026-10-03 10:00:05');
    expect(formatLocalTime(Date.UTC(2026, 9, 3, 0, 30), 'America/Los_Angeles')).toBe('2026-10-02 17:30:00');
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
