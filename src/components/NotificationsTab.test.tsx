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
      // The server row also carries mutes set from the Channels views; this
      // tab must never post them back (it would revert a mute set after load).
      if (url.startsWith('/api/push/preferences')) {
        return Promise.resolve({
          ...SAVED_PREFS,
          mutedChannels: [{ channelId: 2, muteUntil: null }],
          mutedDMs: [{ nodeUuid: '!aaaa', muteUntil: null }],
          sourceFallback: false,
        });
      }
      return Promise.resolve({});
    }),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  },
}));

import NotificationsTab from './NotificationsTab';
import api from '../services/api';
import { SourceProvider } from '../contexts/SourceContext';

function renderWithSource(sourceType: string, meshcoreDeviceType?: number) {
  return render(
    <SourceProvider sourceId="src-1" sourceName="Src One" sourceType={sourceType}>
      <NotificationsTab isAdmin={false} meshcoreDeviceType={meshcoreDeviceType} />
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

  it('MeshCore Companion: hides MQTT, shows DM/trace/emoji/new-node/keywords with MeshCore labels', async () => {
    renderWithSource('meshcore', 1);
    await waitFor(() => {
      expect(document.getElementById('lowBatteryVoltageThreshold')).not.toBeNull();
    });
    expect(screen.queryByText(/notifications\.mqtt_messages/)).toBeNull();
    expect(screen.queryByText(/notifications\.direct_messages_meshcore/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.traceroutes_meshcore/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.emoji_reactions/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.new_nodes/)).not.toBeNull();
    expect(screen.queryByText(/^\s*notifications\.notify_on_mention$/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.keyword_filtering/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.repeater_unsupported_hint/)).toBeNull();
    // M3: the automatic-trace opt-in shows for a Companion, and starts off.
    const autoTrace = screen.getByTestId('notify-on-auto-trace') as HTMLInputElement;
    expect(autoTrace.checked).toBe(false);
    // The learning-window note is Repeater only (#6306).
    expect(screen.queryByText(/notifications\.new_nodes_repeater_note/)).toBeNull();
  });

  it('MeshCore Repeater: hides DM, traceroute and mention, explains why, and shows new-node with its learning note', async () => {
    renderWithSource('meshcore', 2);
    await waitFor(() => {
      expect(document.getElementById('lowBatteryVoltageThreshold')).not.toBeNull();
    });
    expect(screen.queryByText(/notifications\.direct_messages/)).toBeNull();
    expect(screen.queryByText(/notifications\.traceroutes/)).toBeNull();
    expect(screen.queryByTestId('notify-on-auto-trace')).toBeNull();
    // #6306: the new-node toggle is back for a Repeater, with the gate note.
    expect(screen.queryByText(/notifications\.new_nodes(?!_)/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.new_nodes_repeater_note/)).not.toBeNull();
    expect(screen.queryByText(/^\s*notifications\.notify_on_mention$/)).toBeNull();
    expect(screen.queryByText(/notifications\.repeater_unsupported_hint/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.emoji_reactions/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.keyword_filtering/)).not.toBeNull();
  });

  it('MeshCore loads channels from /api/channels/all; Meshtastic from /api/channels', async () => {
    renderWithSource('meshcore', 1);
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/channels/all?sourceId=src-1');
    });
    vi.clearAllMocks();
    renderWithSource('meshtastic_tcp');
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/channels?sourceId=src-1');
    });
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

describe('NotificationsTab — saves send only the fields this tab edits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  const prefPosts = () =>
    (api.post as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === '/api/push/preferences');

  it('Save preferences does not send mute lists (or the GET-only sourceFallback flag)', async () => {
    renderWithSource('meshtastic_tcp');
    await waitFor(() => {
      expect(document.getElementById('lowBatteryThreshold')).not.toBeNull();
    });

    fireEvent.click(screen.getByText(/notifications\.save_preferences/));

    await waitFor(() => expect(prefPosts()).toHaveLength(1));
    const body = prefPosts()[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('mutedChannels');
    expect(body).not.toHaveProperty('mutedDMs');
    expect(body).not.toHaveProperty('sourceFallback');
    expect(body.sourceId).toBe('src-1');
    // The fields it does edit still go up.
    expect(body).toMatchObject({ enableWebPush: false, notifyOnLowBattery: true, lowBatteryThreshold: 20 });
  });

  it('Save preferences sends the message templates edited in the format section (#5593)', async () => {
    renderWithSource('meshtastic_tcp');
    await waitFor(() => {
      expect(document.getElementById('notif-format-title')).not.toBeNull();
    });

    // Untouched: both go up as null, i.e. "use the default".
    fireEvent.click(screen.getByText(/notifications\.save_preferences/));
    await waitFor(() => expect(prefPosts()).toHaveLength(1));
    expect(prefPosts()[0][1]).toMatchObject({ messageTitleTemplate: null, messageBodyTemplate: null });

    fireEvent.change(document.getElementById('notif-format-title')!, { target: { value: '{{ channelName }}' } });
    fireEvent.change(document.getElementById('notif-format-body')!, { target: { value: '{{ senderShortName }}: {{ text }}' } });
    fireEvent.click(screen.getByText(/notifications\.save_preferences/));
    await waitFor(() => expect(prefPosts()).toHaveLength(2));
    const body = prefPosts()[1][1] as Record<string, unknown>;
    expect(body).toMatchObject({
      messageTitleTemplate: '{{ channelName }}',
      messageBodyTemplate: '{{ senderShortName }}: {{ text }}',
      sourceId: 'src-1',
    });
    // Still a partial save: the mute lists stay out of it.
    expect(body).not.toHaveProperty('mutedChannels');
  });

  it('MeshCore: the message format section is shown (message notifications fire there)', async () => {
    renderWithSource('meshcore', 1);
    await waitFor(() => {
      expect(document.getElementById('lowBatteryVoltageThreshold')).not.toBeNull();
    });
    expect(document.getElementById('notif-format-title')).not.toBeNull();
  });

  it('Save Apprise config sends only the URL list', async () => {
    // The Apprise section renders only when Apprise is enabled on the row.
    const defaultGet = (api.get as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.startsWith('/api/push/preferences')
        ? Promise.resolve({ ...SAVED_PREFS, enableApprise: true, mutedChannels: [{ channelId: 2, muteUntil: null }] })
        : defaultGet(url),
    );
    renderWithSource('meshtastic_tcp');
    await waitFor(() => {
      expect(document.getElementById('lowBatteryThreshold')).not.toBeNull();
    });
    fireEvent.click(screen.getByText(/notifications\.save_config/));

    await waitFor(() => expect(prefPosts()).toHaveLength(1));
    expect(prefPosts()[0][1]).toEqual({ appriseUrls: [], sourceId: 'src-1' });
    (api.get as ReturnType<typeof vi.fn>).mockImplementation(defaultGet);
  });
});

describe('NotificationsTab — a source with nothing saved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
  });

  const answerPreferencesWith = (extra: Record<string, unknown>) => {
    const defaultGet = (api.get as ReturnType<typeof vi.fn>).getMockImplementation()!;
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url.startsWith('/api/push/preferences')
        ? Promise.resolve({ ...SAVED_PREFS, ...extra })
        : defaultGet(url),
    );
    return () => (api.get as ReturnType<typeof vi.fn>).mockImplementation(defaultGet);
  };

  const NOTICE = /notifications\.using_defaults_notice/;

  it('says the built-in defaults are in use, and stops saying so after a save', async () => {
    const restore = answerPreferencesWith({ usingDefaults: true });
    try {
      renderWithSource('meshtastic_tcp');
      await waitFor(() => expect(screen.queryByText(NOTICE)).not.toBeNull());

      fireEvent.click(screen.getByText(/notifications\.save_preferences/));
      await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());

      // The flag is GET-only: it never goes back up with a save.
      const posts = (api.post as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === '/api/push/preferences');
      expect(posts).toHaveLength(1);
      expect(posts[0][1]).not.toHaveProperty('usingDefaults');
    } finally {
      restore();
    }
  });

  it('shows no notice for a source that has saved settings', async () => {
    const restore = answerPreferencesWith({ usingDefaults: false });
    try {
      renderWithSource('meshtastic_tcp');
      await waitFor(() => {
        expect(document.getElementById('lowBatteryThreshold')).not.toBeNull();
      });
      expect(screen.queryByText(NOTICE)).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('NotificationsTab — MeshCore MQTT ingest source (#6307)', () => {
  const original = vi.mocked(api.get).getMockImplementation();

  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url.startsWith('/api/sources/src-1/meshcore/ingest/channels')) {
        return Promise.resolve({
          success: true,
          data: [
            { id: 1, name: '', uplinkEnabled: false, downlinkEnabled: false },
            { id: 3, name: '', uplinkEnabled: false, downlinkEnabled: false },
          ],
        });
      }
      if (url.startsWith('/api/push/preferences')) {
        return Promise.resolve({ ...SAVED_PREFS, enabledChannels: [3, 1234], notifyOnMqtt: true, sourceFallback: false });
      }
      return (original as (u: string) => Promise<unknown>)(url);
    }) as never);
  });

  afterEach(() => {
    vi.mocked(api.get).mockImplementation(original as never);
  });

  const prefPosts = () =>
    (api.post as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === '/api/push/preferences');

  it('shows channels, emoji, keywords, format, inactive-node and volt battery with the ingest hint', async () => {
    renderWithSource('meshcore_mqtt');
    await waitFor(() => expect(document.getElementById('lowBatteryVoltageThreshold')).not.toBeNull());
    expect(document.getElementById('lowBatteryThreshold')).toBeNull();
    expect(screen.queryByText(/notifications\.ingest_unsupported_hint/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.ingest_channels_warning/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.emoji_reactions/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.keyword_filtering/)).not.toBeNull();
    expect(document.getElementById('notif-format-title')).not.toBeNull();
    expect(screen.queryByText(/notifications\.notify_on_inactive_node/)).not.toBeNull();
  });

  it('hides DM, MQTT, traceroute, mention, waypoint and new-node', async () => {
    renderWithSource('meshcore_mqtt');
    await waitFor(() => expect(document.getElementById('lowBatteryVoltageThreshold')).not.toBeNull());
    expect(screen.queryByText(/notifications\.direct_messages/)).toBeNull();
    expect(screen.queryByText(/notifications\.traceroutes/)).toBeNull();
    expect(screen.queryByText(/notifications\.new_nodes(?!_)/)).toBeNull();
    expect(screen.queryByText(/^\s*notifications\.notify_on_mention$/)).toBeNull();
    expect(screen.queryByText(/notifications\.notify_on_waypoint/)).toBeNull();
    expect(screen.queryByText(/notifications\.repeater_unsupported_hint/)).toBeNull();
  });

  it('labels an unresolved legacy channel distinctly (#6308)', async () => {
    const base = vi.mocked(api.get).getMockImplementation() as (u: string) => Promise<unknown>;
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url.startsWith('/api/sources/src-1/meshcore/ingest/channels')) {
        return Promise.resolve({
          success: true,
          data: [{ id: 5, name: '', legacy: true, uplinkEnabled: false, downlinkEnabled: false }],
        });
      }
      return base(url);
    }) as never);
    renderWithSource('meshcore_mqtt');
    expect(await screen.findByText("Channel 5 (older messages)")).toBeTruthy();
  });

  it('loads channels from the ingest route, not /api/channels/all', async () => {
    renderWithSource('meshcore_mqtt');
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/sources/src-1/meshcore/ingest/channels'),
    );
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/api/channels/all'));
  });

  it('round-trips saved channels, including an id missing from the list, and saves notifyOnMqtt=true', async () => {
    renderWithSource('meshcore_mqtt');
    await waitFor(() => expect(document.getElementById('lowBatteryVoltageThreshold')).not.toBeNull());
    // The saved id 1234 is not in the list but is still shown (and kept).
    await waitFor(() => expect(screen.queryAllByRole('checkbox', { checked: true }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText(/notifications\.save_preferences/));
    await waitFor(() => expect(prefPosts()).toHaveLength(1));
    const body = prefPosts()[0][1] as Record<string, unknown>;
    expect([...(body.enabledChannels as number[])].sort((a, b) => a - b)).toEqual([3, 1234]);
    expect(body.notifyOnMqtt).toBe(true);
  });

  it('lists broker wording for server events when they are on', async () => {
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url.startsWith('/api/push/preferences')) {
        return Promise.resolve({ ...SAVED_PREFS, notifyOnServerEvents: true, sourceFallback: false });
      }
      return (original as (u: string) => Promise<unknown>)(url);
    }) as never);
    renderWithSource('meshcore_mqtt');
    await waitFor(() => expect(screen.queryByText(/notifications\.server_events_disconnect_broker/)).not.toBeNull());
    expect(screen.queryByText(/notifications\.server_events_reconnect_broker/)).not.toBeNull();
    expect(screen.queryByText(/notifications\.server_events_disconnect$/)).toBeNull();
  });

  it('a Repeater shows the no-DM defaults notice; Companion and Meshtastic keep theirs', async () => {
    const defaults = (url: string) =>
      url.startsWith('/api/push/preferences')
        ? Promise.resolve({ ...SAVED_PREFS, usingDefaults: true, sourceFallback: false })
        : (original as (u: string) => Promise<unknown>)(url);
    vi.mocked(api.get).mockImplementation(defaults as never);
    const { unmount } = renderWithSource('meshcore', 2);
    await waitFor(() => expect(screen.queryByText(/notifications\.using_defaults_notice_no_dm/)).not.toBeNull());
    unmount();
    const c = renderWithSource('meshcore', 1);
    await waitFor(() => expect(screen.queryByText(/notifications\.using_defaults_notice_meshcore/)).not.toBeNull());
    c.unmount();
    renderWithSource('meshtastic_tcp');
    await waitFor(() => expect(screen.queryByText(/notifications\.using_defaults_notice(?!_)/)).not.toBeNull());
  });

  it('Meshtastic server events keep the radio wording', async () => {
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url.startsWith('/api/push/preferences')) {
        return Promise.resolve({ ...SAVED_PREFS, notifyOnServerEvents: true, sourceFallback: false });
      }
      return (original as (u: string) => Promise<unknown>)(url);
    }) as never);
    renderWithSource('meshtastic_tcp');
    await waitFor(() => expect(screen.queryByText(/notifications\.server_events_disconnect$/)).not.toBeNull());
    expect(screen.queryByText(/notifications\.server_events_disconnect_broker/)).toBeNull();
  });
});
