/**
 * @vitest-environment jsdom
 *
 * CoverageReceiverFilter (#5277 Phase 2 WP4) — the scalable receiver picker
 * plus the MQTT recording status block. See COVERAGE_P2_SPEC.md §2.9/§3.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      if (typeof fallback === 'string') {
        const vars = (opts ?? {}) as Record<string, unknown>;
        return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
      }
      return _key;
    },
  }),
}));

import { CoverageReceiverFilter } from './CoverageReceiverFilter';
import { receiverKey } from '../../utils/coverageReceiverFilter';
import type { CoverageReceiverDto, CoverageMqttSourceStatusDto } from '../../types/coverage';

function receiver(overrides: Partial<CoverageReceiverDto>): CoverageReceiverDto {
  return {
    sourceId: 'src-a',
    sourceName: 'Source A',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: '!aaaaaaaa',
    receiverNodeNum: 1,
    longName: 'Receiver One',
    shortName: 'R1',
    latitude: 26.1,
    longitude: -80.2,
    lastReceivedAt: 1,
    receptionCount: 10,
    ...overrides,
  };
}

function renderFilter(
  receivers: CoverageReceiverDto[],
  deselected: Set<string>,
  onChange: (next: Set<string>) => void,
  mqttSources: CoverageMqttSourceStatusDto[] = [],
) {
  return render(
    <MemoryRouter>
      <CoverageReceiverFilter
        receivers={receivers}
        deselected={deselected}
        onChange={onChange}
        mqttSources={mqttSources}
      />
    </MemoryRouter>,
  );
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Receivers:|All receivers/ }));
}

describe('CoverageReceiverFilter', () => {
  it('search narrows the visible rows', () => {
    const receivers = [
      receiver({ receiverId: '!a1', longName: 'Alpha Station' }),
      receiver({ receiverId: '!a2', longName: 'Beta Station' }),
    ];
    renderFilter(receivers, new Set(), vi.fn());
    openPanel();

    expect(screen.getByText('Alpha Station')).toBeInTheDocument();
    expect(screen.getByText('Beta Station')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search receivers'), { target: { value: 'alpha' } });

    expect(screen.getByText('Alpha Station')).toBeInTheDocument();
    expect(screen.queryByText('Beta Station')).not.toBeInTheDocument();
  });

  it('Select all / Select none act only on the currently-visible (searched) rows', () => {
    const receivers = [
      receiver({ receiverId: '!a1', longName: 'Alpha Station' }),
      receiver({ receiverId: '!a2', longName: 'Beta Station' }),
    ];
    const onChange = vi.fn();
    renderFilter(receivers, new Set([receiverKey('src-a', '!a1'), receiverKey('src-a', '!a2')]), onChange);
    openPanel();

    fireEvent.change(screen.getByLabelText('Search receivers'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));

    // Only !a1 (the visible/matching row) is re-selected; !a2 stays deselected.
    const next = onChange.mock.calls[0][0] as Set<string>;
    expect(next.has(receiverKey('src-a', '!a1'))).toBe(false);
    expect(next.has(receiverKey('src-a', '!a2'))).toBe(true);
  });

  it('Select none deselects only the visible rows', () => {
    const receivers = [
      receiver({ receiverId: '!a1', longName: 'Alpha Station' }),
      receiver({ receiverId: '!a2', longName: 'Beta Station' }),
    ];
    const onChange = vi.fn();
    renderFilter(receivers, new Set(), onChange);
    openPanel();

    fireEvent.change(screen.getByLabelText('Search receivers'), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select none' }));

    const next = onChange.mock.calls[0][0] as Set<string>;
    expect(next.has(receiverKey('src-a', '!a1'))).toBe(true);
    expect(next.has(receiverKey('src-a', '!a2'))).toBe(false);
  });

  it('the group tri-state checkbox is indeterminate when partially selected, and toggling it selects the whole group', () => {
    const receivers = [
      receiver({ receiverId: '!a1', longName: 'Alpha' }),
      receiver({ receiverId: '!a2', longName: 'Beta' }),
    ];
    const onChange = vi.fn();
    renderFilter(receivers, new Set([receiverKey('src-a', '!a1')]), onChange);
    openPanel();

    const groupCheckbox = screen.getByRole('checkbox', { name: 'Source A' }) as HTMLInputElement;
    expect(groupCheckbox.indeterminate).toBe(true);

    fireEvent.click(groupCheckbox);
    const next = onChange.mock.calls[0][0] as Set<string>;
    // Was partial -> selects the whole group.
    expect(next.has(receiverKey('src-a', '!a1'))).toBe(false);
    expect(next.has(receiverKey('src-a', '!a2'))).toBe(false);
  });

  it('a fully-selected group checkbox is checked (not indeterminate), and toggling it deselects the whole group', () => {
    const receivers = [receiver({ receiverId: '!a1' }), receiver({ receiverId: '!a2' })];
    const onChange = vi.fn();
    renderFilter(receivers, new Set(), onChange);
    openPanel();

    const groupCheckbox = screen.getByRole('checkbox', { name: 'Source A' }) as HTMLInputElement;
    expect(groupCheckbox.indeterminate).toBe(false);
    expect(groupCheckbox.checked).toBe(true);

    fireEvent.click(groupCheckbox);
    const next = onChange.mock.calls[0][0] as Set<string>;
    expect(next.has(receiverKey('src-a', '!a1'))).toBe(true);
    expect(next.has(receiverKey('src-a', '!a2'))).toBe(true);
  });

  it('shows a Local or Gateway kind badge per row', () => {
    const receivers = [
      receiver({ receiverId: '!local1', receiverKind: 'local', longName: 'Local One' }),
      receiver({ receiverId: '!gw1', receiverKind: 'mqtt_gateway', longName: 'Gateway One' }),
    ];
    renderFilter(receivers, new Set(), vi.fn());
    openPanel();

    const localRow = screen.getByText('Local One').closest('li') as HTMLElement;
    expect(within(localRow).getByText('Local')).toBeInTheDocument();
    const gwRow = screen.getByText('Gateway One').closest('li') as HTMLElement;
    expect(within(gwRow).getByText('Gateway')).toBeInTheDocument();
  });

  // #5277 Phase 3 WP3: MeshCore receivers.
  describe('MeshCore', () => {
    const PUBKEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

    it('shows an Observer kind badge (not Gateway) for a MeshCore mqtt_gateway row', () => {
      const receivers = [
        receiver({
          receiverId: PUBKEY,
          receiverKind: 'mqtt_gateway',
          protocol: 'meshcore',
          longName: 'Observer One',
        }),
      ];
      renderFilter(receivers, new Set(), vi.fn());
      openPanel();

      const row = screen.getByText('Observer One').closest('li') as HTMLElement;
      expect(within(row).getByText('Observer')).toBeInTheDocument();
      expect(within(row).queryByText('Gateway')).not.toBeInTheDocument();
    });

    it('shows a Local kind badge (not Observer) for a MeshCore local row', () => {
      const receivers = [
        receiver({
          receiverId: PUBKEY,
          receiverKind: 'local',
          protocol: 'meshcore',
          longName: 'Companion One',
        }),
      ];
      renderFilter(receivers, new Set(), vi.fn());
      openPanel();

      const row = screen.getByText('Companion One').closest('li') as HTMLElement;
      expect(within(row).getByText('Local')).toBeInTheDocument();
      expect(within(row).queryByText('Observer')).not.toBeInTheDocument();
    });

    it('shows a MeshCore protocol badge only for meshcore rows', () => {
      const receivers = [
        receiver({ receiverId: '!aaaaaaaa', protocol: 'meshtastic', longName: 'Meshtastic One' }),
        receiver({ receiverId: PUBKEY, protocol: 'meshcore', longName: 'MeshCore One', sourceId: 'src-b', sourceName: 'Source B' }),
      ];
      renderFilter(receivers, new Set(), vi.fn());
      openPanel();

      const mtRow = screen.getByText('Meshtastic One').closest('li') as HTMLElement;
      expect(within(mtRow).queryByText('MeshCore')).not.toBeInTheDocument();
      const mcRow = screen.getByText('MeshCore One').closest('li') as HTMLElement;
      expect(within(mcRow).getByText('MeshCore')).toBeInTheDocument();
    });

    it('abbreviates a pubkey receiverId to its first 8 hex chars', () => {
      const receivers = [receiver({ receiverId: PUBKEY, protocol: 'meshcore', longName: 'MeshCore One' })];
      renderFilter(receivers, new Set(), vi.fn());
      openPanel();

      expect(screen.getByText('a1b2c3d4…')).toBeInTheDocument();
      expect(screen.queryByText(PUBKEY)).not.toBeInTheDocument();
    });

    it('search matches a pubkey prefix', () => {
      const receivers = [
        receiver({ receiverId: PUBKEY, protocol: 'meshcore', longName: 'MeshCore One' }),
        receiver({ receiverId: '!other', protocol: 'meshtastic', longName: 'Other One' }),
      ];
      renderFilter(receivers, new Set(), vi.fn());
      openPanel();

      fireEvent.change(screen.getByLabelText('Search receivers'), { target: { value: 'a1b2c3' } });

      expect(screen.getByText('MeshCore One')).toBeInTheDocument();
      expect(screen.queryByText('Other One')).not.toBeInTheDocument();
    });
  });

  it('sorts rows within a group by receptionCount descending', () => {
    const receivers = [
      receiver({ receiverId: '!low', longName: 'Low', receptionCount: 2 }),
      receiver({ receiverId: '!high', longName: 'High', receptionCount: 99 }),
    ];
    renderFilter(receivers, new Set(), vi.fn());
    openPanel();

    const names = screen.getAllByRole('checkbox').filter((el) => el.getAttribute('aria-label') !== 'Source A');
    // First receiver checkbox in DOM order should be "High" (highest count).
    expect(names[0]).toHaveAttribute('aria-label', 'High');
  });

  it('caps a group at 200 rows with a "Show all" button', () => {
    const receivers = Array.from({ length: 250 }, (_, i) =>
      receiver({ receiverId: `!r${i}`, longName: `Station ${i}`, receptionCount: 250 - i }),
    );
    renderFilter(receivers, new Set(), vi.fn());
    openPanel();

    expect(screen.getByText('Station 0')).toBeInTheDocument();
    expect(screen.queryByText('Station 249')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 250' }));
    expect(screen.getByText('Station 249')).toBeInTheDocument();
  });

  it('two sources with the same receiverId toggle independently', () => {
    const receivers = [
      receiver({ sourceId: 'src-a', sourceName: 'Source A', receiverId: '!dup', longName: 'Dup A' }),
      receiver({ sourceId: 'src-b', sourceName: 'Source B', receiverId: '!dup', longName: 'Dup B' }),
    ];
    const onChange = vi.fn();
    renderFilter(receivers, new Set(), onChange);
    openPanel();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Dup A' }));
    const next = onChange.mock.calls[0][0] as Set<string>;
    expect(next.has(receiverKey('src-a', '!dup'))).toBe(true);
    expect(next.has(receiverKey('src-b', '!dup'))).toBe(false);
  });

  describe('MQTT recording status', () => {
    const receivers = [receiver({})];

    it('shows one row per mqttSources entry, with a Recording badge and no link when on', () => {
      renderFilter(receivers, new Set(), vi.fn(), [
        { sourceId: 'src-a', sourceName: 'Source A', recordingEnabled: true },
      ]);

      const status = screen.getByTestId('coverage-mqtt-status');
      expect(within(status).getByText('Source A')).toBeInTheDocument();
      expect(within(status).getByText('Recording')).toBeInTheDocument();
      expect(within(status).queryByRole('link')).not.toBeInTheDocument();
    });

    it('shows an Off badge and a settings link when off', () => {
      renderFilter(receivers, new Set(), vi.fn(), [
        { sourceId: 'src-b', sourceName: 'Source B', recordingEnabled: false },
      ]);

      const status = screen.getByTestId('coverage-mqtt-status');
      expect(within(status).getByText('Off')).toBeInTheDocument();
      const link = within(status).getByRole('link', { name: 'Turn on in source settings' });
      expect(link).toHaveAttribute('href', '/source/src-b/settings#settings-coverage-mqtt');
    });

    it('is hidden when mqttSources is empty', () => {
      renderFilter(receivers, new Set(), vi.fn(), []);
      expect(screen.queryByTestId('coverage-mqtt-status')).not.toBeInTheDocument();
    });

    it('is shown in the empty state (no receivers at all)', () => {
      renderFilter([], new Set(), vi.fn(), [
        { sourceId: 'src-a', sourceName: 'Source A', recordingEnabled: true },
      ]);
      expect(screen.getByTestId('coverage-mqtt-status')).toBeInTheDocument();
      // No receivers at all -> no picker trigger.
      expect(screen.queryByRole('button', { name: /Receivers:|All receivers/ })).not.toBeInTheDocument();
    });

    // #5277 Phase 3 WP3: `protocol` is a WP2 addition to CoverageMqttSourceStatusDto
    // (spec §4) — typed as an optional extra field here so this test compiles
    // and passes both before and after WP2 merges (the orchestrator re-runs
    // WP3's tests after that merge).
    it('labels a MeshCore observer source "Observer recording" when on', () => {
      const mqttSources: Array<CoverageMqttSourceStatusDto & { protocol?: string }> = [
        { sourceId: 'src-a', sourceName: 'Source A', recordingEnabled: true, protocol: 'meshcore' },
      ];
      renderFilter(receivers, new Set(), vi.fn(), mqttSources);

      const status = screen.getByTestId('coverage-mqtt-status');
      expect(within(status).getByText('Observer recording')).toBeInTheDocument();
      expect(within(status).queryByText('Recording')).not.toBeInTheDocument();
    });

    it('keeps the plain "Recording" label for a Meshtastic MQTT source', () => {
      const mqttSources: Array<CoverageMqttSourceStatusDto & { protocol?: string }> = [
        { sourceId: 'src-a', sourceName: 'Source A', recordingEnabled: true, protocol: 'meshtastic' },
      ];
      renderFilter(receivers, new Set(), vi.fn(), mqttSources);

      const status = screen.getByTestId('coverage-mqtt-status');
      expect(within(status).getByText('Recording')).toBeInTheDocument();
    });

    it('treats a missing protocol field as Meshtastic (pre-WP2-merge shape)', () => {
      renderFilter(receivers, new Set(), vi.fn(), [
        { sourceId: 'src-a', sourceName: 'Source A', recordingEnabled: true },
      ]);

      const status = screen.getByTestId('coverage-mqtt-status');
      expect(within(status).getByText('Recording')).toBeInTheDocument();
    });

    it('URL-encodes the sourceId in the settings link', () => {
      renderFilter(receivers, new Set(), vi.fn(), [
        { sourceId: 'src with space', sourceName: 'Weird Source', recordingEnabled: false },
      ]);
      const link = screen.getByRole('link', { name: 'Turn on in source settings' });
      expect(link).toHaveAttribute('href', '/source/src%20with%20space/settings#settings-coverage-mqtt');
    });
  });

  it('scales to 500 receivers across several groups without erroring (spec §4 acceptance)', () => {
    const receivers = Array.from({ length: 500 }, (_, i) =>
      receiver({
        sourceId: `src-${i % 5}`,
        sourceName: `Source ${i % 5}`,
        receiverId: `!r${i}`,
        longName: `Station ${i}`,
        receptionCount: i,
      }),
    );
    renderFilter(receivers, new Set(), vi.fn());
    openPanel();
    expect(screen.getByText('All receivers')).toBeInTheDocument();
  });

  it('the trigger shows "All receivers" when everything is selected, and a count otherwise', () => {
    const receivers = [receiver({ receiverId: '!a1' }), receiver({ receiverId: '!a2' })];
    const { rerender } = renderFilter(receivers, new Set(), vi.fn());
    expect(screen.getByText('All receivers')).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <CoverageReceiverFilter
          receivers={receivers}
          deselected={new Set([receiverKey('src-a', '!a1')])}
          onChange={vi.fn()}
          mqttSources={[]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Receivers: 1 of 2')).toBeInTheDocument();
  });
});
