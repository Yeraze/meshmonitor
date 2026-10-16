/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — location override (#5842).
 *
 * The panel shows an "Override location" button gated on `nodes:write`
 * (`canEditPositionOverride`, not tied to the connection), opens the shared
 * PositionOverrideModal in MeshCore mode (which loads from the MeshCore
 * route), and saves through `onSetPositionOverride`. An applied override is
 * labelled under the Position card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MeshCoreContactDetailPanel } from './MeshCoreContactDetailPanel';
import type { MeshCoreContact } from '../../utils/meshcoreHelpers';
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

const PK = 'e'.repeat(64);

const CONTACT: MeshCoreContact = {
  publicKey: PK,
  advName: 'Hilltop Repeater',
  advType: 2,
  latitude: 28.5,
  longitude: -81.4,
};

function renderPanel(opts: { canEdit?: boolean; onSet?: ReturnType<typeof vi.fn>; contact?: MeshCoreContact } = {}) {
  const { canEdit = true, onSet = vi.fn().mockResolvedValue(undefined), contact = CONTACT } = opts;
  render(
    <MeshCoreContactDetailPanel
      contact={contact}
      publicKey={PK}
      onSetPositionOverride={onSet}
      canEditPositionOverride={canEdit}
      // Disconnected repeater: the override is MeshMonitor-only, so it still shows.
      canWriteNodes={false}
      isCompanion={false}
    />,
  );
  return { onSet };
}

describe('MeshCoreContactDetailPanel location override', () => {
  let apiGet: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.restoreAllMocks();
    apiGet = vi.spyOn(apiService, 'get').mockResolvedValue({ success: true, data: { enabled: true, latitude: 28.5, longitude: -81.4, altitude: 30, isPrivate: false } });
  });

  it('hides the button without nodes:write', () => {
    renderPanel({ canEdit: false });
    expect(screen.queryByRole('button', { name: /Override location/ })).toBeNull();
  });

  it('shows the button on a repeater source with no link', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: /Override location/ })).toBeInTheDocument();
  });

  it('loads from the MeshCore route and saves through onSetPositionOverride', async () => {
    const { onSet } = renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Override location/ }));

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(
      `/api/sources/test-source/meshcore/nodes/${PK}/position-override`,
    ));
    const enabled = await screen.findByRole('checkbox', { name: /use_position|custom position/i });
    expect(enabled).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSet).toHaveBeenCalledWith(PK, {
      enabled: true,
      latitude: 28.5,
      longitude: -81.4,
      altitude: 30,
      isPrivate: false,
    }));
  });

  it('uses contact wording, not Meshtastic node wording, in the modal', async () => {
    renderPanel();
    await userEvent.click(screen.getByRole('button', { name: /Override location/ }));

    // The i18n mock renders keys, so assert the MeshCore keys are the ones used.
    expect(await screen.findByText('position_override.description_meshcore')).toBeInTheDocument();
    expect(screen.queryByText('position_override.description')).toBeNull();
    expect(screen.getByText('position_override.private_description_meshcore')).toBeInTheDocument();
  });

  it('labels an applied override under the Position card', () => {
    renderPanel({ contact: { ...CONTACT, positionIsOverride: true, positionOverrideIsPrivate: true } });
    expect(screen.getByText('Location override (private)')).toBeInTheDocument();
  });
});
