/**
 * RFC 4180 CSV reader (#5891 Phase 3). Frontend-safe, no dependencies.
 * BOM-tolerant, CRLF/LF/CR, quoted fields with embedded commas, quotes and
 * newlines. Each record carries the 1-based line where it starts.
 * `maxRecords` stops parsing once more than that many records exist (the
 * result then has maxRecords + 1 records and `truncated: true`), bounding work
 * and memory on hostile input. Blank lines (including a trailing one) are skipped.
 */
export function parseCsv(
  text: string,
  opts: { maxRecords?: number } = {},
): { records: string[][]; lines: number[]; truncated: boolean } {
  const maxRecords = opts.maxRecords ?? Infinity;
  let truncated = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: string[][] = [];
  const lines: number[] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let sawContent = false; // any char (or quoted field) on the current record

  const endRecord = () => {
    if (sawContent || record.length > 0) {
      record.push(field);
      records.push(record);
      lines.push(startLine);
      if (records.length > maxRecords) truncated = true;
    }
    record = [];
    field = '';
    sawContent = false;
  };

  for (let i = 0; i < text.length && !truncated; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '' ) {
      inQuotes = true;
      sawContent = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
      sawContent = true;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else {
      if (!sawContent) startLine = line;
      field += ch;
      sawContent = true;
    }
  }
  if (!truncated) endRecord();
  return { records, lines, truncated };
}
