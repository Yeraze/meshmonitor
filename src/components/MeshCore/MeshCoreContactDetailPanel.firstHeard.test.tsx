/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — First Heard row (#5390). The value is epoch
 * MILLISECONDS (MeshCore's unit), passed in from the durable node row.
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
  useSource: () => ({ sourceId: 'test-source', sourceName: 'Test' }),
}));

vi.mock('./MeshCoreRemoteConsole', () => ({
  MeshCoreRemoteConsole: () => null,
}));

const PK = 'a'.repeat(64);
const contact: MeshCoreContact = {
  publicKey: PK,
  advName: 'Companion One',
  advType: 1,
  lastSeen: Date.now() - 60_000,
};

describe('MeshCoreContactDetailPanel First Heard (#5390)', () => {
  it('shows First Heard from an epoch-ms value', () => {
    render(
      <MeshCoreContactDetailPanel contact={contact} publicKey={PK} firstHeard={Date.now() - 2 * 3_600_000} />,
    );
    const card = screen.getByTestId('meshcore-first-heard');
    expect(card).toHaveTextContent('First Heard');
    expect(card).toHaveTextContent('2 hours ago');
  });

  it('hides the row when First Heard is unknown', () => {
    render(<MeshCoreContactDetailPanel contact={contact} publicKey={PK} />);
    expect(screen.queryByTestId('meshcore-first-heard')).not.toBeInTheDocument();
  });
});
