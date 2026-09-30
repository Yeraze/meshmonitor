/**
 * @vitest-environment jsdom
 *
 * Web Push subscription state is per source (#5493).
 *
 * A browser has ONE push endpoint per origin, shared by every source it
 * subscribed on. So:
 *  - "Subscribed" must come from the server's answer for THIS source, not
 *    from pushManager.getSubscription() alone;
 *  - Unsubscribe removes this source's row first, and only kills the browser
 *    endpoint when no other source still uses it;
 *  - "Unsubscribe from all sources" removes every row, then the endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../test/mockI18n');
  return createReactI18nextMock(undefined, {
    Trans: ({ i18nKey }: { i18nKey?: string }) => <>{i18nKey}</>,
  });
});

vi.mock('./SectionNav', () => ({ default: () => <div data-testid="section-nav" /> }));
vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const h = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url.startsWith('/api/push/status')) {
        return Promise.resolve({ configured: true, publicKey: 'pk', subject: null, subscriptionCount: 0 });
      }
      if (url.startsWith('/api/push/vapid-key')) return Promise.resolve({ publicKey: 'BPubKeyBase64Url' });
      if (url.startsWith('/api/channels')) return Promise.resolve([]);
      if (url.startsWith('/api/nodes')) return Promise.resolve([]);
      // The Web Push panel only renders with Web Push enabled.
      if (url.startsWith('/api/push/preferences')) return Promise.resolve({ enableWebPush: true });
      return Promise.resolve({});
    }),
    post: h.post,
    put: vi.fn().mockResolvedValue({}),
  },
}));

import NotificationsTab from './NotificationsTab';
import { SourceProvider } from '../contexts/SourceContext';

const ENDPOINT = 'https://push.example.com/browser';

const browserSub = {
  endpoint: ENDPOINT,
  unsubscribe: vi.fn().mockResolvedValue(true),
  getKey: vi.fn(() => new Uint8Array([1, 2, 3]).buffer),
};

let currentBrowserSub: typeof browserSub | null = browserSub;

function installPushApis() {
  (window as any).Notification = { permission: 'granted', requestPermission: vi.fn() };
  (window as any).PushManager = function PushManager() {};
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn(() => Promise.resolve(currentBrowserSub)),
          subscribe: vi.fn(() => Promise.resolve(browserSub)),
        },
      }),
    },
  });
}

type PostHandler = (url: string, body: any) => any;
function onPost(handler: PostHandler) {
  h.post.mockImplementation((url: string, body: any) => Promise.resolve(handler(url, body) ?? {}));
}

function renderOnSource(sourceId = 'src-1') {
  return render(
    <SourceProvider sourceId={sourceId} sourceName="Src" sourceType="meshtastic_tcp">
      <NotificationsTab isAdmin={false} />
    </SourceProvider>
  );
}

describe('NotificationsTab — per-source Web Push state (#5493)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentBrowserSub = browserSub;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    installPushApis();
  });

  afterEach(() => {
    delete (window as any).Notification;
    delete (window as any).PushManager;
    delete (navigator as any).serviceWorker;
  });

  it('reads "not subscribed" for this source when the server says so, even with a browser endpoint', async () => {
    onPost((url) => (url === '/api/push/subscription-status'
      ? { success: true, subscribed: false, otherSources: 1 }
      : undefined));

    renderOnSource('src-2');

    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/api/push/subscription-status', { endpoint: ENDPOINT, sourceId: 'src-2' });
    });
    await screen.findByText('notifications.subscribe_button');
    expect(screen.queryByText('notifications.unsubscribe_button')).toBeNull();
    // Browser still holds an endpoint, so leaving all sources stays on offer.
    expect(screen.getByText('notifications.unsubscribe_all_button')).toBeTruthy();
  });

  it('reads "subscribed" when the server has a row for this source', async () => {
    onPost((url) => (url === '/api/push/subscription-status'
      ? { success: true, subscribed: true, otherSources: 0 }
      : undefined));

    renderOnSource('src-1');

    await screen.findByText('notifications.unsubscribe_button');
    expect(screen.queryByText('notifications.subscribe_button')).toBeNull();
  });

  it('unsubscribe keeps the browser endpoint while other sources remain', async () => {
    onPost((url) => {
      if (url === '/api/push/subscription-status') return { success: true, subscribed: true, otherSources: 1 };
      if (url === '/api/push/unsubscribe') return { success: true, remainingSources: 1 };
      return undefined;
    });

    renderOnSource('src-1');
    fireEvent.click(await screen.findByText('notifications.unsubscribe_button'));

    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/api/push/unsubscribe', { endpoint: ENDPOINT, sourceId: 'src-1' });
    });
    await screen.findByText('notifications.subscribe_button');
    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribe drops the browser endpoint once no source remains', async () => {
    onPost((url) => {
      if (url === '/api/push/subscription-status') return { success: true, subscribed: true, otherSources: 0 };
      if (url === '/api/push/unsubscribe') return { success: true, remainingSources: 0 };
      return undefined;
    });

    renderOnSource('src-1');
    fireEvent.click(await screen.findByText('notifications.unsubscribe_button'));

    await waitFor(() => expect(browserSub.unsubscribe).toHaveBeenCalledTimes(1));
    // Server row goes first, then the endpoint.
    const unsubCallOrder = h.post.mock.invocationCallOrder[
      h.post.mock.calls.findIndex(([url]) => url === '/api/push/unsubscribe')
    ];
    expect(unsubCallOrder).toBeLessThan(browserSub.unsubscribe.mock.invocationCallOrder[0]);
  });

  it('unsubscribe from all sources calls the server and drops the browser endpoint', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    onPost((url) => {
      if (url === '/api/push/subscription-status') return { success: true, subscribed: true, otherSources: 2 };
      if (url === '/api/push/unsubscribe-all') return { success: true, removed: 3 };
      return undefined;
    });

    renderOnSource('src-1');
    fireEvent.click(await screen.findByText('notifications.unsubscribe_all_button'));

    await waitFor(() => expect(browserSub.unsubscribe).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledWith('/api/push/unsubscribe-all', { endpoint: ENDPOINT });
    confirmSpy.mockRestore();
  });

  it('unsubscribe from all sources does nothing when the user cancels', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    onPost((url) => (url === '/api/push/subscription-status'
      ? { success: true, subscribed: true, otherSources: 0 }
      : undefined));

    renderOnSource('src-1');
    fireEvent.click(await screen.findByText('notifications.unsubscribe_all_button'));

    expect(h.post).not.toHaveBeenCalledWith('/api/push/unsubscribe-all', expect.anything());
    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('subscribing on a second source reuses the browser endpoint and saves a row for this source', async () => {
    onPost((url) => (url === '/api/push/subscription-status'
      ? { success: true, subscribed: false, otherSources: 1 }
      : { success: true }));

    renderOnSource('src-2');
    fireEvent.click(await screen.findByText('notifications.subscribe_button'));

    await waitFor(() => {
      expect(h.post).toHaveBeenCalledWith('/api/push/subscribe', expect.objectContaining({
        sourceId: 'src-2',
        subscription: expect.objectContaining({ endpoint: ENDPOINT }),
      }));
    });
    expect(browserSub.unsubscribe).not.toHaveBeenCalled();
  });

  it('falls back to the browser check when the status request fails', async () => {
    h.post.mockRejectedValue(new Error('network'));

    renderOnSource('src-1');

    await screen.findByText('notifications.unsubscribe_button');
  });

  it('with no browser endpoint, reads not subscribed and skips the status call', async () => {
    currentBrowserSub = null;
    onPost(() => undefined);

    renderOnSource('src-1');

    await screen.findByText('notifications.subscribe_button');
    expect(h.post).not.toHaveBeenCalledWith('/api/push/subscription-status', expect.anything());
    expect(screen.queryByText('notifications.unsubscribe_all_button')).toBeNull();
  });
});
