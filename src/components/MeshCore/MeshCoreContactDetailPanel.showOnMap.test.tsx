/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — Show on Map (#5964).
 *
 * The Position card shows a Show on Map button when the node has a position
 * the MeshCore map would draw, on Companion and Repeater sources alike, and a
 * click hands the node's public key to `onShowOnMap`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { HIDE_POSITIONLESS_ADVERT_STORAGE_KEY } from '../../utils/meshcoreAdvertPosition';
import apiService from '../../services/api';

vi.mock('react-i18next', async () => {
  const { createReactI18nextMock } = await import('../../test/mockI18n');
  return createReactI18nextMock();
});

vi.mock('../../contexts/SettingsContext', () => ({
  useNodeListStyle: () => 'monochrome',
  useSettings: () => ({ timeFormat: '24', dateFormat: 'MM/DD/YYYY' }),
}));

vi.mock('../../contexts/SourceContext', () => ({
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

vi.mock('../../hooks/useResolvedSourceId', () => ({
  useResolvedSourceId: () => 'test-source',
}));

vi.mock('./MeshCoreRemoteConsole', () => ({
  MeshCoreRemoteConsole: () => null,
}));

const PK = 'f'.repeat(64);

const POSITIONED: MeshCoreContact = {
  publicKey: PK,
  advName: 'Hilltop',
  advType: 2,
  latitude: 28.5,
  longitude: -81.4,
};

function renderPanel(opts: {
  contact?: MeshCoreContact;
  onShowOnMap?: ReturnType<typeof vi.fn> | undefined;
  isCompanion?: boolean;
} = {}) {
  const onShowOnMap = 'onShowOnMap' in opts ? opts.onShowOnMap : vi.fn();
  render(
    <MeshCoreContactDetailPanel
      contact={opts.contact ?? POSITIONED}
      publicKey={PK}
      onShowOnMap={onShowOnMap}
      canWriteNodes={false}
      isCompanion={opts.isCompanion ?? false}
    />,
  );
  return { onShowOnMap };
}

const button = () => screen.queryByRole('button', { name: /messages\.show_on_map|Show on Map/ });

describe('MeshCoreContactDetailPanel — Show on Map (#5964)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(apiService, 'get').mockResolvedValue({ success: true, data: { items: [] } });
  });

  it('shows the button when the node has a position (Repeater source)', () => {
    renderPanel();
    expect(button()).not.toBeNull();
  });

  it('shows the button on a Companion source too', () => {
    renderPanel({ isCompanion: true });
    expect(button()).not.toBeNull();
  });

  it('hides the button when the node has no position', () => {
    renderPanel({ contact: { publicKey: PK, advName: 'No GPS', advType: 1 } });
    expect(button()).toBeNull();
  });

  it('hides the button when no handler is wired', () => {
    renderPanel({ onShowOnMap: undefined });
    expect(button()).toBeNull();
  });

  it('hides the button for a 0/0 fix the map never draws', () => {
    renderPanel({ contact: { ...POSITIONED, latitude: 0, longitude: 0 } });
    expect(button()).toBeNull();
  });

  it('hides the button when the #5578 toggle hides the node from the map', () => {
    localStorage.setItem(HIDE_POSITIONLESS_ADVERT_STORAGE_KEY, 'true');
    renderPanel({ contact: { ...POSITIONED, lastAdvertHadPosition: false } });
    expect(button()).toBeNull();
  });

  it('keeps the button for a location override with the #5578 toggle on', () => {
    localStorage.setItem(HIDE_POSITIONLESS_ADVERT_STORAGE_KEY, 'true');
    renderPanel({ contact: { ...POSITIONED, lastAdvertHadPosition: false, positionIsOverride: true } });
    expect(button()).not.toBeNull();
  });

  it('calls onShowOnMap with the public key on click', async () => {
    const { onShowOnMap } = renderPanel();
    await userEvent.click(button()!);
    expect(onShowOnMap).toHaveBeenCalledTimes(1);
    expect(onShowOnMap).toHaveBeenCalledWith(PK);
  });
});
