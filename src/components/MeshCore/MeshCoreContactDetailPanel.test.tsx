/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the MeshCore DM contact-detail panel.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

const PK = 'a'.repeat(64);

describe('MeshCoreContactDetailPanel', () => {
  it('renders the public key when a contact is provided', () => {
    const contact: MeshCoreContact = {
      publicKey: PK,
      advName: 'Companion Bob',
      advType: 1,
      rssi: -72,
      snr: 8.5,
      pathLen: 2,
      lastSeen: Date.now(),
      latitude: 30.123,
      longitude: -90.456,
    };

    render(<MeshCoreContactDetailPanel contact={contact} publicKey={PK} />);

    expect(screen.getByText('Companion Bob')).toBeTruthy();
    expect(screen.getByText('-72 dBm')).toBeTruthy();
    expect(screen.getByText('8.5 dB')).toBeTruthy();
    expect(screen.getByText(PK)).toBeTruthy();
    expect(screen.getByText('30.12300, -90.45600')).toBeTruthy();
  });

  it('falls back to truncated key as name when contact is null', () => {
    render(<MeshCoreContactDetailPanel contact={null} publicKey={PK} />);
    // First 8 hex chars with an ellipsis suffix
    expect(screen.getByText(`${PK.substring(0, 8)}…`)).toBeTruthy();
    expect(screen.getByText(PK)).toBeTruthy();
  });

  it('renders Direct when pathLen is 0', () => {
    const contact: MeshCoreContact = {
      publicKey: PK,
      pathLen: 0,
    };
    render(<MeshCoreContactDetailPanel contact={contact} publicKey={PK} />);
    expect(screen.getByText('Direct')).toBeTruthy();
  });

  it('renders Discover Path button when onDiscoverPath is provided and canWriteNodes is true', () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onDiscoverPath={vi.fn().mockResolvedValue(true)}
        canWriteNodes
        isCompanion
      />,
    );
    expect(screen.getByRole('button', { name: 'Discover Path' })).toBeTruthy();
  });

  it('does not render Discover Path button when canWriteNodes is false', () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onDiscoverPath={vi.fn().mockResolvedValue(true)}
        canWriteNodes={false}
        isCompanion
      />,
    );
    expect(screen.queryByRole('button', { name: 'Discover Path' })).toBeNull();
  });

  it('surfaces the real server error from onShareContact (issue #3480)', async () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const serverError = 'Device rejected share-contact — the firmware may not support this command.';
    const onShareContact = vi.fn().mockResolvedValue({ ok: false, error: serverError });

    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onShareContact={onShareContact}
        canWriteNodes
        isCompanion
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share Contact' }));

    // The real reason is shown, NOT the hardcoded generic fallback.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(serverError);
    expect(onShareContact).toHaveBeenCalledWith(PK);

    confirmSpy.mockRestore();
  });

  it('builds a path by repeater name and saves the hex chain', async () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    const repeaters: MeshCoreContact[] = [
      { publicKey: 'b1' + 'c'.repeat(62), advType: 2, advName: 'North Repeater' },
      { publicKey: '7f' + 'd'.repeat(62), advType: 2, advName: 'East Repeater' },
    ];
    const onSetOutPath = vi.fn().mockResolvedValue(true);

    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onSetOutPath={onSetOutPath}
        repeaters={repeaters}
        canWriteNodes
        isCompanion
      />,
    );

    // Define Path… is visible without any advanced toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Define Path…' }));

    // Pick a repeater by name from the hop selector.
    const select = screen.getByRole('combobox', { name: 'Add repeater hop' });
    fireEvent.change(select, { target: { value: 'b1' } });

    // The hop appears with its repeater name.
    expect(screen.getByText('North Repeater')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save Path' }));
    await waitFor(() => expect(onSetOutPath).toHaveBeenCalledWith(PK, 'b1', 1));
  });

  it('reorders hops with the up button before saving', async () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    const repeaters: MeshCoreContact[] = [
      { publicKey: 'b1' + 'c'.repeat(62), advType: 2, advName: 'North Repeater' },
      { publicKey: '7f' + 'd'.repeat(62), advType: 2, advName: 'East Repeater' },
    ];
    const onSetOutPath = vi.fn().mockResolvedValue(true);
    render(
      <MeshCoreContactDetailPanel contact={contact} publicKey={PK} onSetOutPath={onSetOutPath}
        repeaters={repeaters} canWriteNodes isCompanion />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Define Path…' }));
    const select = screen.getByRole('combobox', { name: 'Add repeater hop' });
    fireEvent.change(select, { target: { value: 'b1' } });
    fireEvent.change(select, { target: { value: '7f' } }); // hops: [b1, 7f]
    // Move the second hop (East/7f) up → [7f, b1].
    fireEvent.click(screen.getAllByRole('button', { name: 'Move hop up' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Save Path' }));
    await waitFor(() => expect(onSetOutPath).toHaveBeenCalledWith(PK, '7f,b1', 1));
  });

  it('adds a custom hex byte and rejects an invalid one', async () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    const onSetOutPath = vi.fn().mockResolvedValue(true);
    render(
      <MeshCoreContactDetailPanel contact={contact} publicKey={PK} onSetOutPath={onSetOutPath}
        repeaters={[]} canWriteNodes isCompanion />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Define Path…' }));
    const input = screen.getByPlaceholderText('or hex byte (a3)');
    // Invalid byte → error, no hop added.
    fireEvent.change(input, { target: { value: 'zz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText(/hex hash/i)).toBeTruthy();
    // Valid byte → hop added and saved.
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Path' }));
    await waitFor(() => expect(onSetOutPath).toHaveBeenCalledWith(PK, 'ab', 1));
  });

  it('builds a 2-byte-width path and saves it with hashBytes=2', async () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    const repeaters: MeshCoreContact[] = [
      { publicKey: 'b1f2' + 'c'.repeat(60), advType: 2, advName: 'North Repeater' },
    ];
    const onSetOutPath = vi.fn().mockResolvedValue(true);
    render(
      <MeshCoreContactDetailPanel contact={contact} publicKey={PK} onSetOutPath={onSetOutPath}
        repeaters={repeaters} canWriteNodes isCompanion />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Define Path…' }));
    // Switch the hop hash width to 2 bytes.
    fireEvent.change(screen.getByRole('combobox', { name: 'Hop hash width:' }), { target: { value: '2' } });
    // The repeater's hop is now its 2-byte prefix.
    const select = screen.getByRole('combobox', { name: 'Add repeater hop' });
    fireEvent.change(select, { target: { value: 'b1f2' } });
    expect(screen.getByText('North Repeater')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save Path' }));
    await waitFor(() => expect(onSetOutPath).toHaveBeenCalledWith(PK, 'b1f2', 2));
  });

  it('infers 2-byte width from an existing multi-byte out_path', () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1, outPath: 'b1f2,7f01' };
    const repeaters: MeshCoreContact[] = [
      { publicKey: 'b1f2' + 'c'.repeat(60), advType: 2, advName: 'North Repeater' },
    ];
    render(
      <MeshCoreContactDetailPanel contact={contact} publicKey={PK}
        onSetOutPath={vi.fn().mockResolvedValue(true)} repeaters={repeaters} canWriteNodes isCompanion />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Define Path…' }));
    // Width selector pre-selected to 2 bytes; known 2-byte hop resolves by name.
    expect((screen.getByRole('combobox', { name: 'Hop hash width:' }) as HTMLSelectElement).value).toBe('2');
    expect(screen.getByText('North Repeater')).toBeTruthy();
    expect(screen.getByText('Unknown (0x7f01)')).toBeTruthy();
  });

  it('pre-populates the editor from the existing out_path, resolving names', () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1, outPath: 'b1,7f' };
    const repeaters: MeshCoreContact[] = [
      { publicKey: 'b1' + 'c'.repeat(62), advType: 2, advName: 'North Repeater' },
    ];
    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onSetOutPath={vi.fn().mockResolvedValue(true)}
        repeaters={repeaters}
        canWriteNodes
        isCompanion
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Define Path…' }));
    // Known hop resolves to its name; unknown hop falls back to "Unknown (0x..)".
    expect(screen.getByText('North Repeater')).toBeTruthy();
    expect(screen.getByText('Unknown (0x7f)')).toBeTruthy();
  });

  it('falls back to a generic message when onShareContact returns no error text', async () => {
    const contact: MeshCoreContact = { publicKey: PK, advType: 1 };
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onShareContact = vi.fn().mockResolvedValue({ ok: false });

    render(
      <MeshCoreContactDetailPanel
        contact={contact}
        publicKey={PK}
        onShareContact={onShareContact}
        canWriteNodes
        isCompanion
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Share Contact' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Share contact failed.'));

    confirmSpy.mockRestore();
  });

  describe('zero-hop ping (#4393)', () => {
    const PING_LABEL = 'Ping (0 hop)';

    it('offers Ping even when no route is cached (unlike Trace Path)', () => {
      // pathLen null == unknown route: Trace Path is hidden, Ping is not,
      // because a ping builds its own one-hop path from the contact key.
      const contact: MeshCoreContact = { publicKey: PK, advType: 2, pathLen: null };
      render(
        <MeshCoreContactDetailPanel
          contact={contact}
          publicKey={PK}
          onTracePath={vi.fn()}
          onPingZeroHop={vi.fn().mockResolvedValue({ ok: false, error: 'x' })}
          canWriteNodes
          isCompanion
        />,
      );
      expect(screen.getByRole('button', { name: PING_LABEL })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Trace Path' })).toBeNull();
    });

    it('hides Ping without nodes:write', () => {
      const contact: MeshCoreContact = { publicKey: PK, advType: 2 };
      render(
        <MeshCoreContactDetailPanel
          contact={contact}
          publicKey={PK}
          onPingZeroHop={vi.fn()}
          canWriteNodes={false}
          isCompanion
        />,
      );
      expect(screen.queryByRole('button', { name: PING_LABEL })).toBeNull();
    });

    it('hides Ping on a non-Companion source', () => {
      const contact: MeshCoreContact = { publicKey: PK, advType: 2 };
      render(
        <MeshCoreContactDetailPanel
          contact={contact}
          publicKey={PK}
          onPingZeroHop={vi.fn()}
          canWriteNodes
          isCompanion={false}
        />,
      );
      expect(screen.queryByRole('button', { name: PING_LABEL })).toBeNull();
    });

    it('renders RTT and both SNR readings on a successful ping', async () => {
      const contact: MeshCoreContact = { publicKey: PK, advType: 2 };
      const onPingZeroHop = vi.fn().mockResolvedValue({
        ok: true,
        hopHash: 'aa',
        rttMs: 812,
        snrToTarget: 10,
        snrFromTarget: -3.5,
      });

      render(
        <MeshCoreContactDetailPanel
          contact={contact}
          publicKey={PK}
          onPingZeroHop={onPingZeroHop}
          canWriteNodes
          isCompanion
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: PING_LABEL }));

      await waitFor(() => {
        const status = screen.getByRole('status').textContent ?? '';
        expect(status).toContain('Direct — in range');
        expect(status).toContain('812 ms');
        expect(status).toContain('10.00 dB');
        expect(status).toContain('-3.50 dB');
      });
      expect(onPingZeroHop).toHaveBeenCalledWith(PK);
    });

    it('shows the server reason verbatim when the node does not answer', async () => {
      const contact: MeshCoreContact = { publicKey: PK, advType: 2 };
      const error = 'No reply — the node is not in direct radio range (or does not repeat traces).';
      render(
        <MeshCoreContactDetailPanel
          contact={contact}
          publicKey={PK}
          onPingZeroHop={vi.fn().mockResolvedValue({ ok: false, error })}
          canWriteNodes
          isCompanion
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: PING_LABEL }));

      await waitFor(() => expect(screen.getByRole('status').textContent).toBe(error));
    });

    it('omits the outbound SNR when the node reported none', async () => {
      const contact: MeshCoreContact = { publicKey: PK, advType: 2 };
      render(
        <MeshCoreContactDetailPanel
          contact={contact}
          publicKey={PK}
          onPingZeroHop={vi.fn().mockResolvedValue({
            ok: true, hopHash: 'aa', rttMs: 90, snrToTarget: null, snrFromTarget: 4,
          })}
          canWriteNodes
          isCompanion
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: PING_LABEL }));

      await waitFor(() => {
        const status = screen.getByRole('status').textContent ?? '';
        expect(status).toContain('4.00 dB');
        expect(status).not.toContain('SNR at node');
      });
    });

    it('clears a stale ping result when the selected contact changes (#4514)', async () => {
      const PK2 = 'b'.repeat(64);
      const contactA: MeshCoreContact = { publicKey: PK, advType: 2 };
      const contactB: MeshCoreContact = { publicKey: PK2, advType: 2 };
      const onPingZeroHop = vi.fn().mockResolvedValue({
        ok: true, hopHash: 'aa', rttMs: 100, snrToTarget: 5, snrFromTarget: 2,
      });

      const { rerender } = render(
        <MeshCoreContactDetailPanel
          contact={contactA}
          publicKey={PK}
          onPingZeroHop={onPingZeroHop}
          canWriteNodes
          isCompanion
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: PING_LABEL }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Direct — in range'));

      // Switch to a different contact — the previous ping result must not
      // bleed into the new contact's card.
      rerender(
        <MeshCoreContactDetailPanel
          contact={contactB}
          publicKey={PK2}
          onPingZeroHop={onPingZeroHop}
          canWriteNodes
          isCompanion
        />,
      );

      expect(screen.queryByText('Zero-Hop Ping')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('ignores an in-flight ping reply for a contact the user has since navigated away from (#4514)', async () => {
      const PK2 = 'b'.repeat(64);
      const contactA: MeshCoreContact = { publicKey: PK, advType: 2 };
      const contactB: MeshCoreContact = { publicKey: PK2, advType: 2 };
      // The Promise executor runs synchronously, so resolvePing is assigned
      // before render() returns — safe to use below without an intermediate await.
      let resolvePing: (value: { ok: true; hopHash: string; rttMs: number; snrToTarget: number; snrFromTarget: number }) => void;
      const onPingZeroHop = vi.fn().mockImplementation(
        () => new Promise((resolve) => { resolvePing = resolve; }),
      );

      const { rerender } = render(
        <MeshCoreContactDetailPanel
          contact={contactA}
          publicKey={PK}
          onPingZeroHop={onPingZeroHop}
          canWriteNodes
          isCompanion
        />,
      );

      // Kick off a ping for contact A, then navigate away before it resolves.
      fireEvent.click(screen.getByRole('button', { name: PING_LABEL }));

      rerender(
        <MeshCoreContactDetailPanel
          contact={contactB}
          publicKey={PK2}
          onPingZeroHop={onPingZeroHop}
          canWriteNodes
          isCompanion
        />,
      );

      // Contact A's ping reply now arrives late — it must not paint onto
      // contact B's card.
      resolvePing!({ ok: true, hopHash: 'aa', rttMs: 100, snrToTarget: 5, snrFromTarget: 2 });

      await waitFor(() => expect(onPingZeroHop).toHaveBeenCalledWith(PK));
      // Give the resolved promise's .then a tick to run.
      await new Promise((r) => setTimeout(r, 0));

      expect(screen.queryByText('Zero-Hop Ping')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  /**
   * #4517 — the same async race #4514/#4515 fixed for Zero-Hop Ping existed in
   * every other action on this panel: `await` a reply, then unconditionally
   * write it to state. The contact-change effect clears these fields on
   * switch, so the failure is specifically a reply landing *after* that clear
   * and repainting one contact's data onto another's card.
   */
  describe('stale replies after a contact switch (#4517)', () => {
    const PK2 = 'b'.repeat(64);
    /** pathLen > 0 is required for the Trace Path button to be offered. */
    const contactA: MeshCoreContact = { publicKey: PK, advType: 2, pathLen: 2 };
    const contactB: MeshCoreContact = { publicKey: PK2, advType: 2, pathLen: 2 };

    /** A promise whose resolution the test controls. */
    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    }

    it("does not paint contact A's trace result onto contact B", async () => {
      const d = deferred<{ hops: { index: number; snr: number }[]; lastSnr: number }>();
      const onTracePath = vi.fn().mockReturnValue(d.promise);

      const props = { onTracePath, canWriteNodes: true, isCompanion: true } as const;
      const { rerender } = render(
        <MeshCoreContactDetailPanel contact={contactA} publicKey={PK} {...props} />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Trace Path' }));
      rerender(<MeshCoreContactDetailPanel contact={contactB} publicKey={PK2} {...props} />);

      // A's reply arrives only now, with B on screen.
      d.resolve({ hops: [{ index: 0, snr: 7 }], lastSnr: 5 });
      await waitFor(() => expect(onTracePath).toHaveBeenCalledWith(PK));
      await new Promise((r) => setTimeout(r, 0));

      expect(screen.queryByText('Trace Path Results')).toBeNull();
    });

    it("does not paint contact A's neighbours onto contact B", async () => {
      const d = deferred<{ total: number; neighbours: { publicKeyPrefix: string; heardSecondsAgo: number; snr: number }[] }>();
      const onGetNeighbours = vi.fn().mockReturnValue(d.promise);

      const props = { onGetNeighbours, isCompanion: true } as const;
      const { rerender } = render(
        <MeshCoreContactDetailPanel contact={contactA} publicKey={PK} {...props} />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Neighbours' }));
      rerender(<MeshCoreContactDetailPanel contact={contactB} publicKey={PK2} {...props} />);

      d.resolve({ total: 3, neighbours: [{ publicKeyPrefix: 'ff', heardSecondsAgo: 10, snr: 4 }] });
      await waitFor(() => expect(onGetNeighbours).toHaveBeenCalledWith(PK, { count: 20 }));
      await new Promise((r) => setTimeout(r, 0));

      expect(screen.queryByText(/3 total/)).toBeNull();
    });

    it('still shows a reply for the contact the user is actually on', async () => {
      // The guard must not be so eager that it drops legitimate results.
      const onTracePath = vi.fn().mockResolvedValue({ hops: [{ index: 0, snr: 7 }], lastSnr: 5 });
      render(
        <MeshCoreContactDetailPanel
          contact={contactA} publicKey={PK}
          onTracePath={onTracePath} canWriteNodes isCompanion
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Trace Path' }));
      await waitFor(() => expect(screen.getByText('Trace Path Results')).toBeInTheDocument());
    });

    it('guards every async handler, including ones added later', async () => {
      // The point of routing these through one `beginContactAction()` helper is
      // that the next handler cannot quietly skip the check. Asserted at the
      // source level because a behavioural test can only cover the handlers
      // that exist today.
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(
        resolve('src/components/MeshCore/MeshCoreContactDetailPanel.tsx'), 'utf8',
      );
      const handlers = [...src.matchAll(/const (handle\w+) = async \(\) => \{([\s\S]*?)\n {2}\};/g)];
      expect(handlers.length).toBeGreaterThan(5);

      const unguarded = handlers
        .filter((m) => /await on[A-Z]/.test(m[2]) && !m[2].includes('beginContactAction()'))
        .map((m) => m[1]);
      expect(unguarded, `unguarded handlers: ${unguarded.join(', ')}`).toEqual([]);
    });
  });

});
