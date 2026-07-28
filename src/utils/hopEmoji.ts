/**
 * Hop-count → emoji mapping, shared by Auto-Acknowledge (meshtasticManager) and
 * the Automation Engine (action.tapback emojiMode=hopCount, {{ trigger.hopEmoji }}).
 *
 * Presentation, not protocol — hence src/utils/ rather than
 * src/server/constants/meshtastic.ts, and shared rather than server-only so the
 * tapback emoji picker uses the same glyphs. There must be exactly ONE copy of
 * this table in the repo.
 *
 * 0 hops is *️⃣ (asterisk keycap = "direct"), NOT 0️⃣. 7 and above clamp to 7️⃣
 * (Meshtastic's hop_limit maxes at 7).
 */
export const HOP_COUNT_EMOJIS = ['*️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'] as const;

/** Highest hop count with a distinct glyph; anything above clamps to it. */
export const HOP_EMOJI_MAX = 7;

/**
 * Emoji for a hop count, or `undefined` when the hop count is unknown.
 *
 * - null / undefined / non-finite → `undefined` (caller decides)
 * - negative (a malformed hopStart < hopLimit packet) → clamped to 0 → `*️⃣`
 * - fractional → truncated toward zero
 * - >= HOP_EMOJI_MAX → `7️⃣`
 *
 * Returning `undefined` rather than `*️⃣` for "unknown" is deliberate: telling a
 * range-tester they were direct when we do not know the hop count is a lie, and
 * both engine call sites have a meaningful "unknown" branch.
 */
export function hopCountEmoji(hops: number | null | undefined): string | undefined {
  if (hops == null || !Number.isFinite(hops)) return undefined;
  return HOP_COUNT_EMOJIS[Math.min(Math.max(Math.trunc(hops), 0), HOP_EMOJI_MAX)];
}
