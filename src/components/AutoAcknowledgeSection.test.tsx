/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AutoAcknowledgeSection from './AutoAcknowledgeSection';
import { Channel } from '../types/device';
import { DEFAULT_AUTOACK_MATRIX } from '../utils/autoAckMatrix';
import enLocaleJson from '../../public/locales/en.json';

const enLocale = enLocaleJson as Record<string, string>;

// Mock the useCsrfFetch hook
const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch
}));

// Mock the ToastContainer
const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast })
}));

// Mock supporting hooks/contexts so the component renders in isolation.
vi.mock('../hooks/useSourceQuery', () => ({
  useSourceQuery: () => ''
}));
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: vi.fn()
}));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24h', dateFormat: 'YYYY-MM-DD' })
}));

/**
 * Active suite for the new 2×2 response matrix UI.
 *
 * Under the test i18n mock, t(key) returns the key verbatim, so the
 * "Respond via DM" checkboxes are labelled
 * `automation.auto_ack.matrix_respond_via_dm`.
 */
describe('AutoAcknowledgeSection — response matrix', () => {
  const mockChannels: Channel[] = [
    { id: 0, name: 'Primary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
  ];

  const matrixProps = {
    enabled: true,
    regex: '^(test|ping)',
    message: '🤖 Copy, {NUMBER_HOPS} hops at {TIME}',
    messageDirect: '🤖 Copy, direct! {TIME}',
    channels: mockChannels,
    enabledChannels: [0],
    skipIncompleteNodes: false,
    ignoredNodes: '',
    matrix: DEFAULT_AUTOACK_MATRIX,
    baseUrl: '',
    cooldownSeconds: 60,
    testMessages: 'test',
    onEnabledChange: vi.fn(),
    onRegexChange: vi.fn(),
    onMessageChange: vi.fn(),
    onMessageDirectChange: vi.fn(),
    onChannelsChange: vi.fn(),
    onSkipIncompleteNodesChange: vi.fn(),
    onIgnoredNodesChange: vi.fn(),
    onMatrixChange: vi.fn(),
    onCooldownSecondsChange: vi.fn(),
    onPreSendDelaySecondsChange: vi.fn(),
    onTestMessagesChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const replyDmCheckboxFor = (cellId: string): HTMLInputElement => {
    return document.getElementById(`autoAck-${cellId}-replyDm`) as HTMLInputElement;
  };
  const replyCheckboxFor = (cellId: string): HTMLInputElement => {
    return document.getElementById(`autoAck-${cellId}-reply`) as HTMLInputElement;
  };

  it('renders all six matrix cells (incl. the IP row) with three checkboxes each', () => {
    render(<AutoAcknowledgeSection {...matrixProps} />);
    for (const cellId of ['channelZeroHop', 'channelMultiHop', 'channelIp', 'directZeroHop', 'directMultiHop', 'directIp']) {
      expect(document.getElementById(`autoAck-${cellId}-reply`)).toBeInTheDocument();
      expect(document.getElementById(`autoAck-${cellId}-tapback`)).toBeInTheDocument();
      expect(document.getElementById(`autoAck-${cellId}-replyDm`)).toBeInTheDocument();
    }
  });

  it('disables "Respond via DM" for a channel cell until "Message" (reply) is checked', async () => {
    const user = userEvent.setup();
    render(<AutoAcknowledgeSection {...matrixProps} />);

    const replyDm = replyDmCheckboxFor('channelZeroHop');
    // Reply is off by default → Respond via DM disabled
    expect(replyDm).toBeDisabled();

    // Check the Message (reply) checkbox → Respond via DM becomes enabled
    await user.click(replyCheckboxFor('channelZeroHop'));

    await waitFor(() => {
      expect(replyDmCheckboxFor('channelZeroHop')).not.toBeDisabled();
    });
  });

  it('renders "Respond via DM" as checked + disabled for direct cells', () => {
    render(<AutoAcknowledgeSection {...matrixProps} />);

    for (const cellId of ['directZeroHop', 'directMultiHop', 'directIp']) {
      const replyDm = replyDmCheckboxFor(cellId);
      expect(replyDm).toBeChecked();
      expect(replyDm).toBeDisabled();
    }
  });

  it('lays out one row per path: 0 hops, multi-hop, then IP last (#5796)', () => {
    render(<AutoAcknowledgeSection {...matrixProps} />);
    const order = Array.from(document.querySelectorAll<HTMLInputElement>('input[id^="autoAck-"][id$="-reply"]'))
      .map((el) => el.id.replace(/^autoAck-/, '').replace(/-reply$/, ''));
    expect(order).toEqual(['channelZeroHop', 'directZeroHop', 'channelMultiHop', 'directMultiHop', 'channelIp', 'directIp']);
  });

  it('starts the IP row off and shows the note that MQTT/UDP now needs it', () => {
    render(<AutoAcknowledgeSection {...matrixProps} />);
    for (const cellId of ['channelIp', 'directIp']) {
      expect(replyCheckboxFor(cellId)).not.toBeChecked();
      expect((document.getElementById(`autoAck-${cellId}-tapback`) as HTMLInputElement)).not.toBeChecked();
    }
    expect(screen.getByTestId('autoAck-ip-row-note').textContent).toBe('automation.auto_ack.ip_row_note');
    expect(enLocale['automation.auto_ack.ip_row_note']).toMatch(/MQTT or UDP/);
    expect(enLocale['automation.auto_ack.ip_row_note']).toMatch(/used to answer/);
  });

  it('saves the six IP-row keys with the rest of the matrix', async () => {
    mockCsrfFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const onMatrixChange = vi.fn();
    const user = userEvent.setup();
    render(<AutoAcknowledgeSection {...matrixProps} onMatrixChange={onMatrixChange} />);

    await user.click(replyCheckboxFor('channelIp'));
    await user.click(document.getElementById('autoAck-directIp-tapback') as HTMLInputElement);

    const { useSaveBar } = await import('../hooks/useSaveBar');
    const latest = () => vi.mocked(useSaveBar).mock.calls.at(-1)![0] as { hasChanges: boolean; onSave: () => Promise<void> };
    await waitFor(() => expect(latest().hasChanges).toBe(true));
    await latest().onSave();

    await waitFor(() => expect(mockCsrfFetch).toHaveBeenCalled());
    const body = JSON.parse(mockCsrfFetch.mock.calls[0][1].body);
    expect(body.autoAckChannelIpReplyEnabled).toBe('true');
    expect(body.autoAckChannelIpTapbackEnabled).toBe('false');
    expect(body.autoAckChannelIpReplyDmEnabled).toBe('false');
    expect(body.autoAckDirectIpReplyEnabled).toBe('false');
    expect(body.autoAckDirectIpTapbackEnabled).toBe('true');
    expect(body.autoAckDirectIpReplyDmEnabled).toBe('false');
    await waitFor(() => expect(onMatrixChange).toHaveBeenCalledWith(expect.objectContaining({
      channelIp: { reply: true, tapback: false, replyDm: false },
      directIp: { reply: false, tapback: true, replyDm: false },
    })));
  });
});

describe('AutoAcknowledgeSection — Maximum number of responses', () => {
  const props = {
    enabled: true,
    regex: '^(test|ping)',
    message: '🤖 Copy, {NUMBER_HOPS} hops at {TIME}',
    messageDirect: '🤖 Copy, direct! {TIME}',
    channels: [
      { id: 0, name: 'Primary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
    ] as Channel[],
    enabledChannels: [0],
    skipIncompleteNodes: false,
    ignoredNodes: '',
    matrix: DEFAULT_AUTOACK_MATRIX,
    baseUrl: '',
    cooldownSeconds: 60,
    preSendDelaySeconds: 0,
    maxAttempts: 3,
    testMessages: 'test',
    onEnabledChange: vi.fn(),
    onRegexChange: vi.fn(),
    onMessageChange: vi.fn(),
    onMessageDirectChange: vi.fn(),
    onChannelsChange: vi.fn(),
    onSkipIncompleteNodesChange: vi.fn(),
    onIgnoredNodesChange: vi.fn(),
    onMatrixChange: vi.fn(),
    onCooldownSecondsChange: vi.fn(),
    onPreSendDelaySecondsChange: vi.fn(),
    onMaxAttemptsChange: vi.fn(),
    onTestMessagesChange: vi.fn(),
  };

  // `t` is mocked to echo keys here, so the field is found by id, not label text.
  const field = () => document.getElementById('autoAckMaxResponses') as HTMLInputElement;
  /** The newest SaveBar registration (useSaveBar is mocked at the top of this file). */
  const saveBar = async () => {
    const { useSaveBar } = await import('../hooks/useSaveBar');
    return vi.mocked(useSaveBar).mock.calls.at(-1)![0] as { hasChanges: boolean; onSave: () => Promise<void> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCsrfFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  });

  it('shows 2 when the prop is not passed, bounded 0-10', () => {
    render(<AutoAcknowledgeSection {...props} />);
    expect(field().value).toBe('2');
    expect(field().min).toBe('0');
    expect(field().max).toBe('10');
  });

  it('explains the wait, that replies and tapbacks both count, and that DMs are exempt', () => {
    render(<AutoAcknowledgeSection {...props} />);
    expect(document.querySelector('label[for="autoAckMaxResponses"]')!.textContent)
      .toBe('automation.auto_ack.max_responses_label');
    expect(field().getAttribute('aria-describedby')).toContain('autoAckMaxResponsesHelp');
    expect(document.getElementById('autoAckMaxResponsesHelp')!.textContent)
      .toBe('automation.auto_ack.max_responses_description');
    expect(enLocale['automation.auto_ack.max_responses_label']).toBe('Maximum number of responses');
    const help = enLocale['automation.auto_ack.max_responses_description'];
    expect(help).toMatch(/waits 5 to 30 seconds \(about 17 on average\)/);
    expect(help).toMatch(/does not appear at once/);
    expect(help).toMatch(/replied or sent a tapback/);
    expect(help).toMatch(/channel message/);
    expect(help).toMatch(/Direct messages are answered straight away/);
  });

  it('shows the "no limit" hint only at 0', () => {
    const { rerender } = render(<AutoAcknowledgeSection {...props} maxResponses={3} />);
    expect(screen.queryByText('automation.auto_ack.max_responses_zero_hint')).not.toBeInTheDocument();
    rerender(<AutoAcknowledgeSection {...props} maxResponses={0} />);
    expect(field().value).toBe('0');
    expect(screen.getByText('automation.auto_ack.max_responses_zero_hint')).toBeInTheDocument();
  });

  it('a loaded value is not an unsaved change; an edit is, and saves as a string', async () => {
    const onMaxResponsesChange = vi.fn();
    const user = userEvent.setup();
    render(<AutoAcknowledgeSection {...props} maxResponses={2} onMaxResponsesChange={onMaxResponsesChange} />);
    expect((await saveBar()).hasChanges).toBe(false);

    await user.clear(field());
    await user.type(field(), '4');
    await waitFor(async () => expect((await saveBar()).hasChanges).toBe(true));

    await (await saveBar()).onSave();
    await waitFor(() => expect(mockCsrfFetch).toHaveBeenCalled());
    const body = JSON.parse(mockCsrfFetch.mock.calls[0][1].body);
    expect(body.autoAckMaxResponses).toBe('4');
    await waitFor(() => expect(onMaxResponsesChange).toHaveBeenCalledWith(4));
  });

  it('0 saves as "0", not as the default', async () => {
    const user = userEvent.setup();
    render(<AutoAcknowledgeSection {...props} maxResponses={2} />);
    await user.clear(field());
    await user.type(field(), '0');
    await waitFor(async () => expect((await saveBar()).hasChanges).toBe(true));
    await (await saveBar()).onSave();
    await waitFor(() => expect(mockCsrfFetch).toHaveBeenCalled());
    expect(JSON.parse(mockCsrfFetch.mock.calls[0][1].body).autoAckMaxResponses).toBe('0');
  });
});
