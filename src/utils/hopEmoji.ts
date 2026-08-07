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

/**
 * Glyph for a message that reached MeshMonitor through an MQTT source
 * (`mqtt_broker` / `mqtt_bridge`) rather than over our own RF link (#4594).
 *
 * Keycap style so it sits visually with `*️⃣`–`7️⃣` rather than beside them; the
 * requester's other suggestion (`🔃`) is a different glyph family and would read
 * as a separate scheme.
 *
 * NOT part of `HOP_COUNT_EMOJIS`: that array is indexed BY hop count and its
 * length is the arity of the hop dimension. This is a value on a different
 * axis (transport), so appending it would make `HOP_COUNT_EMOJIS[8]` mean
 * "8 hops" to every existing index-based consumer (the EmojiPicker titles, the
 * catalog help text, `hopCountEmoji`'s clamp). Kept separate deliberately.
 */
export const MQTT_SOURCE_EMOJI = '#️⃣';

/**
 * Emoji for a received message: the MQTT glyph when it arrived through an MQTT
 * source, otherwise the hop-count glyph.
 *
 * `viaMqttSource` describes the SOURCE the message was ingested through, not
 * Meshtastic's per-packet `via_mqtt` flag. The two are different questions: a
 * packet with `via_mqtt` set can still have reached our own radio over RF (an
 * MQTT gateway node rebroadcast it), and its hop count is meaningful. A message
 * from an `mqtt_bridge`/`mqtt_broker` source never touched our RF link at all,
 * and the hop count it carries is the bridging node's view, not ours. Keying on
 * the source type is also what keeps this change backward-compatible — see the
 * note in `triggerContext.buildMessageContext`.
 *
 * When `viaMqttSource` is true the glyph is returned even if the hop count is
 * unknown: unlike a hop count, "came in over MQTT" is never in doubt. This is
 * the same override `*️⃣` performs for the direct case today.
 */
export function hopOrMqttEmoji(
  hops: number | null | undefined,
  viaMqttSource: boolean | null | undefined,
): string | undefined {
  return viaMqttSource === true ? MQTT_SOURCE_EMOJI : hopCountEmoji(hops);
}
