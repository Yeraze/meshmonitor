/**
 * Push subscription renewal for the service worker (#5863).
 *
 * Lives outside `sw.ts` so tests can drive it: the service worker pulls in
 * Workbox, which does not load under Vitest.
 *
 * The SW does not know which sources the browser subscribed on, so it sends
 * the OLD endpoint to `/api/push/renew` and the server copies the sources from
 * the old rows. Without an old endpoint there is nothing to look up; the user
 * re-subscribes from the Notifications tab, which then shows them as not
 * subscribed. URLs resolve against the registration scope so a BASE_URL
 * sub-path deployment reaches the server.
 */

export interface PushRenewalEvent {
  oldSubscription?: { endpoint: string; options?: PushSubscriptionOptionsInit } | null;
  newSubscription?: PushSubscription | null;
}

export interface PushRenewalDeps {
  scope: string;
  pushManager: Pick<PushManager, 'subscribe'>;
  fetch: typeof fetch;
}

export type PushRenewalResult =
  | { status: 'renewed'; renewed: number; skipped: number }
  | { status: 'no-old-endpoint' };

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Re-subscribe and move this browser's server rows to the new endpoint.
 * Throws on any failure, including an HTTP error status.
 */
export async function renewPushSubscription(
  event: PushRenewalEvent,
  deps: PushRenewalDeps,
): Promise<PushRenewalResult> {
  const oldEndpoint = event.oldSubscription?.endpoint;
  // Check first: with nothing to renew, a fresh subscription would hold no
  // server rows. The Notifications tab subscribes again when the user asks.
  if (!oldEndpoint) {
    return { status: 'no-old-endpoint' };
  }

  const subscription = event.newSubscription
    ?? await deps.pushManager.subscribe(event.oldSubscription?.options || { userVisibleOnly: true });

  const p256dh = subscription.getKey('p256dh');
  const auth = subscription.getKey('auth');
  if (!p256dh || !auth) {
    throw new Error('Missing subscription keys');
  }

  // Every API POST needs a CSRF token from this browser's session.
  const tokenRes = await deps.fetch(new URL('api/csrf-token', deps.scope).href, {
    credentials: 'same-origin',
  });
  if (!tokenRes.ok) {
    throw new Error(`CSRF token request failed: HTTP ${tokenRes.status}`);
  }
  const { csrfToken } = await tokenRes.json() as { csrfToken: string };

  const res = await deps.fetch(new URL('api/push/renew', deps.scope).href, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({
      oldEndpoint,
      subscription: {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: arrayBufferToBase64(p256dh),
          auth: arrayBufferToBase64(auth),
        },
      },
    }),
  });
  // fetch() resolves on an HTTP error, so check the status explicitly.
  if (!res.ok) {
    throw new Error(`Renewal rejected: HTTP ${res.status}`);
  }
  const result = await res.json() as { renewed?: number; skipped?: number };
  return { status: 'renewed', renewed: result.renewed ?? 0, skipped: result.skipped ?? 0 };
}
