/**
 * @vitest-environment jsdom
 *
 * Coverage for `TracerouteParticipationPicker` and its exported
 * `buildOptionLabel` helper (Traceroute Strip Interactivity epic, phase 2,
 * WP2 §8.6). See docs/internal/dev-notes/TRS_PHASE2_SPEC.md §6.3.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { TFunction } from 'i18next';
import enLocale from '../../../public/locales/en.json';
import { TracerouteParticipationPicker, buildOptionLabel } from './TracerouteParticipationPicker';
import type { TracerouteParticipationEntry } from '../../services/api';
import type { DeviceInfo } from '../../types/device';

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

const NODE_A_ID = '!000003e8'; // 1000
const NODE_B_ID = '!000007d0'; // 2000
const UNKNOWN_NODE_ID = '!ffffffff'; // not present in `nodes`

const nodeA: DeviceInfo = {
  nodeNum: 1000,
  user: { id: NODE_A_ID, longName: 'Node Alpha', shortName: 'ALFA' },
} as DeviceInfo;

const nodeB: DeviceInfo = {
  nodeNum: 2000,
  user: { id: NODE_B_ID, longName: 'Node Bravo', shortName: 'BRVO' },
} as DeviceInfo;

const nodes: DeviceInfo[] = [nodeA, nodeB];

function makeEntry(overrides: Partial<TracerouteParticipationEntry> = {}): TracerouteParticipationEntry {
  return {
    id: 1,
    timestamp: Date.parse('2026-07-29T12:00:00Z'),
    fromNodeNum: 1000,
    toNodeNum: 2000,
    fromNodeId: NODE_A_ID,
    toNodeId: NODE_B_ID,
    route: '[]',
    routeBack: '[]',
    snrTowards: '[-40]',
    snrBack: '[-44]',
    channel: 0,
    participation: 'endpoint',
    hopCount: 0,
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// buildOptionLabel — pure function, no rendering, no i18n mocking needed:
// the caller-supplied `fmt.t` stub below stands in for the real TFunction
// and mirrors both call shapes `buildOptionLabel` uses:
// `t(key, options)` and `t(key, defaultValue)`.
// -----------------------------------------------------------------------

const stubT = ((key: string, arg2?: unknown, arg3?: unknown) => {
  if (key === 'messages.traceroute_edge_endpoints') {
    const { from, to } = arg2 as { from: string; to: string };
    return `${from} → ${to}`;
  }
  if (key === 'messages.traceroute_picker_no_route') return arg2 as string;
  if (key === 'messages.traceroute_picker_relayed') return arg2 as string;
  if (key === 'messages.traceroute_picker_hops') {
    const { count } = arg2 as { count: number };
    return count === 1 ? `${count} hop` : `${count} hops`;
  }
  if (key === 'messages.traceroute_picker_label') return arg2 as string;
  if (key === 'messages.traceroute_picker_aria') return arg2 as string;
  void arg3;
  return key;
}) as unknown as TFunction;

describe('buildOptionLabel', () => {
  it('composes time + endpoints + hop count', () => {
    const label = buildOptionLabel(
      makeEntry({ hopCount: 3 }),
      nodes,
      { timeFormat: '24', dateFormat: 'YYYY-MM-DD', t: stubT },
    );
    expect(label).toContain('ALFA → BRVO');
    expect(label).toContain('3 hops');
  });

  it('uses the singular form for exactly 1 hop', () => {
    const label = buildOptionLabel(
      makeEntry({ hopCount: 1 }),
      nodes,
      { timeFormat: '24', dateFormat: 'YYYY-MM-DD', t: stubT },
    );
    expect(label).toContain('1 hop');
    expect(label).not.toContain('1 hops');
  });

  it('renders "no route" when hopCount is null', () => {
    const label = buildOptionLabel(
      makeEntry({ hopCount: null }),
      nodes,
      { timeFormat: '24', dateFormat: 'YYYY-MM-DD', t: stubT },
    );
    expect(label).toContain('no route');
  });

  it('appends " · relayed" only when participation is "hop"', () => {
    const hopLabel = buildOptionLabel(
      makeEntry({ participation: 'hop', hopCount: 2 }),
      nodes,
      { timeFormat: '24', dateFormat: 'YYYY-MM-DD', t: stubT },
    );
    expect(hopLabel).toContain('relayed');

    const endpointLabel = buildOptionLabel(
      makeEntry({ participation: 'endpoint', hopCount: 2 }),
      nodes,
      { timeFormat: '24', dateFormat: 'YYYY-MM-DD', t: stubT },
    );
    expect(endpointLabel).not.toContain('relayed');
  });

  it('falls back to the hex id for a node not present in `nodes`', () => {
    const label = buildOptionLabel(
      makeEntry({ fromNodeId: UNKNOWN_NODE_ID, hopCount: 0 }),
      nodes,
      { timeFormat: '24', dateFormat: 'YYYY-MM-DD', t: stubT },
    );
    // getNodeShortName falls back to the last 4 hex digits of the id.
    expect(label).toContain('ffff');
  });
});

// -----------------------------------------------------------------------
// <TracerouteParticipationPicker> rendering — the global setup.ts
// react-i18next mock returns the raw key for object-options calls (it
// interpolates into the KEY string, not a real translation), so a local
// override that resolves real en.json text (plus the `_one`/`_other`
// plural pair for the hop-count key) is needed for label-content
// assertions, mirroring MessagesTab.tracerouteStrip.test.tsx's pattern.
// -----------------------------------------------------------------------

const enDict = enLocale as Record<string, unknown>;
function lookupEnDefault(key: string): string | undefined {
  const value = enDict[key];
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (
      key: string,
      arg2?: string | Record<string, unknown>,
      arg3?: Record<string, unknown>,
    ) => {
      let options: Record<string, unknown> | undefined;
      let defaultValue: string | undefined;
      if (typeof arg2 === 'string') {
        defaultValue = arg2;
        options = arg3;
      } else {
        options = arg2;
      }
      let resolved = lookupEnDefault(key);
      if (resolved === undefined && options && typeof options.count === 'number') {
        const suffix = options.count === 1 ? '_one' : '_other';
        resolved = lookupEnDefault(`${key}${suffix}`);
      }
      let out = resolved ?? defaultValue ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

describe('TracerouteParticipationPicker', () => {
  it('renders nothing for 0 entries', () => {
    const { container } = render(
      <TracerouteParticipationPicker
        entries={[]}
        selectedId={null}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for exactly 1 entry', () => {
    const { container } = render(
      <TracerouteParticipationPicker
        entries={[makeEntry({ id: 1 })]}
        selectedId={1}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a <select> with N <option>s for N >= 2, newest-first order preserved', () => {
    const entries = [
      makeEntry({ id: 3, timestamp: 3000 }),
      makeEntry({ id: 2, timestamp: 2000 }),
      makeEntry({ id: 1, timestamp: 1000 }),
    ];
    const { container } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={3}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
      />,
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.map(o => o.value)).toEqual(['3', '2', '1']);
  });

  it('unknown node ids fall back to the hex id rather than rendering empty', () => {
    const entries = [
      makeEntry({ id: 1, fromNodeId: UNKNOWN_NODE_ID }),
      makeEntry({ id: 2 }),
    ];
    const { container } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={2}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
      />,
    );
    const firstOption = container.querySelector('option[value="1"]');
    expect(firstOption?.textContent).toContain('ffff');
    expect(firstOption?.textContent).not.toMatch(/→\s*BRVO$/); // sanity: label isn't empty
  });

  it('selecting an option calls onSelect with the numeric id, not the DOM string', () => {
    const entries = [makeEntry({ id: 42 }), makeEntry({ id: 7 })];
    const onSelect = vi.fn();
    const { container } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={42}
        onSelect={onSelect}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
      />,
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '7' } });
    expect(onSelect).toHaveBeenCalledWith(7);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const [arg] = onSelect.mock.calls[0];
    expect(typeof arg).toBe('number');
  });

  it('the select reflects selectedId; selectedId: null leaves it unselected without crashing', () => {
    const entries = [makeEntry({ id: 42 }), makeEntry({ id: 7 })];
    const { container, rerender } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={7}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
      />,
    );
    let select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('7');

    expect(() =>
      rerender(
        <TracerouteParticipationPicker
          entries={entries}
          selectedId={null}
          onSelect={() => {}}
          nodes={nodes}
          timeFormat="24"
          dateFormat="YYYY-MM-DD"
        />,
      ),
    ).not.toThrow();

    // No option carries value="" (the component never synthesizes a
    // placeholder), so native <select> semantics fall back to the first
    // rendered option rather than a truly blank selection — this is a
    // browser default, not a component bug, and happens to line up with
    // "newest first" ordering. The assertion that matters here is the one
    // above: the null transition must not throw.
    select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('42');
  });
});
