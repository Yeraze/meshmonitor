/**
 * @vitest-environment jsdom
 *
 * PR-C: MQTT section now gates the form on `sources:write` for the active
 * source. The fieldset is `disabled` and a banner is rendered when the
 * caller lacks the grant.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// --- mocks ---------------------------------------------------------------

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const hasPermissionMock = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: hasPermissionMock }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'src-a', sourceName: 'A' }),
}));

vi.mock('../../contexts/CsrfContext', () => ({
  useCsrf: () => ({ getToken: () => 'csrf' }),
}));

vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: vi.fn(),
}));

const { sourcesRef } = vi.hoisted(() => ({ sourcesRef: { current: [] as unknown[] } }));
vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: sourcesRef.current }),
}));

vi.mock('../../init', () => ({ appBasename: '' }));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import MQTTConfigSection from './MQTTConfigSection';

// Minimal stable props — values don't matter for this test, only the
// permission gating behavior.
const baseProps = {
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
  setMqttEnabled: vi.fn(),
  setMqttAddress: vi.fn(),
  setMqttUsername: vi.fn(),
  setMqttPassword: vi.fn(),
  setMqttEncryptionEnabled: vi.fn(),
  setMqttJsonEnabled: vi.fn(),
  setMqttRoot: vi.fn(),
  setTlsEnabled: vi.fn(),
  setProxyToClientEnabled: vi.fn(),
  setMapReportingEnabled: vi.fn(),
  setMapPublishIntervalSecs: vi.fn(),
  setMapPositionPrecision: vi.fn(),
  isSaving: false,
  onSave: vi.fn(async () => {}),
};

beforeEach(() => {
  hasPermissionMock.mockReset();
  sourcesRef.current = [];
});

describe('MQTTConfigSection — permission gate (PR-C)', () => {
  it('permitted user: fieldset is NOT disabled and no banner is rendered', () => {
    hasPermissionMock.mockReturnValue(true);
    render(<MQTTConfigSection {...baseProps} />);

    const fieldset = document.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect((fieldset as HTMLFieldSetElement).disabled).toBe(false);

    expect(screen.queryByTestId('mqtt-permission-banner')).toBeNull();
  });

  it('denied user: fieldset IS disabled and the permission banner renders', () => {
    hasPermissionMock.mockReturnValue(false);
    render(<MQTTConfigSection {...baseProps} />);

    const fieldset = document.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    expect((fieldset as HTMLFieldSetElement).disabled).toBe(true);

    const banner = screen.getByTestId('mqtt-permission-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/permission/i);
  });

  it('hasPermission is called with sources/write on the current sourceId', () => {
    hasPermissionMock.mockReturnValue(true);
    render(<MQTTConfigSection {...baseProps} />);
    expect(hasPermissionMock).toHaveBeenCalledWith('sources', 'write', { sourceId: 'src-a' });
  });
});

describe('MQTTConfigSection — bridged-node MQTT Client Proxy recommendation', () => {
  beforeEach(() => hasPermissionMock.mockReturnValue(true));

  it('renders the bridged-node recommendation note when isBridged is true', () => {
    render(<MQTTConfigSection {...baseProps} isBridged={true} />);
    const note = screen.getByTestId('mqtt-bridged-note');
    expect(note).toBeInTheDocument();
  });

  it('does not render the note when isBridged is false', () => {
    render(<MQTTConfigSection {...baseProps} isBridged={false} />);
    expect(screen.queryByTestId('mqtt-bridged-note')).toBeNull();
  });

  it('does not render the note when isBridged is omitted (defaults to false)', () => {
    render(<MQTTConfigSection {...baseProps} />);
    expect(screen.queryByTestId('mqtt-bridged-note')).toBeNull();
  });
});

// The rule itself is table-tested in src/utils/mqttProxyLink.test.ts; these pin
// that the form feeds it its own (unsaved) values.
describe('MQTTConfigSection — "no broker is linked" warning (#5013)', () => {
  const WARNING = 'mqtt-proxy-link-warning';
  const node = (config: unknown = {}) => ({ id: 'src-a', name: 'A', type: 'meshtastic_tcp', enabled: true, config });
  const broker = (enabled = true) => ({ id: 'brk', name: 'B', type: 'mqtt_broker', enabled, config: {} });
  const linked = { mqttLink: { enabled: true, mqttBrokerSourceId: 'brk' } };
  const proxyOn = { ...baseProps, mqttEnabled: true, proxyToClientEnabled: true };

  beforeEach(() => hasPermissionMock.mockReturnValue(true));

  it('shows with proxy on and no link, with a link to the docs section', () => {
    sourcesRef.current = [node(), broker()];
    render(<MQTTConfigSection {...proxyOn} />);
    const alert = screen.getByTestId(WARNING);
    expect(alert.querySelector('a')).toHaveAttribute(
      'href', 'https://meshmonitor.org/features/mqtt-broker#why-no-mqtt-traffic',
    );
  });

  it('hides with a link to an enabled MQTT source', () => {
    sourcesRef.current = [node(linked), broker()];
    render(<MQTTConfigSection {...proxyOn} />);
    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it('shows when the linked source is disabled', () => {
    sourcesRef.current = [node(linked), broker(false)];
    render(<MQTTConfigSection {...proxyOn} />);
    expect(screen.getByTestId(WARNING)).toBeInTheDocument();
  });

  it('hides with proxy off, or with MQTT off', () => {
    sourcesRef.current = [node(), broker()];
    const { unmount } = render(<MQTTConfigSection {...proxyOn} proxyToClientEnabled={false} />);
    expect(screen.queryByTestId(WARNING)).toBeNull();
    unmount();
    render(<MQTTConfigSection {...proxyOn} mqttEnabled={false} />);
    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it('hides when a Virtual Node client carries MQTT', () => {
    sourcesRef.current = [node(), broker()];
    render(<MQTTConfigSection {...proxyOn} proxyClientAttached />);
    expect(screen.queryByTestId(WARNING)).toBeNull();
  });
});
