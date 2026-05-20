/**
 * Tests for the pure `parseAutoResponderResponse` helper extracted
 * from MeshtasticManager. The auto-responder calls it for:
 *
 *  - HTTP response bodies (`jsonExpected=false`) — must keep treating
 *    non-MeshMonitor-shaped responses as a single plain message so
 *    webhooks that return their own JSON shape don't silently drop.
 *  - Script stdout    (`jsonExpected=true`)  — strict; non-JSON or
 *    missing-field output is an error.
 *  - Static text responses (`jsonExpected=false`) — same fallback as
 *    HTTP so an admin can author `{"responses":[...]}` directly into
 *    the trigger's Response field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { parseAutoResponderResponse } from './meshtasticManager.js';
import { logger } from '../utils/logger.js';

describe('parseAutoResponderResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Multi-response array ────────────────────────────────────────

  it('returns all strings from { responses: [...] }', () => {
    const result = parseAutoResponderResponse('{"responses":["a","b","c"]}', true);
    expect(result.responses).toEqual(['a', 'b', 'c']);
    expect(result.json).toEqual({ responses: ['a', 'b', 'c'] });
  });

  it('filters non-string entries out of `responses` and warns about discards', () => {
    const result = parseAutoResponderResponse(
      '{"responses":["a", 123, "b", null, "c", true]}',
      true,
    );
    expect(result.responses).toEqual(['a', 'b', 'c']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/dropped 3 non-string/));
  });

  it('treats { responses: [] } as no-responses and logs an error', () => {
    const result = parseAutoResponderResponse('{"responses":[]}', true);
    expect(result.responses).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('treats { responses: [123, null] } as no-responses after filtering', () => {
    const result = parseAutoResponderResponse('{"responses":[123, null]}', true);
    expect(result.responses).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('prefers `responses` over `response` when both are present', () => {
    const result = parseAutoResponderResponse(
      '{"response":"single","responses":["a","b"]}',
      true,
    );
    expect(result.responses).toEqual(['a', 'b']);
  });

  // ── Single response ─────────────────────────────────────────────

  it('returns [s] from { response: "s" }', () => {
    const result = parseAutoResponderResponse('{"response":"hello"}', true);
    expect(result.responses).toEqual(['hello']);
    expect(result.json).toEqual({ response: 'hello' });
  });

  it('falls through when `response` is a non-string', () => {
    // jsonExpected=true → script path → error + empty.
    const script = parseAutoResponderResponse('{"response":42}', true);
    expect(script.responses).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  // ── Plain text input (jsonExpected=false) ───────────────────────

  it('returns the raw body as a single message when input is plain text and jsonExpected=false', () => {
    const result = parseAutoResponderResponse('hello world', false);
    expect(result.responses).toEqual(['hello world']);
    expect(result.json).toEqual({});
  });

  it('treats whitespace-only input as a single plain-text message', () => {
    const result = parseAutoResponderResponse('   ', false);
    expect(result.responses).toEqual(['   ']);
  });

  // ── jsonExpected=true: strict mode ──────────────────────────────

  it('errors on non-JSON input when jsonExpected=true', () => {
    const result = parseAutoResponderResponse('not json', true);
    expect(result.responses).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/));
  });

  it('errors on JSON missing both `response` and `responses` when jsonExpected=true', () => {
    const result = parseAutoResponderResponse('{"status":"ok"}', true);
    expect(result.responses).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/missing valid 'response' or 'responses'/));
  });

  // ── jsonExpected=false: HTTP backwards-compat ──────────────────

  it('returns the raw body when JSON parses but lacks recognised fields and jsonExpected=false', () => {
    // Regression: webhooks that return e.g. {"status":"ok"} as
    // acknowledgment used to get truncated-and-sent as the message.
    // The unified parser must preserve that behaviour for HTTP.
    const raw = '{"status":"ok"}';
    const result = parseAutoResponderResponse(raw, false);
    expect(result.responses).toEqual([raw]);
    expect(result.json).toEqual({ status: 'ok' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns the raw body for a top-level JSON array when jsonExpected=false', () => {
    // Array roots aren't `responses` (that field is *inside* an object).
    // Fall through to raw-body single message.
    const result = parseAutoResponderResponse('[1,2,3]', false);
    expect(result.responses).toEqual(['[1,2,3]']);
  });

  // ── `private` flag exposure ─────────────────────────────────────

  it('exposes the `private` field on `.json` so callers can force DM routing', () => {
    const result = parseAutoResponderResponse(
      '{"response":"msg","private":true}',
      true,
    );
    expect(result.json.private).toBe(true);
    expect(result.responses).toEqual(['msg']);
  });

  it('does not surface a `private` field for plain-text input', () => {
    const result = parseAutoResponderResponse('plain', false);
    expect(result.json).toEqual({});
  });

  // ── Hardening ───────────────────────────────────────────────────

  it('handles JSON null without crashing', () => {
    const result = parseAutoResponderResponse('null', false);
    // null is valid JSON but has no fields — falls through to raw body.
    expect(result.responses).toEqual(['null']);
  });

  it('returns empty messages on empty input with jsonExpected=true', () => {
    const result = parseAutoResponderResponse('', true);
    expect(result.responses).toEqual([]);
  });
});
