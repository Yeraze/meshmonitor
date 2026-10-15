/**
 * @vitest-environment jsdom
 *
 * Quick configure joins the SaveBar (#5831). Picking an MQTT source fills the
 * form and stages this source's `mqttLink`; nothing is written until Save,
 * which sends the device MQTT config first and then the link. Dismiss undoes
 * both. Rendered with a real SaveBarProvider + SaveBar and a stateful harness
 * standing in for ConfigurationTab.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SaveBarProvider } from '../../contexts/SaveBarContext';
import { SaveBar } from '../SaveBar';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-a', sourceName: 'A' }),
}));
vi.mock('../../contexts/CsrfContext', () => ({
  useCsrf: () => ({ getToken: () => 'csrf' }),
}));

const { sourcesRef, putMock, invalidateMock } = vi.hoisted(() => ({
  sourcesRef: { current: [] as unknown[] },
  putMock: vi.fn(),
  invalidateMock: vi.fn(),
}));
vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: sourcesRef.current }),
}));
vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return { ...actual, default: { put: putMock } };
});
vi.mock('../../config/queryClient', () => ({ queryClient: { invalidateQueries: invalidateMock } }));
vi.mock('../../init', () => ({ appBasename: '' }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ApiError } from '../../services/api';
import MQTTConfigSection from './MQTTConfigSection';

const order: string[] = [];
let deviceSaveResult = true;
const onSaveMock = vi.fn(async () => {
  order.push('device');
  return deviceSaveResult;
});

/** Holds the form values the way ConfigurationTab does. */
function Harness({ initial }: { initial?: Partial<Record<string, unknown>> }) {
  const [v, setV] = useState({
    mqttEnabled: false,
    mqttAddress: '',
    mqttUsername: '',
    mqttPassword: '',
    mqttEncryptionEnabled: false,
    mqttJsonEnabled: false,
    mqttRoot: '',
    tlsEnabled: false,
    proxyToClientEnabled: false,
    mapReportingEnabled: false,
    mapPublishIntervalSecs: 0,
    mapPositionPrecision: 13,
    mapShouldReportLocation: false,
    ...initial,
  });
  const set = (k: string) => (value: unknown) => setV((p) => ({ ...p, [k]: value }));
  return (
    <SaveBarProvider>
      <MQTTConfigSection
        {...(v as any)}
        setMqttEnabled={set('mqttEnabled')}
        setMqttAddress={set('mqttAddress')}
        setMqttUsername={set('mqttUsername')}
        setMqttPassword={set('mqttPassword')}
        setMqttEncryptionEnabled={set('mqttEncryptionEnabled')}
        setMqttJsonEnabled={set('mqttJsonEnabled')}
        setMqttRoot={set('mqttRoot')}
        setTlsEnabled={set('tlsEnabled')}
        setProxyToClientEnabled={set('proxyToClientEnabled')}
        setMapReportingEnabled={set('mapReportingEnabled')}
        setMapPublishIntervalSecs={set('mapPublishIntervalSecs')}
        setMapPositionPrecision={set('mapPositionPrecision')}
        setMapShouldReportLocation={set('mapShouldReportLocation')}
        isSaving={false}
        onSave={onSaveMock}
      />
      <SaveBar />
    </SaveBarProvider>
  );
}

const quickSelect = () => document.getElementById('mqttQuickConfig') as HTMLSelectElement;
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const saveButton = () => screen.queryByRole('button', { name: 'common.save' });
const dismissButton = () => screen.getByRole('button', { name: 'common.dismiss' });

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  deviceSaveResult = true;
  sourcesRef.current = [
    { id: 'src-a', name: 'A', type: 'meshtastic_tcp', enabled: true, config: { host: '10.0.0.5', port: 4403 } },
    {
      id: 'brk',
      name: 'Broker',
      type: 'mqtt_broker',
      enabled: true,
      config: { listener: { port: 1884 }, auth: { username: 'mm' }, rootTopic: 'msh/US' },
    },
  ];
  putMock.mockImplementation(async () => {
    order.push('link');
    return { success: true };
  });
});

describe('MQTT quick configure joins the SaveBar (#5831)', () => {
  it('picking a source fills the form and stages the link without writing anything', () => {
    render(<Harness />);
    fireEvent.change(quickSelect(), { target: { value: 'brk' } });

    expect(field('mqttEnabled').checked).toBe(true);
    expect(field('mqttAddress').value).toMatch(/:1884$/);
    expect(field('mqttRoot').value).toBe('msh/US');
    expect(field('proxyToClientEnabled').checked).toBe(true);
    expect(screen.getByTestId('mqtt-quick-config-staged')).toBeInTheDocument();
    expect(putMock).not.toHaveBeenCalled();
    expect(onSaveMock).not.toHaveBeenCalled();
    expect(saveButton()).not.toBeNull();
  });

  it('Save writes the device config first, then the link, then clears the stage', async () => {
    render(<Harness />);
    fireEvent.change(quickSelect(), { target: { value: 'brk' } });
    fireEvent.click(saveButton()!);

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['device', 'link']);
    const [url, body] = putMock.mock.calls[0];
    expect(url).toBe('/api/sources/src-a');
    expect(body.config).toEqual({
      host: '10.0.0.5',
      port: 4403,
      mqttLink: { enabled: true, mqttBrokerSourceId: 'brk' },
    });
    expect(invalidateMock).toHaveBeenCalledWith({ queryKey: ['dashboard', 'sources'] });
    await waitFor(() => expect(saveButton()).toBeNull());
    expect(quickSelect().value).toBe('');
  });

  it('the same option can be picked again after a save', async () => {
    render(<Harness />);
    fireEvent.change(quickSelect(), { target: { value: 'brk' } });
    fireEvent.click(saveButton()!);
    await waitFor(() => expect(saveButton()).toBeNull());

    fireEvent.change(quickSelect(), { target: { value: 'brk' } });
    expect(screen.getByTestId('mqtt-quick-config-staged')).toBeInTheDocument();
    expect(saveButton()).not.toBeNull();
  });

  it('Dismiss reverts the fields and drops the staged link', () => {
    render(<Harness />);
    fireEvent.change(quickSelect(), { target: { value: 'brk' } });
    fireEvent.click(dismissButton());

    expect(field('mqttEnabled').checked).toBe(false);
    expect(quickSelect().value).toBe('');
    expect(screen.queryByTestId('mqtt-quick-config-staged')).toBeNull();
    expect(saveButton()).toBeNull();
    expect(putMock).not.toHaveBeenCalled();
    expect(onSaveMock).not.toHaveBeenCalled();
  });

  it('a failed device save does not write the link', async () => {
    deviceSaveResult = false;
    render(<Harness />);
    fireEvent.change(quickSelect(), { target: { value: 'brk' } });
    fireEvent.click(saveButton()!);

    await waitFor(() => expect(onSaveMock).toHaveBeenCalledTimes(1));
    expect(putMock).not.toHaveBeenCalled();
    await waitFor(() => expect(saveButton()).not.toBeNull());
  });

  it('a failed link write is shown, and the next Save retries only the link', async () => {
    putMock.mockRejectedValueOnce(new ApiError('Forbidden', 403, { body: { error: 'Forbidden' } }));
    render(<Harness />);
    fireEvent.change(quickSelect(), { target: { value: 'brk' } });
    fireEvent.click(saveButton()!);

    expect(await screen.findByTestId('mqtt-quick-config-link-error')).toBeInTheDocument();
    await waitFor(() => expect(saveButton()).not.toBeNull());

    fireEvent.click(saveButton()!);
    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(2));
    // The device took the first save, so the retry sends only the link.
    expect(onSaveMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('mqtt-quick-config-link-error')).toBeNull());
    await waitFor(() => expect(saveButton()).toBeNull());
  });

  it('when the fields already match, Save writes only the link (no device write, no reboot)', async () => {
    render(
      <Harness
        initial={{
          mqttEnabled: true,
          proxyToClientEnabled: true,
          mqttEncryptionEnabled: true,
          mqttAddress: `${window.location.hostname || 'localhost'}:1884`,
          mqttUsername: 'mm',
          mqttRoot: 'msh/US',
        }}
      />,
    );
    fireEvent.change(quickSelect(), { target: { value: 'brk' } });
    fireEvent.click(saveButton()!);

    await waitFor(() => expect(putMock).toHaveBeenCalledTimes(1));
    expect(onSaveMock).not.toHaveBeenCalled();
  });

  it('the form fields sit in the five named groups', () => {
    const { container } = render(<Harness initial={{ mqttEnabled: true }} />);
    const names = Array.from(container.querySelectorAll('[data-config-group]')).map((g) => g.getAttribute('data-config-group'));
    expect(names).toEqual(['connection', 'credentials', 'topics', 'proxy', 'privacy']);
  });
});
