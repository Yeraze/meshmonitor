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
import {
  TracerouteParticipationPicker,
  buildOptionLabel,
  STATISTICAL_OPTION_VALUE,
} from './TracerouteParticipationPicker';
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

    // selectedId: null means the displayed row came from the poll, not the
    // picker (it has no entry id). The component synthesizes a hidden
    // "Latest" placeholder for exactly this state — without it, native
    // <select> semantics would display the FIRST option's label, implying a
    // selection that was never made (PR #4427 review).
    select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('');
    const placeholder = select.querySelector('option[value=""]') as HTMLOptionElement;
    expect(placeholder).not.toBeNull();
    expect(placeholder.hidden).toBe(true);
    expect(placeholder.textContent).toBe('Latest');
  });
});

// -----------------------------------------------------------------------
// statistical option (Statistical Route epic, phase 2, WP3) —
// docs/internal/dev-notes/SR_PHASE2_SPEC.md §3.6/§4.3/D18.
// -----------------------------------------------------------------------

describe('statistical option', () => {
  it('with statistical absent, every existing behavior holds, including "1 entry renders nothing"', () => {
    const { container: zero } = render(
      <TracerouteParticipationPicker
        entries={[]}
        selectedId={null}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
      />,
    );
    expect(zero).toBeEmptyDOMElement();

    const { container: one } = render(
      <TracerouteParticipationPicker
        entries={[makeEntry({ id: 1 })]}
        selectedId={1}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
      />,
    );
    expect(one).toBeEmptyDOMElement();
  });

  it('1 entry + statistical renders the picker with 2 options', () => {
    const { container } = render(
      <TracerouteParticipationPicker
        entries={[makeEntry({ id: 1 })]}
        selectedId={1}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
        statistical={{ totalRoutes: 5 }}
      />,
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = Array.from(select.querySelectorAll('option'));
    expect(options).toHaveLength(2);
  });

  it('0 entries + statistical still renders nothing — one option is not a choice', () => {
    const { container } = render(
      <TracerouteParticipationPicker
        entries={[]}
        selectedId={null}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
        statistical={{ totalRoutes: 5 }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('the statistical option renders first, above the dated entries', () => {
    const entries = [
      makeEntry({ id: 3, timestamp: 3000 }),
      makeEntry({ id: 2, timestamp: 2000 }),
    ];
    const { container } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={3}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
        statistical={{ totalRoutes: 5 }}
      />,
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.map(o => o.value)).toEqual([STATISTICAL_OPTION_VALUE, '3', '2']);
  });

  it('the label reads "Statistical (12 routes)"; totalRoutes: 1 reads "(1 route)"', () => {
    const entries = [makeEntry({ id: 3 }), makeEntry({ id: 2 })];
    const { container: plural } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={3}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
        statistical={{ totalRoutes: 12 }}
      />,
    );
    const pluralOption = plural.querySelector(`option[value="${STATISTICAL_OPTION_VALUE}"]`);
    expect(pluralOption?.textContent).toBe('Statistical (12 routes)');

    const { container: singular } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={3}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
        statistical={{ totalRoutes: 1 }}
      />,
    );
    const singularOption = singular.querySelector(`option[value="${STATISTICAL_OPTION_VALUE}"]`);
    expect(singularOption?.textContent).toBe('Statistical (1 route)');
  });

  it('choosing the statistical option calls onSelectStatistical and not onSelect', () => {
    const entries = [makeEntry({ id: 3 }), makeEntry({ id: 2 })];
    const onSelect = vi.fn();
    const onSelectStatistical = vi.fn();
    const { container } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={3}
        onSelect={onSelect}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
        statistical={{ totalRoutes: 5 }}
        onSelectStatistical={onSelectStatistical}
      />,
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: STATISTICAL_OPTION_VALUE } });
    expect(onSelectStatistical).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('choosing a dated entry calls onSelect with the numeric id and not onSelectStatistical', () => {
    const entries = [makeEntry({ id: 3 }), makeEntry({ id: 2 })];
    const onSelect = vi.fn();
    const onSelectStatistical = vi.fn();
    const { container } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={3}
        onSelect={onSelect}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
        statistical={{ totalRoutes: 5 }}
        onSelectStatistical={onSelectStatistical}
      />,
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '2' } });
    expect(onSelect).toHaveBeenCalledWith(2);
    expect(onSelectStatistical).not.toHaveBeenCalled();
  });

  it('statisticalSelected makes the select show the statistical option, and the hidden "Latest" placeholder does not appear', () => {
    const entries = [makeEntry({ id: 3 }), makeEntry({ id: 2 })];
    const { container } = render(
      <TracerouteParticipationPicker
        entries={entries}
        selectedId={null}
        onSelect={() => {}}
        nodes={nodes}
        timeFormat="24"
        dateFormat="YYYY-MM-DD"
        statistical={{ totalRoutes: 5 }}
        statisticalSelected
      />,
    );
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe(STATISTICAL_OPTION_VALUE);
    expect(select.querySelector('option[value=""]')).toBeNull();
  });
});
