/**
 * @vitest-environment jsdom
 *
 * The root finder beside the device root field (#6287): a pick edits the form
 * (setMqttRoot) and nothing else; the search starts from the radio's region;
 * the button is disabled without `configuration:write`.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
const hasPermissionMock = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: hasPermissionMock }) }));
vi.mock('../../contexts/SourceContext', () => ({ useSource: () => ({ sourceId: 'src-a', sourceName: 'A' }) }));
vi.mock('../../contexts/CsrfContext', () => ({ useCsrf: () => ({ getToken: () => 'csrf' }) }));
vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));
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

const button = () => screen.getByRole('button', { name: 'find-topics-stub' }) as HTMLButtonElement;

beforeEach(() => {
  hasPermissionMock.mockReset();
  hasPermissionMock.mockReturnValue(true);
  setMqttRoot.mockReset();
  props.onSave.mockClear();
});

describe('MQTTConfigSection root finder', () => {
  it('seeds the search from the radio region and the active source', () => {
    render(<MQTTConfigSection {...props} />);
    expect(button().dataset.region).toBe('msh/EU_868');
    expect(button().dataset.context).toBe('device');
    expect(button().dataset.source).toBe('src-a');
  });

  it('a pick sets the root and does not save', () => {
    render(<MQTTConfigSection {...props} />);
    fireEvent.click(button());
    expect(setMqttRoot).toHaveBeenCalledWith('msh/EU_868/DE');
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('is disabled without configuration:write', () => {
    hasPermissionMock.mockReturnValue(false);
    render(<MQTTConfigSection {...props} />);
    expect(button().disabled).toBe(true);
  });
});
