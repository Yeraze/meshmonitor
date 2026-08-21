/**
 * @vitest-environment jsdom
 *
 * RelayCandidateList (#4816 follow-up) — the "who relayed this?" candidate
 * ranking extracted from RelayNodeModal into the unified MessageDetailsModal.
 * Mirrors the candidate-selection assertions: byte match, ack mode, unknown
 * relay (0), and the no-match state.
 */
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import RelayCandidateList, { type RelayCandidateNode } from './RelayCandidateList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

const node = (over: Partial<RelayCandidateNode> = {}): RelayCandidateNode => ({
  nodeNum: 0x1234abcd,
  nodeId: '!1234abcd',
  longName: 'Alpha',
  shortName: 'ALPH',
  heardDirectly: true,
  avgDirectRssi: -50,
  hopsAway: 0,
  ...over,
});

const noop = () => {};

describe('RelayCandidateList', () => {
  it('renders nothing when there is no relay byte and no ack node', () => {
    const { container } = render(<RelayCandidateList nodes={[node()]} onNodeClick={noop} />);
    expect(container.textContent).toBe('');
  });

  it('matches a candidate by the relay low byte and lists it', () => {
    render(
      <RelayCandidateList
        relayNode={0xcd}
        nodes={[node(), node({ nodeNum: 0x9999_0011, nodeId: '!99990011', longName: 'Beta', shortName: 'BETA' })]}
        onNodeClick={noop}
      />,
    );
    expect(screen.getByText('relay_modal.potential_relays')).toBeInTheDocument();
    expect(screen.getByText(/Alpha \(ALPH\)/)).toBeInTheDocument();
    // The non-matching node (byte 0x11) is not shown.
    expect(screen.queryByText(/Beta/)).toBeNull();
  });

  it('ack mode shows only the acknowledging node', () => {
    render(
      <RelayCandidateList
        ackFromNode={0x1234abcd}
        nodes={[node(), node({ nodeNum: 0x2222_2222, nodeId: '!22222222', longName: 'Beta', shortName: 'BETA' })]}
        onNodeClick={noop}
      />,
    );
    expect(screen.getByText('relay_modal.acknowledged_by')).toBeInTheDocument();
    expect(screen.getByText(/Alpha \(ALPH\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Beta/)).toBeNull();
  });

  it('unknown relay (byte 0) shows directly-heard neighbors as estimates', () => {
    render(
      <RelayCandidateList
        relayNode={0}
        messageRssi={-51}
        nodes={[
          node({ longName: 'Near', avgDirectRssi: -50 }),
          node({ nodeNum: 0x5555_0000, nodeId: '!55550000', longName: 'NotHeard', heardDirectly: false }),
        ]}
        onNodeClick={noop}
      />,
    );
    expect(screen.getByText('relay_modal.estimated_relays')).toBeInTheDocument();
    expect(screen.getByText(/Near/)).toBeInTheDocument();
    // Nodes never heard directly are excluded from the 0-byte estimate.
    expect(screen.queryByText(/NotHeard/)).toBeNull();
  });

  it('shows the no-match state when nothing matches the relay byte', () => {
    render(<RelayCandidateList relayNode={0xee} nodes={[node()]} onNodeClick={noop} />);
    expect(screen.getByText(/relay_modal.no_matches/)).toBeInTheDocument();
  });
});
