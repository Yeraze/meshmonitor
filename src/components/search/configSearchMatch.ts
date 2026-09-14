/**
 * The matching rule shared by the in-page section filter (`SectionNav`) and the
 * cross-page configuration palette (`ConfigSearchModal`) — issue #5182.
 *
 * One rule, one module, so the two surfaces cannot drift: a query that finds a
 * section from the palette must also find it once you land on the page.
 *
 * The rule is deliberately dumb: split the query on whitespace and require
 * every token to appear somewhere in the haystack, case-insensitively. No fuzzy
 * matching, no ranking by edit distance. Settings labels are short, mostly
 * single words, and the terms users reach for ("battery", "mqtt", "gps") are
 * substrings of the real label far more often than they are typos of it.
 * Fuzzy matching on a corpus this small mostly produces confident nonsense.
 */

/** Split a raw query into lowercase tokens. An empty query yields no tokens. */
export function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when every token appears in `haystack`.
 *
 * An empty token list matches everything — callers treat "no query" as "no
 * filtering" rather than "no results".
 */
export function matchesQuery(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const lowered = haystack.toLowerCase();
  return tokens.every((token) => lowered.includes(token));
}

/**
 * Rank a matched entry so the palette can order results. Lower is better.
 *
 * Four bands, coarsest first:
 *
 *   0 — the label IS the query
 *   1 — the label starts with the query
 *   2 — every token is somewhere in the label
 *   3 — the label matched none of them, so it got here via a keyword or the
 *       page name
 *
 * The query is compared as one joined string in bands 0 and 1, so "region
 * preset" is ranked against the phrase rather than against each word
 * separately. Anything finer than these four bands would be guesswork on a
 * corpus of eighty short labels.
 */
export function matchRank(label: string, tokens: string[]): number {
  if (tokens.length === 0) return 3;
  const lowered = label.toLowerCase();
  const query = tokens.join(' ');
  if (lowered === query) return 0;
  if (lowered.startsWith(query)) return 1;
  if (tokens.every((token) => lowered.includes(token))) return 2;
  return 3;
}
