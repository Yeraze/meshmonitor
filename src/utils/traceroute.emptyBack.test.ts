/**
 * Tests for formatTracerouteRoute empty-array guard (issue #3622).
 *
 * TracerouteHistoryModal calls:
 *   formatTracerouteRoute(tr.routeBack, tr.snrBack, tr.toNodeNum, tr.fromNodeNum, ...)
 *
 * When the local node (L) sees its own outgoing RESPONSE before relay nodes have
 * populated routeBack, both `route` and `snr` are empty JSON arrays ('[]').
 * Before the fix, this rendered a fictitious "L → A" direct-connection line.
 * After the fix, it returns '(No return path data)'.
 *
 * Contrast with a genuine direct hop, where route=[] but snr has data.
 */
import { describe, it, expect } from 'vitest';
import { formatTracerouteRoute } from './traceroute';
import { DeviceInfo } from '../types/device';

const mockNodes: DeviceInfo[] = [
  {
    nodeNum: 0xaaaa0001,
    user: { id: '!aaaa0001', longName: 'Node A', shortName: 'NDEA' },
  },
  {
    nodeNum: 0xbbbb0002,
    user: { id: '!bbbb0002', longName: 'Node L', shortName: 'NDEL' },
  },
];

describe('formatTracerouteRoute — empty route + empty snr (issue #3622)', () => {
  it('returns "(No return path data)" when both route and snr are empty arrays', () => {
    // This is the case seen when L's own outgoing RESPONSE is observed before
    // relay nodes have populated routeBack. Both fields are '[]', not null.
    const result = formatTracerouteRoute(
      '[]',   // routeBack = empty, not yet populated
      '[]',   // snrBack   = empty
      0xbbbb0002, // toNodeNum  = L (requester's POV: L is the from in return display)
      0xaaaa0001, // fromNodeNum = A (requester's POV: A is the to in return display)
      mockNodes,
    );

    expect(result).toBe('(No return path data)');
  });

  it('renders normally when route is [] but snr has entries (genuine direct hop)', () => {
    // A single-hop traceroute: no intermediate nodes, but the firmware recorded
    // an SNR for the single RF link. This is a real direct connection — should render.
    const result = formatTracerouteRoute(
      '[]',            // no intermediate hops
      '[32]',          // 8 dB SNR for the single hop
      0xbbbb0002,
      0xaaaa0001,
      mockNodes,
    );

    // Should render node names (not the "(No return path data)" sentinel).
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    expect(str).not.toBe('(No return path data)');
    expect(str).not.toBe('(No response received)');
  });

  it('still returns "(No response received)" for a null route', () => {
    // Existing behaviour: a completely missing/null route means the traceroute failed.
    const result = formatTracerouteRoute(
      null,
      null,
      0xbbbb0002,
      0xaaaa0001,
      mockNodes,
    );

    expect(result).toBe('(No response received)');
  });

  it('renders a multi-hop route correctly when both route and snr have data', () => {
    // The guard must not accidentally block valid multi-hop paths.
    const result = formatTracerouteRoute(
      '[3221291011]',  // one intermediate hop (0xc0010003)
      '[40, 32]',      // SNR for each hop
      0xbbbb0002,
      0xaaaa0001,
      mockNodes,
    );

    const str = typeof result === 'string' ? result : JSON.stringify(result);
    expect(str).not.toBe('(No return path data)');
    expect(str).not.toBe('(No response received)');
  });
});
