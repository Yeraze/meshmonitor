/**
 * @vitest-environment jsdom
 *
 * MeshCoreContactDetailPanel — sign-flip notice (#5363): when the server moved
 * a contact's position to its mirror point, the Position card says so and
 * shows what the node reported.
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
const base: MeshCoreContact = {
  publicKey: PK,
  advName: 'Companion One',
  advType: 1,
  lastSeen: Date.now() - 60_000,
  latitude: 27.9,
  longitude: -82.5,
};

describe('MeshCoreContactDetailPanel sign-flip notice (#5363)', () => {
  it('shows the notice with the reported coordinates when corrected', () => {
    render(
      <MeshCoreContactDetailPanel
        contact={{ ...base, positionSignFlipCorrected: true, reportedLatitude: 27.9, reportedLongitude: 82.5 }}
        publicKey={PK}
      />,
    );
    const notice = screen.getByTestId('sign-flip-notice');
    expect(notice).toHaveTextContent('Position auto-corrected (sign flip)');
    expect(notice).toHaveTextContent('Reported: 27.90000, 82.50000');
    expect(screen.getByText('27.90000, -82.50000')).toBeInTheDocument();
  });

  it('shows no notice for an uncorrected position', () => {
    render(<MeshCoreContactDetailPanel contact={base} publicKey={PK} />);
    expect(screen.queryByTestId('sign-flip-notice')).not.toBeInTheDocument();
  });
});
