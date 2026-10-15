/**
 * The MeshCore Auto-Responder test box (#5808) must give the same answer as
 * the server. This compares the client copy against the server's own
 * `compileAutoAckRegex` (RE2, `i` flag, `regex.test`) on a spread of
 * patterns, including ones the server rejects.
 */
import { describe, it, expect } from 'vitest';
import { compileAutoAckRegex } from '../../server/utils/autoAckRegex';
import { compileMeshCoreResponderPattern, meshCoreResponderPatternMatches } from './meshcoreResponderMatch';

const PATTERNS = [
  '^ping', 'ping$', 'help', '^(test|ping)', 'weather\\s+\\w+', '[0-9]{5}', '^status$',
  // Unicode classes: RE2 reads them natively, the browser engine needs `u`
  '\\p{L}', '\\pL+', '^\\P{L}',
  // rejected by the server
  '', 'x'.repeat(101), '.*.*', 'a+b+', '(?=ping)', '(a)\\1', 'café', 'a{1000}', 'a{2,}',
];
const MESSAGES = ['ping', 'PING please', 'say ping', 'I need HELP', 'weather Miami', 'zip 33076', 'status', 'STATUS now', ''];

describe('meshcoreResponderMatch mirrors the server', () => {
  it.each(PATTERNS)('pattern %j: accepted by both or rejected by both', (pattern) => {
    expect(!!compileMeshCoreResponderPattern(pattern).regex).toBe(!!compileAutoAckRegex(pattern).regex);
  });

  it('matches the same messages as the server for every accepted pattern', () => {
    for (const pattern of PATTERNS) {
      const server = compileAutoAckRegex(pattern).regex;
      for (const text of MESSAGES) {
        expect(meshCoreResponderPatternMatches(pattern, text), `${pattern} vs ${text}`).toBe(!!server && server.test(text));
      }
    }
  });
});
