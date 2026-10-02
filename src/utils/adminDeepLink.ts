/**
 * Admin Commands deep-link build/parse (#5535).
 *
 * `/admin?node=!xxxxxxxx` opens the Admin Commands tab with that node
 * pre-selected. Pure, no router dependency — `AdminCommandsTab.tsx` reads
 * `window.location.search` directly (not `useSearchParams()`, since that
 * tab is also exercised by tests rendered outside a Router) through
 * `parseAdminDeepLink`; `RemoteAdminLink.tsx` calls `buildAdminCommandsPath`.
 * Mirrors `coverageDeepLink.ts`'s shape.
 *
 * Untrusted input (a URL query param) is validated strictly: anything that
 * doesn't match the expected shape is dropped rather than passed through.
 *
 * `src/utils/**` is in `tsconfig.server.json`'s include set, so relative
 * imports need an explicit `.js` extension (#4596) — this file has none.
 */

/** `!xxxxxxxx`, lowercase hex (8 digits) — the Meshtastic node id shape. */
const NODE_ID_RE = /^![0-9a-f]{8}$/;

export interface AdminDeepLink {
  /** Lower-cased `!xxxxxxxx` Meshtastic node id. */
  node?: string;
}

/**
 * Build the Admin Commands tab path for `link`. `node` is lower-cased
 * (canonical form); omitted entirely from the query string when absent.
 */
export function buildAdminCommandsPath(link: AdminDeepLink): string {
  if (!link.node) return '/admin';
  const params = new URLSearchParams();
  params.set('node', link.node.toLowerCase());
  return `/admin?${params.toString()}`;
}

/**
 * Parse `params` into an {@link AdminDeepLink}, or `null` when `node` is
 * missing or doesn't match the expected `!xxxxxxxx` shape (case-insensitive;
 * stored lower-cased). Anything else is silently dropped — never forwarded
 * to node-selection logic.
 */
export function parseAdminDeepLink(params: URLSearchParams): AdminDeepLink | null {
  const nodeRaw = params.get('node');
  if (!nodeRaw) return null;

  const lowered = nodeRaw.toLowerCase();
  if (!NODE_ID_RE.test(lowered)) return null;

  return { node: lowered };
}
