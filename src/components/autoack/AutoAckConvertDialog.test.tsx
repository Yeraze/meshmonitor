/**
 * @vitest-environment jsdom
 *
 * AutoAckConvertDialog (#4340 Phase 4 WP4, spec §7): the disable checkbox is
 * checked on first render; unchecking it sends `disableAutoAck: false`; the
 * `notConvertible` group renders every entry; `blocking` disables Convert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AutoAckConvertDialog, { type AutoAckConvertPreviewData } from './AutoAckConvertDialog';

const mockCsrfFetch = vi.fn();
vi.mock('../../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'source-1', sourceName: 'Test Source' }),
}));

const mockShowToast = vi.fn();
vi.mock('../ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

const BASE_AUTOMATION = {
  key: 'direct' as const,
  name: 'Auto-Ack — Test Source',
  description: 'Converted from Auto-Acknowledge (source source-1) on 2026-07-28.',
  enabled: true,
  config: {},
  form: {
    trigger: { type: 'trigger.message', params: { regex: '^(test|ping)', cooldownSeconds: 60, cooldownScope: 'node' } },
    rules: [
      {
        conditions: [
          { type: 'condition.sourceFilter', params: { sourceIds: ['source-1'] } },
          { type: 'condition.numeric', params: { field: 'isDM', op: '==', value: '1' } },
          { type: 'condition.numeric', params: { field: 'zeroHop', op: '==', value: '1' } },
        ],
        actions: [
          { type: 'action.sendMessage', params: { text: 'Copy!', to: '{{ trigger.from }}' } },
        ],
      },
    ],
    combine: null,
  },
};

function buildPreviewData(overrides: Partial<AutoAckConvertPreviewData> = {}): AutoAckConvertPreviewData {
  return {
    sourceId: 'source-1',
    sourceName: 'Test Source',
    autoAckEnabled: true,
    automations: [BASE_AUTOMATION],
    report: {
      converted: [{ key: 'autoAckRegex', label: 'Trigger regex', detail: 'Emitted verbatim.' }],
      approximated: [],
      notConvertible: [
        { key: 'autoAckTestMessages', label: 'Test messages scratchpad', detail: 'No server code reads this key.' },
        { key: 'autoAckMaxAttempts', label: 'DM resend attempts', detail: 'Never emitted onto action.sendMessage.' },
      ],
      dropped: [],
    },
    existing: [],
    blocking: null,
    ...overrides,
  };
}

describe('AutoAckConvertDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks the disable-Auto-Acknowledge checkbox by default on first render', async () => {
    mockCsrfFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: buildPreviewData() }));

    render(<AutoAckConvertDialog isOpen onClose={vi.fn()} baseUrl="" onEnabledChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Turn off Auto-Acknowledge for this source/)).toBeInTheDocument();
    });

    const checkbox = screen.getByText(/Turn off Auto-Acknowledge for this source/).closest('label')?.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox).toBeChecked();
  });

  it('sends disableAutoAck: false when the checkbox is unchecked before converting', async () => {
    mockCsrfFetch
      .mockResolvedValueOnce(jsonResponse({ success: true, data: buildPreviewData() }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { created: [{ id: '1', name: 'Auto-Ack — Test Source' }], updated: [], deleted: [], autoAckDisabled: false, report: buildPreviewData().report },
      }));

    render(<AutoAckConvertDialog isOpen onClose={vi.fn()} baseUrl="" onEnabledChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Turn off Auto-Acknowledge for this source/)).toBeInTheDocument();
    });

    const disableCheckbox = screen
      .getByText(/Turn off Auto-Acknowledge for this source/)
      .closest('label')
      ?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(disableCheckbox);
    expect(disableCheckbox.checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));

    await waitFor(() => {
      expect(mockCsrfFetch).toHaveBeenCalledTimes(2);
    });

    const createCall = mockCsrfFetch.mock.calls[1];
    const body = JSON.parse(createCall[1].body as string);
    expect(body.disableAutoAck).toBe(false);
    expect(body.sourceId).toBe('source-1');
  });

  it('renders every notConvertible report entry', async () => {
    mockCsrfFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: buildPreviewData() }));

    render(<AutoAckConvertDialog isOpen onClose={vi.fn()} baseUrl="" onEnabledChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('autoAckTestMessages')).toBeInTheDocument();
      expect(screen.getByText('autoAckMaxAttempts')).toBeInTheDocument();
    });
    expect(screen.getByText('Test messages scratchpad')).toBeInTheDocument();
    expect(screen.getByText('DM resend attempts')).toBeInTheDocument();
  });

  it('renders the notConvertible group even when it is empty', async () => {
    mockCsrfFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: buildPreviewData({ report: { converted: [], approximated: [], notConvertible: [], dropped: [] } }),
    }));

    render(<AutoAckConvertDialog isOpen onClose={vi.fn()} baseUrl="" onEnabledChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Not convertible \(0\)/)).toBeInTheDocument();
    });
  });

  it('disables Convert when the preview reports a blocking reason', async () => {
    mockCsrfFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: buildPreviewData({ automations: [], blocking: 'NO_CELLS_ENABLED' }),
    }));

    render(<AutoAckConvertDialog isOpen onClose={vi.fn()} baseUrl="" onEnabledChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
    });
    expect(screen.getByText(/Nothing to convert/)).toBeInTheDocument();
  });
});
