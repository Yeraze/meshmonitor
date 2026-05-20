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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>, vars?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        if (vars && typeof vars === 'object') {
          return fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String((vars as any)[k] ?? ''));
        }
        return fallback;
      }
      return key;
    },
  }),
}));

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

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({ data: [] }),
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
