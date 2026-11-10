/**
 * @vitest-environment jsdom
 *
 * The device MQTT form blocks Save on a CHANGED root that breaks the root
 * rules, the same test the server applies (#6338). A bad root the node already
 * holds does not block an unrelated edit.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
const hasPermissionMock = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: hasPermissionMock }) }));
vi.mock('../../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 'src-a', sourceName: 'A' }) }));
vi.mock('../../contexts/CsrfContext', () => ({ useCsrf: () => ({ getToken: () => 'csrf' }) }));
const useSaveBarMock = vi.fn();
vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: (o: unknown) => useSaveBarMock(o) }));
vi.mock('../../hooks/useDashboardData', () => ({ useDashboardSources: () => ({ data: [] }) }));
vi.mock('../../init', () => ({ appBasename: '' }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../MQTT/MqttRootFinder', () => ({
  MqttRootFinder: (props: {
    disabled?: boolean;
    defaultRegionRoot: string;
    onPickRoot: (r: string) => void;
    context: string;
    sourceId?: string | null;
  }) => (
    <button
      type="button"
      disabled={props.disabled}
      data-region={props.defaultRegionRoot}
      data-context={props.context}
      data-source={props.sourceId ?? ''}
      onClick={() => props.onPickRoot('msh/EU_868/DE')}
    >
      find-topics-stub
    </button>
  ),
}));

import MQTTConfigSection from './MQTTConfigSection';

const setMqttRoot = vi.fn();
const props = {
  mqttEnabled: true,
  mqttAddress: 'broker.test',
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
  loraRegion: 3,
  setMqttEnabled: vi.fn(),
  setMqttAddress: vi.fn(),
  setMqttUsername: vi.fn(),
  setMqttPassword: vi.fn(),
  setMqttEncryptionEnabled: vi.fn(),
  setMqttJsonEnabled: vi.fn(),
  setMqttRoot,
  setTlsEnabled: vi.fn(),
  setProxyToClientEnabled: vi.fn(),
  setMapReportingEnabled: vi.fn(),
  setMapPublishIntervalSecs: vi.fn(),
  setMapPositionPrecision: vi.fn(),
  setMapShouldReportLocation: vi.fn(),
  isSaving: false,
  onSave: vi.fn(async () => true),
};


/** The `invalid` flag the section last handed the SaveBar. */
const lastInvalid = () => {
  const calls = useSaveBarMock.mock.calls;
  return (calls[calls.length - 1][0] as { invalid?: boolean }).invalid;
};

beforeEach(() => {
  hasPermissionMock.mockReset();
  hasPermissionMock.mockReturnValue(true);
  useSaveBarMock.mockReset();
});

describe('MQTTConfigSection root save gate', () => {
  it('does not block a valid root', () => {
    const { rerender } = render(<MQTTConfigSection {...props} mqttRoot="msh/US" />);
    expect(lastInvalid()).toBe(false);
    rerender(<MQTTConfigSection {...props} mqttRoot="msh/US/FL" />);
    expect(lastInvalid()).toBe(false);
  });

  it('blocks Save once the root changes to a bad one', () => {
    const { rerender } = render(<MQTTConfigSection {...props} mqttRoot="msh/US" />);
    rerender(<MQTTConfigSection {...props} mqttRoot="msh/US/2" />);
    expect(lastInvalid()).toBe(true);
  });

  it('does not block an unrelated edit on a node that already holds a bad root', () => {
    const { rerender } = render(<MQTTConfigSection {...props} mqttRoot="msh/US " />);
    expect(lastInvalid()).toBe(false);
    rerender(<MQTTConfigSection {...props} mqttRoot="msh/US " mapReportingEnabled />);
    expect(lastInvalid()).toBe(false);
  });
});
