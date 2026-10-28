/**
 * @vitest-environment jsdom
 *
 * DefaultMeshtasticSourceSection (#5245): lists Automatic plus every
 * Meshtastic TCP source, saves `defaultMeshtasticSourceId` through the
 * unscoped POST /api/settings, and shows what a source-less request uses.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { DefaultMeshtasticSourceSection, DEFAULT_SOURCE_SECTION_ID } from './DefaultMeshtasticSourceSection';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

const { saveBarCapture } = vi.hoisted(() => ({
  saveBarCapture: {
    current: null as null | { hasChanges: boolean; onSave: () => Promise<void>; onDismiss: () => void },
  },
}));
vi.mock('../../hooks/useSaveBar', () => ({
  useSaveBar: (options: unknown) => {
    saveBarCapture.current = options as typeof saveBarCapture.current;
  },
}));

vi.mock('../../hooks/useDashboardData', () => ({
  useDashboardSources: () => ({
    data: [
      { id: 'tcp-a', name: 'Indoor', type: 'meshtastic_tcp', enabled: true },
      { id: 'tcp-b', name: 'Solar', type: 'meshtastic_tcp', enabled: false },
      { id: 'mc-1', name: 'MeshCore', type: 'meshcore', enabled: true },
      { id: 'mq-1', name: 'Broker', type: 'mqtt_broker', enabled: true },
    ],
  }),
}));

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  default: { get: apiGetMock, post: apiPostMock },
  ApiError: class ApiError extends Error {},
}));

let stored = '';
let status = { configuredSourceId: null as string | null, effectiveSourceId: 'tcp-a', effectiveSourceName: 'Indoor', mode: 'automatic' };

describe('DefaultMeshtasticSourceSection (#5245)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored = '';
    status = { configuredSourceId: null, effectiveSourceId: 'tcp-a', effectiveSourceName: 'Indoor', mode: 'automatic' };
    apiGetMock.mockImplementation(async (url: string) =>
      url === '/api/settings' ? { defaultMeshtasticSourceId: stored } : { success: true, data: status },
    );
    apiPostMock.mockResolvedValue({ success: true });
  });

  it('lists Automatic and only the Meshtastic TCP sources, marking disabled ones', async () => {
    render(<DefaultMeshtasticSourceSection />);
    expect(screen.getByTestId('default-source-section').id).toBe(DEFAULT_SOURCE_SECTION_ID);
    const select = await screen.findByLabelText(/source used when none is chosen/i) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(['Automatic (first started)', 'Indoor', 'Solar (disabled)']);
    expect(select.value).toBe('');
  });

  it('shows what Automatic resolved to', async () => {
    render(<DefaultMeshtasticSourceSection />);
    expect(await screen.findByTestId('default-source-status')).toHaveTextContent('Automatic is using: Indoor.');
  });

  it('saves the chosen source through the unscoped settings POST', async () => {
    render(<DefaultMeshtasticSourceSection />);
    const select = await screen.findByLabelText(/source used when none is chosen/i) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));

    fireEvent.change(select, { target: { value: 'tcp-b' } });
    await waitFor(() => expect(saveBarCapture.current?.hasChanges).toBe(true));

    status = { configuredSourceId: 'tcp-b', effectiveSourceId: 'tcp-a', effectiveSourceName: 'Indoor', mode: 'fallback' };
    await act(async () => { await saveBarCapture.current!.onSave(); });
    expect(apiPostMock).toHaveBeenCalledWith('/api/settings', { defaultMeshtasticSourceId: 'tcp-b' });
    expect(await screen.findByText(/chosen source is not running, so Indoor/)).toBeInTheDocument();
  });

  it('keeps a stored id whose source is gone visible as its own option', async () => {
    stored = 'gone-id';
    render(<DefaultMeshtasticSourceSection />);
    const select = await screen.findByLabelText(/source used when none is chosen/i) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('gone-id'));
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('Unknown source (gone-id)');
  });
});
