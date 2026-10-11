/**
 * MeshCore `@[Name]` mentions.
 *
 * MeshCore has no protocol field for a mention. Its clients write the node's
 * display name between `@[` and `]`, so the only thing to match on is the
 * name. Meshtastic's `@!hex` form is separate: see `mentions.ts`.
 */

/** A fresh regex each call: a shared `/g` regex carries `lastIndex` between callers. */
const mentionRegex = (): RegExp => /@\[([^\]\n]{1,64})\]/g;

/** Every name mentioned in a message, trimmed, in order, without repeats (case kept). */
export function meshcoreMentionedNames(text: string | null | undefined): string[] {
  if (!text) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(mentionRegex())) {
    const name = match[1].trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Whether a message mentions one node by name. The whole name must match,
 * ignoring case and outer spaces: `@[Bob]` does not mention "Bobby".
 */
export function textMentionsMeshCoreName(text: string | null | undefined, name: string | null | undefined): boolean {
  const wanted = (name ?? '').trim().toLowerCase();
  if (!wanted) return false;
  return meshcoreMentionedNames(text).some((n) => n.toLowerCase() === wanted);
}
