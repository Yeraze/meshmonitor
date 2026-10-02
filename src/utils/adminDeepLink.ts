/**
 * Admin Commands deep-link build/parse (#5535).
 *
 * `/source/:sourceId/admin?node=!xxxxxxxx` opens the Admin Commands tab with
 * that node pre-selected. The Admin Commands tab is NOT a top-level route
 * (unlike `/reports`, which `coverageDeepLink.ts` targets) — it only exists
 * nested under `source/:sourceId/*` (`SourceApp` in `src/main.tsx`), which
 * mounts the legacy Meshtastic `<App>` shell, whose own `<Routes>` declares
 * `path="admin"` (`App.tsx` ~3625). A bare `/admin` falls through to
 * `src/main.tsx`'s top-level `path="*"` (`DashboardPage`) instead — caught by
 * review on the first cut of this file, which built that absolute path.
 *
 * Pure, no router dependency — `AdminCommandsTab.tsx` reads
 * `window.location.search` directly (not `useSearchParams()`, since that tab
 * is also exercised by tests rendered outside a Router) through
 * `parseAdminDeepLink`, which only looks at the query string and doesn't
 * care about the path prefix; `RemoteAdminLink.tsx` calls
 * `buildAdminCommandsPath`.
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
 * Build the Admin Commands tab path for `link`, nested under the given
 * source (required — the route doesn't exist without one). `node` is
 * lower-cased (canonical form); omitted entirely from the query string when
 * absent.
 */
export function buildAdminCommandsPath(sourceId: string, link: AdminDeepLink = {}): string {
  const base = `/source/${encodeURIComponent(sourceId)}/admin`;
  if (!link.node) return base;
  const params = new URLSearchParams();
  params.set('node', link.node.toLowerCase());
  return `${base}?${params.toString()}`;
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
