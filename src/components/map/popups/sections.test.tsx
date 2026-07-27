/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  IdentityItems,
  SignalItems,
  PositionItem,
  LastHeardFooter,
  SourcesList,
  MeshCoreDetails,
  TracerouteBody,
  NodeActions,
  type NodeActionSpec,
} from './sections';
import { toNodeCardModel, type NodeCardModel } from './nodeCardModel';
import type { DbTraceroute } from '../../../services/database';

vi.mock('../../../contexts/SettingsContext', () => ({
}));

// Resolve to the (string or `options.defaultValue`) default — mirroring real
// i18next's behavior when a key's resources aren't loaded — and interpolate
// any `{{token}}` placeholders still present from the options object. This
// lets assertions read the same English text a real render would produce.
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

describe('IdentityItems', () => {
  const model: NodeCardModel = toNodeCardModel(
    { nodeNum: 1, nodeId: '!00000001', longName: 'N', role: 2, hwModel: 9 },
    'meshtastic',
  );

  it('renders ID/role/hardware with the correct icons', () => {
    render(<><IdentityItems model={model} /></>);
    expect(screen.getByText('!00000001')).toBeInTheDocument();
    expect(document.querySelector('.lucide-id-card')).not.toBeNull();
    expect(document.querySelector('.lucide-user')).not.toBeNull();
    expect(document.querySelector('.lucide-monitor')).not.toBeNull();
  });

  it('omits items whose backing field is absent', () => {
    const bare = toNodeCardModel({ nodeNum: 1, longName: 'Bare' }, 'meshtastic');
    render(<><IdentityItems model={bare} /></>);
    expect(document.querySelector('.node-popup-icon')).toBeNull();
  });

  it('renders the ID item full-width only when idFullWidth is set', () => {
    const { container: narrow } = render(<><IdentityItems model={model} /></>);
    expect(narrow.querySelector('.node-popup-item-full')?.textContent).not.toContain('!00000001');

    const { container: full } = render(<><IdentityItems model={model} idFullWidth /></>);
    const idItem = Array.from(full.querySelectorAll('.node-popup-item')).find(el =>
      el.textContent?.includes('!00000001'),
    );
    expect(idItem).toHaveClass('node-popup-item-full');
  });
});

describe('SignalItems', () => {
  it('hides hops >= 999 (unknown-hops sentinel)', () => {
    const model = toNodeCardModel({ nodeNum: 1, hopsAway: 999 }, 'meshtastic');
    render(<><SignalItems model={model} /></>);
    expect(screen.queryByText('🔗')).not.toBeInTheDocument();
  });

  it('shows hops < 999, pluralized', () => {
    const single = toNodeCardModel({ nodeNum: 1, hopsAway: 1 }, 'meshtastic');
    const { unmount } = render(<><SignalItems model={single} /></>);
    expect(screen.getByText('1 hop')).toBeInTheDocument();
    unmount();

    const model = toNodeCardModel({ nodeNum: 1, hopsAway: 3 }, 'meshtastic');
    render(<><SignalItems model={model} /></>);
    expect(screen.getByText('3 hops')).toBeInTheDocument();
  });

  it('suppresses hops entirely when showHops is false (NodePopup composition)', () => {
    const model = toNodeCardModel({ nodeNum: 1, hopsAway: 3 }, 'meshtastic');
    render(<><SignalItems model={model} showHops={false} /></>);
    expect(screen.queryByText('🔗')).not.toBeInTheDocument();
  });

  it('renders raw SNR by default, and rounded SNR when snrDecimals is given', () => {
    const model = toNodeCardModel({ nodeNum: 1, snr: 5.678 }, 'meshtastic');
    const { unmount } = render(<><SignalItems model={model} /></>);
    expect(screen.getByText('5.678 dB')).toBeInTheDocument();
    unmount();

    render(<><SignalItems model={model} snrDecimals={1} /></>);
    expect(screen.getByText('5.7 dB')).toBeInTheDocument();
  });

  it('renders battery 101 as "Plugged In" only when showPluggedIn is set', () => {
    const model = toNodeCardModel({ nodeNum: 1, batteryLevel: 101 }, 'meshtastic');
    const { unmount } = render(<><SignalItems model={model} /></>);
    expect(screen.getByText('101%')).toBeInTheDocument();
    unmount();

    render(<><SignalItems model={model} showPluggedIn /></>);
    expect(screen.getByText('Plugged In')).toBeInTheDocument();
    expect(screen.queryByText('101%')).not.toBeInTheDocument();
  });

  it('renders altitude only when showAltitude is set', () => {
    const model = toNodeCardModel({ nodeNum: 1, position: { altitude: 42 } }, 'meshtastic');
    const { unmount } = render(<><SignalItems model={model} /></>);
    expect(screen.queryByText('42m')).not.toBeInTheDocument();
    unmount();

    render(<><SignalItems model={model} showAltitude /></>);
    expect(screen.getByText('42m')).toBeInTheDocument();
  });

  it('renders position accuracy from precision bits, unit-aware (#4176)', () => {
    const model = toNodeCardModel({ nodeNum: 1, positionPrecisionBits: 18 }, 'meshtastic');
    const { unmount } = render(<><SignalItems model={model} /></>);
    // 18 bits ≈ 91 m in the Meshtastic accuracy table (metric default).
    expect(screen.getByText('~91 m')).toBeInTheDocument();
    unmount();

    render(<><SignalItems model={model} distanceUnit="mi" /></>);
    // Imperial rendering — feet, not metres.
    expect(screen.getByText(/ft$/)).toBeInTheDocument();
  });

  it('hides position accuracy when precision bits are 0/absent (#4176)', () => {
    const disabled = toNodeCardModel({ nodeNum: 1, positionPrecisionBits: 0 }, 'meshtastic');
    const { unmount } = render(<><SignalItems model={disabled} /></>);
    expect(screen.queryByText('🎯')).not.toBeInTheDocument();
    unmount();

    const absent = toNodeCardModel({ nodeNum: 1 }, 'meshtastic');
    render(<><SignalItems model={absent} /></>);
    expect(screen.queryByText('🎯')).not.toBeInTheDocument();
  });

  it('renders the location-source label, hiding UNSET/absent (#4176)', () => {
    const internal = toNodeCardModel({ nodeNum: 1, positionLocationSource: 2 }, 'meshtastic');
    const { unmount } = render(<><SignalItems model={internal} /></>);
    expect(screen.getByText('Internal GPS')).toBeInTheDocument();
    unmount();

    const manual = toNodeCardModel({ nodeNum: 1, positionLocationSource: 1 }, 'meshtastic');
    const r2 = render(<><SignalItems model={manual} /></>);
    expect(screen.getByText('Manual')).toBeInTheDocument();
    r2.unmount();

    const unset = toNodeCardModel({ nodeNum: 1, positionLocationSource: 0 }, 'meshtastic');
    render(<><SignalItems model={unset} /></>);
    expect(screen.queryByText('🛰️')).not.toBeInTheDocument();
  });
});

describe('PositionItem', () => {
  it('renders lat/lng to 5 decimal places', () => {
    render(<PositionItem position={{ lat: 35.12345, lng: -80.6789 }} />);
    expect(screen.getByText('35.12345, -80.67890')).toBeInTheDocument();
  });
});

describe('LastHeardFooter', () => {
  it('renders nothing when lastHeard is null/undefined', () => {
    const { container: n1 } = render(
      <LastHeardFooter lastHeard={null} mode="absolute" timeFormat="24" dateFormat="MM/DD/YYYY" />,
    );
    expect(n1.firstChild).toBeNull();
    const { container: n2 } = render(
      <LastHeardFooter lastHeard={undefined} mode="relative" timeFormat="24" dateFormat="MM/DD/YYYY" />,
    );
    expect(n2.firstChild).toBeNull();
  });

  it('renders a value for both absolute and relative modes', () => {
    const lastHeard = Math.floor(Date.now() / 1000) - 60;
    const { unmount } = render(
      <LastHeardFooter lastHeard={lastHeard} mode="absolute" timeFormat="24" dateFormat="MM/DD/YYYY" />,
    );
    expect(document.querySelector('.lucide-clock')).not.toBeNull();
    unmount();

    render(<LastHeardFooter lastHeard={lastHeard} mode="relative" timeFormat="24" dateFormat="MM/DD/YYYY" />);
    expect(screen.getByText(/minute|just now/)).toBeInTheDocument();
  });
});

describe('SourcesList', () => {
  const sources = [
    { sourceId: 'a', sourceName: 'Tower Alpha', protocol: 'Meshtastic' as const },
    { sourceId: 'b', sourceName: 'Core Bravo', protocol: 'MeshCore' as const },
  ];

  it('still renders a single-source list (the family does not itself apply an ">1 source" threshold)', () => {
    // Whether to omit the section for single-source nodes is a CONSUMER
    // decision (pass `sources={undefined}` / omit the prop); the section
    // itself just renders whatever non-empty array it's given.
    const { container } = render(<SourcesList sources={[sources[0]]} />);
    expect(container.textContent).toContain('Tower Alpha');
    expect(screen.getByText('Seen by 1 source')).toBeInTheDocument();
  });

  it('renders nothing when sources is empty/absent', () => {
    const { container: empty } = render(<SourcesList sources={[]} />);
    expect(empty.firstChild).toBeNull();
    const { container: absent } = render(<SourcesList />);
    expect(absent.firstChild).toBeNull();
  });

  it('renders a "Seen by N sources" title and a row per source', () => {
    render(<SourcesList sources={sources} />);
    expect(screen.getByText('Seen by 2 sources')).toBeInTheDocument();
    expect(screen.getByText('Tower Alpha')).toBeInTheDocument();
    expect(screen.getByText('Core Bravo')).toBeInTheDocument();
    expect(screen.getByText('Meshtastic')).toBeInTheDocument();
    expect(screen.getByText('MeshCore')).toBeInTheDocument();
  });

  it('calls onSourceSelect with the source and nodeId when a row is clicked', () => {
    const onSourceSelect = vi.fn();
    render(<SourcesList sources={sources} nodeId="!00000064" onSourceSelect={onSourceSelect} />);
    fireEvent.click(screen.getByText('Core Bravo'));
    expect(onSourceSelect).toHaveBeenCalledWith(sources[1], '!00000064');
  });

  it('disables rows when no onSourceSelect is given', () => {
    render(<SourcesList sources={sources} />);
    expect(screen.getByText('Tower Alpha').closest('button')).toBeDisabled();
  });
});

describe('MeshCoreDetails', () => {
  it('renders nothing when the model has no meshcore data', () => {
    const model = toNodeCardModel({ nodeNum: 1, longName: 'x' }, 'meshtastic');
    const { container } = render(<><MeshCoreDetails model={model} /></>);
    expect(container.firstChild).toBeNull();
  });

  it('renders the "MeshCore Device" hardware literal, truncated key, and all present fields', () => {
    const model = toNodeCardModel(
      {
        publicKey: 'abcdef0123456789abcdef0123456789',
        advName: 'Repeater One',
        rssi: -80,
        snr: 4.5,
        pathLen: 2,
        outPath: 'a3,7f',
      },
      'meshcore',
    );
    render(<><MeshCoreDetails model={model} /></>);
    expect(screen.getByText('MeshCore Device')).toBeInTheDocument();
    expect(screen.getByText('abcdef0123456789…')).toBeInTheDocument();
    expect(screen.getByText('-80 dBm')).toBeInTheDocument();
    expect(screen.getByText('4.5 dB')).toBeInTheDocument();
    expect(screen.getByText('2 hops')).toBeInTheDocument();
    expect(screen.getByText('a3,7f')).toBeInTheDocument();
  });

  it('renders "Direct" for a zero-hop path and omits fields that are absent', () => {
    const model = toNodeCardModel({ publicKey: 'key', advName: 'X', pathLen: 0 }, 'meshcore');
    render(<><MeshCoreDetails model={model} /></>);
    expect(screen.getByText('Direct')).toBeInTheDocument();
    expect(screen.queryByText(/dBm/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ dB$/)).not.toBeInTheDocument();
  });
});

describe('TracerouteBody', () => {
  const baseTr: DbTraceroute = {
    fromNodeNum: 1,
    toNodeNum: 2,
    fromNodeId: '!00000001',
    toNodeId: '!00000002',
    route: JSON.stringify([]),
    // A literal 'null' string (not an empty array) is how "no return path
    // recorded yet" is represented — an empty-array routeBack is still
    // "present" per the `routeBack && routeBack !== 'null'` gate every
    // current renderer (and this port) uses.
    routeBack: 'null',
    snrTowards: JSON.stringify([]),
    snrBack: 'null',
    timestamp: Date.now(),
    createdAt: Date.now(),
  };

  it('renders "no recent traceroute" when recentTraceroute is null', () => {
    render(<TracerouteBody recentTraceroute={null} nodes={[]} distanceUnit="km" />);
    expect(screen.getByText('No recent traceroute data')).toBeInTheDocument();
  });

  it('renders the failed-traceroute message when route is "null"', () => {
    render(
      <TracerouteBody
        recentTraceroute={{ ...baseTr, route: 'null' }}
        nodes={[]}
        distanceUnit="km"
      />,
    );
    expect(screen.getByText('No response received')).toBeInTheDocument();
  });

  it('renders the forward path, and the return path only when routeBack is present', () => {
    const { unmount } = render(
      <TracerouteBody recentTraceroute={baseTr} nodes={[]} distanceUnit="km" />,
    );
    expect(screen.getByText('Forward:')).toBeInTheDocument();
    expect(screen.queryByText('Return:')).not.toBeInTheDocument();
    unmount();

    render(
      <TracerouteBody
        recentTraceroute={{ ...baseTr, routeBack: JSON.stringify([1, 2]), snrBack: JSON.stringify([10, 10]) }}
        nodes={[]}
        distanceUnit="km"
      />,
    );
    expect(screen.getByText('Return:')).toBeInTheDocument();
  });

  it('renders the "View History" button only when both a recentTraceroute AND onViewHistory are given', () => {
    const onViewHistory = vi.fn();
    const { unmount } = render(
      <TracerouteBody recentTraceroute={baseTr} nodes={[]} distanceUnit="km" />,
    );
    expect(screen.queryByText('View History')).not.toBeInTheDocument();
    unmount();

    const { unmount: unmount2 } = render(
      <TracerouteBody
        recentTraceroute={baseTr}
        nodes={[]}
        distanceUnit="km"
        onViewHistory={onViewHistory}
      />,
    );
    fireEvent.click(screen.getByText('View History'));
    expect(onViewHistory).toHaveBeenCalled();

    unmount2();
    render(<TracerouteBody recentTraceroute={null} nodes={[]} distanceUnit="km" onViewHistory={onViewHistory} />);
    expect(screen.queryByText('View History')).not.toBeInTheDocument();
  });

  it('renders the run button only when onRunTraceroute is given, honoring runDisabled/running', () => {
    const { container, rerender } = render(
      <TracerouteBody recentTraceroute={null} nodes={[]} distanceUnit="km" />,
    );
    expect(screen.queryByText(/Traceroute/)).not.toBeInTheDocument();

    const onRun = vi.fn();
    rerender(
      <TracerouteBody
        recentTraceroute={null}
        nodes={[]}
        distanceUnit="km"
        onRunTraceroute={onRun}
        runDisabled
      />,
    );
    const btn = screen.getByText(/Traceroute/).closest('button')!;
    expect(btn).toBeDisabled();
    expect(container.querySelector('.spinner')).toBeNull();

    rerender(
      <TracerouteBody
        recentTraceroute={null}
        nodes={[]}
        distanceUnit="km"
        onRunTraceroute={onRun}
        running
      />,
    );
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('sets the run button title from runDisabledReason (epic #4294 Phase 2 — TX-disabled tooltip)', () => {
    const onRun = vi.fn();
    const { rerender } = render(
      <TracerouteBody
        recentTraceroute={null}
        nodes={[]}
        distanceUnit="km"
        onRunTraceroute={onRun}
      />,
    );
    // No reason given — no title attribute.
    expect(screen.getByText(/Traceroute/).closest('button')).not.toHaveAttribute('title');

    rerender(
      <TracerouteBody
        recentTraceroute={null}
        nodes={[]}
        distanceUnit="km"
        onRunTraceroute={onRun}
        runDisabled
        runDisabledReason="Transmit is disabled on this node's radio."
      />,
    );
    const btn = screen.getByText(/Traceroute/).closest('button')!;
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', "Transmit is disabled on this node's radio.");
  });
});

describe('NodeActions', () => {
  it('renders primary actions as standalone buttons and groups delete/purge into a danger block', () => {
    const specs: NodeActionSpec[] = [
      { kind: 'more-details', onClick: vi.fn() },
      { kind: 'delete', onClick: vi.fn() },
      { kind: 'purge', onClick: vi.fn() },
    ];
    const { container } = render(<><NodeActions actions={specs} /></>);
    expect(screen.getByText(/More Details/)).toBeInTheDocument();

    const dangerBlock = container.querySelector('.node-popup-danger-actions');
    expect(dangerBlock).not.toBeNull();
    expect(dangerBlock?.querySelectorAll('button')).toHaveLength(2);
    expect(dangerBlock?.querySelector('.popup-danger-btn-severe')).not.toBeNull();
  });

  it('omits the danger block entirely when no delete/purge action is supplied', () => {
    const { container } = render(
      <><NodeActions actions={[{ kind: 'show-on-map', onClick: vi.fn() }]} /></>,
    );
    expect(container.querySelector('.node-popup-danger-actions')).toBeNull();
  });

  it('invokes the right callback for the clicked action and respects `disabled`', () => {
    const onDelete = vi.fn();
    render(
      <><NodeActions actions={[{ kind: 'delete', onClick: onDelete, disabled: true }]} /></>,
    );
    const btn = screen.getByText(/Delete/).closest('button')!;
    expect(btn).toBeDisabled();
  });
});
