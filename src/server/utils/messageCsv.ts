/**
 * CSV building blocks for the filtered message export (#5517).
 *
 * Output targets spreadsheet apps first (Excel, LibreOffice, Google Sheets):
 * - UTF-8 with a byte-order mark, so Excel detects the encoding and emoji or
 *   accented names survive.
 * - CRLF row endings (RFC 4180).
 * - Fields with a comma, quote, CR or LF are quoted, quotes doubled.
 * - Formula-injection guard: a text cell starting with `=`, `+`, `-`, `@`,
 *   tab or CR gets a leading `'`, so a mesh message like `=HYPERLINK(...)`
 *   lands as text instead of running as a formula. Numbers are never guarded
 *   (a negative RSSI must stay a number).
 */

export const CSV_BOM = '\uFEFF';
export const CSV_EOL = '\r\n';

export const MESSAGE_EXPORT_COLUMNS = [
  'timestamp_utc',
  'local_time',
  'network',
  'source',
  'channel',
  'sender_name',
  'sender_id',
  'destination',
  'message',
  'message_id',
  'rssi',
  'snr',
  'hops',
] as const;

export type MessageExportColumn = (typeof MESSAGE_EXPORT_COLUMNS)[number];
export type MessageExportRow = Record<MessageExportColumn, string | number | null | undefined>;

/** Hard cap on exported rows; the file ends with a marker row when it is hit. */
export const MESSAGE_EXPORT_MAX_ROWS = 100_000;

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Encode one CSV cell. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = value;
  if (text.length > 0 && FORMULA_TRIGGERS.has(text[0])) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Encode one CSV row, CRLF-terminated. */
export function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return values.map(csvCell).join(',') + CSV_EOL;
}

/** The header row (BOM not included). */
export function messageExportHeader(): string {
  return csvRow(MESSAGE_EXPORT_COLUMNS);
}

/** One data row in column order. */
export function messageExportLine(row: MessageExportRow): string {
  return csvRow(MESSAGE_EXPORT_COLUMNS.map((c) => row[c]));
}

/** Last line of a file that hit {@link MESSAGE_EXPORT_MAX_ROWS}. */
export function truncationMarkerLine(maxRows: number = MESSAGE_EXPORT_MAX_ROWS): string {
  return csvRow([`TRUNCATED: export stopped at ${maxRows} rows. Narrow the date range or filters to get the rest.`]);
}

/** True when `tz` is an IANA time zone this runtime knows. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Cache of formatters keyed by time zone. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `YYYY-MM-DD HH:mm:ss` wall-clock time in `tz`. Plain and sortable, and every
 * spreadsheet parses it as a date. Caller validates `tz` first.
 */
export function formatLocalTime(ms: number, tz: string): string {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
