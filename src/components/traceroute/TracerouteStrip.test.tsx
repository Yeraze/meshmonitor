/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TracerouteStrip, HOVER_LINGER_MS, type TracerouteStripNodeMeta } from './TracerouteStrip';
import { buildTracerouteStripGraph, type TracerouteStripInput } from '../../utils/tracerouteStrip';
import { calculateDistance, formatDistance } from '../../utils/distance';

// The global setup.ts mock for react-i18next ignores the `defaultValue`
// argument entirely (it only interpolates `{{token}}` placeholders into the
// raw key) — see src/components/NodePopup/NodePopup.test.tsx for the same
// override. This component calls `t(key, defaultEnglish, vars)`, so a smarter
// local mock is needed to assert real rendered English text.
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
      let out = defaultValue ?? key;
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
        }
      }
      return out;
    },
  }),
}));

/** Display formats the strip forwards to `LastHeardFooter`. Spread into every
 *  render so the tests don't restate them 12 times. */
const FMT = { timeFormat: '24' as const, dateFormat: 'YYYY-MM-DD' as const };

function makeMeta(opts: {
  nodeNum: number;
  shortName: string;
  longName?: string | null;
  roleLabel?: string | null;
  hops?: number;
  unmessagable?: boolean;
  hwModelName?: string;
  snr?: number;
  battery?: number;
  lastHeard?: number;
  pos?: { lat: number; lng: number };
  /** Omitted by default — matches the real adapter, which leaves `userId`
   *  undefined for any node without a real `node.user.id`. */
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
      roleName: opts.roleLabel ?? undefined,
      hwModelName: opts.hwModelName,
      hops: opts.hops ?? 1,
      snr: opts.snr,
      battery: opts.battery,
      lastHeard: opts.lastHeard,
      position: opts.pos,
    },
    pos: opts.pos,
    userId: opts.userId,
  };
}

function nodeDivFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const node = el.closest('[tabindex]');
  if (!node) throw new Error(`no tabindex ancestor found for "${text}"`);
  return node as HTMLElement;
}

/** WP2: locates an edge's invisible `.edgeHit` polyline by the leg caption
 *  that always leads its `aria-label` (`edgeSummary`'s first, always-present
 *  fragment). */
function hitTargetFor(container: HTMLElement, leg: 'forward' | 'return'): HTMLElement {
  const caption = leg === 'forward' ? 'Forward' : 'Return';
  const el = Array.from(container.querySelectorAll('polyline[role="img"]')).find((p) =>
    (p.getAttribute('aria-label') ?? '').startsWith(caption),
  );
  if (!el) throw new Error(`no ${leg} hit target found`);
  return el as HTMLElement;
}

describe('TracerouteStrip', () => {
  // Several cases below switch to fake timers to drive HOVER_LINGER_MS.
  // Always restore real timers afterward so unrelated tests aren't affected.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders one node element per graph node (forward-only, 3 hops)', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([110]),
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [110, makeMeta({ nodeNum: 110, shortName: 'MID', longName: 'Middle Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    expect(graph.nodes).toHaveLength(3);
    expect(container.querySelectorAll('div[tabindex="0"]')).toHaveLength(3);
  });

  it('dedups a node shared by both legs to a single element', () => {
    // Identical forward/return path -> full overlap (spec §3.7 case 9).
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([110]),
      routeBack: JSON.stringify([110]),
      snrBack: JSON.stringify([10, 20]),
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [110, makeMeta({ nodeNum: 110, shortName: 'MID', longName: 'Middle Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    // Full overlap: exactly 3 nodes total, all on row 0.
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes.every((n) => n.row === 0)).toBe(true);
    expect(container.querySelectorAll('div[tabindex="0"]')).toHaveLength(3);
    expect(screen.getAllByText('MID')).toHaveLength(1);
  });

  it('places a divergent return-only node on the branch sub-row (row 2 under the spine model)', () => {
    // F = A(100)->B(110)->C(120)->D(200); R = D->E(130)->A (spec case 10).
    // Under the spine model (post-#4392) B/C are forward-exclusive and raise
    // above the spine too, so this is now a three-row graph: forward(B,C)=0,
    // spine(A,D)=1, return(E)=2 — not the old two-row (main=0/branch=1) shape.
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([110, 120]),
      routeBack: JSON.stringify([130]),
      snrBack: JSON.stringify([10, 20]),
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'A', longName: 'Node A' })],
      [110, makeMeta({ nodeNum: 110, shortName: 'B', longName: 'Node B' })],
      [120, makeMeta({ nodeNum: 120, shortName: 'C', longName: 'Node C' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'D', longName: 'Node D' })],
      [130, makeMeta({ nodeNum: 130, shortName: 'E', longName: 'Node E' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

    const branchNode = graph.nodes.find((n) => n.nodeNum === 130);
    expect(branchNode?.row).toBe(2);

    const rowZeroDiv = nodeDivFor('A');
    const branchDiv = nodeDivFor('E');
    expect(rowZeroDiv.style.top).not.toBe(branchDiv.style.top);
  });

  it('renders forward SNR labels above and return labels below (lane distinction)', () => {
    // Direct path, both legs present, both with real (non-sentinel) SNR
    // samples so both labels render (spec §3.7 case 8 with values added).
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      snrTowards: '[20]', // -> 5.0 dB on the forward edge
      routeBack: '[]',
      snrBack: '[-40]', // -> -10.0 dB on the return edge
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

    const forwardLabel = screen.getByText('5.0 dB').closest('span');
    const returnLabel = screen.getByText('-10.0 dB').closest('span');
    expect(forwardLabel).not.toBeNull();
    expect(returnLabel).not.toBeNull();
    // The two lanes must not share a class list (forward "above" vs return
    // "below" per spec §3.4 — labels lane by leg identity, not direction).
    expect(forwardLabel!.className).not.toBe(returnLabel!.className);
  });

  it('renders a "?" chip with a title for an unknown-SNR (INT8_MIN sentinel) edge', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([110]),
      snrTowards: JSON.stringify([-128]), // INT8_MIN sentinel arriving at 110
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [110, makeMeta({ nodeNum: 110, shortName: 'MID', longName: 'Middle Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

    const chip = screen.getByText('?');
    expect(chip).toHaveAttribute(
      'title',
      'Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)',
    );
  });

  it('renders no label element at all for an edge with no SNR sample', () => {
    // route.length (1) === snrTowards.length (1): the trailing (destination)
    // sample is absent, so the from->110 edge... actually here we want the
    // edge whose sample is simply missing (snr: null, snrUnknown: false).
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: JSON.stringify([110]),
      snrTowards: JSON.stringify([-128]), // consumed by the first edge only
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    const secondEdge = graph.edges.find((e) => e.toId.includes('-200'));
    expect(secondEdge).toBeDefined();
    expect(secondEdge!.snr).toBeNull();
    expect(secondEdge!.snrUnknown).toBe(false);

    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [110, makeMeta({ nodeNum: 110, shortName: 'MID', longName: 'Middle Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    // Exactly one SNR label rendered (the unknown-sentinel one) — the null
    // edge contributes NO element, not an empty one.
    const labelSpans = container.querySelectorAll('span[style*="left"]');
    expect(labelSpans).toHaveLength(1);
  });

  it('gives two strips on the same page distinct marker-end urls (useId-suffixed)', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT' })],
    ]);

    render(
      <>
        <TracerouteStrip graph={graph} meta={meta} {...FMT} />
        <TracerouteStrip graph={graph} meta={meta} {...FMT} />
      </>,
    );

    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(2);
    const markerEnds = groups.map((g) => {
      const polyline = g.querySelector('polyline');
      expect(polyline).not.toBeNull();
      return polyline!.getAttribute('marker-end');
    });
    expect(markerEnds[0]).not.toEqual(markerEnds[1]);
  });

  it('every node is tabIndex=0 with an aria-label containing long name, role, and id', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', roleLabel: 'Client' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node', roleLabel: 'Router' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

    const div = nodeDivFor('FRM');
    expect(div).toHaveAttribute('tabindex', '0');
    const label = div.getAttribute('aria-label') ?? '';
    expect(label).toContain('From Node');
    expect(label).toContain('FRM');
    expect(label).toContain('Client');
    expect(label).toContain('!00000064'); // 100 in padded hex
  });

  it('omits the role segment (no dangling ", ,") from the aria-label when roleLabel is null', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      // roleLabel deliberately omitted -> null via makeMeta's default.
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

    const div = nodeDivFor('FRM');
    const label = div.getAttribute('aria-label') ?? '';
    expect(label).toContain('From Node');
    expect(label).toContain('!00000064');
    expect(label).not.toMatch(/,\s*,/);
  });

  it('portals the hover popup to document.body, outside the clipping scroller', () => {
    // The popup MUST NOT live under `.node` — that element carries a
    // `transform`, which would make it the containing block for a fixed-
    // position child and re-trap the popup inside `.scroller`'s
    // `overflow: hidden`. Escaping that clipping is the whole point.
    const graph = buildTracerouteStripGraph({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    });
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', roleLabel: 'Client' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

    // Nothing rendered until hovered.
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    const div = nodeDivFor('FRM');
    fireEvent.mouseEnter(div);

    const popup = document.querySelector('[role="tooltip"]');
    expect(popup).not.toBeNull();
    // Portalled: present in the document but NOT inside the strip's own tree.
    expect(container.contains(popup)).toBe(false);
    expect(popup!.closest('[role="group"]')).toBeNull();

    // mouse-leave defers the hide by HOVER_LINGER_MS (so the pointer can
    // travel across the gap into the popup) rather than hiding synchronously
    // — see the dedicated linger-mechanics cases below for the travel-in
    // behavior itself.
    vi.useFakeTimers();
    fireEvent.mouseLeave(div);
    act(() => {
      vi.advanceTimersByTime(HOVER_LINGER_MS);
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('wires aria-describedby to the portalled popup only while it is shown', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    });
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', roleLabel: 'Client' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    const div = nodeDivFor('FRM');

    // No dangling reference to a popup that isn't rendered.
    expect(div.getAttribute('aria-describedby')).toBeNull();

    // Keyboard focus opens it too, not just the mouse.
    fireEvent.focus(div);
    const tipId = div.getAttribute('aria-describedby');
    expect(tipId).toBeTruthy();
    const popup = document.getElementById(tipId!);
    expect(popup).not.toBeNull();
    expect(popup!.getAttribute('role')).toBe('tooltip');

    fireEvent.blur(div);
    expect(div.getAttribute('aria-describedby')).toBeNull();
  });

  it('shows the Map-style card fields (role, hardware, hops, SNR, battery, position)', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    });
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [
        100,
        makeMeta({
          nodeNum: 100,
          shortName: 'FRM',
          longName: 'From Node',
          roleLabel: 'Client (Base)',
          hwModelName: 'Station G2',
          hops: 2,
          snr: 7.25,
          battery: 64,
          pos: { lat: 26.30307, lng: -80.21952 },
        }),
      ],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    fireEvent.mouseEnter(nodeDivFor('FRM'));

    const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
    const text = popup.textContent ?? '';
    expect(text).toContain('From Node');
    expect(text).toContain('Client (Base)');
    expect(text).toContain('Station G2');
    expect(text).toContain('7.3'); // SNR, one decimal
    expect(text).toContain('64');
    expect(text).toContain('26.30307');
  });

  it('spine model (WP-C): a forward-exclusive node renders above the spine and a return-exclusive node below it', () => {
    // The §3.4.0 BOCA G2 live-mesh fixture, used verbatim (also covered in
    // tracerouteStrip.test.ts case 23): CS and TRPK are forward-exclusive and
    // must raise ABOVE the Yble/Yrze/Boca spine — the DOM-level regression
    // test for the bug that motivated the spine rewrite (the old algorithm
    // put the whole forward leg on row 0 and drew the return edge
    // BOCA G2 -> Yrze underneath CS/TRPK as though it traversed them).
    const YBLE = 2001;
    const YRZE = 2002;
    const CS = 2003;
    const TRPK = 2004;
    const BOCA = 2005;
    const forwardInput: TracerouteStripInput = {
      fromNodeNum: YBLE,
      toNodeNum: BOCA,
      route: JSON.stringify([YRZE, CS, TRPK]),
      snrTowards: JSON.stringify([42, -45, 29, 15]),
      routeBack: JSON.stringify([YRZE]),
      snrBack: JSON.stringify([37, 44]),
    };
    const forwardGraph = buildTracerouteStripGraph(forwardInput);
    const forwardMeta = new Map<number, TracerouteStripNodeMeta>([
      [YBLE, makeMeta({ nodeNum: YBLE, shortName: 'Yble', longName: 'Node Yble' })],
      [YRZE, makeMeta({ nodeNum: YRZE, shortName: 'Yrze', longName: 'Node Yrze' })],
      [CS, makeMeta({ nodeNum: CS, shortName: 'CS', longName: 'CS (SW SECTOR) V4' })],
      [TRPK, makeMeta({ nodeNum: TRPK, shortName: 'TRPK', longName: 'TRPK G2' })],
      [BOCA, makeMeta({ nodeNum: BOCA, shortName: 'Boca', longName: 'Node Boca' })],
    ]);

    const { unmount } = render(<TracerouteStrip graph={forwardGraph} meta={forwardMeta} {...FMT} />);

    const csNode = forwardGraph.nodes.find((n) => n.nodeNum === CS)!;
    const yrzeNode = forwardGraph.nodes.find((n) => n.nodeNum === YRZE)!;
    expect(csNode.lane).toBe('forward');
    expect(yrzeNode.lane).toBe('spine');

    const csDiv = nodeDivFor('CS');
    const yrzeDiv = nodeDivFor('Yrze');
    const csTop = parseFloat(csDiv.style.top);
    const yrzeTop = parseFloat(yrzeDiv.style.top);
    expect(Number.isNaN(csTop)).toBe(false);
    expect(Number.isNaN(yrzeTop)).toBe(false);
    // "Raised above" means a SMALLER top (y grows downward).
    expect(csTop).toBeLessThan(yrzeTop);

    unmount();

    // Mirror fixture for the return-exclusive half: F = A->B->C (B raised),
    // R = C->X->A (X dropped) — spec §3.7 case 25 ("simultaneous
    // divergence"). Confirms the drop direction independently of the raise
    // direction just asserted above.
    const A = 3001;
    const B = 3002;
    const C = 3003;
    const X = 3004;
    const bothInput: TracerouteStripInput = {
      fromNodeNum: A,
      toNodeNum: C,
      route: JSON.stringify([B]),
      snrTowards: JSON.stringify([5, 7]),
      routeBack: JSON.stringify([X]),
      snrBack: JSON.stringify([3, 4]),
    };
    const bothGraph = buildTracerouteStripGraph(bothInput);
    const bothMeta = new Map<number, TracerouteStripNodeMeta>([
      [A, makeMeta({ nodeNum: A, shortName: 'AA', longName: 'Node AA' })],
      [B, makeMeta({ nodeNum: B, shortName: 'BB', longName: 'Node BB' })],
      [C, makeMeta({ nodeNum: C, shortName: 'CC', longName: 'Node CC' })],
      [X, makeMeta({ nodeNum: X, shortName: 'XX', longName: 'Node XX' })],
    ]);

    render(<TracerouteStrip graph={bothGraph} meta={bothMeta} {...FMT} />);

    const bNode = bothGraph.nodes.find((n) => n.nodeNum === B)!;
    const aNode = bothGraph.nodes.find((n) => n.nodeNum === A)!;
    const xNode = bothGraph.nodes.find((n) => n.nodeNum === X)!;
    expect(bNode.lane).toBe('forward');
    expect(aNode.lane).toBe('spine');
    expect(xNode.lane).toBe('return');

    const bDiv = nodeDivFor('BB');
    const aDiv = nodeDivFor('AA');
    const xDiv = nodeDivFor('XX');
    const bTop = parseFloat(bDiv.style.top);
    const aTop = parseFloat(aDiv.style.top);
    const xTop = parseFloat(xDiv.style.top);

    // forward-exclusive (B) above the spine (A): smaller top.
    expect(bTop).toBeLessThan(aTop);
    // return-exclusive (X) below the spine (A): larger top.
    expect(xTop).toBeGreaterThan(aTop);
  });

  it('renders the unknown placeholder (and only the padded hex id in its tooltip) for a node missing from meta', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    // 200 deliberately absent from meta.
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

    const div = nodeDivFor('Unknown');
    fireEvent.mouseEnter(div);

    const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
    expect(popup).not.toBeNull();
    // A hop nobody identified has no card model — it must still render
    // without crashing, carrying the one fact we do have.
    expect(popup.textContent).toContain('!000000c8'); // 200 in padded hex
  });

  it('repositions below the anchor when there is no room above it', () => {
    // jsdom has no layout, so drive the geometry explicitly: a glyph near the
    // top of the viewport cannot fit a popup above it, which is exactly the
    // clipping case that motivated this change.
    const graph = buildTracerouteStripGraph({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    });
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    const div = nodeDivFor('FRM');

    // Anchor sits 4px from the top — no room for a 100px popup above it.
    vi.spyOn(div, 'getBoundingClientRect').mockReturnValue({
      top: 4, bottom: 40, left: 500, right: 532, width: 32, height: 36, x: 500, y: 4,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseEnter(div);
    const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
    Object.defineProperty(popup, 'offsetWidth', { value: 240, configurable: true });
    Object.defineProperty(popup, 'offsetHeight', { value: 100, configurable: true });
    fireEvent.scroll(window); // force a reposition with the measurements in place

    // Flipped below the anchor's bottom edge, not negative-top above it.
    expect(parseFloat(popup.style.top)).toBeGreaterThanOrEqual(40);
  });

  it('clamps horizontally so the popup never overflows the viewport edge', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    });
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    const div = nodeDivFor('FRM');

    // Anchor hard against the left edge — a centred popup would go negative.
    vi.spyOn(div, 'getBoundingClientRect').mockReturnValue({
      top: 400, bottom: 436, left: 2, right: 34, width: 32, height: 36, x: 2, y: 400,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseEnter(div);
    const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
    Object.defineProperty(popup, 'offsetWidth', { value: 240, configurable: true });
    Object.defineProperty(popup, 'offsetHeight', { value: 100, configurable: true });
    fireEvent.scroll(window);

    expect(parseFloat(popup.style.left)).toBeGreaterThanOrEqual(0);
  });

  it('clamps against the RIGHT viewport edge too, not just the left', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    });
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    const div = nodeDivFor('FRM');

    // Anchor hard against the right edge — a centred popup would overflow.
    const vw = window.innerWidth;
    vi.spyOn(div, 'getBoundingClientRect').mockReturnValue({
      top: 400, bottom: 436, left: vw - 34, right: vw - 2, width: 32, height: 36,
      x: vw - 34, y: 400, toJSON: () => ({}),
    } as DOMRect);

    fireEvent.mouseEnter(div);
    const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
    Object.defineProperty(popup, 'offsetWidth', { value: 240, configurable: true });
    Object.defineProperty(popup, 'offsetHeight', { value: 100, configurable: true });
    fireEvent.scroll(window);

    const left = parseFloat(popup.style.left);
    expect(left + 240).toBeLessThanOrEqual(vw);
  });

  it('hides when the anchor scrolls out of view rather than following it off-screen', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    });
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    const div = nodeDivFor('FRM');

    fireEvent.mouseEnter(div);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

    // Simulate the panel scrolling the glyph entirely above the viewport.
    vi.spyOn(div, 'getBoundingClientRect').mockReturnValue({
      top: -320, bottom: -273, left: 500, right: 532, width: 32, height: 47,
      x: 500, y: -320, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.scroll(window);

    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(div.getAttribute('aria-describedby')).toBeNull();
  });

  it('removes its scroll/resize listeners when the popup hides', () => {
    const graph = buildTracerouteStripGraph({
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    });
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
    const div = nodeDivFor('FRM');

    fireEvent.mouseEnter(div);
    const addedScroll = addSpy.mock.calls.filter((c) => String(c[0]) === 'scroll').length;
    expect(addedScroll).toBeGreaterThan(0);

    // The scroll/resize effect only tears down once `hover` actually
    // becomes null, which — for a pointer-leave — happens after the linger
    // delay, not synchronously.
    vi.useFakeTimers();
    fireEvent.mouseLeave(div);
    act(() => {
      vi.advanceTimersByTime(HOVER_LINGER_MS);
    });
    const removedScroll = removeSpy.mock.calls.filter((c) => String(c[0]) === 'scroll').length;
    expect(removedScroll).toBe(addedScroll);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  describe('interactivity (#TRS-phase1 WP1)', () => {
    it('the popup survives the linger window and only hides once HOVER_LINGER_MS has fully elapsed', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
      const div = nodeDivFor('FRM');

      vi.useFakeTimers();
      fireEvent.mouseEnter(div);
      fireEvent.mouseLeave(div);

      act(() => {
        vi.advanceTimersByTime(HOVER_LINGER_MS - 1);
      });
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('moving the pointer from the glyph into the popup cancels the pending hide', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
      const div = nodeDivFor('FRM');

      vi.useFakeTimers();
      fireEvent.mouseEnter(div);
      fireEvent.mouseLeave(div);

      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      expect(popup).not.toBeNull();
      fireEvent.mouseEnter(popup);

      // Well past the linger window — travel into the popup must have
      // cancelled the scheduled hide, not merely delayed it.
      act(() => {
        vi.advanceTimersByTime(HOVER_LINGER_MS * 5);
      });
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

      fireEvent.mouseLeave(popup);
      act(() => {
        vi.advanceTimersByTime(HOVER_LINGER_MS);
      });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('the popup carries the interactive .hoverPopup class hook (pointer-events: auto per the module CSS)', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
      fireEvent.mouseEnter(nodeDivFor('FRM'));

      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      // jsdom doesn't compute CSS module rules, so this asserts the class
      // hook is applied — the real pointer-events check is case (2) above,
      // which proves the popup is actually hoverable.
      expect(popup.className).toMatch(/hoverPopup/);
    });

    it('renders the "More Details" button for a resolved node with a userId', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', userId: '!00000064' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} onOpenNodeDetails={() => {}} />);
      fireEvent.mouseEnter(nodeDivFor('FRM'));

      expect(screen.getByRole('button', { name: /More Details/ })).not.toBeNull();
    });

    it('omits the button when onOpenNodeDetails is not passed', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', userId: '!00000064' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
      fireEvent.mouseEnter(nodeDivFor('FRM'));

      expect(screen.queryByRole('button', { name: /More Details/ })).toBeNull();
    });

    it('omits the button for an unknown/placeholder hop', () => {
      const input: TracerouteStripInput = {
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      };
      const graph = buildTracerouteStripGraph(input);
      // 200 deliberately absent from meta — the existing "unknown hop" fixture.
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', userId: '!00000064' })],
      ]);

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} onOpenNodeDetails={() => {}} />);
      fireEvent.mouseEnter(nodeDivFor('Unknown'));

      expect(screen.queryByRole('button', { name: /More Details/ })).toBeNull();
    });

    it('omits the button when the resolved node has no userId (guards the exact bug the field exists to prevent)', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      // userId deliberately omitted -> undefined via makeMeta's default,
      // even though the node otherwise resolves fully.
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} onOpenNodeDetails={() => {}} />);
      fireEvent.mouseEnter(nodeDivFor('FRM'));

      expect(screen.queryByRole('button', { name: /More Details/ })).toBeNull();
    });

    it('clicking "More Details" calls onOpenNodeDetails with the userId and dismisses the popup', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', userId: '!00000064' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);
      const onOpenNodeDetails = vi.fn();

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} onOpenNodeDetails={onOpenNodeDetails} />);
      fireEvent.mouseEnter(nodeDivFor('FRM'));
      fireEvent.click(screen.getByRole('button', { name: /More Details/ }));

      expect(onOpenNodeDetails).toHaveBeenCalledWith('!00000064');
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('Enter and Space on a focused glyph with an available action fire onOpenNodeDetails', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', userId: '!00000064' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);
      const onOpenNodeDetails = vi.fn();

      render(<TracerouteStrip graph={graph} meta={meta} {...FMT} onOpenNodeDetails={onOpenNodeDetails} />);
      const div = nodeDivFor('FRM');

      fireEvent.keyDown(div, { key: 'Enter' });
      expect(onOpenNodeDetails).toHaveBeenCalledWith('!00000064');

      onOpenNodeDetails.mockClear();
      fireEvent.keyDown(div, { key: ' ' });
      expect(onOpenNodeDetails).toHaveBeenCalledWith('!00000064');
    });

    it('role="button" is set on the glyph only when the action is actually available', () => {
      const input: TracerouteStripInput = {
        fromNodeNum: 100, toNodeNum: 200, route: JSON.stringify([110]), routeBack: null,
      };
      const graph = buildTracerouteStripGraph(input);
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', userId: '!00000064' })],
        // 110 deliberately absent from meta -> placeholder/unknown hop.
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })], // no userId
      ]);

      const { unmount } = render(
        <TracerouteStrip graph={graph} meta={meta} {...FMT} onOpenNodeDetails={() => {}} />,
      );
      expect(nodeDivFor('FRM').getAttribute('role')).toBe('button'); // userId + callback + resolved
      expect(nodeDivFor('Unknown').getAttribute('role')).toBeNull(); // placeholder hop
      expect(nodeDivFor('TGT').getAttribute('role')).toBeNull(); // resolved but no userId
      unmount();

      // And when the callback prop itself is absent, even a userId-bearing
      // node gets no role — there is nothing for it to announce.
      const meta2 = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', userId: '!00000064' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);
      const graph2 = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      render(<TracerouteStrip graph={graph2} meta={meta2} {...FMT} />);
      expect(nodeDivFor('FRM').getAttribute('role')).toBeNull();
    });

    it('unmounting while a hide is pending does not throw', () => {
      const graph = buildTracerouteStripGraph({
        fromNodeNum: 100, toNodeNum: 200, route: '[]', routeBack: null,
      });
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);

      const { unmount } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
      const div = nodeDivFor('FRM');

      vi.useFakeTimers();
      fireEvent.mouseEnter(div);
      fireEvent.mouseLeave(div);

      expect(() => {
        unmount();
        act(() => {
          vi.advanceTimersByTime(HOVER_LINGER_MS);
        });
      }).not.toThrow();
    });
  });

  describe('edge tooltips (#TRS-phase1 WP2)', () => {
    /** Forward + return direct edges between two named nodes, with a real
     *  (non-sentinel) SNR sample on each leg so both SNR rows render.
     *  Mirrors the existing "renders forward SNR labels..." fixture. */
    function buildEdgeFixture(opts: {
      pos100?: { lat: number; lng: number };
      pos200?: { lat: number; lng: number };
    } = {}) {
      const input: TracerouteStripInput = {
        fromNodeNum: 100,
        toNodeNum: 200,
        route: '[]',
        snrTowards: '[20]', // -> 5.0 dB on the forward edge
        routeBack: '[]',
        snrBack: '[-40]', // -> -10.0 dB on the return edge
      };
      const graph = buildTracerouteStripGraph(input);
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', pos: opts.pos100 })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node', pos: opts.pos200 })],
      ]);
      return { graph, meta };
    }

    it('renders one .edgeHit hit target per edge, matching the visible polyline points, with the visible group aria-hidden', () => {
      const { graph, meta } = buildEdgeFixture();
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

      const svg = container.querySelector('svg')!;
      expect(svg.hasAttribute('aria-hidden')).toBe(false);
      expect(svg.hasAttribute('focusable')).toBe(false);

      const groups = svg.querySelectorAll(':scope > g');
      expect(groups).toHaveLength(2);
      expect(groups[0].getAttribute('aria-hidden')).toBe('true');
      expect(groups[1].hasAttribute('aria-hidden')).toBe(false);

      const visiblePolylines = Array.from(groups[0].querySelectorAll('polyline'));
      const hitPolylines = Array.from(groups[1].querySelectorAll('polyline'));
      expect(visiblePolylines).toHaveLength(graph.edges.length);
      expect(hitPolylines).toHaveLength(graph.edges.length);
      visiblePolylines.forEach((vp, i) => {
        expect(hitPolylines[i].getAttribute('points')).toBe(vp.getAttribute('points'));
        expect(hitPolylines[i].getAttribute('role')).toBe('img');
        expect(hitPolylines[i].getAttribute('tabindex')).toBe('0');
      });
    });

    it('shows direction, endpoints, formatted distance and SNR when both endpoints have a position fix', () => {
      const pos100 = { lat: 26.30307, lng: -80.21952 };
      const pos200 = { lat: 26.31307, lng: -80.22952 };
      const { graph, meta } = buildEdgeFixture({ pos100, pos200 });
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

      fireEvent.mouseEnter(hitTargetFor(container, 'forward'));

      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      expect(popup).not.toBeNull();
      const text = popup.textContent ?? '';
      expect(text).toContain('Forward');
      expect(text).toContain('From Node (FRM) → Target Node (TGT)');
      const km = calculateDistance(pos100.lat, pos100.lng, pos200.lat, pos200.lng);
      expect(text).toContain(formatDistance(km, 'km', 1));
      expect(text).toContain('5.0 dB');
    });

    it('omits the distance row when either endpoint lacks a position fix, while direction/endpoints/SNR still render', () => {
      const { graph, meta } = buildEdgeFixture({ pos100: { lat: 1, lng: 2 } }); // pos200 absent
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

      fireEvent.mouseEnter(hitTargetFor(container, 'forward'));

      const popup = document.querySelector('[role="tooltip"]') as HTMLElement;
      const text = popup.textContent ?? '';
      expect(text).toContain('Forward');
      expect(text).toContain('From Node (FRM) → Target Node (TGT)');
      expect(text).toContain('5.0 dB');
      expect(screen.queryByText('Distance:')).toBeNull();
    });

    it('honours distanceUnit, switching between km and mi for the same fixture', () => {
      const pos100 = { lat: 26.30307, lng: -80.21952 };
      const pos200 = { lat: 26.31307, lng: -80.22952 };
      const km = calculateDistance(pos100.lat, pos100.lng, pos200.lat, pos200.lng);
      const { graph, meta } = buildEdgeFixture({ pos100, pos200 });

      const { container: kmContainer, unmount } = render(
        <TracerouteStrip graph={graph} meta={meta} {...FMT} distanceUnit="km" />,
      );
      fireEvent.mouseEnter(hitTargetFor(kmContainer, 'forward'));
      const kmText = (document.querySelector('[role="tooltip"]') as HTMLElement).textContent ?? '';
      unmount();

      const { container: miContainer } = render(
        <TracerouteStrip graph={graph} meta={meta} {...FMT} distanceUnit="mi" />,
      );
      fireEvent.mouseEnter(hitTargetFor(miContainer, 'forward'));
      const miText = (document.querySelector('[role="tooltip"]') as HTMLElement).textContent ?? '';

      expect(kmText).toContain(formatDistance(km, 'km', 1));
      expect(miText).toContain(formatDistance(km, 'mi', 1));
      expect(kmText).not.toBe(miText);
    });

    it("coerces distanceUnit='nm' to km, since formatDistance has no 'nm' branch", () => {
      const pos100 = { lat: 26.30307, lng: -80.21952 };
      const pos200 = { lat: 26.31307, lng: -80.22952 };
      const { graph, meta } = buildEdgeFixture({ pos100, pos200 });

      const { container: kmContainer, unmount } = render(
        <TracerouteStrip graph={graph} meta={meta} {...FMT} distanceUnit="km" />,
      );
      fireEvent.mouseEnter(hitTargetFor(kmContainer, 'forward'));
      const kmText = (document.querySelector('[role="tooltip"]') as HTMLElement).textContent ?? '';
      unmount();

      const { container: nmContainer } = render(
        <TracerouteStrip graph={graph} meta={meta} {...FMT} distanceUnit="nm" />,
      );
      fireEvent.mouseEnter(hitTargetFor(nmContainer, 'forward'));
      const nmText = (document.querySelector('[role="tooltip"]') as HTMLElement).textContent ?? '';

      expect(nmText).toBe(kmText);
    });

    it('shows "Return" for a return-leg edge tooltip and "Forward" for a forward-leg one', () => {
      const { graph, meta } = buildEdgeFixture();
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

      fireEvent.mouseEnter(hitTargetFor(container, 'forward'));
      expect((document.querySelector('[role="tooltip"]') as HTMLElement).textContent).toContain('Forward');

      fireEvent.mouseEnter(hitTargetFor(container, 'return'));
      expect((document.querySelector('[role="tooltip"]') as HTMLElement).textContent).toContain('Return');
    });

    it('shows the unknown-SNR text for a snrUnknown edge; omits the SNR row entirely when snr is null and not unknown', () => {
      const unknownInput: TracerouteStripInput = {
        fromNodeNum: 100,
        toNodeNum: 200,
        route: '[]',
        snrTowards: JSON.stringify([-128]), // INT8_MIN sentinel
        routeBack: null,
      };
      const unknownGraph = buildTracerouteStripGraph(unknownInput);
      const unknownMeta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);
      const { container: c1, unmount: unmountC1 } = render(
        <TracerouteStrip graph={unknownGraph} meta={unknownMeta} {...FMT} />,
      );
      fireEvent.mouseEnter(hitTargetFor(c1, 'forward'));
      const unknownText = (document.querySelector('[role="tooltip"]') as HTMLElement).textContent ?? '';
      expect(unknownText).toContain('Unknown SNR (MQTT-bridged hop, decrypt failure, or old firmware)');
      unmountC1(); // otherwise its still-open popup (with a "Signal:" row) survives into the c2 assertions below

      // Second edge here has NO SNR sample at all (snr: null, snrUnknown: false).
      const missingInput: TracerouteStripInput = {
        fromNodeNum: 100,
        toNodeNum: 200,
        route: JSON.stringify([110]),
        snrTowards: JSON.stringify([-128]), // consumed by the first edge only
        routeBack: null,
      };
      const missingGraph = buildTracerouteStripGraph(missingInput);
      const secondEdge = missingGraph.edges.find((e) => e.toId.includes('-200'));
      expect(secondEdge).toBeDefined();
      expect(secondEdge!.snr).toBeNull();
      expect(secondEdge!.snrUnknown).toBe(false);
      const missingMeta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
        [110, makeMeta({ nodeNum: 110, shortName: 'MID', longName: 'Middle Node' })],
        [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
      ]);
      const { container: c2 } = render(<TracerouteStrip graph={missingGraph} meta={missingMeta} {...FMT} />);
      const secondHit = Array.from(c2.querySelectorAll('polyline[role="img"]')).find((p) =>
        (p.getAttribute('aria-label') ?? '').includes('Middle Node (MID) → Target Node (TGT)'),
      ) as HTMLElement | undefined;
      expect(secondHit).toBeDefined();
      fireEvent.mouseEnter(secondHit!);
      expect(screen.queryByText('Signal:')).toBeNull();
    });

    it('falls back to the unknown placeholder + padded hex for an endpoint missing from meta', () => {
      const input: TracerouteStripInput = {
        fromNodeNum: 100,
        toNodeNum: 200,
        route: '[]',
        routeBack: null,
      };
      const graph = buildTracerouteStripGraph(input);
      // 200 deliberately absent from meta.
      const meta = new Map<number, TracerouteStripNodeMeta>([
        [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node' })],
      ]);
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

      const hit = container.querySelector('polyline[role="img"]') as HTMLElement;
      fireEvent.mouseEnter(hit);
      const text = (document.querySelector('[role="tooltip"]') as HTMLElement).textContent ?? '';
      expect(text).toContain('!000000c8'); // 200 in padded hex
      expect(text).toContain('Unknown');
    });

    it('each hit target has tabIndex=0, role="img", and an aria-label without a dangling separator when distance is absent', () => {
      const { graph, meta } = buildEdgeFixture(); // no pos on either node -> distance absent
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

      const hit = hitTargetFor(container, 'forward');
      expect(hit.getAttribute('tabindex')).toBe('0');
      expect(hit.getAttribute('role')).toBe('img');
      const label = hit.getAttribute('aria-label') ?? '';
      expect(label).toContain('Forward');
      expect(label).toContain('From Node (FRM) → Target Node (TGT)');
      expect(label).toContain('5.0 dB');
      expect(label).not.toMatch(/,\s*,/);
      expect(label.trim().endsWith(',')).toBe(false);
    });

    it('focus opens the tooltip immediately and blur closes it immediately (no linger on the keyboard path)', () => {
      const { graph, meta } = buildEdgeFixture();
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
      const hit = hitTargetFor(container, 'forward');

      expect(hit.getAttribute('aria-describedby')).toBeNull();
      fireEvent.focus(hit);
      const tipId = hit.getAttribute('aria-describedby');
      expect(tipId).toBeTruthy();
      expect(document.getElementById(tipId!)).not.toBeNull();

      fireEvent.blur(hit);
      expect(hit.getAttribute('aria-describedby')).toBeNull();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('click toggles the tooltip open then closed on the same hit target (touch path)', () => {
      const { graph, meta } = buildEdgeFixture();
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
      const hit = hitTargetFor(container, 'forward');

      fireEvent.click(hit);
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

      fireEvent.click(hit);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('a pointerdown outside the hit target and the popup dismisses an open edge tooltip', () => {
      const { graph, meta } = buildEdgeFixture();
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);
      const hit = hitTargetFor(container, 'forward');

      fireEvent.click(hit);
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();

      // Raw dispatchEvent (unlike fireEvent) isn't act()-aware, so the
      // resulting setHover(null) needs an explicit act() to flush before the
      // assertion below reads the DOM.
      const EventCtor = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent;
      act(() => {
        document.body.dispatchEvent(new EventCtor('pointerdown', { bubbles: true, cancelable: true }));
      });

      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });

    it('only one popup is shown at a time: hovering a hit target after a glyph replaces the popup, not adds a second one', () => {
      const { graph, meta } = buildEdgeFixture();
      const { container } = render(<TracerouteStrip graph={graph} meta={meta} {...FMT} />);

      fireEvent.mouseEnter(nodeDivFor('FRM'));
      expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);

      fireEvent.mouseEnter(hitTargetFor(container, 'forward'));
      expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
    });
  });
});
