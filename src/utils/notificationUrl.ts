/**
 * Deep-link URL construction for push notification clicks.
 *
 * Lives outside `src/sw.ts` so the service worker and the tests share one
 * implementation — the previous tests re-implemented the URL logic inline and
 * therefore could not catch a regression in it (#4463).
 */

export interface NotificationNavigationData {
  type: 'channel' | 'dm';
  /** Source the message belongs to. Absent on pre-4.13.4 payloads. */
  sourceId?: string;
  channelId?: number;
  messageId?: string;
  senderNodeId?: string;
}

/** Query parameter carrying the serialized navigation payload. */
export const NOTIFICATION_NAV_PARAM = 'notificationNav';

/** Route tab that handles each notification type. */
export function tabForNavigation(navigationData: NotificationNavigationData): 'messages' | 'channels' {
  return navigationData.type === 'dm' ? 'messages' : 'channels';
}

/**
 * Build the URL to open for a notification click.
 *
 * The app is path-routed (`<base>/source/:sourceId/<tab>`, see src/main.tsx).
 * The scope root falls through to `path="*"` → DashboardPage, which never
 * mounts the notification-navigation handler — so opening the root loses the
 * navigation entirely (#4463). Target the real route instead, and carry the
 * payload in the query string, since the app no longer routes on the hash.
 *
 * Payloads without a `sourceId` (older notifications still in flight, or a
 * push from a build that predates this change) fall back to the scope root
 * with the payload attached, so an already-loaded source view can still use it.
 *
 * @param scope Registration scope — an absolute URL ending in `/`.
 */
export function buildNotificationUrl(
  scope: string,
  navigationData?: NotificationNavigationData | null
): string {
  if (!navigationData) return scope;

  const params = new URLSearchParams();
  params.set(NOTIFICATION_NAV_PARAM, JSON.stringify(navigationData));
  const query = params.toString();

  if (!navigationData.sourceId) {
    return `${scope}?${query}`;
  }

  const path = `source/${encodeURIComponent(navigationData.sourceId)}/${tabForNavigation(navigationData)}`;
  return `${scope}${path}?${query}`;
}
