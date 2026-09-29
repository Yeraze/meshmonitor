/**
 * Maps a detected language tag (a BCP 47 browser tag such as "zh-CN", or a
 * saved choice such as "zh_Hans") onto one of the locale codes we ship.
 *
 * Our locale files use Weblate's underscore codes ("zh_Hans", "pt_BR"), while
 * browsers report hyphenated BCP 47 tags ("zh-Hans", "pt-BR", or a region-only
 * "zh-CN"). i18next cannot relate the two on its own: it only strips a
 * hyphenated region, so "zh-CN" became "zh", matched nothing, and a Chinese
 * browser got English even though we ship Simplified Chinese.
 *
 * Rules, in order:
 *   1. A code we ship is returned unchanged, so a saved choice always wins.
 *   2. The same tag with "-" for "_", matched case-insensitively
 *      ("zh-Hans" -> "zh_Hans", "pt-BR" -> "pt_BR" if shipped).
 *   3. Chinese by script or region: Hant/TW/HK/MO -> Traditional,
 *      anything else (Hans/CN/SG/bare "zh") -> Simplified, when shipped.
 *   4. Otherwise the tag is returned as-is, and i18next's `supportedLngs`
 *      matching reduces it to its base language ("en-US" -> "en") or falls
 *      back to English.
 *
 * Kept free of i18next so it can be unit-tested without initialising it.
 */

const TRADITIONAL_CHINESE_SUBTAGS = new Set(['hant', 'tw', 'hk', 'mo']);

export function toShippedLanguage(tag: string, shipped: readonly string[]): string {
  if (!tag) return tag;
  if (shipped.includes(tag)) return tag;

  const underscored = tag.replace(/-/g, '_').toLowerCase();
  const direct = shipped.find((code) => code.toLowerCase() === underscored);
  if (direct) return direct;

  const [language, ...subtags] = underscored.split('_');
  if (language === 'zh') {
    const traditional = subtags.some((s) => TRADITIONAL_CHINESE_SUBTAGS.has(s));
    const target = traditional ? 'zh_Hant' : 'zh_Hans';
    if (shipped.includes(target)) return target;
  }

  return tag;
}
