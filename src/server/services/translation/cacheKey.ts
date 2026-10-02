/**
 * Translation cache key derivation (#5520).
 *
 * The shared `translation_cache` table is keyed by a sha256 of the normalized
 * text plus the target (and, if explicit, source) language. Only the hash is
 * stored — never the text — so the table cannot be read back into message
 * content.
 */
import { createHash } from 'crypto';

/**
 * Normalize message text for cache keying: Unicode NFC, trim, collapse
 * internal whitespace runs to a single space. Case is kept — "Hi" and "hi"
 * may translate differently (and a proper noun can depend on it).
 */
export function normalizeTranslationText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/**
 * Normalize a source-language hint for keying: `auto`, empty or missing all
 * mean "auto-detect" and key identically (`null`).
 */
export function normalizeSourceLang(sourceLang: string | null | undefined): string | null {
  if (!sourceLang) return null;
  const trimmed = sourceLang.trim().toLowerCase();
  if (!trimmed || trimmed === 'auto') return null;
  return trimmed;
}

/** Lowercased, trimmed target-language code. */
export function normalizeTargetLang(targetLang: string): string {
  return targetLang.trim().toLowerCase();
}

/**
 * sha256 hex of the tuple (normalized text, target language, source language
 * or null).
 *
 * The tuple is JSON-encoded rather than joined with '\0' as the spec sketch
 * says: mesh text can itself contain NUL, and a plain join lets the text
 * `"a\0en"` → `es` collide with `"a"` → `en` from `es` — one message could
 * then poison another's cache entry. JSON encoding is injective.
 */
export function computeTranslationCacheKey(
  text: string,
  targetLang: string,
  sourceLang?: string | null,
): string {
  const tuple = [normalizeTranslationText(text), normalizeTargetLang(targetLang), normalizeSourceLang(sourceLang)];
  return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
}

/**
 * Language codes the cache and link tables accept: an ISO 639 primary subtag
 * with an optional region/script subtag (`en`, `pt-BR`, `zh-Hant`), at most
 * 16 characters (the MySQL column width).
 */
const LANG_CODE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

export function isValidLangCode(code: unknown): code is string {
  return typeof code === 'string' && code.length <= 16 && LANG_CODE_RE.test(code);
}
