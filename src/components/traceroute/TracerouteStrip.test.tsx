/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

function makeMeta(opts: {
  nodeNum: number;
  shortName: string;
  longName?: string | null;
  roleLabel?: string | null;
  hops?: number;
  unmessagable?: boolean;
}): TracerouteStripNodeMeta {
  return {
    nodeNum: opts.nodeNum,
    shortName: opts.shortName,
    longName: opts.longName ?? null,
    roleLabel: opts.roleLabel ?? null,
    nodeId: `!${opts.nodeNum.toString(16).padStart(8, '0')}`,
    category: 'mtClient',
    hops: opts.hops ?? 1,
    unmessagable: opts.unmessagable ?? false,
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

    const { container } = render(<TracerouteStrip graph={graph} meta={meta} />);
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

    const { container } = render(<TracerouteStrip graph={graph} meta={meta} />);
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

    render(<TracerouteStrip graph={graph} meta={meta} />);

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

    render(<TracerouteStrip graph={graph} meta={meta} />);

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

    render(<TracerouteStrip graph={graph} meta={meta} />);

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

    const { container } = render(<TracerouteStrip graph={graph} meta={meta} />);
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
        <TracerouteStrip graph={graph} meta={meta} />
        <TracerouteStrip graph={graph} meta={meta} />
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

    render(<TracerouteStrip graph={graph} meta={meta} />);

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

    render(<TracerouteStrip graph={graph} meta={meta} />);

    const div = nodeDivFor('FRM');
    const label = div.getAttribute('aria-label') ?? '';
    expect(label).toContain('From Node');
    expect(label).toContain('!00000064');
    expect(label).not.toMatch(/,\s*,/);
  });

  it('keeps the tooltip in the DOM (never display:none) and wires it via aria-describedby', () => {
    const input: TracerouteStripInput = {
      fromNodeNum: 100,
      toNodeNum: 200,
      route: '[]',
      routeBack: null,
    };
    const graph = buildTracerouteStripGraph(input);
    const meta = new Map<number, TracerouteStripNodeMeta>([
      [100, makeMeta({ nodeNum: 100, shortName: 'FRM', longName: 'From Node', roleLabel: 'Client' })],
      [200, makeMeta({ nodeNum: 200, shortName: 'TGT', longName: 'Target Node' })],
    ]);

    render(<TracerouteStrip graph={graph} meta={meta} />);

    const div = nodeDivFor('FRM');
    const tipId = div.getAttribute('aria-describedby');
    expect(tipId).toBeTruthy();
    const tooltip = document.getElementById(tipId!);
    expect(tooltip).not.toBeNull();
    expect(tooltip).toHaveAttribute('role', 'tooltip');
    expect(tooltip!.style.display).not.toBe('none');
    expect(tooltip!.textContent).toContain('From Node');
    expect(tooltip!.textContent).toContain('Client');
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

    render(<TracerouteStrip graph={graph} meta={meta} />);

    const div = nodeDivFor('Unknown');
    const tipId = div.getAttribute('aria-describedby');
    const tooltip = document.getElementById(tipId!);
    expect(tooltip!.textContent).toBe('!000000c8'); // 200 in padded hex
  });
});
