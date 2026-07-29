/**
 * @vitest-environment jsdom
 *
 * Focused test for the "Convert to an Automation…" entry point (#4340 Phase 4
 * WP4, spec §6.1 / §7): the button renders and is disabled while `hasChanges`
 * is true. Deliberately a separate file — the existing
 * `AutoAcknowledgeSection.test.tsx` is `describe.skip`'d pending a wholesale
 * rewrite (out of scope for this phase; do not un-skip it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AutoAcknowledgeSection from './AutoAcknowledgeSection';
import { Channel } from '../types/device';
import { DEFAULT_AUTOACK_MATRIX } from '../utils/autoAckMatrix';

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));

const mockShowToast = vi.fn();
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}));

vi.mock('../hooks/useSourceQuery', () => ({
  useSourceQuery: () => '',
}));
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: vi.fn(),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ timeFormat: '24h', dateFormat: 'YYYY-MM-DD' }),
}));
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'source-1', sourceName: 'Test Source' }),
}));

const mockChannels: Channel[] = [
  { id: 0, name: 'Primary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
];

const mockCallbacks = {
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

const defaultProps = {
  enabled: true,
  regex: '^(test|ping)',
  message: '🤖 Copy, {NUMBER_HOPS} hops at {TIME}',
  // Must match the component's own DEFAULT_MESSAGE_DIRECT — the hasChanges diff
  // compares this raw prop against a local state seeded with `messageDirect ||
  // DEFAULT_MESSAGE_DIRECT`, so an empty-string prop would read as an unsaved
  // change on mount even though nothing changed.
  messageDirect: '🤖 Copy, direct connection! SNR: {SNR}dB RSSI: {RSSI}dBm at {TIME}',
  channels: mockChannels,
  enabledChannels: [0],
  skipIncompleteNodes: false,
  ignoredNodes: '',
  matrix: DEFAULT_AUTOACK_MATRIX,
  baseUrl: '',
  cooldownSeconds: 60,
  preSendDelaySeconds: 0,
  maxAttempts: 3,
  testMessages: 'test\nTest message\nping\nPING\nHello world\nTESTING 123',
  ...mockCallbacks,
};

describe('AutoAcknowledgeSection — Convert to an Automation button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the button, enabled, when there are no unsaved changes', () => {
    render(<AutoAcknowledgeSection {...defaultProps} />);

    const button = screen.getByRole('button', { name: /Convert to an Automation/ });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it('disables the button once the local form has unsaved changes', () => {
    render(<AutoAcknowledgeSection {...defaultProps} />);

    const regexInput = screen.getByPlaceholderText('^(test|ping)');
    fireEvent.change(regexInput, { target: { value: '^(different)' } });

    const button = screen.getByRole('button', { name: /Convert to an Automation/ });
    expect(button).toBeDisabled();
  });
});
