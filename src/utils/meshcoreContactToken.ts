/**
 * MeshCore contact-share tokens (#6370).
 *
 * MeshCore One (and now MeshMonitor) shares a contact inside a message as
 *
 *     <PUBLICKEYHEX:type:name>
 *
 * - PUBLICKEYHEX: the 32-byte public key as 64 hex characters. Read in any
 *   case, written in upper case.
 * - type: the firmware ADV_TYPE value. Only 1 (Companion / chat),
 *   2 (Repeater) and 3 (Room) are valid; anything else is not a token.
 * - name: everything after the second ':' (so a name may hold ':'). It may
 *   not hold '>' (that ends the token), so '>' is dropped when writing one.
 *   A blank name is not a token.
 *
 * Written from the token description in the issue; shared by the browser
 * (rendering, composer) and the server (import route validation).
 */

/** ADV_TYPE values a token may carry. */
export type MeshCoreContactTokenType = 1 | 2 | 3;

export const MESHCORE_CONTACT_TOKEN_TYPES: readonly MeshCoreContactTokenType[] = [1, 2, 3];

export interface MeshCoreContactToken {
  /** Lower-case 64-hex public key (MeshMonitor's storage form). */
  publicKey: string;
  type: MeshCoreContactTokenType;
  /** The name with surrounding whitespace trimmed. */
  name: string;
}

export interface MeshCoreContactTokenMatch {
  token: MeshCoreContactToken;
  /** The exact text that matched, angle brackets included. */
  raw: string;
  /** Index of '<' in the source text. */
  start: number;
  /** Index just past '>' in the source text. */
  end: number;
}

/** Same shape MeshCore One looks for. Global: use with matchAll / a fresh lastIndex. */
const TOKEN_RE = /<[0-9a-fA-F]{64}:\d+:[^>]+>/g;

/** True when `type` is a token type (1, 2 or 3). */
export function isMeshCoreContactTokenType(type: unknown): type is MeshCoreContactTokenType {
  return type === 1 || type === 2 || type === 3;
}

/**
 * Parse one token. `text` must be exactly the token, angle brackets included
 * (surrounding whitespace is allowed). Returns null for anything malformed:
 * wrong key length, non-hex key, a type other than 1-3, or a blank name.
 */
export function parseMeshCoreContactToken(text: string): MeshCoreContactToken | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const re = new RegExp(`^${TOKEN_RE.source}$`);
  if (!re.test(trimmed)) return null;
  const inner = trimmed.slice(1, -1);
  // Split on ':' at most twice; the name keeps any further ':'.
  const first = inner.indexOf(':');
  const second = inner.indexOf(':', first + 1);
  if (first < 0 || second < 0) return null;
  const keyHex = inner.slice(0, first);
  const typeText = inner.slice(first + 1, second);
  const name = inner.slice(second + 1).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) return null;
  if (!/^\d+$/.test(typeText)) return null;
  const type = Number(typeText);
  if (!isMeshCoreContactTokenType(type)) return null;
  if (name.length === 0) return null;
  return { publicKey: keyHex.toLowerCase(), type, name };
}

/**
 * Every valid token in a message, in order. Text that looks like a token but
 * fails validation (e.g. type 4) is skipped and stays plain text.
 */
export function extractMeshCoreContactTokens(text: string): MeshCoreContactTokenMatch[] {
  if (typeof text !== 'string' || text.indexOf('<') < 0) return [];
  const out: MeshCoreContactTokenMatch[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = parseMeshCoreContactToken(m[0]);
    if (!token || m.index === undefined) continue;
    out.push({ token, raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Build a token. Returns null when the inputs cannot make a valid one: key not
 * 64 hex, type not 1-3, or a name that is blank once '>' (and any line break,
 * which would split the message) is removed.
 */
export function formatMeshCoreContactToken(input: {
  publicKey: string;
  type: number;
  name: string;
}): string | null {
  const key = typeof input.publicKey === 'string' ? input.publicKey.trim() : '';
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return null;
  if (!isMeshCoreContactTokenType(input.type)) return null;
  const name = (typeof input.name === 'string' ? input.name : '')
    .replace(/>/g, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (name.length === 0) return null;
  return `<${key.toUpperCase()}:${input.type}:${name}>`;
}

/** Text and token pieces of a message, in order, for rendering. */
export type MeshCoreContactTokenSegment =
  | { kind: 'text'; text: string }
  | { kind: 'token'; match: MeshCoreContactTokenMatch };

export function splitMeshCoreContactTokens(text: string): MeshCoreContactTokenSegment[] {
  const matches = extractMeshCoreContactTokens(text);
  if (matches.length === 0) return [{ kind: 'text', text }];
  const out: MeshCoreContactTokenSegment[] = [];
  let last = 0;
  for (const match of matches) {
    if (match.start > last) out.push({ kind: 'text', text: text.slice(last, match.start) });
    out.push({ kind: 'token', match });
    last = match.end;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
