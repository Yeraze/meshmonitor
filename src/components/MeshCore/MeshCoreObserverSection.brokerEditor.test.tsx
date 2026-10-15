/**
 * @vitest-environment jsdom
 *
 * The Analyzer Observer's broker list, edited on the MeshCore Configuration
 * page with a SaveBar draft (#5831). Renders the real section inside a real
 * SaveBarProvider + SaveBar; the source list, the API and the key/credential/
 * status hooks are stubbed.
 *
 * The global react-i18next mock returns the raw key, so assertions match keys.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SaveBarProvider } from '../../contexts/SaveBarContext';
import { SaveBar } from '../SaveBar';

let grants: Record<string, boolean> = {};
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    hasPermission: (r: string, a: string) => grants[`${r}:${a}`] ?? false,
  }),
}));

let sources: Array<{ id: string; name: string; type: string; enabled: boolean; config: Record<string, unknown> }> = [];
vi.mock('../../hooks/useDashboardData', () => ({
  useSourceStatuses: () => new Map(),
  useDashboardSources: () => ({ data: sources }),
}));

vi.mock('./hooks/useObserverKey', () => ({
  useObserverKey: () => ({
    status: null,
    loading: false,
    loadError: null,
    busy: null,
    actionError: null,
    refresh: vi.fn(),
    importFromDevice: vi.fn(),
    setManualKey: vi.fn(),
    clearKey: vi.fn(),
    clearActionError: vi.fn(),
  }),
}));
const credentialCalls = { save: vi.fn(), clear: vi.fn() };
vi.mock('./hooks/useObserverCredentials', () => ({
  useObserverCredentials: () => ({
    status: null,
    loading: false,
    loadError: null,
    busy: null,
    actionError: null,
    refresh: vi.fn(),
    saveCredentials: credentialCalls.save,
    clearCredentials: credentialCalls.clear,
    clearLegacyCredential: vi.fn(),
    clearActionError: vi.fn(),
  }),
}));
vi.mock('./hooks/useObserverStatus', () => ({
  useObserverStatus: () => ({ status: null, loading: false, error: null, refetch: vi.fn() }),
}));

const { putMock, invalidateMock } = vi.hoisted(() => ({ putMock: vi.fn(), invalidateMock: vi.fn() }));
vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return { ...actual, default: { put: putMock } };
});
vi.mock('../../config/queryClient', () => ({ queryClient: { invalidateQueries: invalidateMock } }));

import { ApiError } from '../../services/api';
import { MeshCoreObserverSection } from './MeshCoreObserverSection';

const SOURCE_ID = 'mc1';
const storedObserver = {
  enabled: true,
  authMode: 'token',
  iataCode: 'MCO',
  brokers: [{ url: 'wss://mqtt.meshmapper.net:443', authMode: 'token', tokenAudience: 'mqtt.meshmapper.net', label: 'MeshMapper' }],
  brokerCount: 1,
};
const baseConfig = {
  transport: 'usb',
  serialPort: '/dev/ttyACM0',
  deviceType: 'companion',
  virtualNode: { enabled: true, port: 5000 },
};

function setSource(config: Record<string, unknown>) {
  sources = [{ id: SOURCE_ID, name: 'MC', type: 'meshcore', enabled: true, config }];
}

function renderSection() {
  return render(
    <SaveBarProvider>
      <MeshCoreObserverSection sourceId={SOURCE_ID} connected={true} />
      <SaveBar />
    </SaveBarProvider>,
  );
}

const rows = () => screen.queryAllByTestId(/observer-broker-row-/);
const saveButton = () => screen.queryByRole('button', { name: 'common.save' });
const dismissButton = () => screen.getByRole('button', { name: 'common.dismiss' });
const pickPreset = (id: string) =>
  fireEvent.click(
    within(screen.getByTestId('observer-preset-picker')).getByRole('button', { name: new RegExp(`observer_preset_${id}`) }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  grants = {
    'configuration:read': true,
    'configuration:write': true,
    'sources:write': true,
  };
  setSource({ ...baseConfig, observer: storedObserver });
  putMock.mockResolvedValue({ success: true });
});

describe('Analyzer Observer broker list in MeshCore Configuration (#5831)', () => {
  it('groups the section into Status, Brokers and Credentials', () => {
    const { container } = renderSection();
    const names = Array.from(container.querySelectorAll('[data-config-group]')).map((g) => g.getAttribute('data-config-group'));
    expect(names).toEqual(['status', 'brokers', 'credentials']);
  });

  it('seeds the editor from the stored block and writes nothing on mount', () => {
    renderSection();
    expect(screen.getByRole('checkbox', { name: 'meshcore.form.observer_enable' })).toBeChecked();
    expect(screen.getByPlaceholderText('MCO')).toHaveValue('MCO');
    expect(rows()).toHaveLength(1);
    expect(saveButton()).toBeNull();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('adding a preset broker shows the SaveBar; Save sends one PUT with the whole config and the new list', async () => {
    renderSection();
    pickPreset('letsmesh_us');
    expect(rows()).toHaveLength(2);

    fireEvent.click(saveButton()!);

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const [url, body] = putMock.mock.calls[0];
    expect(url).toBe(`/api/sources/${SOURCE_ID}`);
    // Every other config key rides along, so the server's merge keeps it.
    expect(body.config.virtualNode).toEqual(baseConfig.virtualNode);
    expect(body.config.serialPort).toBe('/dev/ttyACM0');
    expect(body.config.observer).toEqual({
      enabled: true,
      authMode: 'token',
      iataCode: 'MCO',
      brokers: [
        { url: 'wss://mqtt.meshmapper.net:443', authMode: 'token', tokenAudience: 'mqtt.meshmapper.net', label: 'MeshMapper' },
        { url: 'wss://mqtt-us-v1.letsmesh.net:443', authMode: 'token', tokenAudience: 'mqtt-us-v1.letsmesh.net', label: 'LetsMesh US' },
      ],
    });
    // Secrets keep their own routes: the draft never touches them.
    expect(credentialCalls.save).not.toHaveBeenCalled();
    expect(credentialCalls.clear).not.toHaveBeenCalled();
    expect(invalidateMock).toHaveBeenCalledWith({ queryKey: ['dashboard', 'sources'] });
    await waitFor(() => expect(saveButton()).toBeNull());
  });

  it('removing a broker asks first; Cancel keeps it, Remove drops it', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'meshcore.form.observer_broker_remove' }));
    expect(screen.getByText('meshcore.observer.remove_broker_title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(rows()).toHaveLength(1);
    expect(saveButton()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'meshcore.form.observer_broker_remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'meshcore.observer.remove_broker' }));
    expect(rows()).toHaveLength(0);
    expect(saveButton()).not.toBeNull();
  });

  it('Dismiss puts the stored list back and sends nothing', () => {
    renderSection();
    pickPreset('rflab');
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'TPA' } });
    expect(rows()).toHaveLength(2);

    fireEvent.click(dismissButton());

    expect(rows()).toHaveLength(1);
    expect(screen.getByPlaceholderText('MCO')).toHaveValue('MCO');
    expect(saveButton()).toBeNull();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('turning the observer off saves enabled:false and keeps the brokers', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('checkbox', { name: 'meshcore.form.observer_enable' }));
    fireEvent.click(saveButton()!);
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    const observer = putMock.mock.calls[0][1].config.observer;
    expect(observer.enabled).toBe(false);
    expect(observer.brokers).toHaveLength(1);
  });

  it('a client-side validation error is shown and nothing is sent', async () => {
    renderSection();
    fireEvent.change(screen.getByPlaceholderText('MCO'), { target: { value: 'nope' } });
    fireEvent.click(saveButton()!);
    expect(await screen.findByTestId('observer-config-error')).toHaveTextContent('meshcore.form.observer_error_iata');
    expect(putMock).not.toHaveBeenCalled();
  });

  it('a server error is shown and the draft stays for a retry', async () => {
    putMock.mockRejectedValueOnce(
      new ApiError('requires companion', 400, {
        code: 'OBSERVER_REQUIRES_COMPANION',
        body: { error: 'requires companion', code: 'OBSERVER_REQUIRES_COMPANION' },
      }),
    );
    renderSection();
    pickPreset('rflab');
    fireEvent.click(saveButton()!);
    expect(await screen.findByTestId('observer-config-error')).toHaveTextContent(
      'meshcore.form.observer_error_requires_companion',
    );
    expect(rows()).toHaveLength(2);
    // The SaveBar reads "Saving…" until its own onSave promise settles.
    await waitFor(() => expect(saveButton()).not.toBeNull());
  });

  it('preset chips stop at the 8-broker cap', () => {
    setSource({
      ...baseConfig,
      observer: {
        ...storedObserver,
        brokers: Array.from({ length: 8 }, (_, i) => ({ url: `wss://b${i}.example:443`, authMode: 'token', tokenAudience: `b${i}` })),
      },
    });
    renderSection();
    const chips = within(screen.getByTestId('observer-preset-picker')).getAllByRole('button');
    chips.forEach((c) => expect(c).toBeDisabled());
  });

  it('without sources:write the list is read-only and no SaveBar can appear', () => {
    grants['sources:write'] = false;
    renderSection();
    expect(screen.getByTestId('observer-brokers-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('observer-preset-picker')).toBeNull();
    expect(screen.queryByRole('button', { name: 'meshcore.form.observer_broker_remove' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'meshcore.form.observer_enable' })).toBeDisabled();
    expect(screen.getByPlaceholderText('MCO')).toBeDisabled();
  });
});
