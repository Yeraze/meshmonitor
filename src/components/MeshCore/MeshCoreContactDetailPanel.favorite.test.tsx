/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — favorite star (#5507).
 *
 * The Contact Details panel reuses the exact `setNodeFavorite` action the
 * Nodes list star uses (#3588), gated on the same `nodes:write` permission
 * (`canWriteNodes`) as the panel's other action buttons (Reset Path, Share,
 * …). This asserts: current state renders correctly, the toggle calls the
 * action with the right key/value, and it is hidden without write
 * permission.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

vi.mock('./MeshCoreRemoteConsole', () => ({
  MeshCoreRemoteConsole: () => null,
}));

const PK = 'b'.repeat(64);

const CONTACT: MeshCoreContact = {
  publicKey: PK,
  advName: 'Favorite Candidate',
  advType: 1,
};

function renderPanel(opts: {
  isFavorite?: boolean;
  canWriteNodes?: boolean;
  onToggleFavorite?: ReturnType<typeof vi.fn>;
} = {}) {
  const { isFavorite = false, canWriteNodes = true, onToggleFavorite } = opts;
  return render(
    <MeshCoreContactDetailPanel
      contact={CONTACT}
      publicKey={PK}
      isFavorite={isFavorite}
      onToggleFavorite={onToggleFavorite}
      canWriteNodes={canWriteNodes}
      isCompanion
    />,
  );
}

describe('MeshCoreContactDetailPanel favorite star', () => {
  it('renders the outline star and "Add to favorites" when not favorited', () => {
    renderPanel({ isFavorite: false, onToggleFavorite: vi.fn() });
    const btn = screen.getByRole('button', { name: 'Add to favorites' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders the filled star and "Remove from favorites" when favorited', () => {
    renderPanel({ isFavorite: true, onToggleFavorite: vi.fn() });
    const btn = screen.getByRole('button', { name: 'Remove from favorites' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('calls onToggleFavorite with the contact publicKey and the new value', async () => {
    const onToggleFavorite = vi.fn().mockResolvedValue(true);
    renderPanel({ isFavorite: false, onToggleFavorite });
    const btn = screen.getByRole('button', { name: 'Add to favorites' });
    await userEvent.click(btn);
    expect(onToggleFavorite).toHaveBeenCalledWith(PK, true);
  });

  it('toggles off (publicKey, false) when already favorited', async () => {
    const onToggleFavorite = vi.fn().mockResolvedValue(true);
    renderPanel({ isFavorite: true, onToggleFavorite });
    const btn = screen.getByRole('button', { name: 'Remove from favorites' });
    await userEvent.click(btn);
    expect(onToggleFavorite).toHaveBeenCalledWith(PK, false);
  });

  it('shows an error and does not change state optimistically when the action fails', async () => {
    const onToggleFavorite = vi.fn().mockResolvedValue(false);
    renderPanel({ isFavorite: false, onToggleFavorite });
    const btn = screen.getByRole('button', { name: 'Add to favorites' });
    await userEvent.click(btn);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update favorite');
  });

  it('is hidden without write permission (canWriteNodes=false)', () => {
    renderPanel({ isFavorite: false, canWriteNodes: false, onToggleFavorite: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Add to favorites' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove from favorites' })).toBeNull();
  });

  it('is hidden when no onToggleFavorite handler is supplied', () => {
    renderPanel({ isFavorite: false, canWriteNodes: true, onToggleFavorite: undefined });
    expect(screen.queryByRole('button', { name: 'Add to favorites' })).toBeNull();
  });
});
