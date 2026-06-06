/**
 * @vitest-environment jsdom
 *
 * Source-type gating for the NotificationsTab. The same component is mounted
 * for both Meshtastic and MeshCore sources, but MeshCore exposes a different
 * capability set:
 *   - battery is reported as a voltage (mV), not a percentage
 *   - channel/DM/emoji/MQTT/traceroute/new-node notifications do not fire
 * so those controls must be hidden when sourceType === 'meshcore'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => <>{i18nKey}</>,
}));

vi.mock('./SectionNav', () => ({ default: () => <div data-testid="section-nav" /> }));

vi.mock('./ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Saved preferences with low-battery monitoring on, so both threshold inputs
// would render if the component weren't gating them by source type.
const SAVED_PREFS = {
  enableWebPush: false,
  enableApprise: false,
  enabledChannels: [],
  enableDirectMessages: true,
  notifyOnEmoji: true,
  notifyOnMqtt: true,
  notifyOnNewNode: true,
  notifyOnTraceroute: true,
  notifyOnInactiveNode: false,
  notifyOnLowBattery: true,
  lowBatteryThreshold: 20,
  lowBatteryVoltageThreshold: 3300,
  notifyOnServerEvents: false,
  prefixWithNodeName: false,
  monitoredNodes: [],
  whitelist: [],
  blacklist: [],
  appriseUrls: [],
};

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url.startsWith('/api/push/status')) {
        return Promise.resolve({ configured: false, publicKey: null, subject: null, subscriptionCount: 0 });
      }
      if (url.startsWith('/api/channels')) return Promise.resolve([]);
      if (url.startsWith('/api/nodes')) return Promise.resolve([]);
      if (url.startsWith('/api/push/preferences')) return Promise.resolve({ ...SAVED_PREFS });
      return Promise.resolve({});
    }),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  },
}));

import NotificationsTab from './NotificationsTab';
import { SourceProvider } from '../contexts/SourceContext';

function renderWithSource(sourceType: string) {
  return render(
    <SourceProvider sourceId="src-1" sourceName="Src One" sourceType={sourceType}>
      <NotificationsTab isAdmin={false} />
    </SourceProvider>
  );
}

describe('NotificationsTab — source-type gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // NotificationsTab reads window.matchMedia on every render (PWA check).
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  it('MeshCore: shows the mV voltage threshold and hides the % threshold', async () => {
    renderWithSource('meshcore');

    await waitFor(() => {
      expect(document.getElementById('lowBatteryVoltageThreshold')).not.toBeNull();
    });
    expect(document.getElementById('lowBatteryThreshold')).toBeNull();
  });

  it('MeshCore: hides Meshtastic-only notification toggles', async () => {
    renderWithSource('meshcore');

    // Wait until the low-battery section (always present) has rendered.
    await waitFor(() => {
      expect(document.getElementById('lowBatteryVoltageThreshold')).not.toBeNull();
    });

    // These toggles/labels are Meshtastic-only and must not appear for MeshCore.
    expect(screen.queryByText(/notifications\.traceroutes/)).toBeNull();
    expect(screen.queryByText(/notifications\.mqtt_messages/)).toBeNull();
    expect(screen.queryByText(/notifications\.emoji_reactions/)).toBeNull();
    expect(screen.queryByText(/notifications\.direct_messages/)).toBeNull();
    expect(screen.queryByText(/notifications\.keyword_filtering/)).toBeNull();

    // New-node discovery IS supported on MeshCore (contact adverts), so its
    // toggle must remain visible.
    expect(screen.queryByText(/notifications\.new_nodes/)).not.toBeNull();
  });

  it('Meshtastic: shows the % threshold and Meshtastic-only toggles, hides the mV threshold', async () => {
    renderWithSource('meshtastic_tcp');

    await waitFor(() => {
      expect(document.getElementById('lowBatteryThreshold')).not.toBeNull();
    });
    expect(document.getElementById('lowBatteryVoltageThreshold')).toBeNull();
    expect(screen.queryByText(/notifications\.traceroutes/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.keyword_filtering/)).not.toBeNull();
  });
});
