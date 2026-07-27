import { VALID_TABS, type TabType } from '../types/ui';

/**
 * Hash->path redirect shim (#3962 Phase 5.4 PR1, kept >= 1 release for
 * bookmark/embed compatibility). Tabs inside a Meshtastic source view used to
 * be tracked via URL hash (`#nodes`, `#messages`, …, UIContext's old
 * `getTabFromHash`/`updateHash`); they are now path segments
 * (`…/source/:sourceId/nodes`) derived by UIContext's activeTab<->route
 * adapter.
 *
 * Existing bookmarks/deep-links of the form `…/source/:sourceId#nodes` (a
 * bare source path plus a recognized tab hash) — and a few internal
 * `navigate()` calls that still build that shape (DashboardPage's "seen by"
 * source jump + MQTT bridge "Configuration" button, MapAnalysis
 * NodeMarkersLayer's "seen by" jump, both using `#messages`/`#mqtt-config`) —
 * need to redirect to the path-based equivalent.
 *
 * Pure so it can be pin-tested without mounting App. Returns the redirect
 * target path, or null when no redirect is needed (already path-based tab,
 * unrecognized hash, or not a bare source path).
 */
export function getHashTabRedirectTarget(pathname: string, hash: string): string | null {
  const hashTab = hash.startsWith('#') ? hash.slice(1) : hash;
  const isBareSourcePath = /^\/source\/[^/]+\/?$/.test(pathname);
  if (!isBareSourcePath || !VALID_TABS.includes(hashTab as TabType)) {
    return null;
  }
  const base = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return `${base}/${hashTab}`;
}
