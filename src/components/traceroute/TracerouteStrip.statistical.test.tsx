/**
 * @vitest-environment jsdom
 *
 * Statistical-mode tests for `TracerouteStrip` (Statistical Route epic, Phase
 * 2 WP2). Sibling to `TracerouteStrip.test.tsx`, which stays byte-identical —
 * see `docs/internal/dev-notes/SR_PHASE2_SPEC.md` §4.2.
 *
 * Graphs are built through the real seam, `buildStatisticalStrip`, over
 * fixture rows — never hand-built `UnionStripGraph` literals — so these tests
 * exercise the same path MessagesTab will use in WP4.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TracerouteStrip, type TracerouteStripNodeMeta } from './TracerouteStrip';
import { buildTracerouteStripGraph, type TracerouteStripInput } from '../../utils/tracerouteStrip';
import { buildStatisticalStrip } from '../../utils/tracerouteUnionLayout';
import { MIN_STAT_OPACITY, type AggregateTracerouteRow } from '../../utils/tracerouteAggregate';
import { BROADCAST_ADDR } from '../../utils/tracerouteSegments';
import { calculateDistance, formatDistance } from '../../utils/distance';
import styles from './TracerouteStrip.module.css';

// Copied from TracerouteStrip.test.tsx (per §4.2: "Copy its react-i18next
// override..."), extended with a tiny plural resolver for the one key this
// component calls WITHOUT an inline default — `messages.traceroute_stat_seen_in`
// (D15: plural keys can't carry a positional default, so `_one`/`_other` must
// be resolved the way real i18next resolves them, from `options.count`).
const PLURAL_TEMPLATES: Record<string, { one: string; other: string }> = {
  'messages.traceroute_stat_seen_in': {
    one: 'Seen in {{seen}} of {{count}} route ({{percent}}%)',
    other: 'Seen in {{seen}} of {{count}} routes ({{percent}}%)',
  },
};

vi.mock('react-i18next', () => ({
  // #4880: sections.tsx now value-imports SettingsContext (→ config/i18n),
  // which references initReactI18next at load time.
  initReactI18next: { type: '3rdParty', init: () => {} },
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
        defaultValue = typeof options?.defaultValue === 'string' ? options.defaultValue : undefined;
      }
      let template: string;
      if (defaultValue !== undefined) {
        template = defaultValue;
      } else if (options && typeof options.count === 'number' && PLURAL_TEMPLATES[key]) {
        template = options.count === 1 ? PLURAL_TEMPLATES[key].one : PLURAL_TEMPLATES[key].other;
      } else {
        template = key;
      }
      let out = template;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

const FMT = { timeFormat: '24' as const, dateFormat: 'YYYY-MM-DD' as const };

// Copied from TracerouteStrip.test.tsx.
function makeMeta(opts: {
  nodeNum: number;
  shortName: string;
  longName?: string | null;
  roleLabel?: string | null;
  hops?: number;
  unmessagable?: boolean;
  pos?: { lat: number; lng: number };
  userId?: string;
}): TracerouteStripNodeMeta {
  const nodeId = `!${opts.nodeNum.toString(16).padStart(8, '0')}`;
  return {
    nodeNum: opts.nodeNum,
    shortName: opts.shortName,
    longName: opts.longName ?? null,
    roleLabel: opts.roleLabel ?? null,
    nodeId,
    category: 'mtClient',
    hops: opts.hops ?? 1,
    unmessagable: opts.unmessagable ?? false,
    card: {
      longName: opts.longName ?? opts.shortName,
      shortName: opts.shortName,
      nodeId,
      nodeNum: opts.nodeNum,
      position: opts.pos,
    },
    pos: opts.pos,
    userId: opts.userId,
  };
}

function nodeDivsFor(text: string): HTMLElement[] {
  return screen.getAllByText(text).map((el) => {
    const node = el.closest('[tabindex]');
    if (!node) throw new Error(`no tabindex ancestor found for "${text}"`);
    return node as HTMLElement;
  });
}

function nodeDivFor(text: string): HTMLElement {
  const divs = nodeDivsFor(text);
  if (divs.length !== 1) throw new Error(`expected exactly one node for "${text}", found ${divs.length}`);
  return divs[0];
}

/** Locates an edge's invisible `.edgeHit` polyline by a substring of its
 *  aria-label (statistical `edgeSummary`'s endpoints fragment). */
function hitTargetFor(container: HTMLElement, labelSubstring: string): HTMLElement {
  const el = Array.from(container.querySelectorAll('polyline[role="img"]')).find((p) =>
    (p.getAttribute('aria-label') ?? '').includes(labelSubstring),
  );
  if (!el) throw new Error(`no hit target found matching "${labelSubstring}"`);
  return el as HTMLElement;
}

const LOCAL = 100;
const MID = 110;
const PEER = 200;

function row(overrides: Partial<AggregateTracerouteRow> = {}): AggregateTracerouteRow {
  return { fromNodeNum: LOCAL, toNodeNum: PEER, ...overrides };
}

const META = new Map<number, TracerouteStripNodeMeta>([
  [LOCAL, makeMeta({ nodeNum: LOCAL, shortName: 'LOC', longName: 'Local Node', pos: { lat: 10, lng: 20 } })],
  [MID, makeMeta({ nodeNum: MID, shortName: 'MID', longName: 'Middle Node', userId: '!0000006e' })],
  [PEER, makeMeta({ nodeNum: PEER, shortName: 'TGT', longName: 'Target Node', pos: { lat: 10.01, lng: 20.01 } })],
]);

/** 5 rows: 3 via MID (share 0.6), 2 direct (LOC<->PEER share 0.4). Endpoints
 *  are in every row (share 1.0 / 100%). Row 4 carries a real snrBack sample
 *  to prove statistical mode suppresses it (D8) even when present. */
function buildFixture5() {
  const rows: AggregateTracerouteRow[] = [
    row({ route: JSON.stringify([MID]) }),
    row({ route: JSON.stringify([MID]) }),
    row({ route: JSON.stringify([MID]) }),
    row({ route: '[]', routeBack: '[]', snrBack: JSON.stringify([12, 34]) }),
    row({ route: '[]' }),
  ];
  return buildStatisticalStrip(rows, LOCAL, PEER);
}

/** 3 rows: 2 via MID (share 2/3 -> rounds to 67%), 1 direct. */
function buildFixture3() {
  const rows: AggregateTracerouteRow[] = [
    row({ route: JSON.stringify([MID]) }),
    row({ route: JSON.stringify([MID]) }),
    row({ route: '[]' }),
  ];
  return buildStatisticalStrip(rows, LOCAL, PEER);
}

/** 3 rows, one unrecorded (BROADCAST_ADDR) hop at depth 1, seen in 2 of 3. */
function buildFixtureUnknown() {
  const rows: AggregateTracerouteRow[] = [
    row({ route: JSON.stringify([BROADCAST_ADDR]) }),
    row({ route: JSON.stringify([BROADCAST_ADDR]) }),
    row({ route: '[]' }),
  ];
  return buildStatisticalStrip(rows, LOCAL, PEER);
}

/** 3 rows producing TWO distinct unrecorded-hop identities (both nodeNum
 *  BROADCAST_ADDR, but at different depths, D4/D10): `u:1` seen twice, `u:2`
 *  seen once. */
function buildFixtureTwoUnknown() {
  const rows: AggregateTracerouteRow[] = [
    row({ route: JSON.stringify([BROADCAST_ADDR]) }), // u:1 (depth 1)
    row({ route: JSON.stringify([BROADCAST_ADDR]) }), // u:1 again
    row({ route: JSON.stringify([MID, BROADCAST_ADDR]) }), // u:2 (depth 2)
  ];
  return buildStatisticalStrip(rows, LOCAL, PEER);
}

describe('TracerouteStrip — statistical mode (SR_PHASE2_SPEC.md §4.2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('mode branch', () => {
    it('renders .statEdge polylines and no .forwardEdge/.returnEdge', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const statEdges = container.querySelectorAll(`polyline.${styles.statEdge}`);
      const forwardEdges = container.querySelectorAll(`polyline.${styles.forwardEdge}`);
      const returnEdges = container.querySelectorAll(`polyline.${styles.returnEdge}`);
      expect(statEdges.length).toBeGreaterThan(0);
      expect(statEdges.length).toBe(graph.edges.length);
      expect(forwardEdges.length).toBe(0);
      expect(returnEdges.length).toBe(0);
    });

    it('renders no markerEnd on any visible statistical edge', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const visible = container.querySelectorAll(`polyline.${styles.statEdge}`);
      expect(visible.length).toBeGreaterThan(0);
      visible.forEach((p) => expect(p.hasAttribute('marker-end')).toBe(false));
    });

    it('renders no SNR label element anywhere, even for a fixture whose rows carry snrBack', () => {
      const { graph } = buildFixture5(); // row 4 carries snrBack: [12, 34]
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      expect(container.querySelectorAll(`.${styles.snrLabel}`)).toHaveLength(0);
      expect(screen.queryByText(/dB/)).toBeNull();
      expect(screen.queryByText('?')).toBeNull();
    });

    it("the group's aria-label is the statistical one", () => {
      const { graph } = buildFixture5();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      expect(screen.getByRole('group', { name: 'Statistical traceroute paths' })).not.toBeNull();
    });

    it('a single-route graph rendered through the same component still produces arrowheads and SNR labels (the branch does not leak)', () => {
      const input: TracerouteStripInput = {
        fromNodeNum: LOCAL,
        toNodeNum: PEER,
        route: '[]',
        snrTowards: '[20]',
        routeBack: null,
      };
      const graph = buildTracerouteStripGraph(input);
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const forwardEdges = container.querySelectorAll(`polyline.${styles.forwardEdge}`);
      expect(forwardEdges.length).toBeGreaterThan(0);
      forwardEdges.forEach((p) => expect(p.getAttribute('marker-end')).toMatch(/^url\(#/));
      expect(screen.getByText('5.0 dB')).not.toBeNull();
      expect(container.querySelectorAll(`polyline.${styles.statEdge}`)).toHaveLength(0);
    });
  });

  describe('opacity (D16)', () => {
    it('every node div carries --stat-opacity equal to its UnionStripNode.opacity', () => {
      const { graph } = buildFixture5();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      for (const n of graph.nodes) {
        const shortName = META.get(n.nodeNum)!.shortName;
        const div = nodeDivFor(shortName);
        expect(div.style.getPropertyValue('--stat-opacity')).toBe(String(n.opacity));
        expect(div.className).toMatch(new RegExp(styles.statNode));
      }
    });

    it('every visible edge carries --stat-opacity equal to its UnionStripEdge.opacity', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const visible = Array.from(container.querySelectorAll(`polyline.${styles.statEdge}`)) as HTMLElement[];
      expect(visible).toHaveLength(graph.edges.length);
      const opacities = new Set(graph.edges.map((e) => String(e.opacity)));
      visible.forEach((p) => {
        expect(opacities.has(p.style.getPropertyValue('--stat-opacity'))).toBe(true);
      });
    });

    it('an endpoint (share 1.0) reads opacity "1"', () => {
      const { graph } = buildFixture5();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const div = nodeDivFor('LOC'); // endpoint: present in every row
      expect(div.style.getPropertyValue('--stat-opacity')).toBe('1');
    });

    it('a very rare node (share rounding to 0) reads exactly MIN_STAT_OPACITY', () => {
      // 1500 direct rows (endpoints only) + 1 row through MID: MID's share is
      // 1/1501 ≈ 0.000666, which rounds to MIN_STAT_OPACITY at 3 decimals.
      const rows: AggregateTracerouteRow[] = Array.from({ length: 1500 }, () => row({ route: '[]' }));
      rows.push(row({ route: JSON.stringify([MID]) }));
      const { graph } = buildStatisticalStrip(rows, LOCAL, PEER);

      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);
      const div = nodeDivFor('MID');
      expect(div.style.getPropertyValue('--stat-opacity')).toBe(String(MIN_STAT_OPACITY));
    });

    it('.edgeHit targets carry no --stat-opacity (never dimmed)', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const hits = container.querySelectorAll(`.${styles.edgeHit}`);
      expect(hits.length).toBe(graph.edges.length);
      hits.forEach((h) => expect((h as HTMLElement).style.getPropertyValue('--stat-opacity')).toBe(''));
    });

    it('every visible edge carries --stat-weight equal to `${UnionStripEdge.weight}px` (#4566)', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const visible = Array.from(container.querySelectorAll(`polyline.${styles.statEdge}`)) as HTMLElement[];
      expect(visible).toHaveLength(graph.edges.length);
      const weights = new Set(graph.edges.map((e) => `${e.weight}px`));
      visible.forEach((p) => {
        expect(weights.has(p.style.getPropertyValue('--stat-weight'))).toBe(true);
      });
    });

    it('.edgeHit targets carry no --stat-weight (hit-target width stays constant)', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const hits = container.querySelectorAll(`.${styles.edgeHit}`);
      hits.forEach((h) => expect((h as HTMLElement).style.getPropertyValue('--stat-weight')).toBe(''));
    });

    it('a single-route render carries no .statNode class and no --stat-opacity', () => {
      const input: TracerouteStripInput = { fromNodeNum: LOCAL, toNodeNum: PEER, route: '[]', routeBack: null };
      const graph = buildTracerouteStripGraph(input);
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const div = nodeDivFor('LOC');
      expect(div.className).not.toMatch(new RegExp(styles.statNode));
      expect(div.style.getPropertyValue('--stat-opacity')).toBe('');
    });
  });

  describe('tooltips', () => {
    it('hovering a real node shows the node card and "Seen in 3 of 5 routes (60%)"', () => {
      const { graph } = buildFixture5();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      fireEvent.mouseEnter(nodeDivFor('MID'));
      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      expect(popup).not.toBeNull();
      expect(popup.textContent).toContain('Middle Node');
      expect(popup.textContent).toContain('Seen in 3 of 5 routes (60%)');
    });

    it('hovering an endpoint shows 100%', () => {
      const { graph } = buildFixture5();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      fireEvent.mouseEnter(nodeDivFor('LOC'));
      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      expect(popup.textContent).toContain('Seen in 5 of 5 routes (100%)');
    });

    it('the percentage rounds (2 of 3 -> 67%)', () => {
      const { graph } = buildFixture3();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      fireEvent.mouseEnter(nodeDivFor('MID'));
      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      expect(popup.textContent).toContain('Seen in 2 of 3 routes (67%)');
    });

    it('hovering an unrecorded hop shows "Unrecorded hop", the description, the seen-in line, and no !ffffffff or node name', () => {
      const { graph } = buildFixtureUnknown();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      fireEvent.mouseEnter(nodeDivFor('Unknown'));
      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      const text = popup.textContent ?? '';
      expect(text).toContain('Unrecorded hop');
      expect(text).toContain('The traceroute did not record which node relayed here.');
      expect(text).toContain('Seen in 2 of 3 routes (67%)');
      expect(text).not.toContain('!ffffffff');
      expect(text).not.toContain('Local Node');
      expect(text).not.toContain('Middle Node');
      expect(text).not.toContain('Target Node');
    });

    it('hovering an edge shows endpoints with ↔, the seen-in line, and no direction row and no SNR row', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const hit = hitTargetFor(container, 'Local Node (LOC) ↔ Target Node (TGT)');
      fireEvent.mouseEnter(hit);
      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      const text = popup.textContent ?? '';
      expect(text).toContain('Local Node (LOC) ↔ Target Node (TGT)');
      expect(text).toContain('Seen in 2 of 5 routes (40%)');
      expect(text).not.toContain('Forward');
      expect(text).not.toContain('Return');
      expect(screen.queryByText('Signal:')).toBeNull();
    });

    it('an edge whose two ends both have positions still shows the distance row', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const hit = hitTargetFor(container, 'Local Node (LOC) ↔ Target Node (TGT)');
      fireEvent.mouseEnter(hit);
      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      const km = calculateDistance(10, 20, 10.01, 20.01);
      expect(popup.textContent).toContain(formatDistance(km, 'km', 1));
    });

    it('omits the distance row when one endpoint lacks a position fix', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const hit = hitTargetFor(container, 'Local Node (LOC) ↔ Middle Node (MID)'); // MID has no pos
      fireEvent.mouseEnter(hit);
      expect(screen.queryByText('Distance:')).toBeNull();
    });

    it('two unrecorded hops at different depths produce two distinct popups (asserts id, not nodeNum, keying)', () => {
      const { graph } = buildFixtureTwoUnknown();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const unknownDivs = nodeDivsFor('Unknown');
      expect(unknownDivs).toHaveLength(2);

      fireEvent.mouseEnter(unknownDivs[0]);
      const first = (document.querySelector('[role="tooltip"]') as HTMLElement).textContent ?? '';

      fireEvent.mouseEnter(unknownDivs[1]);
      const second = (document.querySelector('[role="tooltip"]') as HTMLElement).textContent ?? '';

      expect(first).not.toBe(second);
      const percents = [first, second].map((t) => t.match(/\((\d+)%\)/)?.[1]);
      expect(new Set(percents).size).toBe(2);
    });
  });

  describe('accessibility parity', () => {
    it("a node's aria-label ends with the seen-in sentence; unrecorded-hop labels contain no hex id", () => {
      const { graph } = buildFixture5();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const label = nodeDivFor('MID').getAttribute('aria-label') ?? '';
      expect(label.endsWith('Seen in 3 of 5 routes (60%)')).toBe(true);

      const { graph: unknownGraph } = buildFixtureUnknown();
      const { unmount } = render(<TracerouteStrip graph={unknownGraph} meta={META} {...FMT} />);
      const unknownLabel = nodeDivFor('Unknown').getAttribute('aria-label') ?? '';
      expect(unknownLabel).not.toContain('!ffffffff');
      expect(unknownLabel).toContain('Unrecorded hop');
      unmount();
    });

    it("an edge's aria-label contains endpoints and seen-in, and neither \"Forward\" nor \"Return\"", () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const hit = hitTargetFor(container, 'Local Node (LOC) ↔ Target Node (TGT)');
      const label = hit.getAttribute('aria-label') ?? '';
      expect(label).toContain('Local Node (LOC) ↔ Target Node (TGT)');
      expect(label).toContain('Seen in 2 of 5 routes (40%)');
      expect(label).not.toContain('Forward');
      expect(label).not.toContain('Return');
    });

    it('focusing a node sets aria-describedby; blurring clears it', () => {
      const { graph } = buildFixture5();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const div = nodeDivFor('MID');
      expect(div.getAttribute('aria-describedby')).toBeNull();
      fireEvent.focus(div);
      expect(div.getAttribute('aria-describedby')).toBeTruthy();
      fireEvent.blur(div);
      expect(div.getAttribute('aria-describedby')).toBeNull();
    });

    it('Enter on a focused real node with a userId still calls onOpenNodeDetails', () => {
      const { graph } = buildFixture5();
      const onOpenNodeDetails = vi.fn();
      render(<TracerouteStrip graph={graph} meta={META} {...FMT} onOpenNodeDetails={onOpenNodeDetails} />);

      fireEvent.keyDown(nodeDivFor('MID'), { key: 'Enter' });
      expect(onOpenNodeDetails).toHaveBeenCalledWith('!0000006e');
    });

    it('tabbing reaches both node divs and edge hit targets, same as single-route mode', () => {
      const { graph } = buildFixture5();
      const { container } = render(<TracerouteStrip graph={graph} meta={META} {...FMT} />);

      const nodeDivs = container.querySelectorAll('div[tabindex="0"]');
      const hitTargets = container.querySelectorAll('polyline[role="img"][tabindex="0"]');
      expect(nodeDivs).toHaveLength(graph.nodes.length);
      expect(hitTargets).toHaveLength(graph.edges.length);
    });
  });
});
