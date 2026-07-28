/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TracerouteStrip, type TracerouteStripNodeMeta } from './TracerouteStrip';
import { buildTracerouteStripGraph, type TracerouteStripInput } from '../../utils/tracerouteStrip';

// The global setup.ts mock for react-i18next ignores the `defaultValue`
// argument entirely (it only interpolates `{{token}}` placeholders into the
// raw key) — see src/components/NodePopup/NodePopup.test.tsx for the same
// override. This component calls `t(key, defaultEnglish, vars)`, so a smarter
// local mock is needed to assert real rendered English text.
vi.mock('react-i18next', () => ({
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
  };
}

function nodeDivFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const node = el.closest('[tabindex]');
  if (!node) throw new Error(`no tabindex ancestor found for "${text}"`);
  return node as HTMLElement;
}

describe('TracerouteStrip', () => {
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
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(3);
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
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(3);
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

    fireEvent.mouseLeave(div);
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

    fireEvent.mouseLeave(div);
    const removedScroll = removeSpy.mock.calls.filter((c) => String(c[0]) === 'scroll').length;
    expect(removedScroll).toBe(addedScroll);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
