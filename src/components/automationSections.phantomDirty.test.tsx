/**
 * @vitest-environment jsdom
 *
 * Regression: opening a Meshtastic source's Automation page showed
 * "Save changes to Auto Acknowledge" with no edits made.
 *
 * Each legacy automation section seeds its local form state with a display
 * fallback (`message || DEFAULT_MESSAGE`, `intervalHours || 6`, ...) but the
 * dirty check compared that local value against the RAW prop. Any setting the
 * server stores as blank/zero (e.g. `autoAckMessageDirect = ''`, which the
 * server reads as "reuse the standard message") therefore looked like an
 * unsaved edit the moment settings loaded. These tests render each section with
 * realistic loaded values that hit the fallback and assert the SaveBar is told
 * there are no changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import AutoAcknowledgeSection from './AutoAcknowledgeSection';
import AutoAnnounceSection from './AutoAnnounceSection';
import AutoWelcomeSection from './AutoWelcomeSection';
import AutoKeyManagementSection from './AutoKeyManagementSection';
import { Channel } from '../types/device';
import { DEFAULT_AUTOACK_MATRIX } from '../utils/autoAckMatrix';

const mockCsrfFetch = vi.fn();
vi.mock('../hooks/useCsrfFetch', () => ({
  useCsrfFetch: () => mockCsrfFetch,
}));
vi.mock('./ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../hooks/useSourceQuery', () => ({
  useSourceQuery: () => '',
}));
const mockUseSaveBar = vi.fn();
vi.mock('../hooks/useSaveBar', () => ({
  useSaveBar: (opts: unknown) => mockUseSaveBar(opts),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24h', dateFormat: 'YYYY-MM-DD' }),
}));
vi.mock('../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'sandbox', sourceName: 'Sandbox', sourceType: 'meshtastic_tcp' }),
}));
vi.mock('../services/api', () => ({
  default: { get: vi.fn().mockResolvedValue({ lastAnnouncementTime: null }) },
}));

/** The most recent `hasChanges` each section reported to the SaveBar. */
function lastHasChanges(id: string): boolean | undefined {
  const calls = mockUseSaveBar.mock.calls.filter(([opts]) => (opts as { id: string }).id === id);
  const last = calls[calls.length - 1];
  return last ? (last[0] as { hasChanges: boolean }).hasChanges : undefined;
}

const channels: Channel[] = [
  { id: 0, name: 'Primary', psk: 'test', uplinkEnabled: true, downlinkEnabled: true, createdAt: 0, updatedAt: 0 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockCsrfFetch.mockResolvedValue({ ok: true, json: async () => [] });
});

describe('Automation sections do not report phantom unsaved changes', () => {
  const autoAckCallbacks = {
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
    onHopLimitChange: vi.fn(),
    onTestMessagesChange: vi.fn(),
  };

  // Context defaults before /api/settings resolves (AutomationContext).
  const autoAckBeforeLoad = {
    enabled: false,
    regex: '^(test|ping)',
    message: '🤖 Copy, {NUMBER_HOPS} hops at {TIME}',
    messageDirect: '🤖 Copy, direct connection! SNR: {SNR}dB RSSI: {RSSI}dBm at {TIME}',
    channels,
    enabledChannels: [] as number[],
    skipIncompleteNodes: false,
    ignoredNodes: '',
    matrix: DEFAULT_AUTOACK_MATRIX,
    baseUrl: '',
    cooldownSeconds: 60,
    preSendDelaySeconds: 0,
    maxAttempts: 3,
    hopLimit: '',
    testMessages: '',
    ...autoAckCallbacks,
  };

  // What a source with blank stored strings loads as: the server treats blank
  // regex/message/messageDirect as "use the default", so they persist as ''.
  const autoAckLoadedBlank = {
    ...autoAckBeforeLoad,
    enabled: true,
    regex: '',
    message: '',
    messageDirect: '',
    enabledChannels: [2, 0, 1],
  };

  it('Auto Acknowledge: blank stored strings are not a change on mount', () => {
    render(<AutoAcknowledgeSection {...autoAckLoadedBlank} />);
    expect(lastHasChanges('auto-acknowledge')).toBe(false);
  });

  it('Auto Acknowledge: blank stored strings are not a change once settings load', () => {
    const { rerender } = render(<AutoAcknowledgeSection {...autoAckBeforeLoad} />);
    expect(lastHasChanges('auto-acknowledge')).toBe(false);
    rerender(<AutoAcknowledgeSection {...autoAckLoadedBlank} />);
    expect(lastHasChanges('auto-acknowledge')).toBe(false);
  });

  it('Auto Acknowledge: the dirty check does not reorder the parent channel array', () => {
    const enabledChannels = [2, 0, 1];
    render(<AutoAcknowledgeSection {...autoAckLoadedBlank} enabledChannels={enabledChannels} />);
    expect(enabledChannels).toEqual([2, 0, 1]);
  });

  it('Auto Announce: blank/zero stored values are not a change', () => {
    const props = {
      enabled: true,
      intervalHours: 0,
      message: '',
      channelIndexes: [] as number[],
      announceOnStart: false,
      useSchedule: false,
      schedule: '',
      channels,
      baseUrl: '',
      onEnabledChange: vi.fn(),
      onIntervalChange: vi.fn(),
      onMessageChange: vi.fn(),
      onChannelIndexesChange: vi.fn(),
      onAnnounceOnStartChange: vi.fn(),
      onUseScheduleChange: vi.fn(),
      onScheduleChange: vi.fn(),
    };
    render(<AutoAnnounceSection {...props} />);
    expect(lastHasChanges('auto-announce')).toBe(false);
  });

  it('Auto Announce: rendering without nodeInfoChannels settles instead of looping', () => {
    // The `nodeInfoChannels` default used to be an inline `= []`: a new array
    // each render, in the deps of an effect that sets state, so it re-rendered
    // until the worker ran out of heap. A settled render calls useSaveBar only
    // a handful of times.
    const props = {
      enabled: false,
      intervalHours: 6,
      message: 'MeshMonitor {VERSION} online for {DURATION} {FEATURES}',
      channelIndexes: [0],
      announceOnStart: false,
      useSchedule: false,
      schedule: '0 */6 * * *',
      channels,
      baseUrl: '',
      onEnabledChange: vi.fn(),
      onIntervalChange: vi.fn(),
      onMessageChange: vi.fn(),
      onChannelIndexesChange: vi.fn(),
      onAnnounceOnStartChange: vi.fn(),
      onUseScheduleChange: vi.fn(),
      onScheduleChange: vi.fn(),
    };
    render(<AutoAnnounceSection {...props} />);
    const renders = mockUseSaveBar.mock.calls.filter(([o]) => (o as { id: string }).id === 'auto-announce').length;
    expect(renders).toBeLessThan(10);
    expect(lastHasChanges('auto-announce')).toBe(false);
  });

  it('Auto Welcome: blank/zero stored values are not a change', () => {
    const props = {
      enabled: true,
      message: '',
      target: '',
      waitForName: true,
      maxHops: 0,
      delay: 30,
      channels,
      baseUrl: '',
      onEnabledChange: vi.fn(),
      onMessageChange: vi.fn(),
      onTargetChange: vi.fn(),
      onWaitForNameChange: vi.fn(),
      onMaxHopsChange: vi.fn(),
      onDelayChange: vi.fn(),
    };
    render(<AutoWelcomeSection {...props} />);
    expect(lastHasChanges('auto-welcome')).toBe(false);
  });

  it('Auto Key Management: zero stored values are not a change', () => {
    const props = {
      enabled: false,
      intervalMinutes: 0,
      maxExchanges: 0,
      autoPurge: false,
      immediatePurge: false,
      baseUrl: '',
      onEnabledChange: vi.fn(),
      onIntervalChange: vi.fn(),
      onMaxExchangesChange: vi.fn(),
      onAutoPurgeChange: vi.fn(),
      onImmediatePurgeChange: vi.fn(),
    };
    render(<AutoKeyManagementSection {...props} />);
    expect(lastHasChanges('auto-key-management')).toBe(false);
  });
});
