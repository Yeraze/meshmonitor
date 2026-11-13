/**
 * Node-name anti-spam sanitizer (#6382) — the pure part.
 *
 * Some mesh users put invite links (Telegram and friends) in their node
 * names. When the operator opts in, MeshMonitor replaces just the link with a
 * placeholder before the name reaches the database:
 *
 *   `NodeName t.me/spam`  →  `NodeName [spammer]`
 *
 * Matching runs on a normalised copy of the name: full-width characters fold
 * to ASCII (NFKC), zero-width characters drop out, and the host patterns allow
 * spaced or bracketed dots (`t . me`, `t[.]me`). Each character of the copy
 * maps back to its place in the original, so only the matched span is
 * replaced and the rest of the name keeps its exact spelling.
 *
 * Admin patterns compile through RE2 (`compileUserRegex`), so a stored
 * pattern cannot cause catastrophic backtracking. A plain host entry
 * (`spam.example`) is treated like a built-in host instead.
 *
 * The runtime state (cached rules, hit counter, local-node bypass) lives in
 * `nodeNameSanitizerRuntime.ts`.
 */
import { compileUserRegex } from './safeRegex.js';
import {
  BUILTIN_SPAM_HOSTS,
  DEFAULT_NODE_NAME_PLACEHOLDER,
  MAX_CUSTOM_PATTERNS,
  MAX_CUSTOM_PATTERN_LENGTH,
  MAX_PLACEHOLDER_BYTES,
  MESHTASTIC_LONG_NAME_MAX_LIMIT,
  MESHTASTIC_LONG_NAME_MIN_LIMIT,
  NODE_NAME_SANITIZE_BUILTINS,
  NODE_NAME_SANITIZE_CUSTOM_PATTERNS,
  NODE_NAME_SANITIZE_ENABLED,
  NODE_NAME_SANITIZE_PLACEHOLDER,
  parseCustomPatternList,
  utf8ByteLength,
} from './nodeNameSanitizerConstants.js';

export interface CompiledNameRule {
  /** Stable id for logs: `builtin:url`, `builtin:host:t.me`, `custom:2`. Never the spam text. */
  id: string;
  /** Global-flag matcher (a native RegExp or an RE2 instance). */
  regex: RegExp;
}

export interface NameSanitizerRules {
  rules: CompiledNameRule[];
  placeholder: string;
}

export interface SanitizeResult {
  value: string;
  changed: boolean;
  /** The first rule that matched, or null. */
  matchedRule: string | null;
}

// ─── Normalisation ─────────────────────────────────────────────────────────

// Zero-width and invisible format code points spammers use to split a host.
// Ranges, not a regex character class: several of these are combining or
// whitespace-like characters that make a literal class unreadable.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
];

function isInvisible(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

interface Normalised {
  text: string;
  /** For each UTF-16 unit of `text`: the [start, end) span it came from in the original. */
  starts: number[];
  ends: number[];
}

function normalise(original: string): Normalised {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of original) {
    const len = ch.length;
    if (!isInvisible(ch)) {
      const folded = ch.normalize('NFKC');
      for (let k = 0; k < folded.length; k++) {
        starts.push(i);
        ends.push(i + len);
      }
      text += folded;
    }
    i += len;
  }
  return { text, starts, ends };
}

// ─── Rule construction ─────────────────────────────────────────────────────

/** One dot, written any of the usual ways: `.`, `\u3002`, ` . `, `[.]`, `(.)`, `[dot]`, `(dot)`. */
const DOT = String.raw`\s*(?:[.\u3002]|\[\s*(?:[.\u3002]|dot)\s*\]|\(\s*(?:[.\u3002]|dot)\s*\))\s*`;

function escapeLabel(label: string): string {
  // Labels hold only [a-z0-9-] (see PLAIN_HOST); '-' needs no escape outside a class.
  return label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pattern for an invite host followed by `/` and the handle:
 * `t.me/x`, `https://t.me/x`, `www.t.me/x`, `t . me / x`.
 */
function hostPattern(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean).map(escapeLabel);
  return String.raw`(?<![\p{L}\p{N}_])(?:https?:\/\/)?(?:www${DOT})?` + labels.join(DOT) + String.raw`\s*\/[^\s]*`;
}

function hostRegex(host: string): RegExp {
  return new RegExp(hostPattern(host), 'giu');
}

/** `https://…` / `http://…` up to the next whitespace. */
const URL_RULE: CompiledNameRule = { id: 'builtin:url', regex: /\bhttps?:\/\/[^\s]+/giu };

const BUILTIN_RULES: CompiledNameRule[] = [
  ...BUILTIN_SPAM_HOSTS.map((h) => ({ id: `builtin:host:${h}`, regex: hostRegex(h) })),
  URL_RULE,
];

/** A bare host such as `spam.example` or `spam.example/`. */
const PLAIN_HOST = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*)\/?$/i;

/**
 * Compile one admin entry. A plain host becomes a host rule (with the same
 * obfuscation handling as the built-ins); anything else is an RE2 regex.
 * Throws on an invalid or over-long pattern.
 */
export function compileCustomPattern(entry: string, index: number): CompiledNameRule {
  const pattern = entry.trim();
  if (pattern.length === 0) throw new Error('Pattern is empty');
  if (pattern.length > MAX_CUSTOM_PATTERN_LENGTH) {
    throw new Error(`Pattern is longer than ${MAX_CUSTOM_PATTERN_LENGTH} characters`);
  }
  const host = PLAIN_HOST.exec(pattern);
  if (host) return { id: `custom:${index}`, regex: hostRegex(host[1]) };
  const regex = compileUserRegex(pattern, 'gi');
  // A pattern that matches the empty string would "match" every name.
  regex.lastIndex = 0;
  const empty = regex.exec('');
  regex.lastIndex = 0;
  if (empty && empty[0] === '') throw new Error('Pattern matches an empty name');
  return { id: `custom:${index}`, regex };
}

// ─── Settings parsing ──────────────────────────────────────────────────────

export interface NodeNameSanitizerConfig {
  enabled: boolean;
  builtins: boolean;
  customPatterns: string[];
  placeholder: string;
}

/** Strict boolean with a default for an absent value. */
function parseBool(raw: string | null | undefined, dflt: boolean): boolean {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return dflt;
}

/** Read the four stored settings. Off by default; built-ins on by default. */
export function parseNodeNameSanitizerConfig(
  settings: Record<string, string | null | undefined>,
): NodeNameSanitizerConfig {
  const placeholder = (settings[NODE_NAME_SANITIZE_PLACEHOLDER] ?? '').trim();
  return {
    enabled: parseBool(settings[NODE_NAME_SANITIZE_ENABLED], false),
    builtins: parseBool(settings[NODE_NAME_SANITIZE_BUILTINS], true),
    customPatterns: parseCustomPatternList(settings[NODE_NAME_SANITIZE_CUSTOM_PATTERNS]),
    placeholder: placeholder || DEFAULT_NODE_NAME_PLACEHOLDER,
  };
}

/**
 * Build the rule set. An invalid stored pattern is skipped (and reported in
 * `skipped`) so one bad row can never turn the whole filter off.
 */
export function buildNameSanitizerRules(config: NodeNameSanitizerConfig): {
  rules: NameSanitizerRules;
  skipped: number[];
} {
  const rules: CompiledNameRule[] = config.builtins ? [...BUILTIN_RULES] : [];
  const skipped: number[] = [];
  config.customPatterns.forEach((p, i) => {
    try {
      rules.push(compileCustomPattern(p, i));
    } catch {
      skipped.push(i);
    }
  });
  return { rules: { rules, placeholder: config.placeholder }, skipped };
}

/**
 * Validate the sanitizer keys of a settings POST. Returns an error message,
 * or null when every present key is valid.
 */
export function validateNodeNameSanitizerSettings(settings: Record<string, string>): string | null {
  for (const key of [NODE_NAME_SANITIZE_ENABLED, NODE_NAME_SANITIZE_BUILTINS]) {
    if (key in settings && settings[key] !== 'true' && settings[key] !== 'false') {
      return `${key} must be the boolean true or false`;
    }
  }
  if (NODE_NAME_SANITIZE_PLACEHOLDER in settings) {
    const p = settings[NODE_NAME_SANITIZE_PLACEHOLDER].trim();
    if (utf8ByteLength(p) > MAX_PLACEHOLDER_BYTES) {
      return `${NODE_NAME_SANITIZE_PLACEHOLDER} must be at most ${MAX_PLACEHOLDER_BYTES} bytes`;
    }
    if (Array.from(p).some((ch) => { const c = ch.codePointAt(0) ?? 0; return c < 0x20 || c === 0x7f; })) {
      return `${NODE_NAME_SANITIZE_PLACEHOLDER} must not contain control characters`;
    }
  }
  if (NODE_NAME_SANITIZE_CUSTOM_PATTERNS in settings) {
    const raw = settings[NODE_NAME_SANITIZE_CUSTOM_PATTERNS];
    let parsed: unknown;
    try {
      parsed = raw === '' ? [] : JSON.parse(raw);
    } catch {
      return `${NODE_NAME_SANITIZE_CUSTOM_PATTERNS} must be a JSON array of strings`;
    }
    if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string')) {
      return `${NODE_NAME_SANITIZE_CUSTOM_PATTERNS} must be a JSON array of strings`;
    }
    if (parsed.length > MAX_CUSTOM_PATTERNS) {
      return `At most ${MAX_CUSTOM_PATTERNS} custom patterns are allowed`;
    }
    for (let i = 0; i < parsed.length; i++) {
      const p = (parsed[i] as string).trim();
      if (p === '') continue;
      try {
        compileCustomPattern(p, i);
      } catch (err) {
        const why = err instanceof Error ? err.message : 'invalid';
        return `Custom pattern ${i + 1} is invalid: ${why}`;
      }
    }
  }
  return null;
}

// ─── Sanitising ────────────────────────────────────────────────────────────

/** True when a gap holds only whitespace and invisible characters. */
function isBlankGap(gap: string): boolean {
  for (const ch of gap) {
    if (!/\s/u.test(ch) && !isInvisible(ch)) return false;
  }
  return true;
}

/** Every match of a global regex as [start, end) in `text`. Skips empty matches. */
function findAll(regex: RegExp, text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  regex.lastIndex = 0;
  let guard = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null && guard++ < 1000) {
    if (m[0].length === 0) {
      regex.lastIndex = m.index + 1;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  regex.lastIndex = 0;
  return out;
}

/** Drop code points from the end of the last non-empty text token until the name fits. */
function trimToBytes(tokens: Array<{ ph: boolean; text: string }>, maxBytes: number): void {
  const render = () => tokens.filter((t) => t.text !== '').map((t) => t.text).join(' ');
  while (utf8ByteLength(render()) > maxBytes) {
    const last = [...tokens].reverse().find((t) => !t.ph && t.text !== '');
    if (!last) return; // only placeholders left: the placeholder is never cut
    const cps = Array.from(last.text);
    cps.pop();
    last.text = cps.join('').trimEnd();
  }
}

/**
 * Replace every rule match in `name` with the placeholder. Matches separated
 * only by whitespace share one placeholder. Leftover whitespace collapses to
 * single spaces. When `maxBytes` is set and the result is too long, the kept
 * text is trimmed from the end; the placeholder never is.
 */
export function sanitizeNodeName(
  name: string,
  rules: NameSanitizerRules,
  opts: { maxBytes?: number } = {},
): SanitizeResult {
  if (!name || rules.rules.length === 0) return { value: name, changed: false, matchedRule: null };

  const norm = normalise(name);
  const spans: Array<[number, number]> = [];
  let matchedRule: string | null = null;
  for (const rule of rules.rules) {
    const hits = findAll(rule.regex, norm.text);
    if (hits.length === 0) continue;
    matchedRule ??= rule.id;
    for (const [s, e] of hits) spans.push([norm.starts[s], norm.ends[e - 1]]);
  }
  if (spans.length === 0) return { value: name, changed: false, matchedRule: null };

  // Merge overlapping spans, and spans with only whitespace / invisible
  // characters between them.
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && (span[0] <= prev[1] || isBlankGap(name.slice(prev[1], span[0])))) {
      prev[1] = Math.max(prev[1], span[1]);
    } else {
      merged.push([span[0], span[1]]);
    }
  }

  const tokens: Array<{ ph: boolean; text: string }> = [];
  let cursor = 0;
  for (const [s, e] of merged) {
    tokens.push({ ph: false, text: name.slice(cursor, s).replace(/\s+/g, ' ').trim() });
    tokens.push({ ph: true, text: rules.placeholder });
    cursor = e;
  }
  tokens.push({ ph: false, text: name.slice(cursor).replace(/\s+/g, ' ').trim() });

  if (opts.maxBytes !== undefined) trimToBytes(tokens, opts.maxBytes);

  const value = tokens.filter((t) => t.text !== '').map((t) => t.text).join(' ') || rules.placeholder;
  return { value, changed: value !== name, matchedRule };
}

/** Byte limit for a Meshtastic long name: 24 (fw 2.8), up to 39 if the original was longer. */
export function meshtasticLongNameLimit(original: string): number {
  return Math.min(MESHTASTIC_LONG_NAME_MAX_LIMIT, Math.max(MESHTASTIC_LONG_NAME_MIN_LIMIT, utf8ByteLength(original)));
}
