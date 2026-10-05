/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel on a Repeater source (#5632).
 *
 * A Repeater keeps no contact table, so its contact list is built server-side
 * from the stored node rows (`contactFromNodeRow`). These fixtures are that
 * record as it arrives over JSON: `undefined` fields are gone, `outPath` and
 * `pathLen` are null. The panel must fill in from it, with or without a
 * position, and must still fall back to the key prefix when there is no
 * record at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'repeater-source', sourceName: 'Repeater' }),
}));

vi.mock('./MeshCoreRemoteConsole', () => ({
  MeshCoreRemoteConsole: () => null,
}));

const PK = 'ab'.repeat(32);

/** An advert-only node: named, typed, heard, never sent a position. */
const advertOnly: MeshCoreContact = {
  publicKey: PK,
  advName: 'Ridge Walker',
  name: 'Ridge Walker',
  advType: 1,
  lastAdvertHadPosition: false,
  lastSeen: Date.now() - 60_000,
  outPath: null,
  pathLen: null,
};

/** A zero-hop neighbour: the neighbours poll adds SNR; an advert gave a fix. */
const neighbour: MeshCoreContact = {
  ...advertOnly,
  advName: 'Tower',
  name: 'Tower',
  advType: 2,
  snr: -2,
  latitude: 45.5,
  longitude: -122.5,
  lastAdvertHadPosition: true,
};

const labels = (): string[] =>
  Array.from(document.querySelectorAll('.node-detail-label')).map((el) => el.textContent ?? '');

describe('MeshCoreContactDetailPanel — Repeater-source contact (#5632)', () => {
  it('fills in an advert-only node: name and Last Heard, and no Position row', () => {
    render(<MeshCoreContactDetailPanel contact={advertOnly} publicKey={PK} isCompanion={false} />);
    expect(screen.getAllByText('Ridge Walker').length).toBeGreaterThan(0);
    expect(screen.queryByText(`${PK.substring(0, 8)}…`)).not.toBeInTheDocument();
    expect(labels()).toContain('Last Heard');
    expect(labels()).not.toContain('Position');
    expect(labels()).not.toContain('Signal (SNR)');
  });

  it('shows position and SNR when the stored row has them', () => {
    render(<MeshCoreContactDetailPanel contact={neighbour} publicKey={PK} isCompanion={false} />);
    expect(screen.getAllByText('Tower').length).toBeGreaterThan(0);
    expect(labels()).toEqual(expect.arrayContaining(['Position', 'Signal (SNR)', 'Last Heard']));
    expect(screen.getByText('45.50000, -122.50000')).toBeInTheDocument();
    expect(screen.getByText('-2.0 dB')).toBeInTheDocument();
  });

  it('with no contact record falls back to the key prefix (the old Repeater-source view)', () => {
    render(<MeshCoreContactDetailPanel contact={null} publicKey={PK} isCompanion={false} />);
    expect(screen.getAllByText(`${PK.substring(0, 8)}…`).length).toBeGreaterThan(0);
    expect(labels()).not.toContain('Last Heard');
  });
});
