/**
 * Parse the reply to a repeater's `get name`.
 *
 * A MeshCore repeater answers CLI verbs through an interactive serial console,
 * so the same value arrives in more than one shape depending on the firmware
 * build and on how far the console got through its boot:
 *
 *     "  -> > LT-KM Seniava 44"   prompt, caret prompt, value
 *     "  -> LT-KM Seniava 44"     single prompt
 *     "LT-KM Seniava 44"          no prompt (stripped further up the stack)
 *
 * A console that is still booting (or firmware without the verb) answers
 * "Unknown command" instead, and the command echo can also land in the buffer.
 *
 * `refreshLocalNode()` used to match the two-prompt form only, with a single
 * `/->\s*>\s*(.+)/`, and fell back to "Unknown Repeater" for every other shape.
 * Right after a power cycle or a USB re-plug that fallback is what the UI and
 * the API showed for a repeater that has a perfectly good name.
 */

// Any number of prompt markers ("->", ">"), with the padding the console adds.
const PROMPT_PREFIX = /^\s*(?:(?:->|>)\s*)+/;
const ECHOED_COMMAND = /^get\s+name$/i;
const UNKNOWN_COMMAND = /^unknown command\b/i;
const BARE_PROMPT = /^[->\s]+$/;
const QUOTED = /^"(.*)"$/;

/**
 * Reduce a `get name` reply to the repeater's name.
 *
 * Prompt markers, the echoed command, bare prompts and "Unknown command"
 * noise are dropped; the last remaining line is the value, with one pair of
 * surrounding quotes removed if the firmware wrapped it.
 *
 * Returns `null` when the reply carries no usable name, so the caller can
 * retry or fall back to its placeholder.
 */
export function parseRepeaterNameResponse(response: string | null | undefined): string | null {
  if (typeof response !== 'string') return null;

  const lines = response
    .split(/\r?\n|\r/)
    .map((line) => line.replace(PROMPT_PREFIX, '').trim())
    .filter((line) => line.length > 0)
    .filter((line) => !BARE_PROMPT.test(line))
    .filter((line) => !ECHOED_COMMAND.test(line))
    .filter((line) => !UNKNOWN_COMMAND.test(line));

  if (lines.length === 0) return null;

  const name = lines[lines.length - 1].replace(QUOTED, '$1').trim();
  return name.length > 0 ? name : null;
}
