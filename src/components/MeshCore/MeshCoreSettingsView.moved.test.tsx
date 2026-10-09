/**
 * MeshCoreSettingsView after the #5683 follow-up: what is written to or done
 * on the radio moved to Device Configuration, and a pointer stays where each
 * control used to be.
 *
 * Covers: the moved controls are gone and the pointers are there; the pointer
 * link switches tab; opening the tab transmits nothing and reads nothing that
 * moved; a viewer who cannot open Device Configuration keeps the device
 * actions and the contact sync here; "Respond to discovery", which stayed, is
 * gated on the grant its own route checks.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreSettingsView } from './MeshCoreSettingsView';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

let grants: (resource: string, action: string) => boolean = () => true;
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (resource: string, action: string) => grants(resource, action) }),
}));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('./MeshCoreIgnoredNodesSection', () => ({ MeshCoreIgnoredNodesSection: () => null }));
vi.mock('./MeshCoreMessageFiltersSection', () => ({ MeshCoreMessageFiltersSection: () => null }));
vi.mock('./MeshCoreNodeDisplaySection', () => ({ MeshCoreNodeDisplaySection: () => null }));
// Fetches on mount; its own tests cover it. Here only its placement matters.
const contactSyncProps = vi.fn();
vi.mock('./MeshCoreContactSyncSection', () => ({
  MeshCoreContactSyncSection: (props: Record<string, unknown>) => {
    contactSyncProps(props);
    return <div data-testid="contact-sync" />;
  },
}));

function makeActions() {
  return {
    discoverNodes: vi.fn().mockResolvedValue(null),
    getDiscoverable: vi.fn().mockResolvedValue(false),
    setDiscoverable: vi.fn().mockResolvedValue(true),
    getDefaultScope: vi.fn().mockResolvedValue(''),
    getDefaultPathHashSize: vi.fn().mockResolvedValue(1),
    setDefaultPathHashSize: vi.fn().mockResolvedValue(1),
    setDefaultScope: vi.fn().mockResolvedValue(''),
    discoverRegions: vi.fn().mockResolvedValue(null),
    fetchSavedRegions: vi.fn().mockResolvedValue([]),
    addSavedRegion: vi.fn().mockResolvedValue(true),
    deleteSavedRegion: vi.fn().mockResolvedValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    purgeAllMessages: vi.fn().mockResolvedValue(true),
    refreshContacts: vi.fn().mockResolvedValue(undefined),
    sendAdvert: vi.fn().mockResolvedValue(undefined),
  };
}

function renderView(props: { canOpenDeviceConfiguration?: boolean; onOpenDeviceConfiguration?: () => void } = {}) {
  const actions = makeActions();
  render(
    <MeshCoreSettingsView
      status={{ connected: true, deviceType: 1 } as never}
      loading={false}
      actions={actions as never}
      baseUrl=""
      sourceId="src-a"
      {...props}
    />,
  );
  return actions;
}

const MOVED_BUTTONS = [
  'Refresh contacts', 'Advert (nearby, zero-hop)', 'Flood advert',
  'Discover Nearby Nodes', 'Discover Repeaters', 'Discover Sensors',
  'Discover regions from repeaters', 'Save path hash size', 'Save default scope',
];

beforeEach(() => {
  vi.clearAllMocks();
  grants = () => true;
});

describe('MeshCoreSettingsView: controls that moved to Device Configuration', () => {
  it('shows none of the moved controls', () => {
    renderView();
    for (const name of MOVED_BUTTONS) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Default path hash size' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Default region / scope' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Device actions' })).toBeNull();
    expect(screen.queryByTestId('contact-sync')).toBeNull();
  });

  it('leaves a pointer for the device actions and one for the device settings', () => {
    renderView();
    expect(screen.getByTestId('meshcore-actions-moved')).toHaveTextContent(
      /Radio contact list sync, Refresh contacts, Send advert and Discover nodes moved to Device Configuration/,
    );
    expect(screen.getByTestId('meshcore-device-settings-moved')).toHaveTextContent(
      /Default path hash size and default region \/ scope .* moved to Device Configuration/,
    );
  });

  it('each pointer link switches to the Device Configuration tab', async () => {
    const user = userEvent.setup();
    const onOpenDeviceConfiguration = vi.fn();
    renderView({ onOpenDeviceConfiguration });
    const links = screen.getAllByRole('button', { name: 'Open Device Configuration' });
    expect(links).toHaveLength(2);
    for (const link of links) await user.click(link);
    expect(onOpenDeviceConfiguration).toHaveBeenCalledTimes(2);
  });

  it('opening the tab transmits nothing and reads none of the moved values', async () => {
    const actions = renderView();
    await waitFor(() => expect(actions.getDiscoverable).toHaveBeenCalled());
    for (const name of ['sendAdvert', 'discoverNodes', 'discoverRegions', 'refreshContacts',
      'setDefaultScope', 'setDefaultPathHashSize', 'setDiscoverable',
      'getDefaultScope', 'getDefaultPathHashSize'] as const) {
      expect(actions[name], name).not.toHaveBeenCalled();
    }
  });

  it('keeps what MeshMonitor stores: connection, receive-only, saved regions, purge', () => {
    renderView();
    for (const name of ['Connection', 'Receive-only mode', 'Saved regions', 'Message data']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });
});

describe('MeshCoreSettingsView: a viewer who cannot open Device Configuration', () => {
  it('keeps the device actions and the contact sync here, so the move costs them nothing', () => {
    renderView({ canOpenDeviceConfiguration: false });
    expect(screen.getByRole('heading', { name: 'Device actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh contacts' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discover Nearby Nodes' })).not.toBeDisabled();
    expect(screen.getByTestId('contact-sync')).toBeInTheDocument();
    expect(screen.queryByTestId('meshcore-actions-moved')).toBeNull();
  });

  it('still gates each of them on its own grant', () => {
    grants = (resource, action) => !(action === 'write' && (resource === 'nodes' || resource === 'connection'));
    renderView({ canOpenDeviceConfiguration: false });
    expect(screen.getByRole('button', { name: 'Refresh contacts' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Advert (nearby, zero-hop)' })).toBeDisabled();
    expect(contactSyncProps).toHaveBeenLastCalledWith(expect.objectContaining({ canEditNodes: false }));
  });

  it('gets the device-settings pointer with the reason and no dead link', () => {
    const onOpenDeviceConfiguration = vi.fn();
    renderView({ canOpenDeviceConfiguration: false, onOpenDeviceConfiguration });
    const note = screen.getByTestId('meshcore-device-settings-moved');
    expect(note).toHaveTextContent(/needs the Device Configuration read permission/);
    expect(screen.queryByRole('button', { name: 'Open Device Configuration' })).toBeNull();
  });

  it('transmits nothing on mount there either', async () => {
    const actions = renderView({ canOpenDeviceConfiguration: false });
    await waitFor(() => expect(actions.getDiscoverable).toHaveBeenCalled());
    for (const name of ['sendAdvert', 'discoverNodes', 'discoverRegions', 'refreshContacts'] as const) {
      expect(actions[name], name).not.toHaveBeenCalled();
    }
  });
});

describe('MeshCoreSettingsView: "Respond to discovery" stayed, gated on its own grant', () => {
  const toggle = () => screen.getByRole('checkbox', { name: /Respond to discovery requests/ });

  it('is enabled with configuration:write and saves through setDiscoverable', async () => {
    const user = userEvent.setup();
    const actions = renderView();
    expect(toggle()).not.toBeDisabled();
    await user.click(toggle());
    expect(actions.setDiscoverable).toHaveBeenCalledWith(true);
  });

  it('is disabled with the reason without configuration:write', async () => {
    const user = userEvent.setup();
    grants = (resource, action) => !(resource === 'configuration' && action === 'write');
    const actions = renderView();
    expect(toggle()).toBeDisabled();
    expect(screen.getByText(/Changing this needs the Device Configuration write permission/)).toBeInTheDocument();
    await user.click(toggle());
    expect(actions.setDiscoverable).not.toHaveBeenCalled();
  });
});
