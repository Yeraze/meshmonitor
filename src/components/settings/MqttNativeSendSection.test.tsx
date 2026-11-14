/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MqttNativeSendSection } from './MqttNativeSendSection';
import type { MqttNativeStatus } from '../../hooks/useMqttNativeSendStatus';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  csrfFetch: vi.fn(),
  showToast: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock('../../services/api', () => ({ default: { get: h.apiGet } }));
vi.mock('../../hooks/useCsrfFetch', () => ({ useCsrfFetch: () => h.csrfFetch }));
vi.mock('../ToastContainer', () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));

function status(overrides: Partial<MqttNativeStatus> = {}): MqttNativeStatus {
  return {
    sourceId: 'src-a',
    enabled: false,
    readiness: { ok: true },
    identity: null,
    identityBlocker: null,
    config: { hopLimit: 3, maxPerMinute: 6, maxPerHour: 60, longName: '', shortName: '', rootTopic: null, announceChannelId: null },
    rootTopicHint: 'msh/US/FL',
    effectiveRootTopic: 'msh/US/FL',
    limits: { hardMaxPerMinute: 6, hardMaxPerHour: 60, maxHopLimit: 7, nodeInfoIntervalMs: 10_800_000, longNameMaxBytes: 24, shortNameMaxBytes: 4 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MqttNativeSendSection (#4305)', () => {
  it('is off by default and shows the RF warning next to the toggle', async () => {
    h.apiGet.mockResolvedValue({ success: true, data: status() });
    render(<MqttNativeSendSection baseUrl="" sourceId="src-a" canWrite />);
    const toggle = await screen.findByRole('checkbox');
    expect(toggle).not.toBeChecked();
    expect(h.apiGet).toHaveBeenCalledWith('/api/sources/src-a/mqtt/native');
    expect(screen.getByText(/Every gateway that downlinks the channel transmits each message on RF/)).toBeInTheDocument();
  });

  it('shows the generated node id once the source has one', async () => {
    h.apiGet.mockResolvedValue({
      success: true,
      data: status({
        enabled: true,
        identity: { nodeNum: 0xabcd1234, nodeId: '!abcd1234', publicKey: 'x', longName: 'MeshMonitor 1234', shortName: '1234', lastNodeInfoAt: null },
      }),
    });
    render(<MqttNativeSendSection baseUrl="" sourceId="src-a" canWrite />);
    expect(await screen.findByText('!abcd1234')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('turning it on PUTs enabled and refreshes the composer status', async () => {
    h.apiGet.mockResolvedValue({ success: true, data: status() });
    h.csrfFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: status({ enabled: true }) }) });
    render(<MqttNativeSendSection baseUrl="/base" sourceId="src-a" canWrite />);
    fireEvent.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(h.csrfFetch).toHaveBeenCalled());
    const [url, init] = h.csrfFetch.mock.calls[0];
    expect(url).toBe('/base/api/sources/src-a/mqtt/native');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: true });
    await waitFor(() => expect(h.invalidateQueries).toHaveBeenCalled());
  });

  it('cannot be changed without write access, nor turned on for a read-only source', async () => {
    h.apiGet.mockResolvedValue({ success: true, data: status() });
    const { unmount } = render(<MqttNativeSendSection baseUrl="" sourceId="src-a" canWrite={false} />);
    expect(await screen.findByRole('checkbox')).toBeDisabled();
    unmount();

    h.apiGet.mockResolvedValue({ success: true, data: status({ readiness: { ok: false, code: 'READ_ONLY', reason: 'ro' } }) });
    render(<MqttNativeSendSection baseUrl="" sourceId="src-a" canWrite />);
    expect(await screen.findByRole('checkbox')).toBeDisabled();
  });
});
