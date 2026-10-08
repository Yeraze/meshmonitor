/**
 * @vitest-environment jsdom
 *
 * Traffic Management "Estimate impact" panel (#5670), rendered inside the real
 * form so the test sees what the user sees.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});
vi.mock('../../hooks/useSaveBar', () => ({ useSaveBar: vi.fn() }));
const sourceState = vi.hoisted(() => ({ sourceId: 'src-a' as string | null, sourceName: 'A' }));
vi.mock('../../contexts/SourceContext', () => ({ useSource: () => sourceState }));

import apiService from '../../services/api';
import TrafficManagementConfigSection from './TrafficManagementConfigSection';
import {
  TMM_MIRROR_FIRMWARE_VERSION,
  type RuleOutcome,
  type TrafficReplayResponse,
} from '../../utils/trafficManagementReplay';

const HOUR = 3_600_000;
const ALICE = 0x11111111;

const estimate = (over: Partial<Extract<RuleOutcome, { status: 'estimate' }>> = {}): RuleOutcome => ({
  status: 'estimate',
  historySpanMs: 6 * HOUR,
  requiredSpanMs: HOUR / 2,
  droppedMin: 12,
  droppedMax: 18,
  consideredPackets: 240,
  bound: 'lower_bound',
  caveats: [
    'ALREADY_FILTERED_ABSENT',
    'EMPTY_CACHE_AT_START',
    'TICK_PHASE_UNKNOWN',
    'CACHE_LOSS_NOT_MODELLED',
    'LOCAL_NODE_ONLY',
    'RELAYED_UNICAST_INVISIBLE',
  ],
  bySender: [
    { key: ALICE, min: 10, max: 14 },
    { key: null, min: 2, max: 4 },
  ],
  byPortnum: [
    { key: 67, min: 12, max: 16 },
    { key: null, min: 0, max: 2 },
  ],
  ...over,
});

function response(over: Partial<TrafficReplayResponse> = {}): TrafficReplayResponse {
  const off = { enabled: false, effectiveMs: 0, ticks: 0, sweepReset: false };
  return {
    sourceId: 'src-a',
    senders: { [String(ALICE)]: { nodeId: '!11111111', shortName: 'ALI', longName: 'Alice' } },
    firmwareVersion: TMM_MIRROR_FIRMWARE_VERSION,
    loggingEnabled: true,
    rowsScanned: 1000,
    truncated: false,
    scanCap: 50_000,
    historyStartMs: 0,
    historyEndMs: 6 * HOUR,
    historySpanMs: 6 * HOUR,
    phasesSampled: 60,
    minRateLimitWindows: 6,
    skipped: { ownPackets: 0, addressedToNode: 0, encrypted: 0, serverDecrypted: 0 },
    current: { positionMinIntervalSecs: 0, rateLimitWindowSecs: 0, rateLimitMaxPackets: 0 },
    proposed: { positionMinIntervalSecs: 0, rateLimitWindowSecs: 420, rateLimitMaxPackets: 5 },
    effective: {
      current: { positionDedup: off, rateLimit: { ...off, threshold: 0 } },
      proposed: {
        positionDedup: off,
        rateLimit: { enabled: true, effectiveMs: 300_000, ticks: 1, sweepReset: false, threshold: 5 },
      },
    },
    positionDedup: { status: 'unchanged', historySpanMs: 6 * HOUR, requiredSpanMs: 0 },
    rateLimit: estimate(),
    ...over,
  };
}

const onSave = vi.fn().mockResolvedValue(undefined);

function Form({ isDisabled = false }: { isDisabled?: boolean }) {
  const [interval, setInterval_] = useState(0);
  const [hops, setHops] = useState(0);
  const [windowSecs, setWindowSecs] = useState(420);
  const [maxPackets, setMaxPackets] = useState(5);
  const [unknown, setUnknown] = useState(0);
  return (
    <TrafficManagementConfigSection
      positionMinIntervalSecs={interval}
      setPositionMinIntervalSecs={setInterval_}
      nodeinfoDirectResponseMaxHops={hops}
      setNodeinfoDirectResponseMaxHops={setHops}
      rateLimitWindowSecs={windowSecs}
      setRateLimitWindowSecs={setWindowSecs}
      rateLimitMaxPackets={maxPackets}
      setRateLimitMaxPackets={setMaxPackets}
      unknownPacketThreshold={unknown}
      setUnknownPacketThreshold={setUnknown}
      isDisabled={isDisabled}
      isSaving={false}
      onSave={onSave}
    />
  );
}

describe('TrafficManagementReplayPanel', () => {
  let replay: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sourceState.sourceId = 'src-a';
    onSave.mockClear();
    replay = vi.spyOn(apiService, 'getTrafficManagementReplay').mockResolvedValue(response());
    fetchSpy = vi.fn(() => Promise.reject(new Error('the panel must not fetch on its own')));
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const press = () => fireEvent.click(screen.getByTestId('tm-replay-estimate'));
  const setNumber = (id: string, value: string) => {
    const input = document.getElementById(id) as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
  };

  it('warns beside the controls that these settings drop other people\'s packets', () => {
    render(<Form />);
    expect(screen.getByTestId('tm-drop-warning').textContent).toMatch(/drop other people's packets/);
    expect(screen.getByTestId('tm-drop-warning').textContent).toMatch(/not relayed and is not delivered/);
  });

  it('does not run until Estimate is pressed, and not when the form changes', () => {
    render(<Form />);
    setNumber('rateLimitMaxPackets', '9');
    setNumber('positionMinIntervalSecs', '3600');
    expect(replay).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes exactly one read with the values in the form, unsaved edits included', async () => {
    render(<Form />);
    setNumber('rateLimitMaxPackets', '9');
    setNumber('positionMinIntervalSecs', '3600');
    press();
    await screen.findByTestId('tm-replay-rate-range');

    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith('src-a', {
      positionMinIntervalSecs: 3600,
      rateLimitWindowSecs: 420,
      rateLimitMaxPackets: 9,
    });
    // Nothing else goes out, and nothing is saved.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows the range, the bound, the history used and every caveat as visible text', async () => {
    render(<Form />);
    press();
    const rangeLine = await screen.findByTestId('tm-replay-rate-range');
    expect(rangeLine.textContent).toContain('12–18');
    expect(rangeLine.textContent).toContain('of 240 logged packets would have been dropped');
    expect(screen.getByTestId('tm-replay-rate-bound').textContent).toBe('Lower bound');

    const rate = screen.getByTestId('tm-replay-rate');
    expect(rate.textContent).toContain('History used: 6 h. This value needs at least 30 min.');
    expect(rate.textContent).toContain('it treats 7 min as 5 min');

    const caveats = within(screen.getByTestId('tm-replay-rate-caveats')).getAllByRole('listitem');
    expect(caveats).toHaveLength(6);
    const text = screen.getByTestId('tm-replay-rate-caveats').textContent ?? '';
    expect(text).toContain('Packets the node already drops never reach MeshMonitor');
    expect(text).toContain('A low number, or zero, does not mean the node drops little');
    expect(text).toContain('tried 60 starting points');
    expect(text).toContain('real drops are likely higher');
    expect(text).toContain('not a figure for the whole mesh');
    // Beside the numbers, not in a tooltip.
    expect(screen.getByTestId('tm-replay-rate-caveats').getAttribute('title')).toBeNull();

    expect(screen.getByTestId('tm-replay-meta').textContent).toContain('1000 rows over 6 h');
    expect(screen.getByTestId('tm-replay-panel').textContent).toContain(TMM_MIRROR_FIRMWARE_VERSION);
  });

  it('names visible senders and folds the rest into "other"', async () => {
    render(<Form />);
    press();
    const senders = await screen.findByTestId('tm-replay-rate-senders');
    expect(senders.textContent).toContain('ALI (Alice)');
    expect(senders.textContent).toContain('10–14');
    expect(senders.textContent).toContain('Other senders');
    const ports = screen.getByTestId('tm-replay-rate-ports');
    expect(ports.textContent).toContain('TELEMETRY');
    expect(ports.textContent).toContain('Other packet types');
  });

  it('keeps the caveat when the answer is zero', async () => {
    replay.mockResolvedValue(response({ rateLimit: estimate({ droppedMin: 0, droppedMax: 0, bySender: [], byPortnum: [] }) }));
    render(<Form />);
    press();
    const rangeLine = await screen.findByTestId('tm-replay-rate-range');
    expect(rangeLine.textContent).toMatch(/^0 of 240/);
    expect(screen.getByTestId('tm-replay-rate-caveats').textContent).toContain('A low number, or zero, does not mean the node drops little');
  });

  it('says "unchanged", not zero, for a rule whose value acts like the current one', async () => {
    render(<Form />);
    press();
    expect((await screen.findByTestId('tm-replay-dedup-unchanged')).textContent).toContain('nothing to estimate');
    expect(screen.queryByTestId('tm-replay-dedup-range')).toBeNull();
  });

  it.each([
    ['PACKET_LOG_DISABLED', /Packet logging is off/, /Turn on packet logging/],
    ['HISTORY_TOO_SHORT', /The log covers 20 min\. This value needs at least 30 min\./, /Wait for more history/],
    ['LOOSER_THAN_CURRENT', /looser than the one the node runs now/, /Only a tighter value can be estimated/],
  ] as const)('explains a %s refusal and what would fix it', async (reason, why, fix) => {
    replay.mockResolvedValue(
      response({ rateLimit: { status: 'cannot_estimate', reason, historySpanMs: HOUR / 3, requiredSpanMs: HOUR / 2 } }),
    );
    render(<Form />);
    press();
    const refused = await screen.findByTestId('tm-replay-rate-refused');
    expect(refused.getAttribute('data-reason')).toBe(reason);
    expect(refused.textContent).toContain('Cannot estimate.');
    expect(refused.textContent).toMatch(why);
    expect(refused.textContent).toMatch(fix);
    expect(screen.queryByTestId('tm-replay-rate-range')).toBeNull();
  });

  it('shows the server\'s reason when the source cannot be estimated at all', async () => {
    replay.mockRejectedValue(new Error('Source "x" is not connected'));
    render(<Form />);
    press();
    expect((await screen.findByTestId('tm-replay-error')).textContent).toContain('is not connected');
  });

  it('marks the result stale when the form changes after an estimate, without re-running', async () => {
    render(<Form />);
    press();
    await screen.findByTestId('tm-replay-rate-range');
    setNumber('rateLimitMaxPackets', '3');
    await waitFor(() => expect(screen.getByTestId('tm-replay-stale')).toBeTruthy());
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('is hidden when the firmware does not support Traffic Management', () => {
    render(<Form isDisabled />);
    expect(screen.queryByTestId('tm-replay-panel')).toBeNull();
  });

  it('cannot run without a source', () => {
    sourceState.sourceId = null;
    render(<Form />);
    expect((screen.getByTestId('tm-replay-estimate') as HTMLButtonElement).disabled).toBe(true);
  });
});
