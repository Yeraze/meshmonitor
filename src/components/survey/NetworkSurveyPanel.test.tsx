/**
 * @vitest-environment jsdom
 *
 * Network survey panel (#4726).
 *
 * The behaviours worth pinning are the ones that would otherwise mislead:
 * telling "nothing heard" apart from "the query failed", and never rendering
 * an absent measurement as a zero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `get` records call arguments only; behaviour is driven by `pendingFailures`
 * and `currentData`.
 *
 * Deliberately NOT `mockRejectedValue`: vitest's spy records returned promises
 * in `mock.results` and reports a rejected one as an unhandled rejection at
 * cleanup, even though the component awaits it inside a try/catch. Throwing
 * from an async wrapper produces the same rejection for the caller with no
 * spy-tracked promise to trip over.
 */
const get = vi.fn();
let pendingFailures = 0;
let currentData: unknown = null;

vi.mock('../../services/api', () => ({
  default: {
    get: async (...a: unknown[]) => {
      get(...a);
      if (pendingFailures > 0) {
        pendingFailures--;
        throw new Error('boom');
      }
      return { success: true, data: currentData };
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k) }),
}));
vi.mock('../icons/UiIcon', () => ({ UiIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));

import NetworkSurveyPanel from './NetworkSurveyPanel';
import { nodeLabel } from './nodeLabel';

const survey = (o: Record<string, unknown> = {}) => ({
  sourceId: 'src-a',
  generatedAt: 1_000,
  windowHours: 24,
  nodes: { total: 12, activeInWindow: 5, withPosition: 3 },
  directNeighbours: [
    { nodeNum: 0xaabbccdd, name: 'Hilltop', avgRssi: -72.5, packetCount: 40, lastHeard: 1 },
    { nodeNum: 0x11223344, name: null, avgRssi: null, packetCount: 2, lastHeard: 1 },
  ],
  hopDistribution: [{ hops: 0, nodeCount: 2 }, { hops: 2, nodeCount: 6 }],
  maxHops: 2,
  ...o,
});

const renderPanel = (data: unknown, props: Record<string, unknown> = {}) => {
  currentData = data;
  return render(<NetworkSurveyPanel sourceId="src-a" {...props} />);
};

beforeEach(() => {
  get.mockReset();
  pendingFailures = 0;
  currentData = null;
});

describe('nodeLabel', () => {
  it('falls back to a hex node id rather than "unknown"', () => {
    expect(nodeLabel({ nodeNum: 0xaabbccdd, name: null }))
      .toBe('!aabbccdd');
  });
});

describe('NetworkSurveyPanel', () => {
  it('renders nothing without a source', () => {
    render(<NetworkSurveyPanel sourceId={null} />);
    expect(screen.queryByTestId('network-survey-panel')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('states plainly that viewing it transmits nothing', async () => {
    // A panel called "survey" that quietly used airtime would be a nasty
    // surprise, and the user has no other way to tell.
    renderPanel(survey());
    expect(await screen.findByText('survey.passive_note')).toBeTruthy();
  });

  it('renders the headline counts', async () => {
    renderPanel(survey());
    expect((await screen.findByTestId('survey-total')).textContent).toBe('12');
    expect(screen.getByTestId('survey-active').textContent).toBe('5');
  });

  it('shows an em dash, not 0, when no traceroute has been answered', async () => {
    // "reach unknown" and "reach is zero hops" are different claims.
    renderPanel(survey({ maxHops: null, hopDistribution: [] }));
    expect((await screen.findByTestId('survey-maxhops')).textContent).toBe('—');
    expect(screen.getByTestId('survey-no-hops')).toBeTruthy();
  });

  it('shows an em dash for a neighbour with no RSSI rather than 0 dBm', async () => {
    renderPanel(survey());
    const row = await screen.findByTestId('survey-neighbour-287454020');
    expect(row.textContent).toContain('—');
    expect(row.textContent).not.toContain('0 dBm');
  });

  it('distinguishes a failed query from an empty mesh', async () => {
    pendingFailures = Number.MAX_SAFE_INTEGER; // every attempt fails
    render(<NetworkSurveyPanel sourceId="src-a" />);

    expect(await screen.findByTestId('survey-error')).toBeTruthy();
    // Must NOT claim nothing was heard — that would be a false statement.
    expect(screen.queryByTestId('survey-no-neighbours')).toBeNull();
  });

  it('says nothing was heard when the mesh really is quiet', async () => {
    renderPanel(survey({ directNeighbours: [], hopDistribution: [], maxHops: null }));
    expect(await screen.findByTestId('survey-no-neighbours')).toBeTruthy();
    expect(screen.queryByTestId('survey-error')).toBeNull();
  });

  it('refetches with the chosen window', async () => {
    const user = userEvent.setup();
    renderPanel(survey());
    await screen.findByTestId('survey-total');

    await user.selectOptions(screen.getByTestId('survey-window'), '6');

    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/sources/src-a/survey?hours=6'));
  });

  it('recovers via retry after a failure', async () => {
    const user = userEvent.setup();
    pendingFailures = 1; // first attempt fails, the retry succeeds
    currentData = survey();
    render(<NetworkSurveyPanel sourceId="src-a" />);

    await screen.findByTestId('survey-error');
    await user.click(screen.getByText('survey.retry'));

    expect(await screen.findByTestId('survey-total')).toBeTruthy();
    expect(screen.queryByTestId('survey-error')).toBeNull();
  });
});

describe('stylesheet', () => {
  it('defines every class the component references', () => {
    // Same guard as the beacon panel: a missing CSS-module key is `undefined`,
    // which React and TypeScript both accept silently.
    const dir = dirname(fileURLToPath(import.meta.url));
    const tsx = readFileSync(join(dir, 'NetworkSurveyPanel.tsx'), 'utf8');
    const css = readFileSync(join(dir, 'NetworkSurveyPanel.module.css'), 'utf8');

    const defined = new Set(Array.from(css.matchAll(/^\.([A-Za-z][\w-]*)/gm), (m) => m[1]));
    const used = new Set(Array.from(tsx.matchAll(/styles\.([A-Za-z][\w]*)/g), (m) => m[1]));

    expect(Array.from(used).filter((c) => !defined.has(c))).toEqual([]);
  });
});
